# Similar Photos — Visual Near-Duplicate Detection: End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | June 2026 |
| **Status** | Specification |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [How This Differs from Burst Detection](#2-how-this-differs-from-burst-detection)
3. [dHash Recap and the `dhash_bits` Column](#3-dhash-recap-and-the-dhash_bits-column)
4. [Detection Algorithm](#4-detection-algorithm)
5. [Best-Shot Scoring](#5-best-shot-scoring)
6. [Data Model](#6-data-model)
7. [Processing and Enrichment Flow](#7-processing-and-enrichment-flow)
8. [Configuration](#8-configuration)
9. [API Endpoints](#9-api-endpoints)
10. [UI](#10-ui)
11. [Security and Privacy](#11-security-and-privacy)
12. [Accuracy Trade-offs and Limitations](#12-accuracy-trade-offs-and-limitations)
13. [Testing Notes](#13-testing-notes)
14. [Future Work](#14-future-work)

---

## 1. Overview and Goals

Similar Photos helps users find and clean up near-duplicate images that have accumulated across their entire circle library — re-imported photos, lightly edited versions of the same shot, and consecutive near-identical frames that slipped past burst detection because they came from different devices or were taken outside the burst time window.

The feature groups photos by perceptual-hash (dHash) similarity alone, with no temporal or device gating. It surfaces these groups as a non-destructive review queue: nothing is deleted until a human confirms a keep set.

### Goals

- Identify near-duplicate photos across the full circle library using only the existing `perceptual_hash` value stored in `media_items`, re-encoded into a native `bit(64)` column (`dhash_bits`) for indexed Hamming search.
- Score each group member by visual quality so the reviewer has a reasonable starting point for the keep decision.
- Surface pending groups through a dedicated "Similar Photos" review queue and contribute a `pendingBurstGroups`-style count to the circle dashboard.
- Operate as a per-circle opt-in (default off), matching the privacy posture of burst detection, face recognition, and auto-tagging.
- Keep all computation on-server using existing utilities — no new heavy dependencies.
- Run as an enrichment job on the existing `enrichment_jobs` queue to inherit retries, observability, and the admin jobs dashboard.

### Non-Goals

- The system does not auto-delete any photo. It suggests; the human confirms.
- The system does not group semantically similar photos (same scene, clearly different angle or zoom). dHash is a visual signal, not a semantic one.
- Video deduplication is out of scope. Only `MediaType.photo` items are processed.
- Cross-circle deduplication is out of scope. Groups are strictly circle-scoped.
- The existing 1536-d text embeddings are not used here — they encode description and tags and would incorrectly group unrelated photos that share the same scene description.

---

## 2. How This Differs from Burst Detection

Burst detection and Similar Photos share the dHash perceptual hash as a core signal, but they answer different questions and use different matching strategies.

| Dimension | Burst Detection | Similar Photos |
|-----------|-----------------|----------------|
| **Matching signals** | Temporal window + same device + dHash (OR Apple BurstUUID) | dHash only, library-wide |
| **Time gating** | Photos must be within `burst.timeGapSeconds` of each other (default 10 s) | No time constraint — matches across years |
| **Device gating** | Photos must share `cameraMake + cameraModel` (or BurstUUID) | No device constraint — matches across different cameras |
| **Default Hamming threshold** | 10 bits (of 64) | 6 bits (of 64) — stricter because there is no corroborating temporal/device evidence |
| **Typical false-positive rate** | Low (time + device together are strong corroboration) | Higher (hash alone has no corroboration; stricter threshold compensates) |
| **Catches** | Rapid-fire sequences from one camera session | Re-imports, cloud-sync duplicates, light edits, cross-device near-dupes |
| **Misses** | Same subject from different cameras or different sessions | Same subject at different zoom or angle |

The stricter default Hamming threshold (6 vs. 10) for Similar Photos is deliberate: without the temporal-proximity and same-device corroboration that burst detection relies on, a more permissive threshold produces many false positives — grouping photos that share a similar overall brightness pattern but are clearly different subjects. The threshold is admin-adjustable (see §8).

---

## 3. dHash Recap and the `dhash_bits` Column

### 3.1 What dHash Measures

A 64-bit dHash (difference hash) is computed from a downscaled, orientation-corrected grayscale version of the image:

1. Resize to 9×8 pixels.
2. For each row, compute whether each pixel is brighter than the one immediately to its right (8 comparisons × 8 rows = 64 bits).
3. Pack into a 64-bit integer.

Two images with the same content produce the same hash. Minor differences — JPEG re-compression, slight brightness adjustments, small crops — produce a small Hamming distance (few differing bits). Clearly different images produce a large Hamming distance.

### 3.2 Why `perceptual_hash` Is Stored as TEXT, Not `bigint`

The `media_items.perceptual_hash` column (written by the `visual-hash` storage processor and by the on-demand hash path in the enrichment handler) stores the 64-bit unsigned integer as a **decimal string in a TEXT column**. Two production bugs were encountered when the column was `bigint`:

1. **"value out of range for type bigint"** — Postgres `bigint` is signed (range −2^63 to 2^63−1). A dHash is unsigned; any hash with the high bit set (value ≥ 2^63) exceeds the signed range and causes an overflow error. This affected roughly half of all possible hash values.
2. **"Do not know how to serialize a BigInt"** — Prisma maps `bigint` columns to JavaScript `BigInt`. `JSON.stringify` has no built-in serializer for `BigInt`, so any endpoint that returned a `MediaItem` row without explicitly excluding the column would 500.

**Resolution:** `perceptual_hash` is `TEXT` in Postgres and `String` in Prisma. Application code calls `BigInt(row.perceptualHash)` only inside the burst matcher and the `dhashDecimalToBitString` conversion function, where Hamming arithmetic is required. The column is excluded from all default API serialization via a Prisma global `omit`.

This is the same lesson documented in the "Gotchas / Lessons Learned" section of CLAUDE.md and in the burst detection spec (§4.2 of `burst-detection.md`).

### 3.3 The `dhash_bits bit(64)` Column

Similar Photos introduces a second representation of the same hash value: `media_items.dhash_bits`, a native Postgres `bit(64)` column. This column exists for one purpose: to enable the pgvector `bit_hamming_ops` HNSW index for approximate nearest-neighbour Hamming search.

**Why a separate column?** Postgres does not support HNSW indexing on TEXT. The `bit(n)` type is what pgvector's `bit_hamming_ops` operator class requires. The column must be managed via raw SQL (`$queryRaw`) because Prisma does not support `bit(n)` natively (it is declared as `Unsupported("bit(64)")` in the schema).

**Conversion:** The `SimilarityDetectionService` converts the decimal string from `perceptual_hash` into a 64-character `'0'/'1'` bit string using `dhashDecimalToBitString` (in `apps/api/src/similarity/similarity-detection.service.ts`). This conversion uses JavaScript `BigInt` arithmetic to extract each bit positionally, avoiding any signed-integer overflow.

**HNSW index:** The migration creates the index inside a `DO` block that catches `undefined_object` and `feature_not_supported` exceptions. If pgvector < 0.7 is installed (which does not have `bit_hamming_ops`), the migration succeeds without the index and logs a `NOTICE`. The application falls back to an in-process JavaScript Hamming matcher (popcount via BigInt bitwise operations) in that case. The neighbor query uses the Postgres expression `bit_count(dhash_bits # ${bitString}::bit(64)) <= ${hashDistance}`, where `#` is the bitwise XOR operator and `bit_count` counts set bits.

---

## 4. Detection Algorithm

The `similarity_detection` enrichment handler processes one media item at a time. The overall approach is single-linkage union-find with a maximum group size cap.

### 4.1 On-Demand Hash Computation for Legacy Photos

For photos uploaded before the `visual-hash` storage processor was introduced, `perceptual_hash` may be null. When the handler encounters a null hash, it:

1. Downloads the raw image bytes from the storage provider using the item's `storageObjectId`.
2. Calls `computeVisualHash` from `apps/api/src/storage/processing/visual-hash.util.ts` to compute the 64-bit dHash and Laplacian sharpness score.
3. Persists both values to `media_items` before proceeding.

If the download or hash computation fails, the error is re-thrown so the enrichment queue retries. If the image is permanently unreadable, the handler logs a warning and returns without grouping the item.

### 4.2 `dhash_bits` Sync

After ensuring `perceptual_hash` is populated, the handler converts it to a bit string using `dhashDecimalToBitString` and writes it to `dhash_bits` via raw SQL. This keeps the indexed column in sync with the source-of-truth decimal string column.

### 4.3 Configuration Load

The handler reads `similarity.hashDistance` and `similarity.maxGroupSize` from the system settings `global` key (see §8).

### 4.4 Neighbor Query

The handler executes:

```sql
SELECT id, similarity_group_id
FROM media_items
WHERE circle_id = <circleId>
  AND deleted_at IS NULL
  AND id != <mediaItemId>
  AND dhash_bits IS NOT NULL
  AND bit_count(dhash_bits # <bitString>::bit(64)) <= <hashDistance>
```

All circle photos — regardless of capture time or camera — are eligible neighbors. This library-wide scan is the key difference from burst detection.

### 4.5 Group Resolution (Union-Find)

After collecting neighbors:

- **No neighbors:** The item has no near-duplicates. No group is created or modified. Return early.
- **All neighbors are ungrouped:** Create a new `SimilarityGroup` (status `pending`), assign the item and all neighbors. Cap membership to `maxGroupSize` (default 50) — excess neighbors (by `importedAt DESC`) are left ungrouped.
- **All neighbors belong to one existing group:** Join that group if it has not reached `maxGroupSize`; otherwise return without joining.
- **Neighbors belong to multiple groups:** Merge all groups into the oldest one (by `createdAt`). Reassign all members. If the merged group exceeds `maxGroupSize`, evict the most-recently-imported members (set `similarityGroupId = null`). Delete the now-empty secondary groups.

### 4.6 Score Recomputation

After any group assignment or merge, `recomputeGroupScores` is called on the target group. It reads all current non-deleted members, computes a composite score (see §5), writes `similarityScore` to each member, and updates `SimilarityGroup.suggestedBestItemId` to the highest-scoring member.

The handler is **idempotent**: processing the same item twice finds the same neighbors and produces the same group state. No duplicate groups are created.

---

## 5. Best-Shot Scoring

Each group member receives a `similarityScore` that is used to pre-select the suggested best frame. The scoring is assistive only — it never triggers automatic deletion.

### 5.1 Sharpness (Primary Signal)

Sharpness is measured as the **variance of the Laplacian** of the orientation-corrected grayscale image, stored in `MediaItem.sharpnessScore` (Float). Higher variance indicates sharper focus. This value is computed by the `visual-hash` storage processor and reused here without an additional processing pass.

### 5.2 Resolution

`MediaItem.width * MediaItem.height` is used as a tiebreaker. Higher-resolution frames are preferred among items that are equally sharp.

### 5.3 Composite Score Formula

```
similarityScore = 0.9 * normalize(sharpnessScore)
                + 0.1 * normalize(resolution)
```

All sub-signals are normalized to [0, 1] within the group before weighting (when all values in a group are equal, each receives 0.5). The member with the highest composite score becomes `SimilarityGroup.suggestedBestItemId`.

Note that Similar Photos scoring uses only sharpness and resolution. Unlike burst detection, it does not incorporate face signals, because face detection is a separate per-circle opt-in and the similarity grouping is not correlated with face-detection timing.

---

## 6. Data Model

### 6.1 New Table: `similarity_groups`

One row per detected similarity group.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `circleId` | UUID | FK → `circles` (cascade delete); groups are circle-scoped |
| `status` | `SimilarityGroupStatus` | See enum below; default `pending` |
| `suggestedBestItemId` | UUID? | FK → `media_items` (SetNull on delete); the highest-scoring member |
| `mediaCount` | Int | Denormalized count of current members; updated whenever a member joins or leaves |
| `resolvedById` | UUID? | FK → `users` (SetNull on delete); who resolved or dismissed the group |
| `resolvedAt` | DateTime? | When the group was resolved or dismissed |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |

Note: unlike `burst_groups`, `similarity_groups` does not have a `capturedAt` column. List-view ordering uses `createdAt` (the group creation timestamp) because similarity groups are not anchored to a specific capture event — members may span many years.

**`SimilarityGroupStatus` enum:**

| Value | Meaning |
|-------|---------|
| `pending` | Awaiting human review; surfaced in the review queue when `mediaCount >= similarity.minGroupSize` |
| `resolved` | Reviewer confirmed a keep set; non-kept members soft-deleted |
| `dismissed` | Reviewer indicated these are not duplicates; members ungrouped |

### 6.2 New Columns on `media_items`

| Column | Type | Notes |
|--------|------|-------|
| `similarityGroupId` | UUID? | FK → `similarity_groups` (SetNull on delete); null when not in any group |
| `similarityScore` | Float? | Composite quality score within the group; null when item is not in a group. Recomputed on every group membership change. |
| `dhash_bits` | `bit(64)` (Unsupported) | Native Postgres `bit(64)` encoding of the same hash stored in `perceptual_hash`. Written and read exclusively via `$queryRaw`. Enables the pgvector HNSW `bit_hamming_ops` index for Hamming nearest-neighbour search. See §3.3 for rationale. |

`perceptual_hash` (TEXT) and `sharpness_score` (Float) were introduced by burst detection and are reused without change.

### 6.3 New Column on `circles`

| Column | Type | Notes |
|--------|------|-------|
| `visualDedupEnabled` | Boolean | Default `false`; controls per-circle opt-in |

### 6.4 Relationships

- `similarity_groups.circleId` → `circles.id` (cascade delete: deleting a circle purges its groups)
- `similarity_groups.suggestedBestItemId` → `media_items.id` (SetNull: if the best item is deleted, clear the suggestion)
- `similarity_groups.resolvedById` → `users.id` (SetNull)
- `media_items.similarityGroupId` → `similarity_groups.id` (SetNull: soft-deleting an item does not delete the group; `mediaCount` is not automatically decremented in the DB — the service manages it)

### 6.5 Migration

Migration: `apps/api/prisma/migrations/20260621050000_add_visual_dedup/migration.sql`

The migration:

1. Creates the `SimilarityGroupStatus` enum (`pending`, `resolved`, `dismissed`).
2. Creates the `similarity_groups` table with indexes on `(circle_id, status)` and `created_at`.
3. Adds `similarity_group_id` (UUID, nullable FK with SetNull) and `similarity_score` (DOUBLE PRECISION, nullable) to `media_items`.
4. Adds `dhash_bits bit(64)` to `media_items` via raw `ALTER TABLE`.
5. Creates the HNSW index on `dhash_bits` inside a `DO` block that silently skips if `bit_hamming_ops` is unavailable (pgvector < 0.7).
6. Adds `visual_dedup_enabled BOOLEAN NOT NULL DEFAULT false` to `circles`.

---

## 7. Processing and Enrichment Flow

### 7.1 `SimilarityEnqueueListener`

`SimilarityEnqueueListener` listens for `OBJECT_PROCESSED_EVENT` (emitted after the synchronous storage processing chain completes, which means the `visual-hash` processor has already run and `perceptual_hash` may be populated).

Before enqueueing, the listener checks:

1. `MediaType` is `photo` — videos are not supported.
2. `mediaItem.deletedAt` is null.
3. `VISUAL_DEDUP_ENABLED` environment variable is not `'false'` (global kill-switch).
4. `circle.visualDedupEnabled` is `true` (per-circle opt-in).

If all checks pass, the listener calls `EnrichmentJobService.enqueue` with `type='similarity_detection'`, `reason=upload`, `priority=10`. The service's idempotency check prevents duplicate jobs.

### 7.2 `SimilarityDetectionHandler`

`SimilarityDetectionHandler` implements `EnrichmentHandler` and self-registers via `onModuleInit`. Its `process(job)` method delegates to `SimilarityDetectionService.processMediaItem(job)`.

**Priority conventions:**

| Trigger | `reason` | `priority` |
|---------|----------|------------|
| On upload | `upload` | 10 |
| Backfill | `backfill` | 100 (lowest) |

There is no per-item rerun endpoint (unlike burst detection). Backfill with `force: true` achieves the same effect.

**Retry behavior:** The handler throws on transient errors (storage download failure, database error) so the enrichment worker applies standard exponential-backoff retry logic. Permanently failed items (item not found, image unreadable, no hash computable) return early without throwing, so they are not retried.

For the full queue architecture, worker lifecycle, retry configuration, and how to add new handlers, see **[docs/specs/enrichment-queue.md](enrichment-queue.md)**.

---

## 8. Configuration

### 8.1 System Settings (Admin-Editable)

Visual deduplication parameters are stored in the `system_settings` JSONB column under the key `'global'`, at JSON path `.similarity.*`. They are editable via the admin UI and validated by a Zod schema on write.

| Setting key | Type | Range | Default | Description |
|-------------|------|-------|---------|-------------|
| `similarity.hashDistance` | integer | 0–32 | 6 | Maximum Hamming distance (bits, out of 64) for two photos to be considered near-duplicates. Lower = stricter matching. The default of 6 is stricter than burst detection's default of 10 because library-wide matching has no temporal or device corroboration. |
| `similarity.minGroupSize` | integer | 2–20 | 2 | Minimum number of items required for a group to be surfaced in the review queue. Groups below this threshold are stored in the database but not returned by the list endpoint. |
| `similarity.maxGroupSize` | integer | 2–unlimited | 50 | Maximum number of items in a single group. Prevents a single highly-duplicated photo from consuming unbounded storage and UI space. Excess members (by `importedAt DESC`) are left ungrouped. |

### 8.2 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VISUAL_DEDUP_ENABLED` | `true` | Global kill-switch. Set to `false` to disable `SimilarityEnqueueListener` for all circles. Per-circle opt-in still applies when `true`. Useful in test and CI environments where grouping noise is unwanted. |

The enrichment worker variables (`ENRICHMENT_WORKER_ENABLED`, `ENRICHMENT_JOB_POLL_MS`, `ENRICHMENT_WORKER_CONCURRENCY`) govern the queue that runs `similarity_detection` jobs alongside all other enrichment types. See [enrichment-queue.md — Configuration](enrichment-queue.md#12-configuration).

---

## 9. API Endpoints

All endpoints require JWT Bearer authentication. No new RBAC permissions are introduced — Similar Photos reuses the existing `media:read`, `media:write`, and `media:delete` system permissions combined with per-circle viewer, collaborator, and circle_admin roles. This is consistent with the authorization model used by burst detection, albums, and bulk operations.

### 9.1 Similar Photo Group Review Queue

#### `GET /api/media/similar`

List similarity groups for a circle, filtered by status.

- **Auth:** `media:read` + per-circle `viewer` role (or `media:read_any` for admin bypass)
- **Query params:**
  - `circleId` (required) — UUID of the circle
  - `status` (optional) — filter to `pending` | `resolved` | `dismissed`; defaults to `pending`
  - `page` (optional) — page number, 1-based; default 1
  - `pageSize` (optional) — items per page; default 20, max 100
- **Response `200`:**
  ```json
  {
    "items": [
      {
        "id": "uuid",
        "circleId": "uuid",
        "status": "pending",
        "mediaCount": 4,
        "createdAt": "2026-06-20T10:00:00.000Z",
        "suggestedBestItemId": "uuid",
        "suggestedBestThumbnailUrl": "https://...",
        "coverThumbnailUrls": ["https://...", "https://...", "https://..."]
      }
    ],
    "meta": { "total": 8, "page": 1, "pageSize": 20 }
  }
  ```
  `coverThumbnailUrls` contains up to 4 signed thumbnail URLs for the first 4 group members (sorted by `importedAt ASC`), for use as a stack preview. `suggestedBestThumbnailUrl` is the signed thumbnail URL for `suggestedBestItemId`.

Only groups with `mediaCount >= similarity.minGroupSize` are returned (undersized groups are not surfaced).

#### `GET /api/media/similar/:id`

Get full detail for a single similarity group: all members in import order, each with their score, thumbnail URL, and key metadata.

- **Auth:** `media:read` + per-circle `viewer` role
- **Response `200`:**
  ```json
  {
    "data": {
      "id": "uuid",
      "circleId": "uuid",
      "status": "pending",
      "mediaCount": 4,
      "createdAt": "2026-06-20T10:00:00.000Z",
      "suggestedBestItemId": "uuid",
      "resolvedById": null,
      "resolvedAt": null,
      "members": [
        {
          "id": "uuid",
          "similarityScore": 0.91,
          "sharpnessScore": 412.3,
          "thumbnailUrl": "https://...",
          "width": 4032,
          "height": 3024,
          "capturedAt": "2024-07-15T14:30:00.000Z",
          "importedAt": "2026-06-20T09:00:00.000Z",
          "isSuggestedBest": true
        }
      ]
    }
  }
  ```
  Members are ordered by `importedAt ASC`. `thumbnailUrl` is a signed URL.
- **Response `404`:** Group not found or caller is not a member of the circle.

### 9.2 Group Actions

#### `POST /api/media/similar/:id/resolve`

Mark a similarity group resolved. Soft-deletes all members whose IDs are not in `keepIds`, then records `resolvedById` and `resolvedAt`. The entire operation runs in a single database transaction.

- **Auth:** `media:delete` + per-circle `collaborator` role
- **Request body:**
  ```json
  { "keepIds": ["uuid", "uuid"] }
  ```
  `keepIds` must be a non-empty array. All IDs must belong to this group. The caller may keep all members (zero deletions).
- **Response `200`:**
  ```json
  { "data": { "deleted": 3, "kept": 1, "groupStatus": "resolved" } }
  ```
- **Response `400`:** `keepIds` contains IDs not belonging to this group, or the group is not in `pending` status.
- **Response `404`:** Group not found.

#### `POST /api/media/similar/:id/dismiss`

Mark a similarity group dismissed, indicating the reviewer considers these items to not be duplicates. Clears `similarityGroupId` and `similarityScore` on all members so they are no longer associated with any group; no items are deleted.

- **Auth:** `media:write` + per-circle `collaborator` role
- **Response `200`:**
  ```json
  { "data": { "groupStatus": "dismissed", "ungrouped": 4 } }
  ```
- **Response `400`:** Group is not in `pending` status.
- **Response `404`:** Group not found.

### 9.3 Backfill

#### `POST /api/media/similar/backfill`

Bulk-enqueue `similarity_detection` jobs for photos in a circle. Requires the circle to have `visualDedupEnabled = true`.

For each enqueued photo that lacks a `perceptual_hash`, the enrichment job performs on-demand fingerprinting: downloads the image from the storage provider, runs `computeVisualHash` to compute the 64-bit dHash and Laplacian sharpness score, and persists both before running the grouping logic. This retroactive path enables backfill to operate on libraries uploaded before the visual dedup feature was introduced.

- **Auth:** `media:write` + per-circle `collaborator` role
- **Requirement:** `circle.visualDedupEnabled` must be `true`; otherwise returns `400 Bad Request`.
- **Request body:**
  ```json
  {
    "circleId": "uuid",
    "from": "2023-01-01T00:00:00.000Z",
    "to": "2025-12-31T23:59:59.999Z",
    "force": false
  }
  ```
  `from` and `to` are optional ISO-8601 datetime strings bounding the `capturedAt` range of photos to enqueue (both bounds are inclusive). They may be provided independently or together. `from > to` returns `400 Bad Request`. When omitted, all eligible photos in the circle are in scope.

  When `force` is `false` (default), only photos without an existing `similarityGroupId` and without a `succeeded` `similarity_detection` job are enqueued. When `force` is `true`, all non-deleted photos within the scope are enqueued (useful after changing `similarity.hashDistance`, to re-fingerprint photos that previously failed hashing, or to regroup the library from scratch).
- **Response `201`:**
  ```json
  { "data": { "enqueued": 287 } }
  ```
- **Error cases:**
  - `400` — `circle.visualDedupEnabled` is `false`
  - `400` — `from` is later than `to`

### 9.4 Per-Circle Dedup Settings

#### `GET /api/circles/:id/dedup-settings`

Get the per-circle visual deduplication opt-in flag.

- **Auth:** `circles:read` + per-circle `viewer` role
- **Response `200`:**
  ```json
  { "visualDedupEnabled": false }
  ```

#### `PUT /api/circles/:id/dedup-settings`

Enable or disable visual deduplication for a circle. Writes an `audit_events` row with action `circle:dedup_settings_update`.

- **Auth:** `circles:write` + per-circle `circle_admin` role (or `circles:manage_any` for admin bypass)
- **Request body:**
  ```json
  { "enabled": true }
  ```
- **Response `200`:**
  ```json
  { "visualDedupEnabled": true }
  ```

### 9.5 Circle Dashboard

`GET /api/media/dashboard?circleId=` gains a `pendingSimilarityGroups` field in its response. This is the count of similarity groups for the circle with `status = pending` and `mediaCount >= similarity.minGroupSize`. The count feeds into the review-queue section of the dashboard UI alongside `pendingBurstGroups`.

---

## 10. UI

### 10.1 Review Queue Surface

A "Similar Photos" page lists pending similarity groups for the active circle. Each group is displayed as a visual stack of thumbnails with a badge showing the total member count.

Opening a group shows a grid view of all members in import order, each displaying:
- The thumbnail at a generous size (to allow sharpness differences to be visible).
- The `similarityScore` as a quality indicator.
- A "Best pick" highlight on the `suggestedBestItemId` member.
- Capture timestamp, import date, and resolution.

The reviewer selects which frames to keep (with the suggested best pre-selected). A "Keep selected, delete rest" action fires `POST /api/media/similar/:id/resolve`. A "Dismiss — not duplicates" action fires `POST /api/media/similar/:id/dismiss`.

### 10.2 Dashboard Integration

The circle dashboard's review-queue section gains a "Similar photos" entry showing the `pendingSimilarityGroups` count alongside burst groups and other review-queue items.

### 10.3 Per-Circle Settings Toggle and Scan Panel

The circle settings page gains a "Similar Photos" toggle card, consistent with the existing "Burst Detection", "Face Recognition", and "Auto-Tagging" toggle cards. Enabling the toggle calls `PUT /api/circles/:id/dedup-settings { enabled: true }`.

Below the toggle, a scan panel is visible when visual deduplication is enabled. It exposes:
- An optional **capture date range** (from / to date pickers) to scope the scan to a specific date window.
- A **Force re-scan** checkbox that maps to the `force` request parameter.
- A **Run scan** button that calls `POST /api/media/similar/backfill` and displays the `{ enqueued }` result.

The sidebar gains a "Similar Photos" navigation entry that links to the review queue page.

---

## 11. Security and Privacy

### All Processing Is On-Server

The dHash computation and sharpness scoring run entirely within the API process using `sharp`. No pixel data leaves the server. The perceptual hash is a compact 64-bit integer that does not allow reconstruction of the original image.

### Non-Destructive by Design

The system stores suggestions and similarity scores in the database. No deletion occurs without an authenticated, authorized API call to `POST /api/media/similar/:id/resolve` with an explicit `keepIds` list. Soft-deletion is used (sets `deletedAt`); records remain recoverable by an admin until a hard-delete sweep is run separately.

### Per-Circle Opt-In

`visualDedupEnabled` defaults to `false`. `SimilarityEnqueueListener` checks the flag before enqueueing. Backfill also refuses to run when the flag is false. A circle never participates in visual deduplication unless a `circle_admin` explicitly enables it.

### Authorization

All similarity group endpoints enforce per-circle role checks. Viewers can read group data. Collaborators can resolve or dismiss groups and run backfill. Circle admins can toggle the opt-in flag. No new RBAC permissions are added.

### Audit Trail

`PUT /api/circles/:id/dedup-settings` writes an `audit_events` row with action `circle:dedup_settings_update`, `actorUserId`, and the new `visualDedupEnabled` value in `meta`. This matches the pattern used by face recognition, auto-tagging, and burst detection settings.

---

## 12. Accuracy Trade-offs and Limitations

dHash-only library-wide matching is a practical, fast, on-server approach to near-duplicate detection. It has honest strengths and weaknesses that users and administrators should understand.

### What dHash Reliably Catches

- **Re-imports:** The same file imported twice produces a Hamming distance of 0.
- **Cloud-sync duplicates:** Photos synced from multiple devices that are pixel-identical or near-identical after JPEG re-encoding.
- **Light edits:** Brightness/contrast adjustments, mild cropping, and JPEG re-compression that preserve the overall visual structure produce distances of 0–4 bits.
- **Consecutive near-identical frames:** Rapid-fire sequences from different cameras, or from the same camera outside the burst detection time window, where the subject is nearly stationary.

### What dHash Will Not Group

- **Same subject, different angle or zoom:** A portrait taken from the front and a portrait taken from the side are visually different at the pixel level. dHash treats them as different images.
- **Same location, different time of day:** A photo of a mountain at sunrise and the same mountain at noon will differ substantially in brightness distribution and thus in hash distance.

### False Positives

dHash without temporal or device corroboration is more false-positive-prone than burst detection. Two distinct photos that happen to have a similar overall brightness distribution — a white wall, a clear blue sky — may produce a small Hamming distance even though they show clearly different scenes.

The stricter default threshold (6 bits vs. burst detection's 10 bits) is the primary mitigation. Administrators who experience too many false positives should lower `similarity.hashDistance` further (toward 3–4). Administrators who find too few true duplicates are being caught should raise it (toward 8–10), accepting a higher false-positive rate.

The non-destructive review queue is the ultimate safety net: a human reviews every group before anything is deleted. A false-positive group costs reviewer time but causes no data loss.

### Future Option: Image Embeddings

A future version of this feature could replace or complement dHash with a 512-d or 1024-d visual embedding from a vision model, which would match semantically similar photos (same subject from different angles). The `similarity_groups` table, the review queue UI, and the enrichment handler structure are all designed to be agnostic to the underlying matching signal — swapping the neighbor query from a Hamming search to a pgvector cosine search would require changes only in `SimilarityDetectionService.processMediaItem`, with no changes to the API contracts or UI. This upgrade path is available behind the same admin UI toggle.

---

## 13. Testing Notes

### Unit Tests

- **`dhashDecimalToBitString`:** verify correct 64-character output for known decimal values; verify that `BigInt(0).toString()` produces `"0"` and maps to all-zero bits; verify that the maximum unsigned 64-bit value maps to all-one bits.
- **`normalize`:** verify [0, 1] normalization; verify the equal-value fallback returns 0.5 for all entries.
- **`recomputeGroupScores`:** mock Prisma and verify composite score weights (90% sharpness, 10% resolution); verify `suggestedBestItemId` points to the member with the highest composite score; verify the equal-case fallback.
- **`SimilarityDetectionService.processMediaItem`:** mock Prisma and storage provider; verify group creation for two-member group; verify join of existing group; verify multi-group merge into oldest group; verify `maxGroupSize` cap evicts excess members; verify early return when `perceptualHash` cannot be computed.

### Integration Tests

- **Basic grouping:** upload two photos in the same circle with matching mock `perceptualHash` values within `hashDistance`; verify a `SimilarityGroup` row is created after both `similarity_detection` jobs complete and both items have `similarityGroupId` set.
- **Minimum group size:** upload two items that group (distance ≤ D); verify the group exists in the database but is not returned by `GET /api/media/similar` when `similarity.minGroupSize = 3`; upload a third; verify the group is now returned.
- **Cross-time, cross-device grouping:** upload two items with matching hash but `capturedAt` values one year apart and different `cameraMake`; verify they are grouped (Similar Photos has no time or device gating).
- **Resolve endpoint:** verify soft-delete is applied to non-kept members, group status changes to `resolved`, kept items remain accessible via `GET /api/media/:id`.
- **Dismiss endpoint:** verify `similarityGroupId` and `similarityScore` are cleared on all members, group status changes to `dismissed`.
- **Opt-in check:** verify `SimilarityEnqueueListener` does not enqueue when `circle.visualDedupEnabled = false`.
- **`VISUAL_DEDUP_ENABLED=false`:** set the environment variable and verify the listener skips all circles.
- **Backfill — force=false:** call backfill; verify already-grouped items are not re-enqueued; call again with `force: true`; verify all items are enqueued.
- **Backfill — date range:** seed two photos with distinct `capturedAt` dates; call backfill with `from`/`to` scoping to only one date; verify only that photo is enqueued; verify `from > to` returns 400.
- **Backfill — `visualDedupEnabled=false`:** verify returns 400.
- **On-demand hashing:** seed a photo with `perceptualHash = null`; run the enrichment job; verify `perceptualHash`, `sharpnessScore`, and `dhash_bits` are written before grouping logic runs.
- **`maxGroupSize` cap:** configure `similarity.maxGroupSize = 3`; upload 5 photos that all hash-match; verify the group has at most 3 members.

### RBAC Tests

- Verify a viewer can call `GET /api/media/similar` and `GET /api/media/similar/:id` but receives `403` on resolve, dismiss, and backfill.
- Verify a collaborator can call resolve, dismiss, and backfill.
- Verify `PUT /api/circles/:id/dedup-settings` returns `403` for a collaborator and `200` for a `circle_admin`.
- Verify a non-member receives `403` on all similarity endpoints.

### Environment

Set `ENRICHMENT_WORKER_ENABLED=false` in test environments to prevent the enrichment worker from processing queued jobs during tests that verify only enqueue behavior. For integration tests requiring end-to-end processing, set `ENRICHMENT_JOB_POLL_MS=100` and enable the worker explicitly.

---

## 14. Future Work

| Capability | Notes |
|------------|-------|
| Visual embedding upgrade | Replace or augment dHash with a 512-d or 1024-d visual embedding to catch same-subject photos at different angles. The `similarity_groups` table and API contracts are signal-agnostic — only `SimilarityDetectionService.processMediaItem` would change. |
| Per-item rerun endpoint | Allow re-enqueueing `similarity_detection` for a single item from the media properties pane (mirrors `POST /api/media/:id/faces/rerun`). Currently only backfill with `force: true` achieves this. |
| Storage savings estimate | Display the estimated bytes that would be freed if all non-suggested-best members across pending groups were deleted. |
| Cross-circle admin view | Allow admins to view similarity groups across all circles (requires `media:read_any` bypass). |
| Configurable scoring weights | Expose sharpness and resolution weights as admin-editable system settings rather than code constants. |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 2026 | AI Assistant | Initial specification |
