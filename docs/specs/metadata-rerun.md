# Metadata Extraction Re-run — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | June 2026 |
| **Status** | Specification |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Why It Exists — The mergeOutput Regression](#2-why-it-exists--the-mergeoutput-regression)
3. [Architecture](#3-architecture)
4. [Data Model](#4-data-model)
5. [API Endpoints](#5-api-endpoints)
6. [Backfill Semantics](#6-backfill-semantics)
7. [UI Entry Points](#7-ui-entry-points)
8. [Testing Notes](#8-testing-notes)

---

## 1. Overview and Goals

Metadata re-run lets a user or administrator re-extract EXIF, image dimensions, reverse-geocode, and video-probe data for one or many media items without re-triggering downstream enrichment (auto-tagging, face detection, burst detection). The feature is implemented as a `metadata_extraction` enrichment job type that plugs into the existing `enrichment_jobs` queue and inherits standard retry, observability, and admin job-dashboard support at zero infrastructure cost.

### Goals

- Re-run the four metadata processors (`exif`, `dimensions`, `geocode`, `video-probe`) on demand for a single item or a whole circle.
- Write corrected typed columns (EXIF fields, GPS coordinates, video duration, etc.) directly to `media_items` without triggering a cascade to auto-tagging, face detection, or burst detection.
- Track per-item status in `media_metadata_status` so users can see whether a rerun has completed.
- Provide a backfill endpoint with optional `capturedAt` range and force flag so legacy photos with missing fields can be re-processed selectively.

### Non-Goals

- The feature does not extract thumbnails or visual hashes (those belong to separate processors and pipelines).
- There is no per-circle opt-in. Any collaborator in any circle can trigger a rerun.
- There is no upload-time enqueue. EXIF extraction already runs during the normal upload storage-processing chain. This feature is for on-demand correction only.
- Reruns do not re-trigger auto-tagging, face detection, or burst detection. The handler deliberately omits the `OBJECT_PROCESSED_EVENT` emission that would start those pipelines.

---

## 2. Why It Exists — The mergeOutput Regression

During a refactor of the storage processing pipeline, a `mergeOutput` configuration option was incorrectly set in the EXIF processor, causing the processor to produce a flattened output object that did not match the key paths expected by `MediaMetadataSyncService`. As a result, many uploaded photos had their EXIF fields (GPS coordinates, capture timestamp, camera make/model, etc.) remain `null` on the `media_items` row even though the raw EXIF data was present in the uploaded file.

Re-uploading the affected photos was not practical. The metadata re-run feature was introduced to fix the affected rows in place: re-read the stored file from S3, run the metadata processors with the corrected configuration, and sync the results directly into `media_items`.

The backfill endpoint (`POST /api/metadata/backfill`) is the primary remediation tool. The single-item rerun (`POST /api/media/:id/metadata/rerun`) provides a convenient way to fix individual photos from the media properties pane.

---

## 3. Architecture

### 3.1 Enrichment Job Type: `metadata_extraction`

`metadata_extraction` is a new job type in the `enrichment_jobs` queue. It is handled by `MetadataExtractionHandler` (`apps/api/src/metadata/metadata.handler.ts`), which self-registers with `EnrichmentHandlerRegistry` via `onModuleInit`. The worker dispatches the job to `MetadataExtractionService.processMediaItem` (`apps/api/src/metadata/metadata.service.ts`).

**Priority conventions:**

| Trigger | `reason` | `priority` |
|---------|----------|------------|
| Per-item rerun (user) | `rerun` | 0 (highest) |
| Backfill | `backfill` | 100 (lowest) |

There is no `upload` reason — metadata extraction does not enqueue at upload time.

For queue architecture, worker lifecycle, and retry configuration, see [enrichment-queue.md](enrichment-queue.md).

### 3.2 Processor Allowlist

`MetadataExtractionService` accepts the full `OBJECT_PROCESSOR` token injection but filters it to a fixed allowlist before running:

```
METADATA_PROCESSOR_ALLOWLIST = ['exif', 'dimensions', 'geocode', 'video-probe']
```

Processors not in the allowlist — including `visual-hash` (used by burst detection), `thumbnail`, and `content-hash` — are never invoked by this handler. This prevents burst scores, thumbnails, or content hashes from being changed during a metadata rerun.

### 3.3 Processing Flow

1. Load `MediaItem` (with `storageObject`). If the item is missing, deleted, or has no `StorageObject`, mark status `failed` and return (non-retryable skip).
2. Upsert `media_metadata_status` to `processing`.
3. Reload `StorageObject` with its `metadata` JSONB.
4. Run each allowlisted processor in priority order. Processors that return `canProcess = false` are skipped. Processor failures are caught individually and recorded as `${name}_error` keys in the merged metadata; they do not abort the run.
5. Deep-merge processor output into `storageObject.metadata._processing`, preserving existing keys not touched by this run. Write `_processedAt` timestamp.
6. Persist the merged metadata back to `StorageObject`.
7. Call `MediaMetadataSyncService.syncFromStorageObject(storageObjectId)` to write typed columns (GPS coordinates, capture timestamp, dimensions, video duration, etc.) into `media_items` directly.
8. **Do NOT emit `OBJECT_PROCESSED_EVENT`.** This is intentional: the event would trigger `AutoTaggingEnqueueListener`, `FaceDetectionEnqueueListener`, and `BurstEnqueueListener`, which is not desired for a metadata-only correction.
9. Upsert `media_metadata_status` to `processed` with `processedAt = now`.

On any uncaught error, mark status `failed` with `lastError` message and re-throw so the worker applies standard retry logic.

### 3.4 Module Wiring

`MetadataModule` (`apps/api/src/metadata/metadata.module.ts`) registers the four processor classes individually, aggregates them under the `OBJECT_PROCESSOR` multi-provider token, and provides `MetadataExtractionHandler`, `MetadataExtractionService`, and `MetadataController`. It imports `MediaModule` to access `MediaMetadataSyncService`.

---

## 4. Data Model

### 4.1 New Table: `media_metadata_status`

One row per media item. Tracks the status of the most recent `metadata_extraction` enrichment job for that item.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `mediaItemId` | UUID | FK → `media_items` (cascade delete); unique — one row per item |
| `circleId` | UUID | FK → `circles` (cascade delete); denormalized for indexed queries |
| `status` | `MediaMetadataStatusType` | See enum below; default `not_processed` |
| `processedAt` | DateTime? | Set when status transitions to `processed` |
| `lastError` | String? | Set when status transitions to `failed` |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |

**`MediaMetadataStatusType` enum:**

| Value | Meaning |
|-------|---------|
| `not_processed` | No metadata rerun has been attempted (virtual — rows are created with `pending`, not `not_processed`; this value is returned by the API when no row exists) |
| `pending` | Job enqueued, not yet picked up by the worker |
| `processing` | Worker has claimed and started the job |
| `processed` | All processors ran; typed columns synced successfully |
| `failed` | Processing failed; see `lastError` for details |

**Indexes:**

- Unique on `media_item_id` (one status row per item)
- Index on `circle_id` (for backfill candidate queries)
- Index on `status` (for filtering pending/failed items)

---

## 5. API Endpoints

All endpoints require JWT Bearer authentication. No new RBAC permissions are introduced — the feature reuses existing `media:read` and `media:write` permissions combined with per-circle viewer and collaborator roles.

### 5.1 Per-Item Rerun

#### `POST /api/media/:id/metadata/rerun`

Re-enqueue metadata extraction for a single media item.

- **Auth:** `media:write` + per-circle `collaborator` role (or `media:write_any` for admin bypass)
- **Path param:** `id` — UUID of the media item
- **Request body:** none
- **Response `201`:**
  ```json
  {
    "data": {
      "jobId": "uuid",
      "status": "pending"
    }
  }
  ```
  The job is enqueued at priority 0 (highest). `media_metadata_status` is upserted to `pending` immediately. Computation is asynchronous — poll `GET /api/media/:id/metadata/status` to track progress.
- **Response `404`:** Item not found or soft-deleted.
- **Response `403`:** Caller is not a `collaborator` in the item's circle.

### 5.2 Per-Item Status

#### `GET /api/media/:id/metadata/status`

Get the current metadata extraction status for a single media item.

- **Auth:** `media:read` + per-circle `viewer` role (or `media:read_any` for admin bypass)
- **Path param:** `id` — UUID of the media item
- **Response `200`:**
  ```json
  {
    "data": {
      "status": "processed",
      "processedAt": "2026-06-21T02:15:00.000Z",
      "lastError": null
    }
  }
  ```
  When no `media_metadata_status` row exists for the item, `status` is `"not_processed"` and both `processedAt` and `lastError` are `null`.
- **Response `404`:** Item not found or soft-deleted.

### 5.3 Circle Backfill

#### `POST /api/metadata/backfill`

Bulk-enqueue `metadata_extraction` jobs for media items in a circle.

- **Auth:** `media:write` + per-circle `collaborator` role (or `media:write_any` for admin bypass)
- **Request body:**
  ```json
  {
    "circleId": "uuid",
    "from": "2025-01-01T00:00:00.000Z",
    "to": "2025-12-31T23:59:59.999Z",
    "force": false
  }
  ```
  `from` and `to` are optional ISO-8601 datetime strings bounding the `capturedAt` range of items to consider (inclusive). `force` defaults to `false`. See [§6 Backfill Semantics](#6-backfill-semantics) for candidate selection details.
- **Response `201`:**
  ```json
  {
    "data": { "enqueued": 142 }
  }
  ```
  Jobs are enqueued at priority 100 (background). Each enqueued item has its `media_metadata_status` upserted to `pending`.
- **Response `403`:** Caller is not a `collaborator` in the circle.

---

## 6. Backfill Semantics

The backfill endpoint queries `media_items` in the target circle with the following filters applied in combination:

1. **Circle scope:** `circleId` = request `circleId`.
2. **Not deleted:** `deletedAt IS NULL`.
3. **Date range (optional):** when `from` or `to` is provided, `capturedAt` is filtered against the range using the shared `whereDateRange` helper (inclusive bounds; null `capturedAt` values are excluded when a bound is specified).
4. **Force flag:**
   - `force = false` (default): only items whose `media_metadata_status` row is absent OR whose status is NOT `processed` are included. This skips items that have already been successfully processed and avoids unnecessary re-runs.
   - `force = true`: all non-deleted items in scope are enqueued regardless of existing status. Use this after a processor bug fix or configuration change that requires all items to be re-processed, even those that previously succeeded.

For each selected item, the endpoint:
- Calls `EnrichmentJobService.enqueue` with `type='metadata_extraction'`, `reason=backfill`, `priority=100`.
- Upserts `media_metadata_status` to `pending`.

The `enqueued` response count reflects the number of jobs successfully submitted in the request.

---

## 7. UI Entry Points

### 7.1 Media Properties Pane (MediaDetailDrawer)

A "Re-run metadata extraction" button in the media detail drawer calls `POST /api/media/:id/metadata/rerun` for the currently viewed item. The button is visible to collaborators and above. After the call, the UI polls `GET /api/media/:id/metadata/status` and displays the current status (`pending`, `processing`, `processed`, or `failed`) alongside `processedAt` and any `lastError`.

### 7.2 Circle Settings Tab — Backfill Panel

The circle Settings tab includes a "Re-extract metadata" panel (visible to `circle_admin` role). The panel provides:

- An optional **capture date range** (`from` / `to` date pickers) to scope the backfill to a specific time window rather than re-processing the entire circle.
- A **Force re-run** checkbox that maps to the `force` request parameter.
- A **Run** button that calls `POST /api/metadata/backfill` with the selected options and displays the `{ enqueued }` result.

This panel is the primary tool for the mergeOutput regression remediation: an admin can select the affected date range and run the backfill without touching photos that were uploaded correctly.

---

## 8. Testing Notes

### Unit Tests

- **`MetadataExtractionService.processMediaItem`:** mock Prisma and verify status transitions (`pending → processing → processed`), processor invocation, metadata merge, `syncFromStorageObject` call, and absence of `OBJECT_PROCESSED_EVENT` emission.
- **Graceful skip:** verify that a missing, deleted, or storageObject-less item marks status `failed` and does not throw.
- **Processor allowlist:** verify that processors whose `name` is not in the allowlist are not invoked.
- **Per-processor failure isolation:** mock one processor to throw and verify the other processors still run and status is `processed` (individual processor errors are recorded as `_error` keys but do not abort the run).

### Integration Tests

- **Full pipeline:** enqueue a `metadata_extraction` job and verify that `media_metadata_status` transitions through `pending → processing → processed` and that typed columns on `media_items` are updated.
- **No cascade:** verify that no `auto_tagging`, `face_detection`, or `burst_detection` jobs are enqueued as a side effect of a `metadata_extraction` job completing.
- **Backfill — force=false:** seed items with `status=processed` and items with no status row; call backfill with `force=false`; verify only the unprocessed items are enqueued.
- **Backfill — force=true:** call backfill with `force=true`; verify all non-deleted items in the circle are enqueued regardless of their existing status.
- **Backfill — date range:** seed items with distinct `capturedAt` values; call backfill with a `from`/`to` range covering only some items; verify only those items are enqueued.
- **Status endpoint — no row:** call `GET /api/media/:id/metadata/status` for an item with no `media_metadata_status` row; verify response is `{ status: 'not_processed', processedAt: null, lastError: null }`.

### RBAC Tests

- Verify a `viewer` can call `GET /api/media/:id/metadata/status` but receives `403` on `POST /api/media/:id/metadata/rerun` and `POST /api/metadata/backfill`.
- Verify a `collaborator` can call both write endpoints.
- Verify a non-member receives `403` on all three endpoints.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 2026 | AI Assistant | Initial specification |
