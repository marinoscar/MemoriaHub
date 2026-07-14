# Burst Photo Detection — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.7 |
| **Last Updated** | July 2026 |
| **Status** | Specification |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Detection Signals and Algorithm](#2-detection-signals-and-algorithm)
3. [Best-Shot Scoring](#3-best-shot-scoring)
4. [Data Model](#4-data-model)
5. [Processing and Enrichment Flow](#5-processing-and-enrichment-flow)
6. [Configuration](#6-configuration)
7. [API Endpoints](#7-api-endpoints)
8. [UI](#8-ui)
9. [Security and Privacy](#9-security-and-privacy)
10. [Testing Notes](#10-testing-notes)
11. [Future Work](#11-future-work)

---

## 1. Overview and Goals

Burst detection helps users clean up their photo library after rapid-fire shooting sessions. When someone fires 10–15 near-identical frames in quick succession — to catch a fleeting expression, nail a timing-critical shot, or steady a shaky hand — only one or two of those frames are keepers. The rest clutter the library and consume storage.

The feature identifies these "burst groups" automatically and surfaces them as a review queue. A human reviewer sees the group, picks the best frames, and confirms deletion. The system never deletes anything without explicit confirmation.

### Goals

- Detect groups of near-identical photos taken from the same device within a short time window.
- Support three complementary detection signals ranked by precision: Apple BurstUUID, temporal proximity, and perceptual hash.
- Score each group member by visual quality so the reviewer has an informed starting point.
- Surface pending burst groups through a dedicated review queue and contribute to the existing dashboard review-queue count.
- Operate as a global feature toggle (`features.burstDetection` system setting, default off) consistent with face recognition and auto-tagging. Previously a per-circle opt-in; as of migration `20260621050000_drop_circle_feature_flags` the per-circle `burst_detection_enabled` column is dropped and enablement is global. **Note:** any previously-enabled circles lost their opt-in — an Admin must re-enable the feature globally.
- Keep all computation on-server using `sharp` with no new heavy dependencies (no OpenCV, no cloud calls).
- Run as an enrichment job on the existing `enrichment_jobs` queue to inherit retries, observability, and the admin jobs dashboard at zero infrastructure cost.

### Non-Goals

- The system does not auto-delete any photo. It suggests; the human confirms.
- The system does not detect semantically similar photos taken at different times or from different devices (that is a separate dedup problem).
- The existing 1536-d text embeddings (description + tags + people names) are explicitly not used here — they are semantic, not visual, and are the wrong tool for near-duplicate detection.
- Video burst detection is out of scope. Only `MediaType.photo` items are processed.
- Cross-circle burst detection is out of scope. Groups are strictly circle-scoped.

---

## 2. Detection Signals and Algorithm

Three signals are combined in priority order. The algorithm is deliberately lightweight: no external service, no cloud call, no GPU.

### 2.1 Signal 1 — Apple BurstUUID (Hard-Merge Prior)

Apple's camera hardware embeds a `BurstUUID` field in the EXIF MakerNote of every frame belonging to a hardware burst sequence. All frames in the sequence share the same non-null value.

This signal has the **highest precision** of the three — any two items sharing a non-null `BurstUUID` are definitively the same hardware burst — but **low recall**: manual shooting bursts (rapid-fire without the hardware burst mode) lack this field entirely.

**Rule:** Any two items within the same circle whose `burstUuid` fields are both non-null and equal are always grouped into the same burst group, regardless of their temporal gap or perceptual hash distance. This is a hard prior that cannot be overridden by the other signals.

The `burstUuid` value is extracted by the EXIF processor using `exifr`'s MakerNote parsing. On iPhone, the field appears at MakerNote key `BurstUUID` (or its numeric equivalent depending on exifr's MakerNote dictionary). Items from non-Apple cameras will have `burstUuid = null`.

### 2.2 Signal 2 — Temporal Proximity (Same-Device Window)

Two items are temporally proximate when:

1. They originate from the **same device**, identified by `cameraMake + cameraModel` (from EXIF) or `sourceDeviceId` when present. Cross-device grouping is disabled — items from different cameras are never grouped by time alone, even if captured simultaneously.
2. Their consecutive capture-time gap is **≤ T seconds** (configurable; default 10 s). "Consecutive" means the gap between adjacent items when the candidate set is sorted by `capturedAt`.

Sub-second precision is required to correctly order rapid-fire sequences. The EXIF processor folds `SubSecTimeOriginal` into `capturedAt` at millisecond resolution when the field is present. Items whose EXIF provides only second-level granularity will have `SubSecTimeOriginal = null` and `capturedAt` at whole-second resolution; they are still eligible but ordering within the same second is undefined.

Temporal proximity alone is a **necessary but not sufficient** condition for grouping. It must be combined with Signal 3 (perceptual hash) to avoid grouping distinct scenes that happen to be photographed rapidly.

### 2.3 Signal 3 — Perceptual Hash / dHash (Visual Near-Duplicate)

A 64-bit **dHash** (difference hash) is computed from the orientation-corrected thumbnail using `sharp`. The dHash is stored as `BigInt` in `MediaItem.perceptualHash`.

Two items are visual near-duplicates when their Hamming distance is **≤ D bits** (configurable; default 10 of 64 bits). A Hamming distance of 0 means the thumbnails are pixel-identical after orientation correction and downscale; a distance of 10 allows for JPEG re-compression artifacts, minor exposure changes, and sub-pixel motion.

The perceptual hash is computed by the `visual-hash` storage processor (see §5.1) from the orientation-corrected image, ensuring that portrait photos rotated by EXIF orientation are compared right-side-up.

The existing 1536-d text embedding stored in `media_item_embedding` is **not used** for burst detection. That embedding encodes description, tags, and people names — it is a semantic signal, not a visual one, and would incorrectly group unrelated photos that happen to share the same scene description.

### 2.4 Grouping Rule

A burst group is formed when ≥ N items (configurable; default 3) cluster by the following rules applied via single-linkage union-find:

- Two items are linked if: **(temporal proximity AND pHash distance ≤ D)** OR **(shared non-null BurstUUID)**.
- The union-find is computed greedily as the `BurstDetectionHandler` processes each item: the handler finds candidate preceding neighbors within the time window and same device, computes pHash distance, and attaches the item to an existing group or creates a new two-item group.
- Groups below size N remain **provisional** — they are not surfaced in the review queue until a subsequent item causes the group to reach the minimum size. Provisional groups are stored in the database but have no effect on the UI or the dashboard count.

The greedy per-item approach means group membership can grow as new uploads arrive. An item that completes an undersized provisional group triggers a recount that may cause the group to become visible for the first time.

---

## 3. Best-Shot Scoring

Each group member receives a `burstScore` combining three quality signals. The scoring is **assistive only** — it is never used to automatically delete anything. Its sole purpose is to pre-select the suggested best frame so the reviewer has a useful starting point.

### 3.1 Sharpness (Primary Signal)

Sharpness is measured as the **variance of the Laplacian** of the orientation-corrected grayscale image, computed by `sharp` via a convolution kernel. Higher variance indicates more high-frequency edge detail, which correlates strongly with focus quality. A blurry or motion-smeared frame produces a low Laplacian variance; a sharply focused frame produces a high value.

The raw variance is stored as `MediaItem.sharpnessScore` (Float). This value is computed by the `visual-hash` storage processor alongside the perceptual hash (see §5.1). It does not require a separate processing pass.

### 3.2 Face Signals (Secondary, Optional)

When `features.faceRecognition` is enabled globally and the media item has been processed by the face detection pipeline, the handler reads existing `Face` rows and incorporates two sub-signals:

- **Face count:** more faces detected is generally preferable to fewer, on the assumption that the photographer was trying to capture a group.
- **Face sharpness:** the mean `confidence` of detected faces on the item is used as a proxy for facial sharpness (providers report lower confidence on blurry, partially occluded, or rotated faces).

These signals are optional. When face data is absent (feature disabled, item not yet processed, or no faces detected), `burstScore` is computed from sharpness and resolution alone without degradation.

### 3.3 Resolution

`MediaItem.width * MediaItem.height` is included as a tiebreaker. Among items that are equally sharp and have the same face signals, the higher-resolution frame is preferred.

### 3.4 Composite Score Formula

```
burstScore = w_sharp * normalize(sharpnessScore)
           + w_face  * normalize(faceSignal)       // 0 when face data unavailable
           + w_res   * normalize(resolution)
```

Weights are implementation constants (`w_sharp = 0.6`, `w_face = 0.3`, `w_res = 0.1`). Each sub-signal is normalized to [0, 1] within the group before weighting, so all members in the group contribute to the normalization range. The member with the highest composite `burstScore` becomes `BurstGroup.suggestedBestItemId`.

`suggestedBestItemId` and all member `burstScore` values are recomputed each time a new member joins the group, so the suggestion stays current as the group grows.

### 3.5 Confidence Score (Visual Cohesion)

Alongside per-member `burstScore`, each group is scored once for overall visual cohesion and stored as `BurstGroup.confidence` (Float, `[0, 1]`) at detection time. Unlike `burstScore`, which ranks individual frames within a group, `confidence` describes how tightly the group's members agree with each other — surfaced to the reviewer in the burst list/detail response as a quick "how sure are we this is really a burst" signal.

```
confidence = mean(hashCohesion, timeCohesion)

hashCohesion = clamp(1 - maxPairwiseHamming / burst.hashDistance, 0, 1)
timeCohesion = clamp(1 - avgAdjacentGapSeconds / burst.timeGapSeconds, 0, 1)
```

- `maxPairwiseHamming` — the largest dHash Hamming distance between any two members of the group (the group's "worst" visual match).
- `avgAdjacentGapSeconds` — the mean capture-time gap between consecutive members when sorted by `capturedAt`.
- Each sub-score is clamped to `[0, 1]` before averaging: a group where every pairwise hash distance and every adjacent gap sits comfortably under its configured threshold (`burst.hashDistance`, `burst.timeGapSeconds`) scores close to `1.0`; a group whose hash distance or time gap approaches its threshold scores lower.
- `confidence` is written in the same recomputation pass that sets `suggestedBestItemId`/`burstScore` (§2.4's Step 6), so it stays current as the group grows. Groups formed purely via the BurstUUID hard-prior (§2.1) are scored the same way — the formula does not special-case that signal.
- Groups created before this field existed have `confidence = null` until the group's membership is next recomputed (e.g. a new member joins, or a backfill re-run touches the group).

---

## 4. Data Model

### 4.1 New Table: `burst_groups`

One row per detected burst group.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `circleId` | UUID | FK → `circles` (cascade delete); groups are circle-scoped |
| `status` | `BurstGroupStatus` | See enum below; default `pending` |
| `suggestedBestItemId` | UUID? | FK → `media_items` (SetNull on delete); the highest-scoring member |
| `mediaCount` | Int | Denormalized count of current members; updated whenever a member joins or leaves |
| `capturedAt` | DateTime? | Capture timestamp of the earliest member; used for chronological sorting of the review queue |
| `resolvedById` | UUID? | FK → `users` (SetNull on delete); who resolved or dismissed the group |
| `resolvedAt` | DateTime? | When the group was resolved or dismissed |
| `resolutionAction` | String? (`'archive'`\|`'trash'`) | Which outcome a resolve applied to the non-kept members; null until resolved |
| `keptCount` | Int? | Number of members kept by a resolve; null until resolved |
| `removedCount` | Int? | Number of members archived/trashed by a resolve; null until resolved |
| `confidence` | Float? | `[0, 1]` visual-cohesion score set at detection time; see §3.5. Null for legacy groups until next recomputation |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |

`resolutionAction`, `keptCount`, `removedCount`, and `confidence` were added by migration `20260713120000_add_burst_dup_resolution_tracking`, along with a new index `(circleId, status, resolutionAction)` to support filtering the review queue and admin reporting by resolution outcome.

**`BurstGroupStatus` enum:**

| Value | Meaning |
|-------|---------|
| `pending` | Awaiting human review; surfaced in the review queue when `mediaCount >= minGroupSize` |
| `resolved` | Reviewer confirmed a keep set; non-kept members soft-deleted |
| `dismissed` | Reviewer indicated this is not a burst; members ungrouped |

### 4.2 New Columns on `media_items`

| Column | Type | Notes |
|--------|------|-------|
| `perceptualHash` | String? (TEXT, unsigned decimal) | 64-bit dHash stored as an unsigned decimal string; null until the `visual-hash` processor runs. **Not `bigint`**: Postgres `bigint` is signed and overflows unsigned 64-bit hashes with the high bit set; JS `BigInt` is not JSON-serializable. Parsed with `BigInt(string)` inside the burst matcher only. Omitted from default API responses via Prisma global `omit`. |
| `sharpnessScore` | Float? | Variance-of-Laplacian; null until the `visual-hash` processor runs |
| `burstUuid` | String? | Apple BurstUUID from EXIF MakerNote; null for non-Apple cameras or manual-burst photos |
| `burstScore` | Float? | Composite quality score within the group; null when item is not in a group |
| `burstGroupId` | String? | FK → `burst_groups` (SetNull on delete); null when not assigned to a group |

**Storage rationale for `perceptualHash` — lessons learned:**

Two production bugs were encountered when `perceptualHash` was stored as a Postgres `bigint` (Prisma `BigInt`):

1. **"value out of range for type bigint"** — a dHash is an unsigned 64-bit integer. Postgres `bigint` is signed (range −2^63 to 2^63−1). Any hash whose high bit is set (value ≥ 2^63) exceeds the signed range and causes a Postgres overflow error. This affected roughly half of all possible hash values.
2. **"Do not know how to serialize a BigInt"** — Prisma maps `bigint` columns to JavaScript's `BigInt` primitive. `JSON.stringify` has no built-in serializer for `BigInt`, so any endpoint that returned a `MediaItem` row without explicitly excluding the column would 500.

**Resolution:** the column is `TEXT` in Postgres and `String` in Prisma, storing the value as an unsigned decimal string (e.g. `"13853051937932480"`). Application code calls `BigInt(row.perceptualHash)` only inside the burst matcher where Hamming distance arithmetic is required. The column is excluded from all default API serialization via a Prisma global `omit` so it cannot accidentally appear in responses.

### 4.3 Global Feature Setting (replaces per-circle column)

The `burstDetectionEnabled` column that was added to `circles` has been removed in migration `20260621050000_drop_circle_feature_flags`. Burst detection is now enabled globally via the system setting `features.burstDetection` (Boolean, default `false`) stored in the `system_settings` JSONB at path `.features.burstDetection`. The `BurstEnqueueListener` reads this via `SystemSettingsService.isFeatureEnabled('burstDetection')`.

### 4.4 Relationships

- `burst_groups.circleId` → `circles.id` (cascade delete: deleting a circle purges its groups)
- `burst_groups.suggestedBestItemId` → `media_items.id` (SetNull: if the best item is deleted, clear the suggestion)
- `burst_groups.resolvedById` → `users.id` (SetNull)
- `media_items.burstGroupId` → `burst_groups.id` (SetNull: soft-deleting an item does not delete the group; the group's `mediaCount` is decremented)

---

## 5. Processing and Enrichment Flow

### 5.1 New Storage Processor: `visual-hash`

A new synchronous processor in the existing storage processing chain. The chain currently runs processors in priority order: EXIF extraction (~20), thumbnail generation (~40), geolocation (~60), etc. The `visual-hash` processor runs at **priority 45** — after thumbnail generation (which produces the source image it needs), before geolocation.

**What it does:**

1. Calls `prepareImageForProcessing(rawBuffer, { maxDim: 512 })` from `apps/api/src/storage/processing/image-orientation.util.ts` to obtain an orientation-corrected, downscaled JPEG. The 512 px cap is sufficient for both dHash and Laplacian variance — running these algorithms on full-resolution images wastes CPU without improving result quality.
2. **dHash computation:** resize to 9×8 pixels (grayscale), compute horizontal differences across each row (8 differences × 8 rows = 64 bits), encode as a 64-bit integer stored in `MediaItem.perceptualHash`.
3. **Laplacian sharpness:** apply a discrete Laplacian convolution kernel to the grayscale image, compute the variance of the resulting pixel values, store in `MediaItem.sharpnessScore`.

Both computations use `sharp` pipeline operations. No OpenCV, no native bindings beyond what `sharp` already provides, and no external service calls.

**On failure:** if `prepareImageForProcessing` returns `width: 0` (sharp could not decode the image), the processor skips writing both values and logs a warning. `perceptualHash` and `sharpnessScore` remain null. The burst detection handler tolerates null values — items with null `perceptualHash` are grouped only if they share a non-null `BurstUUID` or are within the time window with a neighbor whose hash is also null (in the latter case, temporal proximity alone is insufficient: a null-hash item is not linked to another null-hash item by temporal proximity alone — at least one of the pair must have a hash for the visual similarity test to pass).

### 5.2 EXIF Processor Extension

The existing EXIF processor is extended to extract two additional fields:

- **`burstUuid`:** read from `exifr`'s MakerNote output. On Apple devices, this appears as the string value of the `BurstUUID` MakerNote key. For all other cameras the field is absent and `burstUuid` is written as null.
- **`capturedAt` sub-second precision:** when `SubSecTimeOriginal` is present in EXIF, it is parsed as a decimal fraction and added to the `DateTimeOriginal`-derived timestamp at millisecond resolution. The updated `capturedAt` is written to `MediaItem`. When `SubSecTimeOriginal` is absent, behavior is unchanged (whole-second precision).

### 5.3 New Enrichment Job: `burst_detection`

The burst detection enrichment job reuses the generic `enrichment_jobs` queue. Its type string is `'burst_detection'`.

**Priority conventions:**

| Trigger | `reason` | `priority` |
|---------|----------|------------|
| Per-item rerun (user) | `rerun` | 0 (highest) |
| On upload | `upload` | 10 |
| Backfill | `backfill` | 100 (lowest) |

For the full queue architecture, worker lifecycle, retry logic, and how to add new handlers, see **[docs/specs/enrichment-queue.md](enrichment-queue.md)**.

### 5.4 BurstEnqueueListener

`BurstEnqueueListener` listens for `OBJECT_PROCESSED_EVENT` (emitted after the synchronous storage processing chain completes, i.e. after the `visual-hash` processor has run and `perceptualHash` is populated).

Before enqueueing, the listener checks:

1. `MediaType` is `photo` (burst detection does not apply to videos).
2. `mediaItem.deletedAt` is null.
3. `BURST_DETECTION_ENABLED` environment variable is not `'false'` (environment kill-switch).
4. `features.burstDetection` is `true` in system settings (global feature toggle; previously a per-circle flag).

If all checks pass, the listener calls `EnrichmentJobService.enqueue` with `type='burst_detection'`, `reason=upload`, `priority=5`. The idempotency check in `EnrichmentJobService.enqueue` prevents duplicate jobs if the event fires more than once.

### 5.5 BurstDetectionHandler

`BurstDetectionHandler` implements `EnrichmentHandler` and self-registers via `onModuleInit`. Its `process(job)` method delegates to `BurstDetectionService.processMediaItem(job)`.

**`BurstDetectionService.processMediaItem` — step by step:**

**Step 1.** Load the `MediaItem` including `perceptualHash`, `sharpnessScore`, `burstUuid`, `capturedAt`, `width`, `height`, `cameraMake`, `cameraModel`, `circleId`. If the item is not found or `deletedAt` is set, return early (non-retryable).

**Step 1a (on-demand hashing — retroactive fingerprinting).** If `perceptualHash` is null (i.e. the item was uploaded before the `visual-hash` processor existed), the handler downloads the raw image from the storage provider and calls `computeVisualHash` from `apps/api/src/storage/processing/visual-hash.util.ts` to compute the 64-bit dHash and Laplacian sharpness score. Both values are persisted to `media_items` before proceeding. If the download or hash computation fails, the handler logs a warning and continues without a hash — the item will be eligible for grouping via BurstUUID only. This on-demand path is identical to the `visual-hash` storage processor but runs lazily inside the enrichment job so that libraries uploaded before the feature was introduced can be retroactively fingerprinted and grouped.

**Step 2.** Load system settings for burst configuration: `burst.timeGapSeconds` (T), `burst.hashDistance` (D), `burst.minGroupSize` (N).

**Step 3.** Find candidate neighbors. Query `media_items` in the same circle where:
- `mediaType = photo`
- `deletedAt` is null
- `capturedAt` is within `[item.capturedAt - T seconds, item.capturedAt]` (preceding window only — the handler processes items in upload order; future items will link back when they are processed)
- `cameraMake = item.cameraMake AND cameraModel = item.cameraModel` (same device), OR `burstUuid IS NOT NULL AND burstUuid = item.burstUuid` (shared BurstUUID overrides device check)

Order by `capturedAt DESC` to find the most recent preceding neighbors first.

**Step 4.** For each candidate neighbor, determine whether to link:
- If both items share a non-null `burstUuid` → **always link** (BurstUUID hard prior).
- Else if `item.perceptualHash` is null or `neighbor.perceptualHash` is null → **do not link** (cannot compute distance; temporal proximity alone is insufficient without a hash).
- Else if `hammingDistance(item.perceptualHash, neighbor.perceptualHash) <= D` → **link** (temporal + visual match).
- Otherwise → do not link.

**Step 5.** If any links were found, resolve group membership:
- Collect the `burstGroupId` values of all linked neighbors that are already in a group.
- If all linked neighbors are ungrouped: create a new `BurstGroup` (status `pending`, `circleId`, `capturedAt` = earliest member's `capturedAt`), assign the item and all linked neighbors to it, set `mediaCount`.
- If linked neighbors belong to exactly one existing group: assign the item to that group, increment `mediaCount`.
- If linked neighbors belong to multiple distinct groups: merge all groups into the oldest one (by `createdAt`), reassign all members, delete the now-empty groups.

**Step 6.** If the item was assigned to a group, recompute `suggestedBestItemId` and `burstScore` for all current members of the group:
- Load face data for the group's members if `features.faceRecognition` is enabled globally and face rows exist.
- Compute the composite score per §3.4.
- Write `burstScore` to each member's `media_items` row.
- Set `BurstGroup.suggestedBestItemId` to the highest-scoring member.
- Set `BurstGroup.mediaCount` to the current member count.

**Step 6a. Burst wins over duplicate detection.** After scores are recomputed, the handler loads every current member of the target burst group and calls `DuplicateDetectionService.evictFromDuplicateGroups(memberIds)` to clear `duplicateGroupId` on any of them that had already been linked into a `DuplicateGroup` — closing the upload-time ordering race where `duplicate_detection` processes an item before `burst_detection` does (both are enqueued together on upload, so either order can occur). This is **best-effort**: wrapped in try/catch, a failure is logged as a warning and never fails the burst job. `DuplicateDetectionService` now also refuses to write a burst member into a duplicate group at write time — it re-checks `burstGroupId` under a `SELECT ... FOR UPDATE` row lock immediately before writing `duplicateGroupId`, inside the same `processMediaItem` transaction — so this eviction step is now best-effort cleanup for the case where dedup already committed, not the sole mechanism; burst's own upload-enqueue priority is also 5 (vs. `duplicate_detection`'s 10, see §5.4), narrowing the window before eviction is even needed. See [duplicate-detection.md §3.2](duplicate-detection.md#32-burst-overlap-exclusion-rules) for the full write-time mechanism, rationale, and the one-time `evictExistingBurstOverlaps` remediation used by the admin backfill.

**Step 7.** If the item was not linked to any neighbor, no group is created or modified. The item's `burstGroupId` remains null.

**On error:** throw so the worker applies standard retry logic. The handler does not maintain a separate per-item status table — group membership is the observable state.

**Idempotency:** calling the handler twice for the same item is safe. On the second run, Step 3 will find the same neighbors, Step 4 will compute the same links, and Step 5 will find the item is already in a group. The upsert in Step 6 recomputes scores and writes the same values. No duplicate groups are created.

---

## 6. Configuration

### 6.1 System Settings (Admin-Editable)

Burst detection parameters are stored in the `system_settings` JSONB column under the key `'global'`, at JSON path `.burst.*`. They are editable via the admin UI and validated by a Zod schema on write.

| Setting key | Type | Range | Default | Description |
|-------------|------|-------|---------|-------------|
| `burst.timeGapSeconds` | integer | 1–300 | 10 | Maximum capture-time gap (seconds) between consecutive items from the same device for temporal proximity to apply |
| `burst.hashDistance` | integer | 0–32 | 10 | Maximum Hamming distance (bits, out of 64) for two items to be considered visual near-duplicates |
| `burst.minGroupSize` | integer | 2–20 | 3 | Minimum number of items required for a group to be surfaced in the review queue |
| `burst.autoResolveThreshold` | integer | 0–100 | 60 | Default percentage pre-filled into the review queue's "Archive above N" / "Delete above N" buttons, which call `POST /api/media/bursts/bulk/resolve-by-threshold` (§7.2) |

The upper bound of `hashDistance` is capped at 32 (half the 64-bit hash width) by the Zod schema. Values above 32 would cause false positives by matching images that are more different than similar.

### 6.2 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BURST_DETECTION_ENABLED` | `true` | Environment kill-switch. Set to `false` to disable `BurstEnqueueListener` regardless of system settings. The system setting `features.burstDetection` is the runtime on/off toggle; this env var is a hard override for CI/test environments. |

The enrichment worker variables (`ENRICHMENT_WORKER_ENABLED`, `ENRICHMENT_JOB_POLL_MS`, `ENRICHMENT_WORKER_CONCURRENCY`) govern the queue that runs `burst_detection` jobs alongside all other enrichment types. See [enrichment-queue.md — Configuration](enrichment-queue.md#12-configuration).

---

## 7. API Endpoints

All endpoints require JWT Bearer authentication. No new RBAC permissions are introduced — burst detection reuses the existing `media:read`, `media:write`, and `media:delete` system permissions combined with per-circle viewer, collaborator, and circle_admin roles.

### 7.1 Burst Group Review Queue

#### `GET /api/media/bursts`

List burst groups for a circle, filtered by status, with member counts, cover thumbnails, and the suggested best item.

- **Auth:** `media:read` + per-circle `viewer` role (or `media:read_any` for admin bypass)
- **Query params:**
  - `circleId` (required) — UUID of the circle
  - `status` (optional) — filter to `pending` | `resolved` | `dismissed`; defaults to `pending`
  - `page` (optional) — page number, 1-based; default 1
  - `pageSize` (optional) — items per page; default 20, max 100
- **Response `200`:**
  ```json
  {
    "data": [
      {
        "id": "uuid",
        "circleId": "uuid",
        "status": "pending",
        "mediaCount": 7,
        "capturedAt": "2026-06-15T14:32:01.234Z",
        "suggestedBestItemId": "uuid",
        "suggestedBestThumbnailUrl": "https://...",
        "coverThumbnailUrls": ["https://...", "https://...", "https://..."],
        "createdAt": "2026-06-15T14:32:10.000Z"
      }
    ],
    "meta": { "total": 12, "page": 1, "pageSize": 20 }
  }
  ```
  `coverThumbnailUrls` contains up to 4 signed thumbnail URLs for the first 4 group members (sorted by `capturedAt ASC`), for use as a stack preview. `suggestedBestThumbnailUrl` is the signed thumbnail URL for `suggestedBestItemId`.

Only groups with `mediaCount >= burst.minGroupSize` are returned (provisional undersized groups are not surfaced).

#### `GET /api/media/bursts/:id`

Get full detail for a single burst group: all members in capture order, each with their score, thumbnail URL, and key metadata.

- **Auth:** `media:read` + per-circle `viewer` role
- **Response `200`:**
  ```json
  {
    "data": {
      "id": "uuid",
      "circleId": "uuid",
      "status": "pending",
      "mediaCount": 7,
      "capturedAt": "2026-06-15T14:32:01.234Z",
      "suggestedBestItemId": "uuid",
      "resolvedById": null,
      "resolvedAt": null,
      "members": [
        {
          "id": "uuid",
          "capturedAt": "2026-06-15T14:32:01.234Z",
          "burstScore": 0.87,
          "sharpnessScore": 412.3,
          "thumbnailUrl": "https://...",
          "width": 4032,
          "height": 3024,
          "isSuggestedBest": true
        }
      ]
    }
  }
  ```
  Members are ordered by `capturedAt ASC`. `thumbnailUrl` is a signed URL.
- **Response `404`:** Group not found or caller is not a member of the circle.

### 7.2 Group Actions

#### `POST /api/media/bursts/:id/resolve`

Mark a burst group resolved. Applies either **archive** or **trash** to all members whose IDs are not in `keepIds`, then records `resolvedById`, `resolvedAt`, `resolutionAction`, `keptCount`, and `removedCount`.

Archive sets `archivedAt` on the non-kept members (reversible, hides them from browse surfaces). Trash sets `deletedAt` (reuses the existing Trash lifecycle — see [Archive & Trash Bin](archive-trash.md) — recoverable for `storage.trash.retentionDays` days before automatic purge). The operation runs in a single database transaction: either all member updates and the group status update succeed together, or the whole operation rolls back. A successful resolve writes an `AuditEvent` (`burst_group:resolved`) recording the actor, `keepIds`, and `action`.

- **Auth:** `media:write` + per-circle `collaborator` role. `action: 'trash'` additionally requires `media:delete` — a collaborator without delete rights can archive a group but not trash it.
- **Request body:**
  ```json
  { "keepIds": ["uuid", "uuid"], "action": "archive" }
  ```
  `keepIds` must be a non-empty array; all IDs must belong to this group. `action` is `'archive'` or `'trash'`. The caller may keep all members (zero removed) if they decide the entire group is worth keeping.
- **Response `200`:**
  ```json
  { "data": { "removed": 6, "kept": 1, "action": "archive", "groupStatus": "resolved" } }
  ```
- **Response `400`:** `keepIds` is empty, contains IDs not belonging to this group, the group is not in `pending` status, or `action: 'trash'` was requested without `media:delete`.
- **Response `404`:** Group not found.

#### `POST /api/media/bursts/:id/dismiss`

Mark a burst group dismissed, indicating the reviewer considers these items to not be a burst (e.g., intentionally similar photos). Clears `burstGroupId` and `burstScore` on all members so they are no longer associated with any group.

- **Auth:** `media:write` + per-circle `collaborator` role
- **Response `200`:**
  ```json
  { "data": { "groupStatus": "dismissed", "ungrouped": 7 } }
  ```
- **Response `400`:** Group is not in `pending` status (cannot dismiss an already-resolved or already-dismissed group).
- **Response `404`:** Group not found.

#### `POST /api/media/bursts/bulk/resolve`

Resolve multiple pending burst groups in a single call, always keeping each group's `suggestedBestItemId` and archiving/trashing the rest — the bulk equivalent of accepting the system's suggestion across many groups at once rather than reviewing each one individually.

- **Auth:** `media:write` + per-circle `collaborator` role. `action: 'trash'` additionally requires `media:delete`, same as the single-group resolve endpoint.
- **Request body:**
  ```json
  { "circleId": "uuid", "ids": ["uuid", "uuid"], "action": "archive" }
  ```
  `ids` is 1–100 burst group UUIDs. Every ID must belong to `circleId`; if any ID is missing or belongs to a different circle, the whole request is rejected before any group is touched.
- **Behavior:** each group is resolved independently inside its own database transaction (so one group's failure does not roll back another's success). For each group:
  - A group not currently in `pending` status is skipped (counted in `skipped`), not treated as an error.
  - A group with no `suggestedBestItemId` (no scored member to keep) is also skipped (counted in `skipped`).
  - A group that is eligible but fails during its own transaction is counted in `errors` and does not block the remaining groups.
  - An eligible group keeps only its `suggestedBestItemId` and archives/trashes every other member, exactly as if `POST /api/media/bursts/:id/resolve` had been called with `keepIds: [suggestedBestItemId]`.
- **Response `200`:**
  ```json
  {
    "data": {
      "resolvedGroups": 18,
      "keptCount": 18,
      "removedCount": 94,
      "action": "archive",
      "skipped": 2,
      "errors": 0
    }
  }
  ```
- **Response `400`:** `ids` is empty or exceeds 100, or an ID does not belong to `circleId`.

This endpoint powers the review queue's bulk "Resolve & Archive" / "Resolve & Delete" toolbar action, which appears once the reviewer multi-selects group cards (see §8.1).

#### `POST /api/media/bursts/bulk/resolve-by-threshold`

Resolve every **pending** burst group whose detection-time `confidence` (§3.5) meets or exceeds a caller-supplied score threshold, without requiring the reviewer to select groups individually. This is the endpoint behind the review queue's "Archive above N" / "Delete above N" buttons (see §8.1) — a manual, on-demand trigger fired by clicking a button, not an automatic background sweep. There is no cron; nothing resolves a group unless this endpoint (or the per-group/bulk-by-id endpoints above) is called.

- **Auth:** `media:write` + per-circle `collaborator` role. `action: 'trash'` additionally requires `media:delete`, same as the other resolve endpoints.
- **Request body:**
  ```json
  { "circleId": "uuid", "threshold": 75, "action": "archive" }
  ```
  `threshold` is an integer `0`–`100`, expressed as a percentage; it is compared against the persisted `BurstGroup.confidence` (a `[0, 1]` float) as `confidence >= threshold / 100`.
- **Behavior:** loads pending groups for the circle, capped at 500 per call (`MAX_THRESHOLD_RESOLVE`), and resolves every group meeting the threshold using the same keep-`suggestedBestItemId`-archive/trash-the-rest semantics as `POST /api/media/bursts/bulk/resolve`, each in its own transaction.
  - Groups with `confidence = null` — legacy groups created before the confidence column existed, or otherwise not yet scored — are **excluded** from threshold matching regardless of the threshold value; they are never auto-resolved by this endpoint and must be resolved individually via `POST /api/media/bursts/:id/resolve`.
  - A group below the threshold, or lacking a `suggestedBestItemId`, is skipped (counted in `skipped`).
  - A group that is eligible but fails during its own transaction is counted in `errors` and does not block the remaining groups.
- **Response `200`:**
  ```json
  {
    "data": {
      "resolvedGroups": 9,
      "keptCount": 9,
      "removedCount": 41,
      "action": "archive",
      "skipped": 3,
      "errors": 0
    }
  }
  ```
- **Response `400`:** `threshold` is out of range, or more than 500 pending groups exist in the circle (narrow the scope by resolving in batches, or use the by-id bulk endpoint above).

`burst.autoResolveThreshold` (§6.1) is the system-setting default that pre-fills the "Archive above N" / "Delete above N" buttons' threshold value on the review queue page; it does not gate or auto-fire this endpoint on its own.

### 7.3 Global Backfill (Admin)

#### `POST /api/admin/bursts/backfill`

Bulk-enqueue `burst_detection` jobs for photos across **all circles** that have not yet been processed (or all photos when `force: true`). Replaces the former per-circle `POST /api/media/bursts/backfill` endpoint.

For each enqueued photo that lacks a `perceptualHash`, the enrichment job performs on-demand fingerprinting: it downloads the image from the storage provider, runs `computeVisualHash` (`apps/api/src/storage/processing/visual-hash.util.ts`) to compute the 64-bit dHash and Laplacian sharpness score, and persists both to `media_items` before applying burst-grouping logic. This retroactive path enables backfill to operate on libraries that pre-date the burst detection feature.

After enqueueing runs across all circles, the endpoint also runs a one-time app-wide remediation step, `DuplicateDetectionService.evictExistingBurstOverlaps()`, which evicts any media item currently double-listed in both a pending burst group and a duplicate group — burst wins (see [duplicate-detection.md §3.2](duplicate-detection.md#32-burst-overlap-exclusion-rules)). This is best-effort: a remediation failure is logged but does not fail the backfill enqueue. The evicted count is returned as `evictedDuplicateOverlaps` in the response below.

- **Auth:** Admin role + `system_settings:write`
- **Requirement:** `features.burstDetection` must be `true` in system settings; otherwise returns `400 Bad Request`.
- **Request body:**
  ```json
  {
    "from": "2025-01-01T00:00:00.000Z",
    "to": "2025-12-31T23:59:59.999Z",
    "force": false
  }
  ```
  `from` and `to` are optional ISO-8601 datetime strings that bound the `capturedAt` range of photos to enqueue (both bounds are inclusive). They may be provided independently or together. `from > to` returns `400 Bad Request`. When omitted, all eligible photos across all circles are in scope.

  When `force` is `false` (default), only photos without an existing `burstGroupId` and without a `succeeded` `burst_detection` job are enqueued. When `force` is `true`, all non-deleted photos within the scope are enqueued (useful after changing `burst.timeGapSeconds` or `burst.hashDistance`, or to re-fingerprint photos that previously failed hashing).
- **Response `201`:**
  ```json
  { "data": { "enqueued": 312, "circles": 4, "evictedDuplicateOverlaps": 5 } }
  ```
  `evictedDuplicateOverlaps` counts media items evicted from duplicate groups by the post-backfill remediation step described above.
- **Error cases:**
  - `400` — `features.burstDetection` is `false` in system settings
  - `400` — `from` is later than `to`

### 7.4 Circle Dashboard

`GET /api/media/dashboard?circleId=` returns a `pendingBurstGroups` field. This is the count of burst groups for the circle with `status = pending` and `mediaCount >= burst.minGroupSize`. The count feeds into the existing review-queue section of the dashboard UI. The field is populated whenever `features.burstDetection` is enabled globally.

### 7.5 Review Insights

#### `GET /api/media/review-insights?circleId=`

An on-demand, per-circle aggregate of burst (and duplicate — see [duplicate-detection.md §9](duplicate-detection.md#9-api-endpoints)) review-queue activity, computed live on every call with no snapshot table and no cron. It answers "how much has burst review actually cleaned up in this circle" beyond the raw pending count.

- **Auth:** `media:read` + per-circle `viewer` role
- **Response `200`:**
  ```json
  {
    "bursts": {
      "identified": 42,
      "pending": 5,
      "resolved": 30,
      "dismissed": 7,
      "archivedGroups": 18,
      "trashedGroups": 12,
      "itemsKept": 30,
      "itemsArchived": 140,
      "itemsDeleted": 95
    },
    "duplicates": { "...": "same shape" }
  }
  ```
  `identified` is the total groups ever created for the circle (`pending + resolved + dismissed`); `archivedGroups`/`trashedGroups` split `resolved` groups by `resolutionAction`; `itemsKept`/`itemsArchived`/`itemsDeleted` sum `keptCount`/`removedCount` across resolved groups, split by the resolution's outcome. All fields are numbers.

This is the data source for the "Review Insights" page (`/review-insights`), a per-circle sidebar entry (not admin-only) that shows identified/resolved/dismissed counts and an archived-vs-deleted breakdown for both burst and duplicate review.

---

## 8. UI

### 8.1 Review Queue Surface

A "Review bursts" page (or tab within the existing review area) lists pending burst groups for the active circle, with a true total count and pagination rather than a single unbounded page. Each group is displayed as a visual stack of thumbnails — typically three to four frames overlapping — with a badge showing the total frame count and a confidence meter reflecting `BurstGroup.confidence` (§3.5). Group cards carry a multi-select checkbox (enlarged for mobile touch targets); a bulk toolbar appears once one or more groups are selected, offering "Resolve & Archive" and "Resolve & Delete" (the latter, and any selection over 25 groups, prompts a confirmation before firing `POST /api/media/bursts/bulk/resolve`).

Alongside the multi-select toolbar, the page offers "Archive above N" and "Delete above N" score-threshold buttons, pre-filled with `burst.autoResolveThreshold` (§6.1) and adjustable before firing, which call `POST /api/media/bursts/bulk/resolve-by-threshold` (§7.2) to resolve every qualifying pending group without requiring the reviewer to select cards individually. For Admins, the page header also carries a gear icon linking directly to `/admin/settings/bursts` (§8.3) to adjust detection parameters and the auto-resolve threshold.

Opening a group shows a side-by-side or grid view of all members in capture order, each displaying:
- The thumbnail at a generous size (to allow sharpness differences to be visible).
- The `burstScore` as a quality indicator (e.g., one to three star rating or a numerical badge).
- A "Best pick" highlight on the `suggestedBestItemId` member.
- Capture timestamp and resolution.

The reviewer selects which frames to keep (checkboxes, with the suggested best pre-selected). Rather than an archive-vs-trash toggle, the detail page presents two distinctly-colored actions — "Archive" and "Delete" — either of which fires `POST /api/media/bursts/:id/resolve` with the corresponding `action`. A "Dismiss — not a burst" action fires `POST /api/media/bursts/:id/dismiss`.

### 8.2 Dashboard Integration

The circle dashboard's existing review queue section gains a "Burst groups" entry alongside the existing review-queue counts (e.g., pending face labeling). The count is sourced from `pendingBurstGroups` in the dashboard API response.

### 8.3 Global Feature Toggle and Scan Panel

The Admin Settings page at `/admin/settings/bursts` provides a "Burst detection" toggle that writes `features.burstDetection` to system settings, along with the `burst.autoResolveThreshold` control that seeds the review queue's "Archive above N" / "Delete above N" buttons (§8.1). The per-circle toggle cards that previously appeared on the circle detail page have been removed.

A "Scan for bursts" panel is visible on the Admin Settings page when burst detection is globally enabled. It exposes:

- An optional **capture date range** (from / to date pickers) to scope the scan to a specific time window rather than re-processing the entire library.
- A **Force re-scan** checkbox that maps to the `force` request parameter.
- A **Run scan** button that calls `POST /api/admin/bursts/backfill` with the selected options and displays the `{ enqueued, circles }` result.

This UI makes retroactive fingerprinting of legacy libraries practical: an admin can select the years before the feature was introduced, run the scan, and have photos across all circles grouped without touching more recent uploads.

---

## 9. Security and Privacy

### All Processing Is On-Server

The `visual-hash` processor, dHash computation, and Laplacian sharpness calculation run entirely within the API process using `sharp`. No pixel data leaves the server. The perceptual hash is a compact 64-bit integer that does not allow reconstruction of the original image.

BurstUUID extraction reads from EXIF metadata already present in the uploaded file; no additional data is transmitted anywhere.

### Non-Destructive by Design

The system stores suggestions and scores in the database. No archiving or deletion occurs without an authenticated, authorized API call to `POST /api/media/bursts/:id/resolve` (or its bulk counterpart) with an explicit `keepIds`/`ids` list and an `action`. Archive sets `archivedAt` (reversible, no retention clock); trash sets `deletedAt` and follows the existing Trash lifecycle — recoverable for `storage.trash.retentionDays` days before automatic purge (see [Archive & Trash Bin](archive-trash.md)).

### Global Feature Toggle

`features.burstDetection` defaults to `false`. The `BurstEnqueueListener` checks this system setting before enqueueing. The global backfill also refuses to run when the setting is false. No circle participates in burst detection until an Admin enables the feature globally via `/admin/settings/bursts`.

### Authorization

All burst group endpoints enforce per-circle role checks. Viewers can read group data. Collaborators can resolve or dismiss groups and run backfill. No new RBAC permissions are added — the feature reuses the existing `media:read`, `media:write`, and `media:delete` permissions, consistent with the authorization model for albums and bulk operations.

### Audit Trail

Changes to the global `features.burstDetection` setting are tracked via the standard system-settings audit mechanism. The former per-circle `circle:burst_settings_update` event is no longer emitted (the per-circle settings endpoints have been removed).

---

## 10. Testing Notes

### Unit Tests

- **dHash computation:** verify correct 64-bit output for a known synthetic image; verify that two identical images produce Hamming distance 0; verify that a slightly altered image (brightness shift) produces distance ≤ 5.
- **Laplacian sharpness:** verify that a blurred image produces lower variance than its unblurred original.
- **Hamming distance utility:** property tests over edge cases (all-zero, all-one, single-bit flip).
- **Burst group scoring:** unit-test `BurstDetectionService.computeBurstScore` with mocked sharpness/face/resolution inputs; verify weight application and normalization.
- **BurstDetectionService.processMediaItem:** mock Prisma and verify group creation, member attachment, multi-group merge, and score recomputation for representative scenarios.

### Integration Tests

- **Full pipeline test:** upload two photos in the same circle with matching mock `perceptualHash` values within `hashDistance`, verify a `BurstGroup` row is created after both `burst_detection` jobs complete.
- **BurstUUID grouping:** upload two items with the same non-null `burstUuid` in different time windows; verify they are grouped despite the time gap exceeding `timeGapSeconds`.
- **Minimum group size:** upload two items that would be grouped (distance ≤ D); verify the group exists in the database but is not returned by `GET /api/media/bursts` (below `minGroupSize = 3`); upload a third; verify the group is now visible.
- **Cross-device isolation:** upload two items with matching hash and capture time but different `cameraMake`; verify no group is created.
- **Resolve endpoint:** verify soft-delete is applied to non-kept members, group status changes to `resolved`, non-deleted items remain accessible.
- **Dismiss endpoint:** verify `burstGroupId` is cleared on all members, group status changes to `dismissed`.
- **Global feature check:** verify `BurstEnqueueListener` does not enqueue when `features.burstDetection` is `false` in system settings.
- **`BURST_DETECTION_ENABLED=false`:** set the environment variable and verify the listener skips all photos regardless of system settings.
- **Backfill — basic:** call `POST /api/admin/bursts/backfill` with `force: false`; verify already-grouped items are not re-enqueued; call again with `force: true`; verify all items are enqueued.
- **Backfill — 400 when disabled:** verify `POST /api/admin/bursts/backfill` returns `400` when `features.burstDetection` is `false`.
- **Backfill — date range:** seed two photos with distinct `capturedAt` dates; call backfill with `from`/`to` scoping to only one date; verify only that photo is enqueued. Verify `from > to` returns 400.
- **Backfill — on-demand hashing:** seed a photo with `perceptualHash = null` (simulating a legacy upload); run the enrichment job for it; verify `perceptualHash` and `sharpnessScore` are written to the `media_items` row before grouping logic runs.

### RBAC Tests

- Verify a viewer can call `GET /api/media/bursts` and `GET /api/media/bursts/:id` but receives `403` on resolve and dismiss.
- Verify a collaborator can call resolve and dismiss.
- Verify `POST /api/admin/bursts/backfill` returns `403` for a non-admin and `201` for an Admin with `system_settings:write`.
- Verify a non-member receives `403` on all burst endpoints.

### Environment

Set `ENRICHMENT_WORKER_ENABLED=false` in test environments to prevent the enrichment worker from processing queued jobs during tests that are testing only the enqueue behavior. For integration tests that need end-to-end processing, set `ENRICHMENT_JOB_POLL_MS=100` and enable the worker explicitly.

---

## 11. Future Work

The following extensions are left for future iterations. None of them require changes to the data model or queue infrastructure defined in this spec.

| Capability | Notes |
|------------|-------|
| Video burst detection | Group short video clips taken in rapid succession; requires per-frame thumbnail extraction and a different dHash strategy |
| Cross-device grouping | Allow grouping items from different cameras (e.g., the same photographer using two bodies simultaneously) using pHash distance alone, without the same-device requirement; may produce more false positives |
| Configurable scoring weights | Expose `w_sharp`, `w_face`, `w_res` as admin-editable system settings rather than code constants |
| Auto-resolve single-obvious-best groups | When one member scores significantly above the rest (e.g., `burstScore > 0.9` and all others `< 0.3`), offer a one-click auto-resolve mode — still requires user confirmation, just pre-fills the selection |
| Smart backfill on settings change | ~~Deferred~~ — The "Scan for bursts" panel on the circle Settings tab now provides `from`/`to` date scoping and a `force` flag, enabling targeted re-runs after parameter changes without reprocessing the entire library. An automatic admin-UI prompt on settings save remains a possible future polish item. |
| Storage savings estimate | Display the estimated bytes that would be freed if all non-suggested-best members across pending groups were deleted |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 2026 | AI Assistant | Initial specification |
| 1.1 | June 2026 | AI Assistant | Document `from`/`to` date-range params on backfill endpoint; document on-demand retroactive perceptual hashing for legacy photos in the enrichment handler (§5.5 Step 1a) and backfill (§7.3); document "Scan for bursts" panel in circle Settings UI (§8.3); resolve deferred "Smart backfill on settings change" Future Work item |
| 1.2 | June 2026 | AI Assistant | Change `perceptualHash` column type from `BigInt` to `String` (TEXT, unsigned decimal) to fix signed-overflow and JSON-serialization bugs; add storage rationale and lessons-learned note in §4.2 |
| 1.3 | June 2026 | AI Assistant | Per-circle opt-in removed — burst detection is now a global system setting (`features.burstDetection`); per-circle backfill replaced by global admin endpoint (`POST /api/admin/bursts/backfill`); per-circle settings endpoints removed; Admin Settings UI updated |
| 1.4 | July 2026 | AI Assistant | Document burst-wins duplicate-group eviction: `BurstDetectionService.processMediaItem` now evicts its group's members from any duplicate group after grouping (Step 6a); `POST /api/admin/bursts/backfill` gained a post-step remediation and `evictedDuplicateOverlaps` response field; see [duplicate-detection.md §3.2](duplicate-detection.md#32-burst-overlap-exclusion-rules) for full detail |
| 1.5 | July 2026 | AI Assistant | `POST /api/media/bursts/:id/resolve` gained an `action: 'archive'\|'trash'` option (replacing unconditional soft-delete) and now writes a `burst_group:resolved` audit event; added `POST /api/media/bursts/bulk/resolve` for bulk keep-suggested-best resolution; added the detection-time `confidence` visual-cohesion score (§3.5) and its `resolutionAction`/`keptCount`/`removedCount`/`confidence` columns on `burst_groups` (migration `20260713120000_add_burst_dup_resolution_tracking`); added `GET /api/media/review-insights` (§7.5); documented the review-queue's multi-select bulk toolbar, confidence meter, and pagination (§8.1) |
| 1.6 | July 2026 | AI Assistant | Lowered `burst_detection`'s upload-time enqueue priority from 10 to 5 (§5.4, Step 6a) so it is claimed before `duplicate_detection` (priority 10, unchanged) in the common case; documented the dedup-side write-time `SELECT ... FOR UPDATE` re-check that closes the residual TOCTOU race the reactive eviction alone didn't fully close — see [duplicate-detection.md §3.2](duplicate-detection.md#32-burst-overlap-exclusion-rules) for the full mechanism |
| 1.7 | July 2026 | AI Assistant | Added `POST /api/media/bursts/bulk/resolve-by-threshold` (§7.2) and the `burst.autoResolveThreshold` system setting (§6.1) powering the review queue's "Archive above N" / "Delete above N" buttons; null-confidence legacy groups are never auto-resolved by the threshold path; documented the review queue's admin-only settings gear icon and the group detail page's Archive/Delete button pair replacing the archive-vs-trash toggle (§8.1, §8.3) |
