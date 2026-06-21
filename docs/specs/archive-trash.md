# Archive & Trash Bin — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | June 2026 |
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
10. [Security and RBAC](#10-security-and-rbac)
11. [Gotchas and Implementation Notes](#11-gotchas-and-implementation-notes)

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
| `POST` | `/api/media/trash/empty` | `{ circleId }` | `{ deleted: number }` | circle_admin |

`listTrash` queries `where { circleId, deletedAt: { not: null } }` and does **not** filter on `archivedAt`, so items trashed while archived appear in the Trash page.

`deleteForever` and `emptyTrash` call `MediaService.purgeMediaItems`, which hard-deletes DB rows and S3 blobs. This is irreversible.

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

**Delete forever (collaborator):** Selects one or more items from the Trash page and calls `POST /api/media/trash/delete-forever`. Only items with `deletedAt IS NOT NULL` and in the specified circle are eligible. Returns `{ deleted: number }`.

**Empty trash (circle_admin):** Empties the entire trash for a circle via `POST /api/media/trash/empty`. The circle_admin restriction prevents collaborators from accidentally destroying other members' trashed items. Returns `{ deleted: number }`.

Both operations call `MediaService.purgeMediaItems` and are irreversible.

---

## 10. Security and RBAC

| Operation | System permission | Min per-circle role |
|---|---|---|
| View archived items | `media:read` | `viewer` |
| View trash | `media:read` | `viewer` |
| Archive / unarchive items | `media:write` | `collaborator` |
| Restore from trash | `media:write` | `collaborator` |
| Delete forever (selected items) | `media:delete` | `collaborator` |
| Empty trash (entire circle) | `media:delete` | `circle_admin` |

Admins holding `circles:manage_any` bypass the per-circle role check and can perform all operations on any circle.

---

## 11. Gotchas and Implementation Notes

### `listTrash` does not filter by `archivedAt`

Items trashed while archived (`deletedAt IS NOT NULL AND archivedAt IS NOT NULL`) appear in the Trash page. This is correct: the Trash page shows everything that has been deleted, regardless of whether it was also archived. If restored, the item will return to its archived state (because `archivedAt` is not cleared by restore).

### Browse surfaces must pass `excludeArchived: true`

Every caller that should hide archived items must explicitly pass `excludeArchived: true` to `buildMediaWhere`. If a new browse surface is added without this flag, archived items will appear in it. The flag is not the default to preserve backward compatibility with all existing callers.

### `purgeMediaItems` is shared

`MediaService.purgeMediaItems(ids)` is the single path for all permanent deletion: "Delete forever", "Empty trash", and the `TrashPurgeHandler`. Any changes to purge behavior (e.g. emitting an event, updating a counter) should be made in that method.

### S3 blob deletion is best-effort

`purgeMediaItems` deletes S3 blobs and DB rows. If the S3 delete call fails, the error is logged but the DB row is still deleted. This means the S3 bucket may retain orphan blobs after a failed purge run. The enrichment worker will retry the job, which will attempt to delete the same item IDs again; if the DB rows are gone, the `findMany` that precedes purge will return an empty list and no S3 calls will be made. Orphan blobs can be cleaned up by a separate S3 lifecycle rule or a manual reconciliation script.

### Retention setting change is not retroactive on existing rows

Reducing `storage.trash.retentionDays` takes effect on the next purge run. Items whose `deleted_at` is now past the new cutoff will be purged on the next cron tick. This is by design — the cutoff is always computed fresh from the current setting.

---

## Document History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | June 2026 | AI Assistant | Initial specification matching shipped implementation |
