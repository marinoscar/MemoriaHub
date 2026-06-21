# Burst Photo Detection — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | June 2026 |
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
- Operate as a per-circle opt-in (default off) to match the privacy posture of face recognition and auto-tagging.
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

When the circle has `faceRecognitionEnabled = true` and the media item has been processed by the face detection pipeline, the handler reads existing `Face` rows and incorporates two sub-signals:

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
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |

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

### 4.3 New Column on `circles`

| Column | Type | Notes |
|--------|------|-------|
| `burstDetectionEnabled` | Boolean | Default `false`; controls per-circle opt-in |

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
3. `BURST_DETECTION_ENABLED` environment variable is not `'false'` (global kill-switch).
4. `circle.burstDetectionEnabled` is `true` (per-circle opt-in).

If all checks pass, the listener calls `EnrichmentJobService.enqueue` with `type='burst_detection'`, `reason=upload`, `priority=10`. The idempotency check in `EnrichmentJobService.enqueue` prevents duplicate jobs if the event fires more than once.

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
- Load face data for the group's members if `circle.faceRecognitionEnabled` is true and face rows exist.
- Compute the composite score per §3.4.
- Write `burstScore` to each member's `media_items` row.
- Set `BurstGroup.suggestedBestItemId` to the highest-scoring member.
- Set `BurstGroup.mediaCount` to the current member count.

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

The upper bound of `hashDistance` is capped at 32 (half the 64-bit hash width) by the Zod schema. Values above 32 would cause false positives by matching images that are more different than similar.

### 6.2 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BURST_DETECTION_ENABLED` | `true` | Global kill-switch. Set to `false` to disable `BurstEnqueueListener` for all circles. Per-circle opt-in still applies when `true`. Useful in test and CI environments. |

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

Mark a burst group resolved. Soft-deletes all members whose IDs are not in `keepIds`, then records `resolvedById` and `resolvedAt`.

The deletion step reuses the bulk soft-delete logic (`POST /api/media/bulk/delete` semantics: sets `deletedAt` on each item). The operation runs in a single database transaction: either all deletions and the group status update succeed together, or the whole operation rolls back.

- **Auth:** `media:delete` + per-circle `collaborator` role
- **Request body:**
  ```json
  { "keepIds": ["uuid", "uuid"] }
  ```
  `keepIds` must be a non-empty array. All IDs must belong to this group. The caller may keep all members (zero deletions) if they decide the entire group is worth keeping.
- **Response `200`:**
  ```json
  { "data": { "deleted": 6, "kept": 1, "groupStatus": "resolved" } }
  ```
- **Response `400`:** `keepIds` is empty, contains IDs not belonging to this group, or the group is not in `pending` status.
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

### 7.3 Backfill

#### `POST /api/media/bursts/backfill`

Bulk-enqueue `burst_detection` jobs for photos in a circle that have not yet been processed (or all photos when `force: true`). Requires the circle to have `burstDetectionEnabled = true`.

For each enqueued photo that lacks a `perceptualHash`, the enrichment job performs on-demand fingerprinting: it downloads the image from the storage provider, runs `computeVisualHash` (`apps/api/src/storage/processing/visual-hash.util.ts`) to compute the 64-bit dHash and Laplacian sharpness score, and persists both to `media_items` before applying burst-grouping logic. This retroactive path enables backfill to operate on libraries that pre-date the burst detection feature.

- **Auth:** `media:write` + per-circle `collaborator` role
- **Requirement:** `circle.burstDetectionEnabled` must be `true`; otherwise returns `400 Bad Request`.
- **Request body:**
  ```json
  {
    "circleId": "uuid",
    "from": "2025-01-01T00:00:00.000Z",
    "to": "2025-12-31T23:59:59.999Z",
    "force": false
  }
  ```
  `from` and `to` are optional ISO-8601 datetime strings that bound the `capturedAt` range of photos to enqueue (both bounds are inclusive). They may be provided independently or together. `from > to` returns `400 Bad Request`. When omitted, all eligible photos in the circle are in scope.

  When `force` is `false` (default), only photos without an existing `burstGroupId` and without a `succeeded` `burst_detection` job are enqueued. When `force` is `true`, all non-deleted photos within the scope are enqueued (useful after changing `burst.timeGapSeconds` or `burst.hashDistance`, or to re-fingerprint photos that previously failed hashing).
- **Response `201`:**
  ```json
  { "data": { "enqueued": 312 } }
  ```
- **Error cases:**
  - `400` — `circle.burstDetectionEnabled` is `false`
  - `400` — `from` is later than `to`

### 7.4 Per-Circle Burst Settings

#### `GET /api/circles/:id/burst-settings`

Get the per-circle burst detection opt-in flag.

- **Auth:** `circles:read` + per-circle `viewer` role
- **Response `200`:**
  ```json
  { "burstDetectionEnabled": false }
  ```

#### `PUT /api/circles/:id/burst-settings`

Enable or disable burst detection for a circle. Writes an audit event `circle:burst_settings_update`.

- **Auth:** `circles:write` + per-circle `circle_admin` role (or `circles:manage_any` for admin bypass)
- **Request body:**
  ```json
  { "enabled": true }
  ```
- **Response `200`:**
  ```json
  { "burstDetectionEnabled": true }
  ```

### 7.5 Circle Dashboard

`GET /api/media/dashboard?circleId=` gains a `pendingBurstGroups` field in its response. This is the count of burst groups for the circle with `status = pending` and `mediaCount >= burst.minGroupSize`. The count feeds into the existing review-queue section of the dashboard UI.

---

## 8. UI

### 8.1 Review Queue Surface

A "Review bursts" page (or tab within the existing review area) lists pending burst groups for the active circle. Each group is displayed as a visual stack of thumbnails — typically three to four frames overlapping — with a badge showing the total frame count.

Opening a group shows a side-by-side or grid view of all members in capture order, each displaying:
- The thumbnail at a generous size (to allow sharpness differences to be visible).
- The `burstScore` as a quality indicator (e.g., one to three star rating or a numerical badge).
- A "Best pick" highlight on the `suggestedBestItemId` member.
- Capture timestamp and resolution.

The reviewer selects which frames to keep (checkboxes, with the suggested best pre-selected). A single "Keep selected, delete rest" action fires `POST /api/media/bursts/:id/resolve`. A "Dismiss — not a burst" action fires `POST /api/media/bursts/:id/dismiss`.

### 8.2 Dashboard Integration

The circle dashboard's existing review queue section gains a "Burst groups" entry alongside the existing review-queue counts (e.g., pending face labeling). The count is sourced from `pendingBurstGroups` in the dashboard API response.

### 8.3 Per-Circle Settings Toggle and Scan Panel

The circle settings page gains a "Burst detection" toggle card, consistent with the existing "Face recognition" and "Auto-tagging" toggle cards. Enabling the toggle calls `PUT /api/circles/:id/burst-settings { enabled: true }`.

Below the toggle, a "Scan for bursts" panel is always visible when burst detection is enabled. It exposes:

- An optional **capture date range** (from / to date pickers) so the `circle_admin` can scope the scan to a specific date window rather than re-processing the entire library.
- A **Force re-scan** checkbox that maps to the `force` request parameter.
- A **Run scan** button that calls `POST /api/media/bursts/backfill` with the selected options and displays the `{ enqueued }` result.

This UI makes retroactive fingerprinting of legacy libraries practical: a user can select the years before the feature was introduced, run the scan, and have their old photos grouped without touching more recent uploads.

---

## 9. Security and Privacy

### All Processing Is On-Server

The `visual-hash` processor, dHash computation, and Laplacian sharpness calculation run entirely within the API process using `sharp`. No pixel data leaves the server. The perceptual hash is a compact 64-bit integer that does not allow reconstruction of the original image.

BurstUUID extraction reads from EXIF metadata already present in the uploaded file; no additional data is transmitted anywhere.

### Non-Destructive by Design

The system stores suggestions and scores in the database. No deletion occurs without an authenticated, authorized API call to `POST /api/media/bursts/:id/resolve` with an explicit `keepIds` list. Soft-deletion is used (sets `deletedAt`); records remain recoverable by an admin until a hard-delete sweep is run separately.

### Per-Circle Opt-In

`burstDetectionEnabled` defaults to `false`. The `BurstEnqueueListener` checks the flag before enqueueing. Backfill also refuses to run when the flag is false. A circle never participates in burst detection unless a `circle_admin` explicitly enables it.

### Authorization

All burst group endpoints enforce per-circle role checks. Viewers can read group data. Collaborators can resolve or dismiss groups and run backfill. No new RBAC permissions are added — the feature reuses the existing `media:read`, `media:write`, and `media:delete` permissions, consistent with the authorization model for albums and bulk operations.

### Audit Trail

`PUT /api/circles/:id/burst-settings` writes an `audit_events` row with action `circle:burst_settings_update`, `actorUserId`, and the new `enabled` value in `meta`. This matches the pattern used by face recognition and auto-tagging settings.

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
- **Opt-in check:** verify `BurstEnqueueListener` does not enqueue when `circle.burstDetectionEnabled = false`.
- **`BURST_DETECTION_ENABLED=false`:** set the environment variable and verify the listener skips all circles.
- **Backfill — basic:** call `POST /api/media/bursts/backfill` with `force: false`; verify already-grouped items are not re-enqueued; call again with `force: true`; verify all items are enqueued.
- **Backfill — date range:** seed two photos with distinct `capturedAt` dates; call backfill with `from`/`to` scoping to only one date; verify only that photo is enqueued. Verify `from > to` returns 400.
- **Backfill — on-demand hashing:** seed a photo with `perceptualHash = null` (simulating a legacy upload); run the enrichment job for it; verify `perceptualHash` and `sharpnessScore` are written to the `media_items` row before grouping logic runs.

### RBAC Tests

- Verify a viewer can call `GET /api/media/bursts` and `GET /api/media/bursts/:id` but receives `403` on resolve, dismiss, and backfill.
- Verify a collaborator can call resolve, dismiss, and backfill.
- Verify `PUT /api/circles/:id/burst-settings` returns `403` for a collaborator and `200` for a `circle_admin`.
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
