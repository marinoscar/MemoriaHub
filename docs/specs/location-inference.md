# Location Inference — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.2 |
| **Last Updated** | July 2026 |
| **Status** | Specification (backend + UI both implemented) |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Coordinate Provenance Model](#2-coordinate-provenance-model)
3. [Per-Item Algorithm](#3-per-item-algorithm)
4. [Sweep Architecture](#4-sweep-architecture)
5. [Job Architecture and Throughput Expectations](#5-job-architecture-and-throughput-expectations)
6. [Data Model](#6-data-model)
7. [Configuration](#7-configuration)
8. [API Endpoints](#8-api-endpoints)
9. [Bulk Accept/Reject at Scale](#9-bulk-acceptreject-at-scale)
10. [RBAC](#10-rbac)
11. [Review UI](#11-review-ui)
12. [Algorithm Positioning — Verified Against the Field](#12-algorithm-positioning--verified-against-the-field)
13. [Known Limitations and Non-Goals](#13-known-limitations-and-non-goals)
14. [Testing Notes](#14-testing-notes)
15. [Future Work](#15-future-work)

---

## 1. Overview and Goals

### The problem

Many photos in a family circle lack GPS coordinates — the camera or phone had location services off, the file was imported from an old device, or a messaging app stripped EXIF on re-share. But it is common for the *same camera* to have captured other photos minutes before or after a GPS-less shot, and those neighboring photos usually **do** have coordinates. Location inference fills the gap: it looks at chronologically-nearby, same-device photos that already have coordinates and either interpolates between two of them or borrows from the single nearest one, subject to a set of conservative gates (time window, anchor agreement, implied travel speed) before deciding whether the result is trustworthy enough to write automatically or should be queued for a human to confirm.

### Goals

- Recover missing GPS coordinates for the common case: a same-device photo taken close in time to other GPS-tagged photos.
- Tiered confidence: high-confidence inferences are auto-applied (and revertible); everything else goes to a confirm/adjust/reject review queue.
- Operate as a global feature toggle (`features.locationInference`, default off), consistent with face recognition, auto-tagging, burst detection, and duplicate detection.
- Run entirely on the existing `enrichment_jobs` queue (per-item and sweep modes both go through the same handler) so it inherits retries, observability, and the admin jobs dashboard.
- Scale to a backfill sweep across a library of several thousand existing photos without exceeding the enrichment worker's stuck-job reset threshold — a full circle sweep is designed to complete in well under a minute at 10k photos, not hours.
- Every threshold (time windows, anchor-agreement distance, implied-speed ceiling, device-matching requirement) is admin-tunable via system settings.

### Non-Goals (v1)

See §13 for the full list — most notably, there is no debounced "sweep on new anchor upload" and no cross-device corroboration; both are explicit v2 candidates.

---

## 2. Coordinate Provenance Model

### `coord_source` column

`MediaItem.coordSource` (`String?`, `@map("coord_source")`) records **where `takenLat`/`takenLng` came from**: `'exif'` | `'manual'` | `'inferred'` | `null` (no coordinates at all). This is a new column, added by migration `20260703000000_add_coord_source_and_location_suggestions`.

**Why a new column, and not an overload of `geoSource`:** `geoSource` already exists and tracks which *reverse-geocoding provider/trigger* produced the place-name columns (`geoCountry`, `geoAdmin1`, etc.) — it is overwritten every time a `geocode` job runs, regardless of where the underlying coordinates came from. Reusing it for coordinate provenance would mean every automatic geocode re-run silently destroys the record of whether a photo's GPS came from its own EXIF, a human's manual pin-drop, or this feature's inference. Keeping the two columns separate means **`GeocodeHandler` overwriting `geoSource` after an auto-apply is expected and correct** — provenance survives because it lives in `coordSource`, which the geocode handler never touches.

### Three writers, and only three

| Writer | Sets `coordSource` to | Code location |
|---|---|---|
| EXIF metadata sync (upload path + `metadata_extraction` rerun) | `'exif'` | `MediaMetadataSyncService.syncFromStorageObject` (`apps/api/src/media/sync/media-metadata-sync.service.ts:148`) — set **only** when EXIF actually supplied `latitude` in that run (present-only semantics: `if (typeof exifMeta['latitude'] === 'number') { update.takenLat = ...; update.coordSource = 'exif'; }`) |
| `bulkUpdateMedia` (manual location edit via bulk operations or the properties pane) | `'manual'` | `MediaService.bulkUpdateMedia` → shared `applyLocation()` helper, `apps/api/src/media/media.service.ts:1443` |
| Location inference (auto-apply, accept-unmodified, or bulk-accept) | `'inferred'` (auto-apply/accept-unmodified) or `'manual'` (accept-with-adjustment) | `LocationInferenceService.applyComputedSuggestion`, `LocationSuggestionService.acceptSuggestion`/`bulkAcceptSuggestions` |

Before this migration, the only two writers of `takenLat`/`takenLng` were EXIF sync and `bulkUpdateMedia`. Location inference is the third. A migration backfill assigns provenance to every pre-existing row with coordinates: rows whose `geoSource = 'manual'` (a human-entered location predating this feature) become `coordSource = 'manual'`; every other row that already has `takenLat` becomes `coordSource = 'exif'`.

### Accept flow provenance nuance

`POST /api/media/location-suggestions/:id/accept` (§8) inspects whether the caller supplied `lat`/`lng` that differ from the stored suggestion:

- **Unmodified accept** (no override, or an override equal to the stored value): `coordSource = 'inferred'`.
- **Adjusted accept** (caller supplied different coordinates): `coordSource = 'manual'` — the human corrected the machine's guess, so the provenance should read as human-sourced from that point forward.

Both paths go through the same `applyLocation()` helper (`apps/api/src/media/geo/apply-location.util.ts`), which also performs a **synchronous** reverse-geocode call and writes the resulting geo columns in the same patch — this is different from the sweep and per-item-inference auto-apply paths, which write coordinates immediately but enqueue an *asynchronous* `geocode` job for the place-name lookup (see §13, "follow-on geocode cost").

### Extending `GEO_CLEAR_COLUMNS`

`GEO_CLEAR_COLUMNS` (`apps/api/src/media/geo/geo-result.mapper.ts`) — the shared column-nulling object used whenever a location is cleared (bulk "clear location" and location-suggestion revert) — was extended to also null `coordSource`, so clearing a location always resets provenance to "no coordinates" rather than leaving a stale `coordSource` value pointing at coordinates that no longer exist.

---

## 3. Per-Item Algorithm

Implemented as pure, independently-testable functions in `apps/api/src/location-inference/location-inference.service.ts` (`computeLocationSuggestion`, `haversineKm`, `interpolateLng`), called from both the per-item path (`inferForItem`) and the sweep's per-target walk (`walkGroup`) — there is exactly one implementation of the algorithm, not two.

### 3.1 Guards

An item is a candidate for inference only if: `type = photo`, not soft-deleted, `takenLat IS NULL` (already has coordinates → nothing to do), and `capturedAt IS NOT NULL`. A photo with no EXIF capture timestamp cannot be time-anchored against anything and is skipped — this is the same class of item burst detection also cannot help (no temporal signal) and duplicate detection's territory instead (visual-only matching). Documenting the triangle: **EXIF-stripped, GPS-less photos with no capture date are not inferable by this feature at all** — visual/near-duplicate matching (`docs/specs/duplicate-detection.md`) is the only mechanism that can still identify them, and only if a visual match exists.

### 3.2 Device matching

If `locationInference.requireSameDevice = true` (the default) and the item has neither `cameraMake` nor `cameraModel`, it is **not inferable** — there is no device to match anchors against, and the function returns without writing anything. If `requireSameDevice = false`, anchors are drawn from any device, but such cross-device inferences are **never eligible for auto-apply** — they can only ever become `pending` suggestions (see §3.6).

### 3.3 Anchor selection

Anchors are the nearest media item strictly before and strictly after the target's `capturedAt`, within `locationInference.maxGapMinutes`, in the same circle, matching device when required, and — critically — with:

```
coordSource IN ('exif', 'manual')
```

**Never `'inferred'`.** This is the drift-prevention rule: an already-inferred coordinate can never itself become an anchor for a further inference. Without this rule, a chain of inferences could compound small errors across a sequence of GPS-less photos, each one trusting the previous inference instead of a real, human/EXIF-sourced coordinate. The per-item path enforces this via the Prisma `where` clause (`anchorWhereBase.coordSource: { in: ['exif', 'manual'] }`); the sweep enforces the equivalent invariant differently — see §4.3's "snapshot invariant."

The per-item path queries the composite index `idx_media_circle_device_captured` on `(circle_id, camera_make, camera_model, captured_at) WHERE deleted_at IS NULL` (raw SQL only — not representable in the Prisma schema's DSL, so it exists in the migration file but is deliberately **not** mirrored in `schema.prisma`, the same precedent as `people_circle_id_hidden_at_idx`).

### 3.4 Interpolation, extrapolation, and the antimeridian

**Two anchors found, agreeing** (`haversineKm(anchorBefore, anchorAfter) <= maxAnchorDistanceKm`): time-weighted linear interpolation. The weight `w` is the fraction of the elapsed time between the two anchors that the target's `capturedAt` falls at (`gapBeforeSeconds / (gapBeforeSeconds + gapAfterSeconds)`, or `0.5` if both gaps are zero). Latitude interpolates linearly; longitude uses `interpolateLng`, which is **antimeridian-safe**: if the two longitudes are more than 180° apart, one side is normalized by ±360° before interpolating (so the "short way around" through ±180° is taken, not the long way through 0°), then the result is wrapped back into `[-180, 180]`. `method = 'interpolated'`.

**Two anchors found, disagreeing** (distance exceeds `maxAnchorDistanceKm`): rather than interpolating between two points that are implausibly far apart for the given time gap, the algorithm falls back to the coordinates of whichever anchor is nearer in time to the target. `method` **stays `'interpolated'`** in this case (it is a fallback within the two-anchor branch, not a distinct code path) and confidence is capped at `0.5` (§3.5).

**Exactly one anchor found**: this is extrapolation, not interpolation — the target's position is inferred from a single point rather than triangulated between two. It uses the coordinates of that single anchor directly, but is gated by the **tighter** `locationInference.maxExtrapolationGapMinutes` bound rather than `maxGapMinutes`. This mirrors ExifTool's `-geotag` feature, which maintains two separate limits: `GeoMaxIntSecs` for interpolation between two track points and a stricter `GeoMaxExtSecs` for extrapolating beyond the ends of the track — extrapolating past a single known point is inherently riskier than triangulating between two, so the window that data can be trusted for is narrower. If the single anchor's time gap exceeds `maxExtrapolationGapMinutes`, the function returns `null` (not inferable) even though it would have been within `maxGapMinutes`. `method = 'nearest'`; extrapolated suggestions are **never auto-apply-eligible** regardless of how small the gap is — the auto-apply gate (§3.6) requires two anchors, full stop.

**Zero anchors found**: returns `null`.

### 3.5 Confidence formula

For the two-anchor case, exactly as implemented in `computeLocationSuggestion`:

```
gapHours        = (gapBeforeSeconds + gapAfterSeconds) / 3600
impliedSpeedKmh = gapHours > 0 ? haversineKm(anchorBefore, anchorAfter) / gapHours : 0

maxGapUsedMinutes = max(gapBeforeSeconds, gapAfterSeconds) / 60
timeFactor   = clamp01(1 - maxGapUsedMinutes / maxGapMinutes)
agreeFactor  = 1 - min(anchorDistanceKm / maxAnchorDistanceKm, 1)
speedFactor  = max(0, 1 - impliedSpeedKmh / maxImpliedSpeedKmh)

confidence = clamp01(0.5 * timeFactor + 0.3 * agreeFactor + 0.2 * speedFactor)

if anchors disagree (distance > maxAnchorDistanceKm): confidence = min(confidence, 0.5)
if impliedSpeedKmh > maxImpliedSpeedKmh:               confidence = min(confidence, 0.4)
```

For the single-anchor (extrapolation) case, there is no second anchor to agree/disagree with and no speed to compute, so `agreeFactor`/`speedFactor` are fixed constants rather than computed:

```
timeFactor = clamp01(1 - gapMinutes / maxGapMinutes)   // note: still divided by maxGapMinutes, not maxExtrapolationGapMinutes
confidence = clamp01(0.5 * timeFactor + 0.3 * 0.25 + 0.2 * 0.5)
```

**Zero/near-zero gap → speed = 0** is an explicit guard against division by zero (`gapHours > 0 ? ... : 0`), not an edge case that falls through to `NaN` or `Infinity`.

### 3.6 Auto-apply criteria

Auto-apply requires **all** of the following simultaneously:

1. `deviceMatchGuaranteed` is true — only when the caller filtered anchors to the same `cameraMake`/`cameraModel` as the target (i.e. `requireSameDevice = true` was in effect for this computation). When `requireSameDevice = false`, `deviceMatchGuaranteed` is always false and auto-apply is never eligible for that item, regardless of any other factor.
2. Two anchors were found (single-anchor extrapolation is never eligible — see §3.4).
3. Both `gapBeforeSeconds / 60` and `gapAfterSeconds / 60` are `<= locationInference.autoApplyMaxGapMinutes`. This is a **tighter** ceiling than `maxGapMinutes` — `autoApplyMaxGapMinutes: 0` disables auto-apply entirely while still allowing suggestions to be generated for the review queue.
4. The anchors agree (`anchorDistanceKm <= maxAnchorDistanceKm`).
5. The implied speed does not exceed `maxImpliedSpeedKmh` (a subject who appears to be traveling faster than the ceiling is presumed to possibly be in transit between the two anchor locations, making a linear interpolation unreliable — suggestion-only, never auto-applied, confidence additionally capped at `0.4` per §3.5).

If any of these fail, the computed result is written as a `pending` suggestion instead (or is not written at all when `computeLocationSuggestion` itself returns `null` — no anchors, or a single anchor beyond `maxExtrapolationGapMinutes`).

### 3.7 What happens on auto-apply vs. suggestion-only

**Auto-apply** (`LocationInferenceService.applyComputedSuggestion`, `computed.autoApplyEligible = true`) does all of the following in a single `$transaction`:

1. `MediaItem.update`: `takenLat`, `takenLng`, `coordSource = 'inferred'`.
2. `LocationSuggestion.upsert`: full computed fields (lat, lng, confidence, method, anchor IDs, gaps, distance, implied speed), `status = 'auto_applied'` — **the suggestion row is written even for an auto-applied item**; it is the audited, revertible record of what happened and why, not just a queue entry for pending review.
3. `AuditEvent.create`: `action: 'media:location_inferred'`, `actorUserId: null` (system-initiated — there is no existing "system actor" convention in this codebase, and `actorUserId` is nullable specifically to accommodate cases like this one), `meta` carries the full suggestion fields.

Then, **outside** the transaction, a `geocode` enrichment job is enqueued (priority 0 for the per-item path, priority 100 for the sweep path — see §5) to fill in the place-name columns asynchronously.

**Suggestion-only** (`autoApplyEligible = false` but `computeLocationSuggestion` returned a non-null result): `LocationSuggestion.upsert` with `status = 'pending'`. No coordinates are written to `MediaItem` and no audit event is created — the suggestion row itself is the record until a human acts on it.

**Rejected-suggestion skip**: on the non-forced per-item path (`forceRerun = false`, i.e. upload-time enqueue), if an existing suggestion for the item already has `status = 'rejected'`, `inferForItem` returns immediately without recomputing — a human's rejection is sticky and is not silently re-litigated by a later automatic pass. The explicit per-item rerun endpoint (`POST /api/media/:id/infer-location`, which always enqueues with `reason: 'rerun'`) bypasses this skip (`forceRerun = true` when `job.reason === JobReason.rerun`), since a rerun is an explicit human request to recompute regardless of a prior rejection.

---

## 4. Sweep Architecture

The sweep (`LocationInferenceService.sweepCircle`) is the backfill mechanism: **one job per circle**, pure in-memory computation over a single narrow DB read followed by chunked writes — not one job per media item (see §5 for why).

### 4.1 Snapshot invariant

The entire circle's eligible rows (id, `capturedAt`, `cameraMake`, `cameraModel`, `takenLat`, `takenLng`, `coordSource`, filtered to `type = photo, deletedAt IS NULL, capturedAt IS NOT NULL`, ordered by `[cameraMake, cameraModel, capturedAt]`) are loaded into memory **once**, up front. The entire walk (§4.2) computes results by reading only this in-memory array — it is never mutated, and no database write happens until the walk has finished computing every target's result. This guarantees that **an item auto-applied earlier in the same sweep can never become a "real" anchor for a later item processed later in that same sweep** — the anchor lookup for every target uses the pre-sweep snapshot state (`coordSource IN ('exif','manual')` at load time), not any coordinate this sweep itself is in the process of writing. This is the sweep's equivalent of the per-item path's `coordSource` `WHERE` filter (§3.3) — same rule, enforced structurally instead of by query, because the sweep's anchor lookup is an in-memory array scan rather than a fresh DB query per target.

**Why no date filter on the load itself:** the projection loads the *entire* circle regardless of the `from`/`to` range — only which *targets* get processed and written is restricted by `[from, to]` (§4.4). An anchor that happens to fall just outside the requested date range must still be available to anchor a target that falls inside it; filtering the load itself by date would silently drop valid anchors sitting right at the range boundary.

### 4.2 Two-pointer walk, grouped by device

Rows are already sorted by `(cameraMake, cameraModel, capturedAt)`, so adjacent same-device groups fall out of a single linear scan (`i`/`j` two-pointer group boundary detection in `sweepCircle`). For each contiguous same-device group with a non-null device, `walkGroup` runs a genuine two-pointer walk:

- A single backward pass precomputes, for every index, the nearest anchor at-or-after that index (`nextAnchorIdx`).
- A single forward pass tracks the nearest anchor at-or-before the current position (`lastAnchorIdx`), updated in a straight line as the scan advances.

This gives O(n) anchor lookup per device group rather than a per-target O(n) or O(log n) query, which is what makes a 10k-50k row sweep complete in seconds rather than minutes. Both the precomputed "before" and "after" anchor candidates are then checked against `maxGapMs`; if either exceeds it, that side is nulled out before calling the same `computeLocationSuggestion` function used by the per-item path.

Null-device rows are **not** walked in this device-grouped pass — matching two "unknown device" items as if they shared a camera would be unsound. If `requireSameDevice = false`, a **second pass** re-sorts the entire circle by `capturedAt` alone (ignoring device) and walks it the same way, but with `deviceMatchGuaranteed = false` — so every result from this second pass is suggestion-only (auto-apply is impossible per §3.6's first criterion) and only targets not already handled by pass 1 are considered (`targetNotHandled`).

### 4.3 Force semantics

`force = false` (default): a target is only computed if it doesn't already have **any** `LocationSuggestion` row (an id-set of every existing suggestion's `mediaItemId` in the circle is preloaded before the walk). This means `force: false` never revisits an item that was previously accepted, rejected, reverted, or already auto-applied/pending — it strictly fills gaps.

`force = true`: the existing-suggestion id-set is treated as empty, so every eligible GPS-less target in the range is recomputed regardless of prior state. This is where the **pending + rejected delete rationale** matters: because `LocationSuggestion.mediaItemId` is `@unique`, `createMany` would violate the unique constraint if a row already existed for a target being recomputed. The chunked write step (§4.4) therefore deletes stale rows before inserting: under `force: false` only `status = 'pending'` rows are ever cleared (since `force: false`'s target selection already excludes anything with an existing row, this delete is effectively a no-op safety net); under `force: true` it deletes **both** `pending` **and** `rejected` rows for the chunk's target IDs — `rejected` specifically, because forcing a recompute is an explicit admin instruction to re-evaluate everything, including items a human previously rejected, and the unique constraint would otherwise reject the new row outright. `accepted`, `auto_applied`, and `reverted` rows are never deleted by the sweep — those represent an already-resolved outcome (coordinates already written to the `MediaItem`, or a deliberate revert), and the target-selection logic (`isTargetBase`: `takenLat === null`) already excludes any item with real coordinates from being a target at all, so an `accepted`/`auto_applied` row's underlying item is naturally never re-selected.

### 4.4 Chunked writes

Results are written in chunks of 500 (`CHUNK_SIZE`), each inside its own `$transaction`:

1. `LocationSuggestion.deleteMany` — stale rows for this chunk's target IDs, scoped by status per §4.3.
2. `LocationSuggestion.createMany` — one row per target, `status` set to `auto_applied` or `pending` per whether `computed.autoApplyEligible`.
3. Per-auto-apply-item `MediaItem.update` (`takenLat`, `takenLng`, `coordSource = 'inferred'`) — done as individual `update` calls within the transaction, not a single `updateMany`, since each item's coordinates differ.
4. `AuditEvent.createMany` for the auto-applied subset only (`sweep: true` flag in `meta` distinguishes sweep-driven auto-applies from per-item ones in the audit log).

**Geocode jobs are enqueued strictly after each chunk's transaction commits, never inside it** — job-row creation is a separate table write, and if the transaction were to roll back after a geocode job had already been enqueued inside it, the job would be orphaned (referencing coordinates that were never actually written). Enqueuing after commit means a geocode job is only ever created for a coordinate write that definitely succeeded.

### 4.5 Per-circle in-flight guard

`LocationInferenceBackfillService.backfillAllCircles` performs an explicit `EnrichmentJob.findFirst` check (`type: 'location_inference', circleId, status IN (pending, running)`) before enqueueing a new sweep for a circle, skipping it if one is already in flight. This guard is **necessary specifically because sweep jobs use `skipDedup: true`** — the standard enrichment-queue dedup check for null-`mediaItemId` jobs only filters on `(type, mediaItemId IS NULL)`, which would otherwise collapse sweep jobs for *every different circle* into a single job (since they all share `mediaItemId: null` and the same `type`). `skipDedup: true` is required so multiple circles can each get their own sweep job; the backfill service's own per-circle guard is what prevents two concurrent sweeps of the *same* circle from racing on `LocationSuggestion` upserts.

### 4.6 Anchors-outside-range rule

Restated for clarity since it is easy to get backwards: the `[from, to]` range bounds **which targets are processed and written**, not which rows are loaded as potential anchors. An anchor whose `capturedAt` falls before `from` or after `to` is still fully eligible to anchor a target whose `capturedAt` falls inside `[from, to]` — §4.1's full-circle load exists specifically to make this possible.

---

## 5. Job Architecture and Throughput Expectations

### 5.1 One handler, two modes

`LocationInferenceHandler` (`type = 'location_inference'`) dispatches purely on `job.mediaItemId`:

| Job shape | Mode | Behavior |
|---|---|---|
| `mediaItemId` set | Per-item | `inferForItem(mediaItemId, forceRerun)`; `forceRerun = (job.reason === 'rerun')` |
| `mediaItemId` null, `circleId` set, `payload.mode = 'sweep'` | Sweep | `sweepCircle(circleId, { from, to, force })` read from `payload`; `circleId` is read from the **job row**, not the payload |

If a sweep job somehow has no `circleId`, the handler logs a warning and returns rather than throwing — there is nothing meaningful it can do without a circle to scope the query to.

### 5.2 Triggers and priorities

| Trigger | Reason | Priority | mediaItemId | Gate |
|---|---|---|---|---|
| Upload (photo) | `upload` | 10 | set | `features.locationInference` **and** `LOCATION_INFERENCE_ENABLED !== 'false'` |
| Per-item rerun (`POST /api/media/:id/infer-location`) | `rerun` | 0 (highest) | set | none beyond the endpoint's own auth |
| Auto-apply's own follow-on geocode (not a `location_inference` job — a `geocode` job) | `rerun` (per-item) / `backfill` (sweep) | 0 (per-item) / 100 (sweep) | set | — |
| Admin backfill (one sweep job per eligible circle) | `backfill` | 100 (lowest) | null | `features.locationInference` (400 if disabled); per-circle in-flight guard (§4.5) |

Upload-time enqueue lives in `MediaEnrichmentService.enqueueUploadEnrichment` alongside `auto_tagging`, `face_detection`, `burst_detection`, and `duplicate_detection` — the fifth and final block in that method as of this feature, gated by the same single cached `SystemSettingsService.getSettings()` read used by all five, and by the same env-kill-switch pattern (`LOCATION_INFERENCE_ENABLED`). Unlike `auto_tagging`/`face_detection`, location inference has **no per-item status upsert table** — it mirrors `burst_detection`/`duplicate_detection`'s pattern of "no status row, the outcome lives in the domain table itself" (here, the `LocationSuggestion` row, or the plain absence of one if no anchors were found at all).

### 5.3 Why the sweep is a single job, not chunked

This is the deliberate opposite design choice from duplicate detection's chunked batch backfill (`docs/specs/duplicate-detection.md` §6.2), and the reason is the underlying work's cost profile:

- The sweep is **pure DB read + in-memory computation + batched writes** — no image download, no ML inference, no external API call per item. A 10k-photo circle's entire projection is on the order of a few MB, and the two-pointer walk (§4.2) is linear in the number of rows.
- Duplicate detection's backfill is **compute-bound** (CLIP embedding ≈150-400ms/image plus download/decode, ≈1-2s/photo end-to-end) — chunking to 100 items/job exists there specifically to stay under the `ENRICHMENT_STUCK_MINUTES` ceiling (default 15 minutes; worst case ≈5 min/chunk).
- A location-inference sweep of even a 50k-photo circle is estimated at 1-3 minutes end-to-end (see the table below) — an order of magnitude under the stuck-reset threshold, so there is no scale at which chunking the sweep itself would currently be necessary. (If a future circle vastly exceeds 50k-100k+ photos, keyset-chunking the sweep's initial load is the documented escape hatch — not needed today; see §15.)

### 5.4 Throughput expectations

Defaults assumed: `ENRICHMENT_JOB_POLL_MS=5000`, `ENRICHMENT_WORKER_CONCURRENCY=1`, 2 vCPU host.

| Library size (per circle) | Sweep jobs enqueued | Approximate wall-clock time |
|---|---|---|
| 1 000 photos | 1 | **< 10 seconds** |
| 10 000 photos | 1 | **< 1 minute** |
| 50 000 photos | 1 | **~1–3 minutes** |

One sweep job per circle regardless of size — there is no chunk count to report, unlike duplicate detection's chunked backfill. Because each circle only ever gets one sweep job at a time (§4.5's in-flight guard), a library with many circles enqueues one job per eligible circle; the poll-floor concern that motivates duplicate detection's chunking (§5.3 above; also see `docs/specs/duplicate-detection.md` §6.2) essentially does not apply here, since even dozens of circles' worth of sweep jobs complete quickly relative to the 5-second poll tick.

### 5.5 Bulk accept/reject job types

**As of issue #190, the Location Suggestions bulk-accept/bulk-reject actions run on the shared `review_run_evaluate` / `review_run_execute_batch` job pair** — the two location-suggestion-specific job types originally added by issue #125 (`location_suggestion_run_evaluate` / `location_suggestion_run_execute_batch`) were absorbed into the generic pair used by all three review queues (bursts, duplicates, location suggestions). See [review-runs.md §5](review-runs.md#5-job-types) for the full job-type reference and [review-runs.md §6](review-runs.md#6-subject-strategy-split) for `LocationSuggestionReviewStrategy`, which carries forward the accept/reject transaction body and its deferred `geocode` enqueue unchanged from the original handler.

The two old type names still exist in the codebase as thin, deprecated shim handler classes — kept only so a job already enqueued under the old type at the moment of deploy still executes correctly — but nothing enqueues new jobs under them; every new bulk-accept/bulk-reject run enqueues `review_run_evaluate`/`review_run_execute_batch` directly. Both the current and the deprecated types remain **server-only** (no `nodeResultSchema`/`persistNodeResult` node pair) and auto-eligible for `ENRICHMENT_WORKER_MODE=system`. The chunking rationale from the original design is unchanged: unlike the sweep (§5.3), this pair chunks its execute step into 200-item batches — not because the per-item work is compute-bound (it is pure DB writes, same profile as the sweep), but to mirror the Empty Trash at Scale precedent (`docs/specs/archive-trash.md` §10) for progress-polling granularity, so a run with tens of thousands of matched suggestions reports incremental `processedCount` progress batch-by-batch rather than jumping from 0 to 100% on a single job's completion.

---

## 6. Data Model

### 6.1 `media_items.coord_source`

See §2. `TEXT?`, `'exif' | 'manual' | 'inferred'`, null = no coordinates.

### 6.2 New table: `location_suggestions`

One row per media item that has (or had) a candidate coordinate guess — `mediaItemId` is `@unique`, so there is never more than one live suggestion per item.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `mediaItemId` | UUID, unique | FK → `media_items` (cascade delete) |
| `circleId` | UUID | FK → `circles` (cascade delete) |
| `lat`, `lng` | Float | |
| `confidence` | Float | §3.5 formula output |
| `method` | String | `'interpolated'` \| `'nearest'` |
| `anchorBeforeId`, `anchorAfterId` | UUID? | **No database-level FK constraint** — deliberately, mirroring the `media_visual_embedding.circleId` "denormalized, no FK" precedent from duplicate detection, so deleting the referenced anchor media item never blocks or cascades against a pending suggestion row |
| `gapBeforeSeconds`, `gapAfterSeconds` | Int? | |
| `anchorDistanceKm` | Float? | null for the single-anchor (extrapolation) case |
| `impliedSpeedKmh` | Float? | null for the single-anchor case |
| `status` | `LocationSuggestionStatus` | `pending` \| `accepted` \| `rejected` \| `auto_applied` \| `reverted` |
| `resolvedById` | UUID? | FK → `users` (SetNull) |
| `resolvedAt` | DateTime? | |
| `createdAt` / `updatedAt` | DateTime | |

Index: `@@index([circleId, status])`.

**Auto-applied inferences also write a row** (`status = 'auto_applied'`) rather than skipping suggestion-row creation — this is what makes an auto-apply revertible and auditable through the same table as every other outcome, instead of needing a separate audit mechanism.

### 6.3 Composite device-timeline index

Raw SQL only (not representable in the Prisma schema DSL — a partial index with a `WHERE` clause), added in the same migration:

```sql
CREATE INDEX idx_media_circle_device_captured
  ON media_items (circle_id, camera_make, camera_model, captured_at)
  WHERE deleted_at IS NULL;
```

Serves three purposes simultaneously: the sweep's initial ordered load (§4.1), the per-item path's anchor-before/anchor-after queries (§3.3), and incidentally overlaps with (but does not replace) the burst-detection neighbor query's own indexing needs.

### 6.4 Global feature setting

`features.locationInference` (Boolean, default `false`) in the `system_settings` JSONB — read via `SystemSettingsService.isFeatureEnabled(FEATURE_KEYS.LOCATION_INFERENCE)`.

### 6.5 Run tables: absorbed into `review_runs` / `review_run_items` (issue #190)

Issue #125 originally added dedicated `location_suggestion_runs` / `location_suggestion_run_items` tables (migration `20260725000000_location_suggestion_runs`) for the bulk accept/reject run architecture. **Issue #190 folded both tables into the shared `review_runs` / `review_run_items` model** used by all three review queues (bursts, duplicates, location suggestions) and dropped the two location-suggestion-specific tables along with their three enums (`LocationSuggestionRunAction`, `LocationSuggestionRunStatus`, `LocationSuggestionRunItemStatus`). Run UUIDs were preserved during the migration, so every previously-issued `/api/location-suggestion-runs/:id` link still resolves via a deprecated alias controller.

The full shared schema — `review_runs`, the exclusive-arc `review_run_items` (with its `locationSuggestionId` column and matching CHECK constraints), the integrity guarantees, and the migration's data-copy mechanics — is documented in **[review-runs.md §3](review-runs.md#3-data-model)** and **[review-runs.md §11](review-runs.md#11-migration-from-location_suggestion_runs)**. What carried forward unchanged for this feature specifically: a location-suggestion run item's `status` still passes through the same `matched → processing → applied|failed|skipped` states, and `processing` still exists as the crash-safe claim marker it always was — accept/reject never deletes the underlying `LocationSuggestion` row the way a trash-empty purge deletes its `MediaItem`, so the row stays in place through to a terminal status rather than doubling deletion as the claim signal.

---

## 7. Settings Reference

### 7.1 System Settings (Admin-Editable, under `locationInference.*`)

| Setting key | Type | Range | Default | Description |
|---|---|---|---|---|
| `features.locationInference` | boolean | — | `false` | Global on/off for the entire feature (upload-time per-item enqueue + admin sweep backfill both gated on this) |
| `locationInference.maxGapMinutes` | integer | 1–1440 | `30` | Maximum time gap (either side) for a two-anchor interpolation window |
| `locationInference.maxExtrapolationGapMinutes` | integer | 1–240 | `10` | Maximum time gap for the single-anchor (extrapolation) case — the ExifTool `GeoMaxExtSecs` analog; tighter than `maxGapMinutes` by design |
| `locationInference.autoApplyMaxGapMinutes` | integer | 0–60 | `5` | Maximum gap (both sides) for auto-apply eligibility; `0` disables auto-apply entirely while suggestions still generate |
| `locationInference.requireSameDevice` | boolean | — | `true` | When `true`, anchors must share the target's `cameraMake`/`cameraModel`, and auto-apply is possible; when `false`, cross-device anchors are allowed but the result is always suggestion-only |
| `locationInference.maxAnchorDistanceKm` | number | 0.1–100 | `2` | Maximum distance between two anchors for them to be considered "agreeing" (interpolation vs. nearer-in-time fallback, and an auto-apply gate) |
| `locationInference.maxImpliedSpeedKmh` | number | 10–1000 | `150` | Ceiling on the implied travel speed between anchors; exceeding it caps confidence at `0.4` and blocks auto-apply |
| `locationInference.bulkAcceptThreshold` | integer | 0–100 | `80` | Confidence floor, as a percent, for the review page's bulk actions (issue #126): "Accept all ≥ N%" starts an async run (§9) accepting every `pending` suggestion with `confidence >= N/100`; "Reject all < N%" starts an async run rejecting every `pending` suggestion with `confidence < N/100`. One setting, one number, partitions the pending queue for both buttons — there is no separate reject-side threshold |

All seven are validated by the shared Zod schema in `apps/api/src/settings/dto/update-system-settings.dto.ts` and round-tripped through `PATCH`/`PUT /api/system-settings` like every other setting group.

### 7.2 Environment Variable

| Variable | Default | Description |
|---|---|---|
| `LOCATION_INFERENCE_ENABLED` | `true` | Environment kill-switch. Set to `false` to disable upload-time `location_inference` enqueue regardless of `features.locationInference`. The system setting is the runtime toggle; this env var is a hard override for CI/test environments — same pattern as `DUPLICATE_DETECTION_ENABLED`, `BURST_DETECTION_ENABLED`, `AUTO_TAG_ENABLED`, `FACE_AUTO_DETECT`. |

The shared enrichment worker variables (`ENRICHMENT_WORKER_ENABLED`, `ENRICHMENT_JOB_POLL_MS`, `ENRICHMENT_WORKER_CONCURRENCY`) govern the same queue that runs both per-item and sweep `location_inference` jobs alongside every other enrichment type — see [enrichment-queue.md](enrichment-queue.md).

---

## 8. API Endpoints

All endpoints require JWT Bearer authentication. No new system-level RBAC permission scopes were introduced — review-queue endpoints reuse `media:read`/`media:write`; the admin backfill endpoint reuses `system_settings:write`, exactly like duplicate detection and burst detection.

### 8.1 `GET /api/media/location-suggestions`

List location suggestions (review queue) for a circle.

- **Auth:** `media:read` + per-circle `viewer` role.
- **Query params:** `circleId` (required, UUID), `status` (`pending`\|`accepted`\|`rejected`\|`auto_applied`\|`reverted`, **default `pending`**), `page` (default 1), `pageSize` (default 20, max 100), `mediaItemId` (optional UUID — filters the list down to the suggestion for one specific media item, e.g. to check whether an item currently has a live suggestion from the media properties pane), `sortBy` (`createdAt` default \| `confidence`), `sortOrder` (`desc` default \| `asc`).
- **Response `200`:**
  ```json
  {
    "items": [
      {
        "id": "uuid",
        "mediaItemId": "uuid",
        "status": "pending",
        "lat": 9.9333,
        "lng": -84.0833,
        "confidence": 0.87,
        "method": "interpolated",
        "anchorBeforeId": "uuid",
        "anchorAfterId": "uuid",
        "gapBeforeSeconds": 180,
        "gapAfterSeconds": 240,
        "anchorDistanceKm": 0.4,
        "impliedSpeedKmh": 5.7,
        "capturedAt": "2026-06-15T14:32:01.234Z",
        "cameraMake": "Apple",
        "cameraModel": "iPhone 14",
        "thumbnailUrl": "https://..."
      }
    ],
    "meta": { "total": 12, "page": 1, "pageSize": 20 }
  }
  ```
  Ordered by `createdAt DESC, id DESC` by default; `sortBy=confidence` overrides the primary key with a trailing `createdAt DESC, id DESC` tiebreaker instead. Both `confidence` and `createdAt` are non-null columns on `LocationSuggestion`, so — unlike the burst/duplicate review queues (`docs/specs/burst-detection.md` §7.1, `docs/specs/duplicate-detection.md` §9.1) — there is no nulls-last rule to apply here; a plain-direction Prisma `orderBy` suffices and the `{ sort, nulls }` object form is not used.

### 8.2 `POST /api/media/location-suggestions/:id/accept`

Accept a pending suggestion, optionally adjusting the coordinates.

- **Auth:** `media:write` + per-circle `collaborator` role.
- **Request body:** `{ "lat"?: number, "lng"?: number }` (both optional, `-90..90` / `-180..180`). Omit both to accept the suggestion's own coordinates unmodified.
- **Behavior:** unmodified (no override, or an override equal to the stored `lat`/`lng`) → `coordSource = 'inferred'`; adjusted → `coordSource = 'manual'`. Both cases write coordinates plus a **synchronous** reverse-geocode via the shared `applyLocation()` helper (§2), and mark the suggestion `status = 'accepted'` with `resolvedById`/`resolvedAt`.
- **Response `200`:** `{ "data": { "id", "status": "accepted", "lat", "lng", "coordSource" } }`.
- **Response `400`:** suggestion is not `pending`.
- **Response `404`:** suggestion not found.
- Writes an `audit_events` row (`location_suggestion:accepted`).

### 8.3 `POST /api/media/location-suggestions/:id/reject`

- **Auth:** `media:write` + per-circle `collaborator` role.
- **Response `200`:** `{ "data": { "id", "status": "rejected" } }`.
- **Response `400`:** suggestion is not `pending`.
- **Response `404`:** suggestion not found.
- Writes an `audit_events` row (`location_suggestion:rejected`). A rejected suggestion is sticky against future non-forced per-item recomputes (§3.7).

### 8.4 `POST /api/media/location-suggestions/:id/revert`

Undo an auto-applied inference.

- **Auth:** `media:write` + per-circle `collaborator` role.
- **Behavior:** clears `takenLat`/`takenLng`/geo columns/`coordSource` via `GEO_CLEAR_COLUMNS` (§2), sets suggestion `status = 'reverted'`.
- **Response `200`:** `{ "data": { "id", "status": "reverted" } }`.
- **Response `400`:** suggestion is not `auto_applied` (only auto-applied inferences can be reverted through this endpoint — an accepted suggestion's coordinates are considered a deliberate human confirmation, not something to "revert").
- **Response `404`:** suggestion not found.
- Writes an `audit_events` row (`location_suggestion:reverted`).

### 8.5 `POST /api/media/location-suggestions/bulk-accept`

**Rewritten by issue #125; runs on the shared review-run engine as of issue #190.** Starts an **asynchronous run** (§9, and [review-runs.md](review-runs.md) for the shared architecture) that accepts every `pending` suggestion in a circle at or above a confidence floor — no longer a single synchronous request that iterates and applies suggestions in-line.

- **Auth:** `media:write` + per-circle `collaborator` role.
- **Request body:** `{ "circleId": "uuid", "threshold": number (0-100 integer) }`. Note the scale change from the old `minConfidence` (0–1 float) to `threshold` (0–100 integer, matching `burst.autoResolveThreshold`/`dedup.autoResolveThreshold`'s convention) — the run service converts it to a `0-1` confidence floor (`threshold / 100`) at evaluation time.
- **Behavior:** creates a `ReviewRun` (`subjectType = 'location_suggestion'`, `action = 'accept'`) and enqueues a `review_run_evaluate` job; returns immediately without waiting for evaluation or execution. Every accepted suggestion is applied **unmodified** (no per-item lat/lng override is possible in bulk), so every accepted item gets `coordSource = 'inferred'`, and a `geocode` job is enqueued per item (deferred, not synchronous — §13).
- **Response `200`:** `{ "data": { "runId": "uuid", "status": "evaluating", "matchedCount": 0 } }` — `matchedCount` is always `0` at creation; poll `GET /api/review-runs/:id` (§8.7) for the real total once evaluation completes.
- **Response `409`:** a `location_suggestion` review run is already `evaluating` or `running` for this circle ([review-runs.md §8](review-runs.md#8-concurrency-guard)).
- Writes an `audit_events` row (`review_run:started`) with the circle, subject type, action, and threshold.

### 8.6 `POST /api/media/location-suggestions/bulk-reject`

New in issue #125; runs on the shared review-run engine as of issue #190 — the mirror-image bulk action: starts an asynchronous run that rejects every `pending` suggestion **below** a confidence floor (the low-confidence noise a reviewer wants to clear in bulk without touching anything above the line).

- **Auth:** `media:write` + per-circle `collaborator` role.
- **Request body:** `{ "circleId": "uuid", "threshold": number (0-100 integer) }` — identical shape to bulk-accept.
- **Behavior:** creates a `ReviewRun` (`subjectType = 'location_suggestion'`, `action = 'reject'`) and enqueues a `review_run_evaluate` job with the same evaluate/execute-batch machinery as bulk-accept, but the confidence filter and per-item outcome are inverted: matches `pending` suggestions with `confidence < threshold / 100`, and each matched suggestion is simply marked `rejected` — no coordinate write, no `geocode` job.
- **Response `200`:** `{ "data": { "runId": "uuid", "status": "evaluating", "matchedCount": 0 } }`.
- **Response `409`:** a run is already in progress for this circle — same per-circle guard as bulk-accept; accept and reject runs for the same circle cannot run concurrently, since both count against the same `(circleId, subjectType, status)` in-flight check.
- Writes an `audit_events` row (`review_run:started`).

### 8.7 `GET /api/review-runs/:id` (deprecated alias: `GET /api/location-suggestion-runs/:id`)

Run detail: counters plus a live per-status item tally. Full response shape and semantics in [review-runs.md §12.2](review-runs.md#122-inspecting-and-cancelling-a-run). The `/api/location-suggestion-runs/:id` path still works — it is a deprecated alias controller that delegates straight into the same service, kept so links issued before issue #190 keep resolving (§9.2) — but new integrations should call `/api/review-runs/:id` directly.

- **Auth:** `media:read` + per-circle `viewer` role.
- **Response `200`:** `{ "id", "circleId", "subjectType", "action", "threshold", "status", "matchedCount", "processedCount", "succeededCount", "failedCount", "skippedCount", "startedById", "createdAt", "updatedAt", "startedAt", "finishedAt", "lastError", "itemStatusCounts": { "matched"?: n, "processing"?: n, "applied"?: n, "failed"?: n, "skipped"?: n } }`.
- **Response `404`:** run not found.

### 8.8 `GET /api/review-runs/:id/items` (deprecated alias: `GET /api/location-suggestion-runs/:id/items`)

Paginated run items with batched signed thumbnails. See [review-runs.md §12.2](review-runs.md#122-inspecting-and-cancelling-a-run).

- **Auth:** `media:read` + per-circle `viewer` role.
- **Query params:** `status` (`matched`\|`processing`\|`applied`\|`failed`\|`skipped`, optional), `page` (default 1), `pageSize` (default 50, max 100).
- **Response `200`:** `{ "items": [{ "id", "subjectId", "subjectType", "status", "error", "updatedAt", "media": { "type", "capturedAt", "filename", "width", "height" } | null, "thumbnailUrl": string | null }], "meta": { "page", "pageSize", "totalItems", "totalPages" } }`. `subjectId` is the item's `locationSuggestionId` for this queue, flattened out of the shared model's exclusive-arc column set — the response no longer names it `suggestionId`/`mediaItemId`/`lat`/`lng`/`confidence` directly the way the pre-#190 endpoint did; those per-suggestion fields are not part of the generic shape.

### 8.9 `POST /api/review-runs/:id/cancel` (deprecated alias: `POST /api/location-suggestion-runs/:id/cancel`)

Cancel a non-terminal run. See [review-runs.md §9](review-runs.md#9-cancellation-semantics) for the cooperative-cancellation semantics.

- **Auth:** `media:write` + per-circle `collaborator` role.
- **Response `200`:** `{ "runId": "uuid", "status": "cancelled" }`.
- **Response `400`:** run has already reached a terminal status.
- **Response `404`:** run not found.
- Writes an `audit_events` row (`review_run:cancelled`).

### 8.10 `POST /api/media/:id/infer-location`

Force a fresh per-item inference rerun, bypassing the rejected-suggestion skip rule.

- **Auth:** `media:write` + per-circle `collaborator` role (checked via `CircleMembershipService.assertCircleAccess`, performed before any other logic — mirrors the fix applied to the duplicate-detection rerun endpoint after it originally missed this check).
- **Response `201`:** `{ "data": { "jobId": "uuid", "status": "pending" } }`.
- **Response `400`:** item is not a photo.
- **Response `404`:** item not found or soft-deleted.
- Enqueues a `location_inference` job at priority 0 with `reason: 'rerun'`.

### 8.11 `POST /api/admin/location-inference/backfill`

Bulk-enqueue one sweep job per eligible circle, across **all circles**.

- **Auth:** Admin role + `system_settings:write`.
- **Requirement:** `features.locationInference` must be `true`; otherwise `400`.
- **Request body:** `{ "from"?: "ISO-8601", "to"?: "ISO-8601", "force"?: false }`. `from`/`to` bound which targets get processed (not which rows are loaded as anchors — §4.6). `force: true` re-evaluates every eligible item including previously-rejected ones (§4.3).
- **Response `201`:** `{ "data": { "enqueued": number, "circles": number, "estimatedItems": number } }` — `enqueued` = sweep jobs actually created (can be lower than `circles` if a circle already had a sweep pending/running, per §4.5's guard), `circles` = number of circles that had at least one eligible GPS-less item, `estimatedItems` = total eligible item count across those circles (computed for free via the same `groupBy` used to enumerate circles).

### 8.12 Circle Dashboard

`GET /api/media/dashboard?circleId=` returns a `pendingLocationSuggestions` count (`LocationSuggestionStatus.pending`, circle-scoped), alongside the existing `pendingBurstGroups` and `pendingDuplicateGroups` counts.

---

## 9. Bulk Accept/Reject at Scale

### 9.1 Why this changed (issue #125), and what changed again (issue #190)

The original `bulk-accept` endpoint (§8.5 as originally written) was a single synchronous request: it loaded every matching `pending` suggestion and accepted them one at a time in-request, each accept performing its own synchronous reverse-geocode call via `applyLocation()`. That is fine for a handful of suggestions but does not scale — a circle with a large backlog of pending suggestions (e.g. right after a bulk import with `features.locationInference` newly turned on) could see the request hold open for a long time, with no progress feedback and no way to cancel mid-flight. This is the same failure mode Empty Trash at Scale (issue #165) fixed for the "Empty trash" button — see `docs/specs/archive-trash.md` §10.1.

Issue #125's fix rebuilt bulk-accept — and added its mirror-image, bulk-reject — on the same **run-record + chunked-job + progress-polling** pattern already proven by Media Workflow Automation's `workflow_runs`/`workflow_run_items` (`docs/specs/workflows.md`) and Empty Trash at Scale's `trash_empty_runs`/`trash_empty_run_items` (`docs/specs/archive-trash.md` §10), backed by feature-specific `location_suggestion_runs`/`location_suggestion_run_items` tables and `location_suggestion_run_evaluate`/`location_suggestion_run_execute_batch` job types.

**Issue #190 then generalized that exact pattern into a model shared by all three review queues** (bursts, duplicates, location suggestions) — see [review-runs.md](review-runs.md) for the full shared architecture, including the data model, integrity constraints, job types, lifecycle state machine, and the migration that folded `location_suggestion_runs`/`location_suggestion_run_items` into the new `review_runs`/`review_run_items` tables with run UUIDs preserved. This section now documents only what remains genuinely specific to this feature.

### 9.2 What stayed location-specific

Location suggestions are the one review queue with no `resolve_archive`/`resolve_trash`/`dismiss` action set — only `accept` and `reject` (§8.5/§8.6), and `LocationSuggestion.confidence` is the one **non-nullable** confidence column among the three subjects (burst/duplicate group confidence are both nullable), so — unlike bursts and duplicates — there is no null-confidence exclusion branch in `LocationSuggestionReviewStrategy.evaluatePage`; every `pending` row participates in the threshold filter.

`LocationSuggestionReviewStrategy.executeItem` (see [review-runs.md §6](review-runs.md#6-subject-strategy-split)) carries forward the accept/reject transaction body unchanged from the original `location_suggestion_run_execute_batch` handler: if the suggestion is no longer `pending` by the time its batch runs (resolved individually since evaluation), the run-item is marked `skipped` without touching the suggestion; otherwise **accept** writes `takenLat`/`takenLng` + `coordSource='inferred'` on the `MediaItem` and marks the suggestion `accepted`, while **reject** marks the suggestion `rejected` with no coordinate write — both inside one `$transaction`. The strategy's `deferredEffects` enqueues one dedup-safe `geocode` job (priority 100, `reason: 'backfill'`) per accepted item, **after** every transaction in the batch has committed — never inside the accept transaction itself, for the same reason the sweep defers its geocode enqueue past each write transaction (§4.4): a rolled-back coordinate write must never leave an orphaned geocode job referencing coordinates that don't exist. A reject enqueues nothing.

The per-circle concurrency guard (§9.4 in [review-runs.md §8](review-runs.md#8-concurrency-guard)) is scoped per `(circleId, subjectType)`, so — as before — an accept run and a reject run for the same circle still cannot be in flight simultaneously (both are `subjectType = 'location_suggestion'`), the same way two concurrent empty-trash runs for one circle cannot; a reviewer who fires off "Accept all ≥ 80%" and then immediately clicks "Reject all < 80%" before the first run finishes gets a clear `409` rather than two runs quietly fighting over the same pending queue.

### 9.3 Frontend — progress page

Starting a run from the Location Suggestions page (`LocationSuggestionsPage.tsx`) navigates to `/review-runs/:runId` — the shared `ReviewRunPage` described in [review-runs.md §14](review-runs.md#14-frontend) — rather than the feature-specific `LocationSuggestionRunPage.tsx` it used to. The old `/location-suggestion-runs/:runId` route still works: it now renders a redirect component (`LocationSuggestionRunRedirect`) that immediately navigates to `/review-runs/:runId`. `ReviewRunPage` reads `subjectType` off the run to label counts and copy appropriately for accept/reject (e.g. "Applied"/"Rejected" tile labels), and links failed items back to the Location Suggestions page.

### 9.4 Failure handling

Failure handling is identical to every other subject on the shared engine — see [review-runs.md §7](review-runs.md#7-run-lifecycle-state-machine) for the evaluate-retry-then-terminal-fail and the claim/read-back-work-set-on-retry mechanics that make a crashed `review_run_execute_batch` job safe to retry mid-batch.

---

## 10. RBAC

| Endpoint | Permission | Per-circle role | Notes |
|---|---|---|---|
| `GET /api/media/location-suggestions` | `media:read` | `viewer` | |
| `POST /api/media/location-suggestions/:id/accept` | `media:write` | `collaborator` | |
| `POST /api/media/location-suggestions/:id/reject` | `media:write` | `collaborator` | |
| `POST /api/media/location-suggestions/:id/revert` | `media:write` | `collaborator` | |
| `POST /api/media/location-suggestions/bulk-accept` | `media:write` | `collaborator` | Starts an async review run (§9); no longer a synchronous bulk apply |
| `POST /api/media/location-suggestions/bulk-reject` | `media:write` | `collaborator` | New in issue #125; starts an async review run (§9) |
| `GET /api/review-runs/:id` (alias: `GET /api/location-suggestion-runs/:id`) | `media:read` | `viewer` | Shared review-run API — see [review-runs.md §13](review-runs.md#13-rbac) |
| `GET /api/review-runs/:id/items` (alias: `GET /api/location-suggestion-runs/:id/items`) | `media:read` | `viewer` | |
| `POST /api/review-runs/:id/cancel` (alias: `POST /api/location-suggestion-runs/:id/cancel`) | `media:write` | `collaborator` | |
| `POST /api/media/:id/infer-location` | `media:write` | `collaborator` | |
| `POST /api/admin/location-inference/backfill` | `system_settings:write` | — (Admin, app-wide) | 400 if feature disabled |

No new permission scopes were introduced — all endpoints reuse `media:read`/`media:write`/`system_settings:write`, consistent with burst detection and duplicate detection.

---

## 11. Review UI

`LocationSuggestionsPage` (`apps/web/src/pages/LocationSuggestions/LocationSuggestionsPage.tsx`), reachable at `/location-suggestions`, lists pending suggestions for the active circle as a stack of cards, each showing:

- A thumbnail, `capturedAt`, a color-coded confidence `Chip` (green ≥80%, amber ≥50%, default below that), and a `method` chip (`Interpolated` / `Nearest anchor`).
- Camera make/model when present.
- A plain-language anchor summary (e.g. "Interpolated between 2 nearby photos (3.0 min before, 4.0 min after) · anchors 0.40 km apart", or "Estimated from a single nearby photo (2.0 min before)" for the extrapolation case).
- An inline speed warning (only rendered when `impliedSpeedKmh >= 60`, a UI-only display threshold distinct from the backend's `maxImpliedSpeedKmh` gate): "Anchors imply ~X km/h — subject may have been traveling."
- A small `LocationMiniMap` preview at the suggested coordinates.
- Three actions: **Confirm** (accept unmodified), **Adjust** (opens `AdjustLocationDialog`, which reuses the `LocationPickerMap`/reverse-geocode-preview pattern from `BulkLocationDialog`, seeded at the suggested coordinates, and calls accept with the adjusted lat/lng), and **Reject**.

**Header controls (rebuilt for issue #125/#126):** an admin-only gear icon (`isAdmin`-gated, `SettingsIcon`, links to `/admin/settings/location-inference`) sits next to the page title. Alongside it, a `ReviewSortSelect` control (shared with the Bursts and Duplicates pages, §8.1 of this doc for the underlying `sortBy`/`sortOrder` params) offers Newest/Oldest first (`createdAt`) and Confidence highest/lowest. As on the other two review pages, the selection is mirrored into the URL query string, an unrecognized URL value falls back to the page default (`createdAt`/`desc`) rather than reaching the API, changing it resets to page 1, and only a non-default selection is sent on the wire. Also alongside it, an inline **"Threshold %"** number field lets any reviewer adjust the confidence cutoff on the fly for this session without leaving the page — it initializes from the persisted `locationInference.bulkAcceptThreshold` system setting (§7.1, default 80) and is clamped `0–100` client-side, but changing it here does **not** write back to the system setting; it only affects the two buttons' behavior for the current page view. Those two buttons read the live threshold value directly in their labels — **"Accept all ≥ N%"** and **"Reject all < N%"** — both disabled while `items.length === 0` or a run is already being started. Clicking either opens a confirmation dialog; on confirm, the page calls `POST /api/media/location-suggestions/bulk-accept` or `bulk-reject` (§8.5/§8.6) with `{ circleId, threshold: thresholdPct }` and, on success, **navigates immediately** to `/review-runs/:runId` (§9.3, formerly `/location-suggestion-runs/:runId`) rather than waiting in place — the old synchronous flow's "stay on this page and watch a spinner" UX no longer applies since the request itself returns before any suggestion has actually been processed.

Elsewhere in the app:

- `MediaDetailDrawer` shows a "Location (inferred)" provenance indicator with a **Revert** action when `coordSource === 'inferred'`, and a **"Suggest location"** button (enqueue + poll) when the item has no coordinates at all.
- `Sidebar` has a "Location Suggestions" nav entry; `HomePage` shows a review-queue banner driven by `pendingLocationSuggestions`.
- `pages/Admin/LocationInferenceSettingsPage.tsx` exposes the global toggle, all six original `locationInference.*` algorithm parameters (with helper text explaining `requireSameDevice`'s WhatsApp/no-EXIF consequence, what `autoApplyMaxGapMinutes: 0` means, and the speed-gate rationale), a `Slider`-based control for `locationInference.bulkAcceptThreshold` (0–100, default 80, labeled "Bulk-accept confidence threshold" with helper text explaining it seeds both the review page's "Accept all ≥ N%" and "Reject all < N%" default), and a backfill panel with `from`/`to` date pickers and a `force` checkbox, mirroring `TaggingSettingsPage`.
- `ReviewRunPage.tsx` (`/review-runs/:runId`) — the shared progress-polling page a bulk-accept/bulk-reject run navigates to (§9.3); `LocationSuggestionRunPage.tsx` was deleted, and `/location-suggestion-runs/:runId` now redirects here via `LocationSuggestionRunRedirect`. See [review-runs.md §14](review-runs.md#14-frontend) for the shared component's full behavior.

---

## 12. Algorithm Positioning — Verified Against the Field

Researched (July 2026) against every notable prior-art implementation for GPS-from-timeline inference, to answer "is this approach actually good, or just plausible-sounding":

- **ExifTool `-geotag` / gpscorrelate / Lightroom / digiKam** (the industry-standard GPX-track correlation approach): linear interpolation between the two nearest track points, with separate maximum-gap limits for interpolation (`GeoMaxIntSecs`) versus extrapolation (`GeoMaxExtSecs`). This feature is the same algorithm class — using the circle's own GPS-bearing sibling photos as the "track" instead of an external GPX file — and directly adopts the interpolation/extrapolation split as `maxGapMinutes` vs. `maxExtrapolationGapMinutes` (§3.4, §7.1). Sources: exiftool.org's `-geotag` documentation; dfandrich.github.io/gpscorrelate.
- **PhotoPrism "estimated places"** — the closest self-hosted precedent (per photoprism community discussions #2212 and #3142): assigns GPS from *any* photo taken the same calendar day (a 24-hour window), with no device matching, no confidence score, and no review queue, and by its own community's admission produces wrong results whenever the user travels within a day. This feature is strictly more conservative on every axis: minute-scale time windows (not day-scale), same-device gating by default, an explicit anchor-disagreement distance cap, an implied-speed sanity gate, and a confidence-tiered split between silent auto-apply and a human review queue — plus full provenance and revertibility, none of which PhotoPrism's feature has.
- **Immich** — has no location-inference feature at all; an open feature request (immich Discussion #1675) has remained unimplemented as of this writing.
- **Google Photos** — historically used Location History plus landmark recognition; per 9to5google's reporting, since December 2022 it relies on landmark recognition (server-side ML against a reference landmark database) only, a signal class that is fundamentally unavailable to a privacy-first, self-hosted application by design (it requires either cloud ML inference or a large landmark reference dataset). Landmark-style matching using this app's existing CLIP visual embeddings (`docs/specs/duplicate-detection.md`) against a curated reference set is a plausible v3 direction; general ML scene-geolocation (GeoCLIP-style planet-scale coordinate regression) remains an explicit non-goal — it is meaningfully less accurate than timeline correlation at the street/neighborhood level the interpolation approach achieves, and too heavy computationally for a 2-4 vCPU self-hosted target.
- Beyond all of the above, this feature additionally contributes: the implied-speed sanity gate (§3.6), the never-chain-from-inferred drift-prevention rule (§3.3), a full per-inference audit trail with single-click revert, and every threshold being admin-tunable at runtime rather than hardcoded. Cross-device corroboration (using a *different* device's GPS-tagged photos to anchor a device that itself never has GPS) is explicit v2 scope (§13).

---

## 13. Known Limitations and Non-Goals

### v1 non-goals

- **Debounced sweep-on-new-anchor.** Uploading a single new GPS-tagged photo does **not** trigger a circle-wide sweep. The reasoning: sibling GPS-less photos from the same shoot typically upload in the same session and each already gets its own per-item `location_inference` job at upload time, which will find the newly-uploaded anchor on its own. Triggering a full sweep on every single GPS upload would risk "sweep storms" during bulk imports (hundreds of GPS photos uploading in quick succession, each independently triggering a redundant full-circle sweep), and there is no existing debounce/coalescing primitive in the codebase to build this safely today. A debounced version (wait N seconds after the last GPS upload in a circle, then sweep once) is explicit v2 scope.
- **Cross-device corroboration.** A device that itself never records GPS (e.g. an older camera with no GPS chip) cannot currently be anchored using a *different* device's coordinates even when `requireSameDevice = false` allows cross-device suggestions — the algorithm's anchor-agreement and confidence math were designed and tuned around same-device physical plausibility (a phone can't teleport, so two same-device timestamps close together imply nearby locations); reasoning about cross-device corroboration robustly (e.g. "my phone and my partner's camera were both clearly at the same event") is a distinct, more speculative problem left for v2.

### Known limitation: follow-on geocode cost

Auto-applied inferences (both per-item and sweep-driven) write coordinates **immediately** but only *enqueue* a `geocode` enrichment job to fill in place-name columns (`geoCountry`, `geoLocality`, etc.) — they do not call the geocode provider synchronously. This means an auto-applied item shows correct coordinates on a map right away, but **its place name may not appear until the `geocode` job drains off the shared enrichment queue** at whatever pace the queue and the active reverse-geocoding provider (`offline`/`nominatim`/`google`) allow — potentially hours for a large sweep, since these geocode jobs are enqueued at priority 100 (sweep) or 0 (per-item auto-apply's own follow-on) and compete with every other job type on the same worker. This is a pre-existing behavior class shared by every other feature that writes coordinates and defers geocoding (e.g. the existing app-wide geocode backfill, `docs/specs/geocoding.md`) — not something new introduced by this feature, but worth calling out explicitly here since a reviewer staring at an auto-applied suggestion with a blank place name might otherwise assume something is broken.

Note the one exception: the single-item **`accept`** endpoint performs a **synchronous** reverse-geocode via `applyLocation()` (§2) rather than deferring — because it is an interactive, single-request human action where waiting for one geocode call is acceptable UX, unlike a sweep processing thousands of items. As of issue #125 (§9), the bulk `bulk-accept`/`bulk-reject` path no longer takes this synchronous branch either way: it runs asynchronously through the run engine and enqueues a standard `geocode` job per accepted item, same deferred-geocode profile as the sweep.

---

## 14. Testing Notes

Unit test coverage lives alongside each module:

- `location-inference.service.spec.ts` — the pure `computeLocationSuggestion`/`haversineKm`/`interpolateLng` functions: anchor selection (before/after/both/none), interpolation math, the antimeridian wrap, the disagreement fallback, the confidence formula (including the zero-gap speed guard), the auto-apply gate matrix (device-match requirement, gap ceilings, agreement, speed), and the sweep's `walkGroup` two-pointer logic (device grouping, snapshot-no-chaining invariant).
- `location-inference.handler.spec.ts` — dispatch on `mediaItemId` presence, `forceRerun` derivation from `job.reason`, the no-`circleId` warn-and-return path.
- `location-inference-backfill.service.spec.ts` — circle enumeration via `groupBy`, the per-circle in-flight guard, `estimatedItems`/`enqueued`/`circles` accounting.
- `location-suggestion.service.spec.ts` — accept (unmodified vs. adjusted → `coordSource`), reject, revert (status-gating to `auto_applied` only), the per-circle collaborator check on the rerun path, and `listSuggestions`'s `sortBy`/`sortOrder` handling (`confidence` vs. the default `createdAt`, both directions, and the trailing `id` tiebreaker). The former synchronous `bulkAcceptSuggestions` test block was removed when that method was replaced by the async run-based engine (§9) — bulk accept/reject coverage now lives in the three specs below.
- `admin-location-inference.controller.spec.ts` — the 400-when-disabled branch and successful backfill delegation.

As of issue #190, the run engine itself (`createRun`, the concurrency guard, evaluate/execute-batch, cancel) is generic and tested once, alongside the other two review queues, under `apps/api/src/review-runs/` rather than per-feature here — see `review-run.service.spec.ts`, `review-run-evaluate.handler.spec.ts`, `review-run-execute-batch.handler.spec.ts`, and `strategies/location-suggestion.strategy.spec.ts` (the location-specific accept/reject transaction and its deferred `geocode` enqueue). The location-suggestion-specific `runs/location-suggestion-run*.spec.ts` files this section used to reference no longer exist; the deprecated shim handlers (`runs/location-suggestion-run-evaluate.handler.ts`, `runs/location-suggestion-run-execute-batch.handler.ts`) are thin enough (pure delegation) that they are not separately unit-tested.

### End-to-end manual verification (per `/verify`)

1. Enable `features.locationInference` in Admin Settings.
2. Upload a GPS-tagged photo, then a same-camera GPS-less photo captured 2 minutes later.
3. Confirm the second photo's location was **auto-applied** (visible on its map pin immediately) with an `inferred` provenance chip in the properties pane.
4. Click **Revert** and confirm coordinates and provenance clear.
5. Repeat the upload with a gap or device mismatch large enough to only produce a `pending` suggestion; confirm it appears in `/location-suggestions` with the correct confidence tier, method label, and (if applicable) speed warning.
6. Run `POST /api/admin/location-inference/backfill` with a date range and watch `/admin/settings/jobs` for the `location_inference` job (type filter) drain to `succeeded`.
7. With several `pending` suggestions at varying confidence, adjust the inline "Threshold %" field on `/location-suggestions` and click **"Accept all ≥ N%"**; confirm the browser navigates to `/review-runs/:runId`, the page shows `evaluating` → `running` → `completed`, `matchedCount`/`processedCount`/`succeededCount` update on poll, and the accepted items' coordinates and `coordSource: 'inferred'` are visible once you return to the media items. Repeat with **"Reject all < N%"** and confirm the below-threshold suggestions move to `rejected` with no coordinate writes.
8. Start a bulk run against a large pending backlog and click **"Cancel run"** mid-flight; confirm the run reaches `cancelled`, items already processed keep their outcome, and remaining suggestions stay `pending`.
9. On `/location-suggestions` with several pending suggestions at varying confidence, switch the sort control to **"Confidence — Highest"** and confirm the list re-orders and resets to page 1; reload the page and confirm the sort persists via the URL query string; manually edit the URL to an invalid `sortBy` value and confirm the page falls back to the default (`createdAt`/`desc`) instead of erroring.

---

## 15. Future Work

| Capability | Notes |
|---|---|
| Debounced sweep-on-new-anchor | See §13 — explicit v2, needs a debounce/coalescing primitive not yet present in the codebase |
| Cross-device corroboration | See §13 — explicit v2 |
| Landmark-style visual geolocation via existing CLIP embeddings | See §12 — plausible v3, contingent on curating a reference landmark set |
| Keyset-chunked sweep load | Not needed at current scale (§5.3); would only become relevant for a single circle vastly exceeding 50k-100k photos |
| Configurable confidence-formula weights | The `0.5/0.3/0.2` weighting in §3.5 is currently a code constant, not an admin-editable setting — mirrors the equivalent Future Work item for duplicate detection's best-copy scoring weights |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | July 2026 | AI Assistant | Initial specification, documenting the full implementation: `coordSource` provenance model and its three writers, the antimeridian-safe interpolation/extrapolation algorithm with its exact confidence formula and auto-apply gate, the single-sweep-job-per-circle backfill architecture with its snapshot invariant and force semantics, the full review/admin API surface, and the review UI |
| 1.1 | July 2026 | AI Assistant | Document the configurable `locationInference.bulkAcceptThreshold` setting (§7.1, issue #126) and the async run-based "Bulk Accept/Reject at Scale" rebuild (§9, issue #125): `location_suggestion_runs`/`location_suggestion_run_items` data model (§6.5), `location_suggestion_run_evaluate`/`location_suggestion_run_execute_batch` server-only job types (§5.5), the rewritten `bulk-accept` and new `bulk-reject` endpoints plus the three run-inspection/cancel endpoints (§8.5–§8.9), the updated RBAC table (§10), and the review page's gear icon / inline threshold / run-progress page (§11) |
| 1.2 | July 2026 | AI Assistant | Issue #190: `location_suggestion_runs`/`location_suggestion_run_items` were folded into the shared `review_runs`/`review_run_items` model (run UUIDs preserved), and the location-suggestion-specific job types were replaced by the generic `review_run_evaluate`/`review_run_execute_batch` pair (kept as deprecated shims for in-flight jobs) — §6.5 and §5.5 now defer to the new [review-runs.md](review-runs.md) spec for the shared architecture. Rewrote §9 to document only what remains location-specific (the non-nullable confidence column, the accept/reject transaction, the deferred `geocode` enqueue). Updated §8.5–§8.9 to reflect the canonical `/api/review-runs/*` paths with `/api/location-suggestion-runs/*` as a deprecated alias, §10's RBAC table, §11's UI (the `ReviewRunPage` redirect replacing the deleted `LocationSuggestionRunPage.tsx`), and §14's testing notes. |
