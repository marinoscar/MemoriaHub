# Database Performance & Scalability Audit

| Field | Value |
|-------|-------|
| **Date** | 2026-06-28 |
| **Branch** | `claude/database-performance-audit-cmo92j` |
| **Status** | Advisory — no changes applied |
| **Scope** | PostgreSQL / Prisma schema, hot query paths, background workers |

---

MemoriaHub stores media metadata in PostgreSQL (via Prisma ORM) with media bytes on S3/Cloudflare R2. The application performs well at current scale. The owner requested a forward-looking review of the database design before growth exposes performance degradation, with specific concern about (a) database query performance decay as item counts climb into the millions and (b) UI slowness rooted in server-side query patterns. This audit covers the full Prisma schema and index definitions, the hot user-facing read paths (browse, search, dashboard, Explore), and the background worker and admin query paths. It is advisory only; no schema, migration, or source code changes have been made.

---

## Overall Verdict

The design is **fundamentally sound for the target scale**. Key strengths are covered in [Section 5](#5-strengths). The risks identified are not architectural rewrites — they are a focused set of missing composite indexes, a handful of N+1 / unbounded-scan query patterns, and one job-claim concurrency caveat that only becomes a problem when the API is run as more than one instance. None of these require emergency action today; they are work to schedule before the catalog reaches the lower millions of items.

---

## Table of Contents

1. [Tier 1 — Most Likely to Degrade the UI First](#1-tier-1--most-likely-to-degrade-the-ui-first)
   - [1.1 Per-Item Thumbnail Signing N+1](#11-per-item-thumbnail-signing-n1)
   - [1.2 Missing Composite Indexes on `media_items` for the Core Browse Query](#12-missing-composite-indexes-on-media_items-for-the-core-browse-query)
   - [1.3 Offset Pagination and Full `count()` on Every List Request](#13-offset-pagination-and-full-count-on-every-list-request)
2. [Tier 2 — Heavy Aggregations That Scan Without Bounds](#2-tier-2--heavy-aggregations-that-scan-without-bounds)
   - [2.1 Explore Endpoints Fetch All Rows Then Aggregate in JavaScript](#21-explore-endpoints-fetch-all-rows-then-aggregate-in-javascript)
   - [2.2 `media_tags` Missing a `tagId` Index](#22-media_tags-missing-a-tagid-index)
   - [2.3 Semantic-Search Superset Fetch](#23-semantic-search-superset-fetch)
3. [Tier 3 — Background and Worker Scale-Out](#3-tier-3--background-and-worker-scale-out)
   - [3.1 Job-Claim Is Not Concurrency-Safe Across Instances](#31-job-claim-is-not-concurrency-safe-across-instances)
   - [3.2 Admin Job Stats — Four Full-Table Aggregations, Uncached](#32-admin-job-stats--four-full-table-aggregations-uncached)
   - [3.3 Backfill Endpoints Loop Unbounded with Serial N+1 Writes](#33-backfill-endpoints-loop-unbounded-with-serial-n1-writes)
4. [Tier 4 — Watch as Data Accumulates (No Action Needed Yet)](#4-tier-4--watch-as-data-accumulates-no-action-needed-yet)
   - [4.1 `audit_events` Unbounded Growth](#41-audit_events-unbounded-growth)
   - [4.2 `enrichment_jobs` Unbounded Growth](#42-enrichment_jobs-unbounded-growth)
   - [4.3 No Spatial Index on `takenLat` / `takenLng`](#43-no-spatial-index-on-takenlat--takenlng)
   - [4.4 Large `metadata` JSONB Selected by Default on List Queries](#44-large-metadata-jsonb-selected-by-default-on-list-queries)
5. [Strengths](#5-strengths)
6. [Recommended Sequencing](#6-recommended-sequencing)

---

## 1. Tier 1 — Most Likely to Degrade the UI First

### 1.1 Per-Item Thumbnail Signing N+1

**VERIFIED**

**Files:** `apps/api/src/media/media-thumbnail.service.ts:52-55`, `apps/api/src/media/media.service.ts:1826-1861`

Every call to `signThumb()` issues a `storageObject.findUnique({ where: { storageKey } })` to determine which provider and bucket the thumbnail lives in, then calls `getSignedDownloadUrl` on that provider. The same logic exists in two places: as a private method on `MediaService` (lines 1826–1861) and as the shared `MediaThumbnailService.signThumb()` (lines 39–73 of the thumbnail service). Both implementations issue one database round-trip per item.

`attachThumbnailUrls()` in `MediaThumbnailService` (lines 80–89) maps `signThumb()` over every item in a page result:

```typescript
return Promise.all(
  items.map(async (item) => ({
    ...item,
    thumbnailUrl: await this.signThumb(item.metadata),
  })),
);
```

`Promise.all` runs these concurrently, which improves latency compared to sequential awaits, but it does not reduce the total number of database queries. A page of 50 items costs 50 `storage_objects` lookups on top of the main `findMany`. The dashboard (`getDashboard`, lines 1369–1388) signs three sets simultaneously — up to 24 On-This-Day items, 12 recent, and 12 favorites — for a worst-case of 48 additional queries per dashboard load.

This is the single most likely cause of UI slowness as catalogs grow, because the database hit count scales linearly with page size and is incurred on every page view, every search result, and every dashboard open.

**Recommendation (cheapest first):**

1. Batch the lookup. Before calling `signThumb` across a page, run one `findMany({ where: { storageKey: { in: keys } } })` and build a `Map<storageKey, { storageProvider, bucket }>`. Pass the resolved provider into each signing call. This drops N queries to 1 per page.
2. Denormalize `storageProvider` and `bucket` onto `media_items.metadata` at upload time so the thumbnail-signing path never needs a `storage_objects` lookup at all.
3. Optionally lengthen the signed URL TTL and cache signed URLs on the client so that refreshing a page or re-rendering a gallery does not re-sign thumbnails that are still valid.

---

### 1.2 Missing Composite Indexes on `media_items` for the Core Browse Query

**VERIFIED**

**File:** `apps/api/prisma/schema.prisma:526-539`

The `media_items` model declares the following single-column indexes:

```prisma
@@index([circleId])
@@index([addedById])
@@index([capturedAt])
@@index([contentHash])
@@index([type])
@@index([deletedAt])
@@index([archivedAt])
@@index([favorite])
@@index([geoCountryCode])
@@index([geoAdmin1])
@@index([geoLocality])
@@index([burstUuid])
@@index([burstGroupId])
```

The core browse query in `listMedia` (lines 280–380 of `media.service.ts`) produces a `WHERE` clause that always includes `circleId = $1 AND deleted_at IS NULL AND archived_at IS NULL`, and sorts by `ORDER BY captured_at DESC`. With only single-column indexes, Postgres must choose between scanning the `(circleId)` index and filtering rows for the soft-delete/archive state, or scanning the `(capturedAt)` index and filtering for `circleId`. Neither allows the planner to satisfy the filter and the sort order from a single index scan. As the `media_items` table grows into the millions of rows, the planner will increasingly resort to large index scans followed by in-memory sorts.

The same structural problem applies to the common facet filters that extend the base query: `WHERE circleId = X AND type = 'photo' AND deleted_at IS NULL` and `WHERE circleId = X AND favorite = true AND deleted_at IS NULL`.

**Recommendation:**

| Proposed index | Query it serves |
|---|---|
| `(circleId, capturedAt DESC)` | All browse/list pages — the primary composite index |
| Partial on `WHERE deleted_at IS NULL AND archived_at IS NULL` over `(circleId, capturedAt DESC)` | Active-item hot path; eliminates soft-delete filtering overhead |
| `(circleId, type, capturedAt DESC)` | Browse filtered by media type |
| `(circleId, favorite, capturedAt DESC)` | Favorites tab / filter |

A partial index cannot be declared in Prisma's `schema.prisma` syntax and must be applied via a raw SQL migration (the pattern is already established in this codebase for pgvector indexes). The composite indexes without the partial clause can be added as standard `@@index` entries.

Validate each candidate with `EXPLAIN (ANALYZE, BUFFERS)` against a production-representative dataset before committing.

---

### 1.3 Offset Pagination and Full `count()` on Every List Request

**VERIFIED**

**Files:** `apps/api/src/media/media.service.ts:352-360`, `apps/api/src/search/search.service.ts:157-160`, `apps/api/src/enrichment/enrichment-admin.service.ts:232-259`

Every paginated list endpoint runs two parallel queries:

```typescript
const [items, totalItems] = await Promise.all([
  this.prisma.mediaItem.findMany({ where, orderBy, skip, take: pageSize }),
  this.prisma.mediaItem.count({ where }),
]);
```

This pattern appears in `listMedia`, `listArchived`, `listTrash`, the normal filter-only path in `SearchService.runSearch`, the album list, and the admin job list. Both `OFFSET N ROWS` and `COUNT(*)` over a filtered predicate become progressively more expensive as rows accumulate:

- `COUNT(*)` over a large filtered result set cannot use an index-only scan when the filter involves nullable columns or JSONB; at millions of rows it requires a sequential scan or a large index scan.
- Deep offsets (`OFFSET 100000 LIMIT 50`) require the database to traverse and discard 100,000 rows before returning the requested page.

For browse surfaces that are scrolled rather than page-jumped (the gallery, search results, trash, archive), this is the wrong pagination primitive.

**Recommendation:**

- Replace `skip`/`take` offset pagination with keyset (cursor) pagination on `(capturedAt, id)` for all infinite-scroll or "load more" surfaces. The cursor approach is `WHERE (capturedAt, id) < ($lastCapturedAt, $lastId) ORDER BY capturedAt DESC, id DESC LIMIT N` and is index-friendly regardless of depth.
- Drop or approximate the exact `totalItems` count. Display "1,000+" beyond a threshold, or cache the count with a short TTL and refresh it lazily. Exact totals are rarely actionable for a gallery user.
- For admin surfaces where exact pagination is required (job list, user list), the current approach is acceptable at current admin-table scale; add the TTL cache when the job table grows (see Section 4.2).

---

## 2. Tier 2 — Heavy Aggregations That Scan Without Bounds

### 2.1 Explore Endpoints Fetch All Rows Then Aggregate in JavaScript

**VERIFIED**

**File:** `apps/api/src/media/media.service.ts:1870-1977`

`explorePlaces` (lines 1870–1926) fetches every geotagged, non-deleted, non-archived `media_item` in the circle with no row limit, then groups and sorts the result in Node.js:

```typescript
const items = await this.prisma.mediaItem.findMany({
  where: {
    circleId,
    deletedAt: null,
    archivedAt: null,
    OR: [
      { geoLocality: { not: null } },
      { geoPlaceName: { not: null } },
    ],
  },
  select: { geoLocality: true, geoPlaceName: true, metadata: true },
});
// ... group by name in a Map, sort, slice to 50
```

At 500,000 geotagged items this transfers 500,000 rows from Postgres to the Node.js process on every call, serializes them, and processes them in-process before returning 50 results.

`exploreTags` (lines 1932–1977) uses a Prisma `include` to load every `Tag` with its `_count` and one cover `mediaItem`, then sorts and slices in JavaScript. While Prisma generates an aggregating SQL query for `_count`, pulling all tags with a cover item join is unbounded when a circle has thousands of tags.

The contrast is clear when looking at `facetsLocations` (lines 2023–2111), which correctly pushes the aggregation into SQL via Prisma's `groupBy`:

```typescript
const rows = await this.prisma.mediaItem.groupBy({
  by: ['geoCountry', 'geoCountryCode', 'geoAdmin1', 'geoLocality'],
  where: { circleId, deletedAt: null, geoCountry: { not: null } },
  _count: { _all: true },
});
```

This is the pattern `explorePlaces` should follow.

**Recommendation:**

- Rewrite `explorePlaces` to use `prisma.mediaItem.groupBy({ by: ['geoLocality', 'geoPlaceName'], where: ..., _count: { _all: true }, orderBy: { _count: { geoLocality: 'desc' } }, take: 50 })` — equivalent semantics, all aggregation in SQL.
- Rewrite `exploreTags` similarly: `prisma.tag.findMany` with `_count` is acceptable, but add a `take` limit and perform sorting in SQL with `orderBy: { mediaTags: { _count: 'desc' } }`.
- Add a short-lived (5–60 second) in-memory or Redis cache on both endpoints. Place counts and tag counts change only when items are uploaded, tagged, or geocoded; stale-by-a-minute is invisible to users.

---

### 2.2 `media_tags` Missing a `tagId` Index

**VERIFIED**

**File:** `apps/api/prisma/schema.prisma:617-619`

The `MediaTag` model declares:

```prisma
@@unique([tagId, mediaItemId])
@@index([mediaItemId])
```

The unique constraint on `(tagId, mediaItemId)` creates a B-tree index with `tagId` as the leading column. In Postgres, a `UNIQUE` constraint index is a usable B-tree index, so "all `media_tags` for a given `tagId`" queries — such as reverse tag lookups ("all items with tag X") — can actually use the unique index as a partial scan on `tagId`. This is more nuanced than a missing index; the unique index does serve the reverse lookup, but only when the Prisma/Hibernate query planner constructs the predicate with `tagId` as the leading column.

However, the index is a composite covering both columns; the planner may prefer a sequential scan when selectivity on `tagId` alone is low (many rows per tag). At 10M–100M `media_tags` rows with highly popular tags, an explicit single-column `@@index([tagId])` gives the planner a lighter, more targeted option.

**Recommendation:** Add `@@index([tagId])` to `MediaTag`. This is a low-risk, low-effort addition that improves plan stability for tag-reverse lookups and the Explore tags aggregation.

---

### 2.3 Semantic-Search Superset Fetch

**File:** `apps/api/src/search/search.service.ts:94-147`

The semantic search path fetches a superset of KNN candidates, then re-filters them in JavaScript:

```typescript
const knnLimit = Math.min(Math.max(pageSize * 5, 100), 500);
const knn = await this.semanticSearch.knnMediaIds(circleId, vec, knnLimit);
// ...
const allItems = await this.prisma.mediaItem.findMany({ where });
// ... sort by KNN rank in app, slice to page
```

Up to 500 candidate IDs are passed to `findMany`, which returns up to 500 rows. These are then re-sorted in Node.js and sliced to `pageSize`. The pgvector HNSW index (`media_item_embedding_hnsw_idx`) is in place — confirmed in `apps/api/prisma/migrations/20260620030000_add_media_embeddings/migration.sql:20-21` — so the KNN step is efficient. The concern is that the `findMany({ id: { in: orderedIds } })` has no `skip`/`take` and no DB-level pagination; at `knnLimit = 500` it always pulls 500 rows regardless of `pageSize`.

This is a modest concern today; 500 rows is a small result set. It becomes relevant if `knnLimit` grows or if the filter intersection routinely drops the 500-row superset to a small result, requiring a larger superset to fill a page.

**Recommendation:** Keep the current superset bounded at 500 (or proportional to pageSize). Tune pgvector `ef_search` via a `SET LOCAL hnsw.ef_search = N` raw SQL statement if recall-versus-latency balance needs adjusting. Consider paginating the `findMany` in-DB once the superset size is reliably large enough to cover multiple pages.

---

## 3. Tier 3 — Background and Worker Scale-Out

### 3.1 Job-Claim Is Not Concurrency-Safe Across Instances

**VERIFIED**

**File:** `apps/api/src/enrichment/enrichment-job.worker.ts:106-130`

`claimNextJob` wraps the find-and-update in a Prisma transaction:

```typescript
return this.prisma.$transaction(async (tx) => {
  const job = await tx.enrichmentJob.findFirst({
    where: {
      status: JobStatus.pending,
      OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
    },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });

  if (!job) return null;

  return tx.enrichmentJob.update({
    where: { id: job.id },
    data: { status: JobStatus.running, startedAt: new Date(), scheduledFor: null },
  });
});
```

A Prisma interactive transaction issues the `findFirst` as a plain `SELECT` with no row-level lock. In a serializable or repeatable-read transaction this can still allow two concurrent transactions to read the same row before either commits the `UPDATE`. Postgres default isolation is `READ COMMITTED`, so two concurrent transactions will both see the `pending` row, both attempt the `UPDATE`, and one will "win" — but both will report a successful claim, because the `UPDATE` does not guard on `status = 'pending'`. The second worker will overwrite the first's `startedAt` and begin processing a job that is already running.

At the current deployment topology — single API instance, `ENRICHMENT_WORKER_CONCURRENCY = 1`, poll loop guarded by `this.running = true` — the `processBatch` `for` loop (lines 91–104) is effectively serial. No two claims run concurrently, so this is safe today. The risk activates under any of:

- Running two or more API instances (horizontal scaling / rolling deploys with overlap).
- Raising `ENRICHMENT_WORKER_CONCURRENCY` above 1 in the same process (the `for` loop is still sequential in a single process, but the guard is process-local).
- Any future refactor that introduces async concurrency in `processBatch`.

**Recommendation:** Move the claim to a `SELECT ... FOR UPDATE SKIP LOCKED` raw SQL statement:

```sql
UPDATE enrichment_jobs
SET status = 'running', started_at = now(), scheduled_for = NULL
WHERE id = (
  SELECT id FROM enrichment_jobs
  WHERE status = 'pending'
    AND (scheduled_for IS NULL OR scheduled_for <= now())
  ORDER BY priority ASC, created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

`SKIP LOCKED` causes competing workers to skip rows that are already locked by another transaction, eliminating double-claim races. This is the standard pattern for Postgres-based job queues. Alternatively, add a `status = 'pending'` guard to the `update` call's `where` clause and treat a zero-row-updated response as a lost race, then retry the claim. Implement this **before** deploying multiple API instances.

---

### 3.2 Admin Job Stats — Four Full-Table Aggregations, Uncached

**VERIFIED**

**File:** `apps/api/src/enrichment/enrichment-admin.service.ts:103-133`

`getStats()` runs four parallel queries over the full `enrichment_jobs` table on every admin dashboard hit:

```typescript
const [statusGroups, typeStatusGroups, stuckCount, scheduledCount] = await Promise.all([
  this.prisma.enrichmentJob.groupBy({ by: ['status'], _count: { id: true } }),
  this.prisma.enrichmentJob.groupBy({ by: ['type', 'status'], _count: { id: true } }),
  this.prisma.enrichmentJob.count({
    where: { status: JobStatus.running, startedAt: { lt: stuckThreshold } },
  }),
  this.prisma.enrichmentJob.count({
    where: { status: JobStatus.pending, scheduledFor: { gt: now } },
  }),
]);
```

The `stuckCount` query filters `status = 'running' AND started_at < threshold`. The existing indexes are `(status, priority, createdAt)` and `(status, scheduledFor, priority, createdAt)` (schema lines 772–773). Neither index has `startedAt` as a trailing column, so the stuck-count query scans all `running` rows after an index seek on `status`. This is negligible today; at 10M+ rows in the table with many historical `succeeded` or `failed` rows it will be slow.

The two `groupBy` queries must aggregate all rows, which grows with table size regardless of indexing.

**Recommendations:**

1. Add a `(status, startedAt)` index to accelerate the stuck-count query.
2. Cache `getStats()` with a short TTL (5–30 seconds) using an in-process cache or a lightweight Redis key. The admin dashboard does not require real-time accuracy.
3. Implement a terminal-row purge or archival strategy for `succeeded` and `failed` jobs so the table stays bounded (see Section 4.2). Aggregate queries over a small active-rows table are inherently fast.

---

### 3.3 Backfill Endpoints Loop Unbounded with Serial N+1 Writes

**VERIFIED**

**Files:** `apps/api/src/geo/geocode-backfill.service.ts:26-67`, `apps/api/src/tagging/tagging-backfill.service.ts:31-77`

Both backfill services follow the same pattern:

1. `findMany` all eligible items with no row limit.
2. Loop over every item and issue two awaited writes per item: one `enrichmentJobService.enqueue()` (which itself does an upsert or insert) and one `mediaXxxStatus.upsert()`.

For the geocode backfill (`geocode-backfill.service.ts:26-67`):

```typescript
const mediaItems = await this.prisma.mediaItem.findMany({
  where: { deletedAt: null, takenLat: { not: null }, takenLng: { not: null }, ...dateWhere, ... },
  select: { id: true, circleId: true },
});

let enqueued = 0;
for (const item of mediaItems) {
  await this.enrichmentJobService.enqueue({ ... });
  await this.prisma.mediaGeocodeStatus.upsert({ ... });
  enqueued++;
}
```

At 100,000 eligible items, this is 200,000 serial round-trips to Postgres. The `backfillAllCircles` variant in `TaggingBackfillService` (lines 91–113) nests an outer loop over all circles, multiplying this by the number of circles.

**Recommendation:**

- Replace the serial loop with batched writes: collect enrichment job rows into arrays and call `prisma.enrichmentJob.createMany({ data: [...], skipDuplicates: true })` in batches of 500–1,000. Apply the same batch pattern to status upserts.
- Paginate the driving `findMany` query (e.g. take 1,000 rows at a time with a cursor on `id`) so that a very large backfill does not hold the entire result set in Node.js heap.
- Schedule backfills off-peak or add a rate/throttle signal to the admin trigger. This is lower urgency — backfills are one-shot admin operations — but matters on a memory-constrained VPS.

---

## 4. Tier 4 — Watch as Data Accumulates (No Action Needed Yet)

### 4.1 `audit_events` Unbounded Growth

**File:** `apps/api/prisma/schema.prisma:163-179`

`audit_events` is well-indexed on `actorUserId`, `(targetType, targetId)`, and `createdAt`. Writes are selective (not per-request). No growth concern exists today, but the table has no archival, partitioning, or retention policy. At large enterprise-level event volumes (hundreds of millions of rows) the `createdAt` index will still serve point queries efficiently, but cold-path analytics over the full table will become expensive.

**Recommendation:** Plan time-based partitioning by `createdAt` (e.g. monthly partitions) or define a retention window (e.g. roll events older than 2 years to a separate archive schema) before the table exceeds ~50M rows. This is a long-horizon item for the current user base.

---

### 4.2 `enrichment_jobs` Unbounded Growth

**File:** `apps/api/prisma/schema.prisma:748-777`

`enrichment_jobs` accumulates `succeeded` and `failed` terminal rows indefinitely. The claim query's indexed scan on `status = 'pending'` is unaffected by terminal rows today because the `(status, priority, createdAt)` index allows an index seek directly to `pending` rows. However, the admin stats aggregations (Section 3.2) and the `listJobs` paginated view (`enrichment-admin.service.ts:199–271`) do scan terminal rows, and the table's physical size grows without bound.

**Recommendation:** Add a scheduled purge job that hard-deletes `succeeded` and `failed` rows older than a configurable retention window (e.g. 30 days). Wire it as a new enrichment job type or a standalone cron alongside `TrashPurgeTask`. Alternatively, declare the table as a Postgres range-partitioned table by `created_at` and drop old partitions wholesale.

---

### 4.3 No Spatial Index on `takenLat` / `takenLng`

**File:** `apps/api/prisma/schema.prisma:487-488`

The `near` geo-radius filter (from the search overhaul) uses a bounding-box approximation over `takenLat` and `takenLng` columns that are individually unindexed. Today, the `(circleId)` index filters the result set to a single circle first; within that circle, the lat/lng predicate is applied as a filter. For circles with millions of items and heavy geo-radius search traffic, this will become a per-circle sequential scan on lat/lng values.

**Recommendation:** No action needed now. If geo-radius search becomes a hot path, consider adding a GiST index via PostGIS (`geography` column type), or a composite index `(circleId, takenLat, takenLng)` as a cheaper non-PostGIS approximation. Validate the actual query plan first.

---

### 4.4 Large `metadata` JSONB Selected by Default on List Queries

**File:** `apps/api/src/media/media.service.ts:352-358`

`listMedia` calls `prisma.mediaItem.findMany({ where, orderBy, skip, take: pageSize })` with no `select` clause. This returns all columns including `metadata Json?`, which stores the full processed EXIF payload. EXIF blocks can reach 100 KB for camera-raw files with embedded GPS, maker notes, and ICC profiles.

At 50 items per page, a list request can deserialize up to 5 MB of EXIF JSON that the browse UI does not display. The thumbnailUrl signing step reads only the `thumbnailStorageKey` key from `metadata`; all other EXIF fields are unused by the list response.

**Recommendation:** Add an explicit `select` to the hot `findMany` calls in `listMedia`, `listArchived`, `listTrash`, and the dashboard that omits columns not needed for list rendering (large EXIF blobs, `perceptualHash`, `embedding` if ever included, etc.). Reserve the full-column fetch for the detail view (`getMediaItem`). This reduces wire transfer, deserialization time, and Node.js heap pressure proportionally.

---

## 5. Strengths

The following design decisions are genuine strengths that should be preserved.

**Circle-scoped denormalization as a natural partition key.** `circleId` is present on `media_items`, `faces`, `enrichment_jobs`, `media_tag_status`, `media_face_status`, `media_geocode_status`, `media_metadata_status`, `burst_groups`, and `media_item_embedding`. Every user-facing query is circle-scoped, which means the `circleId` index acts as a coarse partition, keeping working sets small even when the total table is large.

**Separate per-item status tables.** `media_face_status`, `media_tag_status`, `media_geocode_status`, and `media_metadata_status` are each a separate table with a `@unique` on `mediaItemId`. This avoids adding nullable status columns to `media_items`, keeps the main table narrow, and allows efficient status lookups without touching the wide item row.

**Generic enrichment queue with rate-limit-aware schema.** `enrichment_jobs` has dedicated `scheduledFor`, `rateLimitedAt`, and `rateLimitHits` columns, plus composite indexes `(status, priority, createdAt)` and `(status, scheduledFor, priority, createdAt)` (schema lines 772–773). The schema natively supports the deferred-retry and rate-limit-backoff patterns without requiring a separate queue infrastructure.

**pgvector HNSW index for semantic search.** The HNSW cosine index (`media_item_embedding_hnsw_idx`) on the `media_item_embedding` table is created via raw SQL migration and is therefore not subject to Prisma's inability to express vector index types. This follows the established project pattern for schema features that Prisma cannot express natively.

**Partial unique index for content-hash dedup.** The content-hash deduplication constraint is per `(circle_id, content_hash)` — circle-scoped, not global — which avoids false dedup collisions across circles while still preventing within-circle duplicates.

**Consistent soft-delete and archive filtering.** The `deletedAt` / `archivedAt` column pair is consistently applied across all browse, search, and aggregation query paths. The two states are independent; the schema and query patterns correctly treat them as orthogonal filters.

**Documented intentional schema drift.** The codebase explicitly acknowledges in `CLAUDE.md` and migration comments that partial indexes and vector indexes are created via raw SQL because Prisma cannot express them. This prevents future contributors from accidentally removing or misunderstanding these index entries.

---

## 6. Recommended Sequencing

| Priority | Work item | Impact | Effort | Before |
|---|---|---|---|---|
| 1 | Batch `storage_objects` lookup in thumbnail signing (Section 1.1) | Eliminates N+1 DB queries on every page view and dashboard load | Low — one query change and a map | Current user count grows |
| 2 | Add `(circleId, capturedAt DESC)` composite index and optional partial index on active items (Section 1.2) | Enables index-only scans for browse; removes large sorts | Low — raw SQL migration or `@@index` | Catalog reaches ~500K items |
| 3 | Add `(circleId, type, capturedAt DESC)` and `(circleId, favorite, capturedAt DESC)` indexes (Section 1.2) | Accelerates type-filter and favorites views | Low — additional `@@index` entries | Same as above |
| 4 | Add `@@index([tagId])` on `MediaTag` (Section 2.2) | Stabilises tag-reverse lookup plan at high row counts | Trivial | Catalog reaches millions of tag rows |
| 5 | Push Explore aggregations into SQL and add short-TTL cache (Section 2.1) | Eliminates unbounded full-table fetch on Explore page | Medium — rewrite two service methods | Any significant geo or tag usage |
| 6 | Harden job-claim with `SELECT ... FOR UPDATE SKIP LOCKED` (Section 3.1) | **Required for correctness** before running multiple API instances | Medium — raw SQL query replacement | Any horizontal scale-out or rolling deploy with overlap |
| 7 | Cache `getStats()` and add `(status, startedAt)` index (Section 3.2) | Protects admin dashboard as job table grows | Low | Job table exceeds ~1M rows |
| 8 | Batch backfill enqueue writes (Section 3.3) | Reduces backfill duration and DB load | Medium — refactor loop to `createMany` | Next large backfill run |
| 9 | Add select-narrowing to hot list `findMany` calls to omit `metadata` JSONB (Section 4.4) | Reduces wire transfer and heap pressure | Low-medium — API contract must remain compatible | Catalog reaches large EXIF volumes |
| 10 | Plan terminal-job purge/archival and `audit_events` retention (Sections 4.1, 4.2) | Keeps aggregate queries fast long-term | Medium — new cron + retention policy | Job table exceeds ~5M rows |

---

**No schema, code, or migration changes were made as part of this audit. All recommendations are advisory and should be validated with `EXPLAIN (ANALYZE, BUFFERS)` against production-representative data volumes before implementation.**
