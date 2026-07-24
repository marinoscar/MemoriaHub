# Archive & Trash Bin — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.2 |
| **Last Updated** | July 2026 |
| **Status** | Implemented |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Semantic Definitions — Archive vs Trash](#2-semantic-definitions--archive-vs-trash)
3. [Data Model](#3-data-model)
4. [Search-Inclusion Asymmetry](#4-search-inclusion-asymmetry)
5. [API Endpoints](#5-api-endpoints)
6. [Trash Purge Job](#6-trash-purge-job)
7. [System Setting — retentionDays](#7-system-setting--retentiondays)
8. [Dedup-on-Restore](#8-dedup-on-restore)
9. [Manual Purge from the Trash Page](#9-manual-purge-from-the-trash-page)
10. [Empty Trash at Scale (Async Run Model)](#10-empty-trash-at-scale-async-run-model)
11. [Security and RBAC](#11-security-and-rbac)
12. [Gotchas and Implementation Notes](#12-gotchas-and-implementation-notes)

---

## 1. Overview and Goals

The Archive & Trash feature gives users two distinct ways to remove media items from the main library view without losing data.

**Archive** is a long-term hiding mechanism. Users archive items they no longer want cluttering the main browse view but are not ready to delete — blurry shots, duplicates they want to keep for reference, seasonal photos. Archived items remain fully searchable.

**Trash** is a recoverable delete with automatic purge. The existing "delete" action now moves items to the Trash (sets `deleted_at`) rather than destroying them immediately. Items stay in Trash for a configurable retention window (default 30 days) before being permanently erased by the automated purge job.

### Goals

- Give users a safety net before data is destroyed.
- Keep archived items discoverable via search while removing them from browse surfaces.
- Automate permanent deletion on a configurable schedule without requiring user action.
- Reuse the existing `deleted_at` soft-delete column for Trash to avoid data model fragmentation.
- Run automatic purge on the shared enrichment queue so it inherits retries, observability, and the `/admin/jobs` dashboard at zero infrastructure cost.

### Non-Goals

- There is no per-circle opt-in for archive or trash. The features are always available.
- Trash does not track a per-item expiry. All items in a circle share the global `storage.trash.retentionDays` setting.
- Archive does not have its own retention policy. Archived items are never auto-deleted; only a user action can delete an archived item.

---

## 2. Semantic Definitions — Archive vs Trash

The two states are **independent columns** on `media_items`. An item can be in any combination:

| `deleted_at` | `archived_at` | Effective state |
|---|---|---|
| `null` | `null` | Active — visible in all browse surfaces and search |
| `null` | non-null | Archived — hidden from browse, visible in search and the dedicated Archive page |
| non-null | `null` | Trashed — hidden from browse and search; visible only on the Trash page |
| non-null | non-null | Trashed while archived — treated as Trashed; the Trash page does not filter by `archived_at` |

**Archive state:** controlled by `archivedAt` (Prisma column name) / `archived_at` (Postgres column). Setting it hides the item from Home, the circle dashboard, Albums, People, Explore, and Map. It does not prevent the item from appearing in `GET /api/search` results.

**Trash state:** controlled by `deletedAt` / `deleted_at`. This is the same column used by all pre-existing soft-delete paths (`DELETE /api/media/:id`, `POST /api/media/bulk/delete`). Items with a non-null `deleted_at` are excluded from all standard `listMedia` queries, all search queries, and all browse surfaces.

---

## 3. Data Model

No new tables are required. The feature adds one column to `media_items`.

### New Column: `media_items.archived_at`

| Property | Value |
|---|---|
| Type | `DateTime?` (nullable timestamptz) |
| Default | `null` |
| Null meaning | Not archived (active) |
| Non-null meaning | Archived; value is the timestamp when the item was archived |
| Index | No dedicated index (filtered queries always scope by `circleId` first) |

The existing `deleted_at` column continues to serve as the Trash marker. No schema change is required for Trash itself.

### Partial Unique Index (Dedup)

The dedup index for `media_items` is:

```sql
CREATE UNIQUE INDEX media_items_circle_hash_unique
  ON media_items (circle_id, content_hash)
  WHERE deleted_at IS NULL;
```

This index does not include `archived_at`, so archived items participate in dedup. If an archived item with the same hash exists, uploading a duplicate will still deduplicate to the existing (archived) item.

---

## 4. Search-Inclusion Asymmetry

This is the most important design subtlety in the feature.

### Browse surfaces exclude archived items

Every browse query — `listMedia`, `listLocations`, `explorePlaces`, `exploreTags`, `getDashboard`, `addAlbumItemsByFilter`, the agentic search tool's `search_media` — passes `excludeArchived: true` into `buildMediaWhere`. This causes `buildMediaWhere` to add `archivedAt: null` to the Prisma where clause, filtering out archived items silently.

### Search includes archived items by default

`POST /api/search` and `GET /api/search/fields` do **not** modify the baseline `buildWhereFromFields` to add an `archivedAt` filter. Archived items are therefore included in search results unless the caller explicitly opts out.

### Why the asymmetry?

Archived items were deliberately chosen to remain visible in search. The intended user experience is: archive hides items from casual browsing, but if a user actively searches for a specific photo (by tag, date, person, etc.) they should find it even if it is archived. This matches how "archive" works in email clients.

### Implementation: caller-controlled opt-in flag

The `buildMediaWhere` function accepts an optional `excludeArchived?: boolean` parameter. Browse callers pass `true`; search callers omit it (or pass `false`), preserving the default inclusive behavior.

```typescript
// Browse — hides archived:
buildMediaWhere(circleId, { ..., excludeArchived: true })

// Search — includes archived (default):
buildMediaWhere(circleId, { ... })
// or equivalently:
buildMediaWhere(circleId, { ..., excludeArchived: false })
```

The `buildWhereFromFields` function (used by `POST /api/search`) follows the same pattern. The searchable field registry exposes `excludeArchived` as a boolean field with key `'excludeArchived'` so search API callers can opt out of archived items when they want to.

**Why the baselines were NOT modified for archive:**

Modifying `buildMediaWhere` or `buildWhereFromFields` to always exclude archived items would silently change the behavior of every existing search caller. Instead, the flag is additive: omitting it leaves the query unchanged, and passing `true` tightens it. Browse callers have been updated to pass `true`; all other callers continue to work with no change.

---

## 5. API Endpoints

All endpoints are mounted under `/api/media` and require a valid JWT. See [CLAUDE.md — Media — Archive & Trash](../../CLAUDE.md#media--archive--trash) for the full endpoint table.

### Archive endpoints

| Method | Path | Body | Response | Min per-circle role |
|---|---|---|---|---|
| `PATCH` | `/api/media/bulk/archive` | `{ circleId, ids[] }` (1–500 UUIDs) | `{ archived: number }` | collaborator |
| `PATCH` | `/api/media/bulk/unarchive` | `{ circleId, ids[] }` (1–500 UUIDs) | `{ unarchived: number }` | collaborator |
| `GET` | `/api/media/archived` | `?circleId=&page=&pageSize=` | paginated MediaItem list | viewer |

`bulkArchive` silently skips items that are already archived or trashed (the `updateMany` where clause is `{ archivedAt: null, deletedAt: null }`). The returned `archived` count reflects only the items actually changed.

### Trash endpoints

| Method | Path | Body | Response | Min per-circle role |
|---|---|---|---|---|
| `GET` | `/api/media/trash` | `?circleId=&page=&pageSize=` | paginated MediaItem list | viewer |
| `POST` | `/api/media/trash/restore` | `{ circleId, ids[] }` (1–500 UUIDs) | `{ restored: number, conflicts: string[] }` | collaborator |
| `POST` | `/api/media/trash/delete-forever` | `{ circleId, ids[] }` (1–500 UUIDs) | `{ deleted: number }` | collaborator |
| `POST` | `/api/media/trash/empty` | `{ circleId }` | `{ runId, status, matchedCount }` (async — see §10) | circle_admin |

`listTrash` queries `where { circleId, deletedAt: { not: null } }` and does **not** filter on `archivedAt`, so items trashed while archived appear in the Trash page.

`deleteForever` calls `MediaService.purgeMediaItemsBatched`, which hard-deletes DB rows and S3 blobs in batches (see §10 for why this replaced the older per-item `purgeMediaItems` on the hot paths). This is irreversible.

**`emptyTrash` is asynchronous (issue #165).** Unlike `deleteForever`, `POST /api/media/trash/empty` no longer purges anything synchronously in the request — it starts a background run and returns immediately. See [§10 — Empty Trash at Scale](#10-empty-trash-at-scale-async-run-model) for the full run lifecycle, job types, and progress-polling endpoints.

Permission note: both `delete-forever` and `empty` require the `media:delete` system permission in addition to the per-circle role check.

---

## 6. Trash Purge Job

### Components

| Component | File | Role |
|---|---|---|
| `TrashPurgeTask` | `apps/api/src/media/trash-purge.task.ts` | Hourly cron; enqueues `trash_purge` job when none is pending/running |
| `TrashPurgeHandler` | `apps/api/src/media/trash-purge.handler.ts` | Enrichment handler; type `'trash_purge'`; self-registers via `onModuleInit` |
| `MediaService.purgeMediaItems` | `apps/api/src/media/media.service.ts` | Shared helper; hard-deletes DB rows and S3 blobs for a list of IDs |

### Flow

```
Every clock hour
  TrashPurgeTask.handleScheduledPurge()
    ├── check for existing pending/running trash_purge job
    │     └── if found → SKIP (queue already has one)
    └── EnrichmentJobService.enqueue({
          type: 'trash_purge',
          mediaItemId: null,   // global job
          circleId: null,      // global job
          reason: 'backfill',
          priority: 100,       // low priority — background work
        })

EnrichmentJobWorker claims job
  TrashPurgeHandler.process(job)
    ├── read storage.trash.retentionDays (default 30)
    ├── cutoff = now() - retentionDays * 86400s
    ├── find all media_items where deleted_at < cutoff (all circles)
    └── MediaService.purgeMediaItems(ids)
          ├── hard-delete storage_objects rows
          ├── delete S3 blobs (best-effort; errors logged, not thrown)
          └── hard-delete media_items rows (cascades to all child tables)
```

### Global Job Deduplication

`trash_purge` is a global enrichment job (`mediaItemId: null`). The `EnrichmentJobService.enqueue` idempotency check matches on `(type='trash_purge', mediaItemId IS NULL)` — only one `trash_purge` job can be `pending` or `running` at a time. `TrashPurgeTask` also does an early-exit check before calling `enqueue`, but the queue-level idempotency is the authoritative guard.

### Retries

The job inherits the standard enrichment worker retry behavior: up to `ENRICHMENT_MAX_ATTEMPTS` (default 3) attempts on normal errors, with equal-jitter exponential backoff. A permanently failed job is visible in `/admin/jobs` under `type='trash_purge'` and can be retried manually.

### Visibility in /admin/jobs

The `trash_purge` job type appears in all admin jobs dashboard views:
- `GET /api/admin/jobs/stats` — counted in `byType` breakdown under `type='trash_purge'`.
- `GET /api/admin/jobs?type=trash_purge` — filterable job list.
- Per-row retry and delete actions.

---

## 7. System Setting — retentionDays

**Key:** `storage.trash.retentionDays`

| Property | Value |
|---|---|
| Type | integer |
| Minimum | 1 |
| Maximum | 365 |
| Default | 30 |
| Storage | `system_settings` JSONB, nested under `storage.trash.retentionDays` |
| Admin UI | System Settings admin page |

This setting controls the number of days after which trashed items are permanently deleted by the automated purge job. It does not apply retroactively in isolation: the cutoff is computed as `now() - retentionDays * 86400s` on each purge run, so reducing the setting will cause more items to be purged on the next run.

The setting does not throttle manual "Delete forever" or "Empty trash" operations — those are always immediately available to users with the appropriate role.

---

## 8. Dedup-on-Restore

Restoring a trashed item clears its `deleted_at`, which makes it re-eligible for the partial unique index `(circle_id, content_hash) WHERE deleted_at IS NULL`. If another active (non-trashed) item with the same `content_hash` already exists in the same circle, the restore would violate this index.

### How it is handled

`restoreFromTrash` processes each requested ID individually in a loop. For each item, it attempts `prisma.mediaItem.update({ where: { id, deletedAt: { not: null } }, data: { deletedAt: null } })`. If Prisma throws a `P2002` unique constraint violation (the index name matches `circle_id, content_hash`), the update is caught, the item's ID is added to the `conflicts[]` array, and processing continues with the next item.

### Response shape

```json
{
  "restored": 3,
  "conflicts": ["uuid-of-item-that-conflicted"]
}
```

The caller should surface the `conflicts` list to the user so they can decide whether to keep the trashed version or the active duplicate.

### Why partial items in a batch succeed

The loop does not wrap all items in a single transaction. A conflict on one item does not roll back successfully restored items. This is intentional: restoring 9 out of 10 items is better than failing the entire batch because one has a hash collision.

---

## 9. Manual Purge from the Trash Page

Users do not have to wait for the automated purge. The Trash page exposes two manual operations:

**Delete forever (collaborator):** Selects one or more items from the Trash page and calls `POST /api/media/trash/delete-forever`. Only items with `deletedAt IS NOT NULL` and in the specified circle are eligible. Returns `{ deleted: number }`. This call is still synchronous — it operates on a caller-selected, bounded set (1–500 UUIDs), which is small enough that a single request never approaches the timeout that motivated §10 below.

**Empty trash (circle_admin):** Empties the *entire* trash for a circle via `POST /api/media/trash/empty`. The circle_admin restriction prevents collaborators from accidentally destroying other members' trashed items. Unlike "Delete forever", this operation has no caller-supplied bound — a circle's trash can hold thousands of items — so as of issue #165 it runs asynchronously as a background run rather than in the HTTP request. See §10.

Both operations are irreversible and ultimately hard-delete DB rows and S3 blobs via the shared `MediaService.purgeMediaItemsBatched` helper (§10).

---

## 10. Empty Trash at Scale (Async Run Model)

### 10.1 Why this changed (issue #165)

The original "Empty trash" implementation was a single synchronous call: `POST /api/media/trash/empty` loaded every trashed item in the circle and hard-deleted them one at a time in-request via `MediaService.emptyTrash`. Past roughly 2,000 trashed items this routinely exceeded the HTTP timeout, leaving the client with an error even though the server-side purge was still (partially) running. There was also no way to see progress or cancel a purge already in flight.

The fix rebuilds "Empty trash" on the same **run-record + chunked-job + progress-polling** pattern already proven by Media Workflow Automation (`workflow_runs`/`workflow_run_items`, see [Workflow Automation spec](workflows.md)) — deliberately stripped down, since empty-trash has no conditions, no action list, and no approval gate: every trashed item in the circle is simply hard-deleted.

### 10.2 Data model

Two new tables (migration `20260724000000_trash_empty_runs`):

**`trash_empty_runs`** — one row per "empty trash" run for a circle.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `circle_id` | UUID | FK → `circles`, cascade delete |
| `status` | `TrashEmptyRunStatus` | `evaluating` \| `running` \| `completed` \| `completed_with_errors` \| `failed` \| `cancelled` |
| `matched_count` | Int, default 0 | Trashed items discovered when the run was evaluated |
| `processed_count` | Int, default 0 | Items a batch job has attempted (success or failure) |
| `succeeded_count` | Int, default 0 | Items successfully hard-deleted |
| `failed_count` | Int, default 0 | Items whose hard-delete failed (item still exists) |
| `skipped_count` | Int, default 0 | Reserved for parity with the workflow run shape; not currently incremented by the empty-trash handlers |
| `started_by_id` | UUID? | FK → `users`, `SetNull` |
| `last_error` | String? | Set when the run transitions to `failed` |
| `created_at` / `updated_at` / `started_at` / `finished_at` | Timestamptz | |

Indexes: `(circle_id, status)` (serves the per-circle concurrency guard and the Trash page's "resume run" lookup) and `(status, updated_at)`.

**`trash_empty_run_items`** — one row per matched (trashed) media item within a run.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `run_id` | UUID | FK → `trash_empty_runs`, cascade delete |
| `media_item_id` | UUID | FK → `media_items`, **cascade delete** — a successful purge deletes the `MediaItem` row, which cascades away this run-item row too |
| `status` | `TrashEmptyRunItemStatus` | `matched` \| `deleted` \| `failed` \| `skipped` |
| `error` | String? | Set when `status='failed'` |
| `created_at` / `updated_at` | Timestamptz | |

`@@unique([runId, mediaItemId])` is the idempotency anchor for batch retries — the same pattern used by `workflow_run_items` and `storage_migration_items`. A retried batch job's `updateMany` only claims rows still at `status='matched'`, so a crash-and-retry never double-counts or double-deletes.

### 10.3 Job types (both server-only)

Two new `enrichment_jobs` types drive the run, mirroring the workflow evaluate/execute-batch split:

- **`trash_empty_evaluate`** (`mediaItemId: null`, `circleId` set, priority 20, payload `{ runId }`) — keyset-paginates every trashed item in the circle (`deletedAt IS NOT NULL`) into `trash_empty_run_items` at `status='matched'`, 1,000 rows per page, ordered `(capturedAt DESC NULLS LAST, id DESC)` — the same ordering as the gallery keyset scan. Sets `matchedCount`, then transitions the run: `matchedCount === 0` → `completed` immediately; otherwise → `running` and fans out `trash_empty_execute_batch` jobs via `TrashEmptyRunService.enqueueExecuteBatches`.
- **`trash_empty_execute_batch`** (`mediaItemId: null`, `circleId` set, priority 100, payload `{ runId, itemIds[] }`, `skipDedup: true`) — one job per 200-item chunk (a local constant, not a system setting — empty-trash has no user-tunable batch size). Each job: (1) bails immediately if the run was cancelled (cooperative cancellation), (2) atomically claims its still-`matched` rows to `deleted` via a single `updateMany` (so a crashed-and-retried job only re-claims what it didn't already own), (3) hard-deletes the claimed items via `MediaService.purgeMediaItemsBatched`, flipping any that fail back to `status='failed'` with an `error` message, (4) increments the run's atomic counters, and (5) attempts to finalize the run — a race-safe conditional `updateMany` on `status='running'` so only the last batch to drain the queue actually transitions the run to `completed` (no failures) or `completed_with_errors` (`failedCount > 0`).

Both job types are **server-only** — they deliberately do not implement the `nodeResultSchema`/`persistNodeResult` node pair, since purging requires storage credentials a distributed worker node never holds. This mirrors the existing `location_inference`/`face_auto_archive_sweep`/`trash_purge` precedent: `EnrichmentHandlerRegistry.serverOnlyTypes()` auto-classifies a handler without a node pair as server-only, and `systemModeEligibleTypes()` auto-includes it in `ENRICHMENT_WORKER_MODE=system`, so no `enrichment-job.worker.ts` edit was needed to make the feature fleet-safe (a deployment running `ENRICHMENT_WORKER_MODE=system` with a node fleet still executes empty-trash runs on the API's own in-process worker).

### 10.4 Batched purge: `purgeMediaItemsBatched`

The new `MediaService.purgeMediaItemsBatched(ids)` collapses what was previously ~3 round-trips *per item* (one `MediaItem` delete, one blob delete, one `StorageObject` delete) into a handful of calls for the whole batch:

1. One `mediaItem.deleteMany` for the batch, falling back to per-item deletes only if the batch call itself throws (so one bad row can't strand the rest, and the caller still learns exactly which IDs failed via `failedIds`).
2. Best-effort blob deletes grouped by `(storageProvider, bucket)`, one `provider.deleteMany(keys)` call per group. The new `StorageProvider.deleteMany` uses each provider's native batch API — S3's `DeleteObjectsCommand`, chunked at 1,000 keys per call (the S3 API limit). Blob-delete failures are logged but non-fatal, matching the older `purgeMediaItems` semantics: an item still counts as deleted even if its blob delete failed.
3. One `storageObject.deleteMany` for the objects belonging to the successfully-deleted `MediaItem` rows.

`purgeMediaItemsBatched` is now the **shared purge path** for three callers: the manual "Delete forever" flow (`deleteForever`), the `trash_purge` cron handler (§6), and the new `trash_empty_execute_batch` handler (§10.3). The older, per-item `purgeMediaItems` method still exists in the codebase but is no longer used by any of these hot paths.

### 10.5 Per-circle concurrency guard

`TrashEmptyRunService.createRun` counts existing runs for the circle in `evaluating` or `running` status; if one is already active, the request is rejected with `409 Conflict` ("A trash-empty run is already in progress for this circle"). This prevents two concurrent empty-trash runs for the same circle from racing to claim the same trashed items.

### 10.6 API — run inspection and cancellation

| Method | Path | Response | Min per-circle role |
|---|---|---|---|
| `GET` | `/api/trash-empty-runs/:id` | Run detail: counters (`matchedCount`, `processedCount`, `succeededCount`, `failedCount`, `skippedCount`) plus `itemStatusCounts` (a live tally grouped by `trash_empty_run_items.status`) | viewer (media:read) |
| `GET` | `/api/trash-empty-runs/:id/items` | `?status=&page=&pageSize=` — paginated run items with batched signed thumbnails; `status` filters to `matched`\|`deleted`\|`failed`\|`skipped` | viewer (media:read) |
| `POST` | `/api/trash-empty-runs/:id/cancel` | Cancel a non-terminal run; `400` if the run has already reached a terminal status | circle_admin (media:delete) |

Reads use `media:read` + the circle's `viewer` role; starting and cancelling a run both require `media:delete` + `circle_admin`, matching the RBAC that already gated the synchronous "Empty trash" button.

**Cancellation semantics:** cancelling sets `status='cancelled'` immediately. This is *cooperative* — any `trash_empty_execute_batch` job already claimed by the worker checks the run's status before doing any work and bails out if it sees `cancelled`, but it does not (and cannot) recall a batch mid-purge. Items already hard-deleted before the cancel took effect remain deleted; items not yet claimed by a batch are simply never processed.

### 10.7 Frontend — progress page

Starting an empty-trash run from the Trash page (`TrashPage.tsx`) navigates to `/trash/runs/:runId` (`TrashEmptyRunPage.tsx`), which polls `GET /api/trash-empty-runs/:id` every 2 seconds while the run is non-terminal (`evaluating` or `running`) and stops polling once it reaches a terminal status. The page shows:
- A prominent total (`matchedCount`) — "how many items are in this run", the detail users most wanted visibility into.
- An indeterminate progress bar while `evaluating` ("Preparing…", finding every trashed item), and a determinate bar (`processedCount / matchedCount`) while `running`.
- A terminal summary banner (success/warning/error) plus a count-tile row (Total/Processed/Deleted/Failed/Skipped).
- A paginated table of failed items (fetched via `GET /api/trash-empty-runs/:id/items?status=failed`) once the run finishes with `failedCount > 0`, each row linking to the media item.
- A "Cancel run" button, shown only to a `circle_admin` while the run is non-terminal.

### 10.8 Failure handling

If `trash_empty_evaluate` itself throws (e.g. a transient DB error) partway through paginating, the run is left in `evaluating` and the job retries through the normal enrichment backoff path — `createMany({ skipDuplicates: true })` makes re-materializing the matched set idempotent on retry. Only once the job has exhausted `ENRICHMENT_MAX_ATTEMPTS` does the handler mark the run terminally `failed` (with `lastError` set) before rethrowing so the job itself also fails.

If a `trash_empty_execute_batch` job crashes mid-batch after claiming rows (flipping them to `deleted`) but before calling `purgeMediaItemsBatched`, a retry of that job re-reads every row already at `status='deleted'` for its `itemIds` (not just the ones it newly claimed this attempt) and re-attempts the purge — safe because `purgeMediaItemsBatched` is a no-op for IDs whose `MediaItem` row is already gone.

---

## 11. Security and RBAC

| Operation | System permission | Min per-circle role |
|---|---|---|
| View archived items | `media:read` | `viewer` |
| View trash | `media:read` | `viewer` |
| Archive / unarchive items | `media:write` | `collaborator` |
| Restore from trash | `media:write` | `collaborator` |
| Delete forever (selected items) | `media:delete` | `collaborator` |
| Empty trash (start run, entire circle) | `media:delete` | `circle_admin` |
| Cancel an empty-trash run | `media:delete` | `circle_admin` |
| View an empty-trash run / its items | `media:read` | `viewer` |

Admins holding `circles:manage_any` bypass the per-circle role check and can perform all operations on any circle.

---

## 12. Gotchas and Implementation Notes

### `listTrash` does not filter by `archivedAt`

Items trashed while archived (`deletedAt IS NOT NULL AND archivedAt IS NOT NULL`) appear in the Trash page. This is correct: the Trash page shows everything that has been deleted, regardless of whether it was also archived. If restored, the item will return to its archived state (because `archivedAt` is not cleared by restore).

### Browse surfaces must pass `excludeArchived: true`

Every caller that should hide archived items must explicitly pass `excludeArchived: true` to `buildMediaWhere`. If a new browse surface is added without this flag, archived items will appear in it. The flag is not the default to preserve backward compatibility with all existing callers.

### `purgeMediaItemsBatched` is shared

`MediaService.purgeMediaItemsBatched(ids)` (§10.4) is the single path for all permanent deletion at scale: "Delete forever", the `TrashPurgeHandler`'s automatic purge, and the `trash_empty_execute_batch` handler (§10.3) all call it. Any changes to purge behavior (e.g. emitting an event, updating a counter) should be made in that one method rather than duplicated across callers. The older per-item `purgeMediaItems` still exists but is no longer used by these hot paths as of issue #165.

### S3 blob deletion is best-effort

`purgeMediaItemsBatched` deletes S3 blobs (via the provider's batched `deleteMany`) and DB rows. If a blob-delete call fails, the error is logged but the DB row is still deleted. This means the S3 bucket may retain orphan blobs after a failed purge run. A retried purge attempt (e.g. a retried `trash_empty_execute_batch` job, or the next `trash_purge` cron tick) will attempt to delete the same item IDs again; if the DB rows are gone, the `findMany` that precedes purge will return an empty list and no S3 calls will be made. Orphan blobs can be cleaned up by a separate S3 lifecycle rule or a manual reconciliation script.

### Retention setting change is not retroactive on existing rows

Reducing `storage.trash.retentionDays` takes effect on the next purge run. Items whose `deleted_at` is now past the new cutoff will be purged on the next cron tick. This is by design — the cutoff is always computed fresh from the current setting.

### Archive/Trash UI surfaces burst/duplicate group origin (issue #163)

The Archive/Trash gallery (`MediaGallery`) and item detail drawer (`MediaDetailDrawer`, both in `apps/web`) show an origin badge/link when an item retains a `burstGroupId`/`duplicateGroupId` from a *resolved* (not dismissed) burst/duplicate review group — resolve does not clear these columns, only dismiss does (see [burst-detection.md §7.2](burst-detection.md#72-group-actions) / [duplicate-detection.md §9.3](duplicate-detection.md#93-post-apimediaduplicatesidresolve)). This lets a user confirm a kept duplicate/best-shot exists before choosing "Delete forever". Trashed-item caveat: because `BurstService.getBurstGroup`'s member sub-query filters by `deletedAt: null` (not `archivedAt`), a trashed item will not itself appear in its own linked burst group's member list even though the group and its other members remain visible.

---

## Document History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | June 2026 | AI Assistant | Initial specification matching shipped implementation |
| 1.1 | July 2026 | AI Assistant | Document Archive/Trash UI origin badge/link for items retaining a resolved (not dismissed) burst/duplicate group id (§11, issue #163) |
| 1.2 | July 2026 | AI Assistant | Document the async run-based "Empty Trash at Scale" rebuild (§10, issue #165): `trash_empty_runs`/`trash_empty_run_items` data model, `trash_empty_evaluate`/`trash_empty_execute_batch` server-only job types, the shared batched `purgeMediaItemsBatched` purge path, per-circle concurrency guard, run inspection/cancel API, and the progress-polling UI |
