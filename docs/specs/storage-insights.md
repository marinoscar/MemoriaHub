# Storage Insights — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.1 |
| **Last Updated** | June 2026 |
| **Status** | Implemented |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Data Model](#2-data-model)
3. [Metric Definitions and Aggregation Logic](#3-metric-definitions-and-aggregation-logic)
4. [Snapshot Lifecycle](#4-snapshot-lifecycle)
5. [Queue-Based Compute Architecture](#5-queue-based-compute-architecture)
6. [Cron and Interval-Gating Logic](#6-cron-and-interval-gating-logic)
7. [System Setting](#7-system-setting)
8. [API Endpoints and RBAC](#8-api-endpoints-and-rbac)
9. [Frontend Dashboard](#9-frontend-dashboard)
10. [Gotchas and Implementation Notes](#10-gotchas-and-implementation-notes)

---

## 1. Overview and Goals

Storage Insights is a global, admin-only dashboard that surfaces media storage metrics aggregated across all circles. It answers questions that span the entire library — total bytes stored, how storage is split between photos and videos, total item counts, how many faces have been detected, and how many items carry AI-generated tags.

### Goals

- Give admins a quick, reliable read on storage growth without running manual SQL.
- Keep queries off the hot path: metrics are precomputed and cached in a snapshot table rather than recomputed on every page load.
- Provide a manual escape hatch (hard refresh) so admins can see up-to-date data when needed.
- Run computation on the existing enrichment queue to inherit retries, observability, and the admin jobs dashboard — no additional worker infrastructure.
- Reuse existing `system_settings:read` / `system_settings:write` permissions — no new RBAC surface.

### Non-Goals

- Historical trend data or per-circle breakdowns are not provided. Only the most recent aggregate snapshot is kept.
- The dashboard does not track raw bucket size (bytes in S3 for all objects). It tracks media storage — bytes attributable to non-deleted media items.

---

## 2. Data Model

### `insights_snapshots` Table

One row per successful compute run. After each successful run, older rows are pruned so at most one row survives.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `status` | `InsightsSnapshotStatus` | See enum below |
| `metrics` | JSONB | Null until status reaches `ready`; holds `InsightsMetrics` (see below) |
| `computed_at` | Timestamptz | Timestamp of when the compute finished; null until `ready` |
| `duration_ms` | Integer | Wall-clock milliseconds the compute took; null until `ready` |
| `error` | Text | Reserved; not written in the queue-based flow (errors are tracked on the `enrichment_jobs` row) |
| `created_at` | Timestamptz | When the row was inserted |

### `InsightsSnapshotStatus` Enum

| Value | Meaning |
|-------|---------|
| `computing` | Reserved; not used in the queue-based flow — the handler writes `ready` directly |
| `ready` | Aggregation succeeded; `metrics` and `computed_at` are populated |
| `failed` | Reserved; not used in the queue-based flow — failure state is on the enrichment job row |

In the current architecture the snapshot table holds at most one row with `status='ready'`. In-flight and failure state lives on the `enrichment_jobs` row and is exposed via the `refresh` object on `GET /api/admin/insights`.

### `InsightsMetrics` JSON Shape

Stored in `insights_snapshots.metrics` as a JSONB object when status is `ready`.

| Field | JSON Type | Notes |
|-------|-----------|-------|
| `totalBytes` | string | Total storage bytes across all non-deleted media items. Serialized as a string to avoid JavaScript BigInt precision loss. |
| `photoBytes` | string | Bytes consumed by photos only. String for the same reason. |
| `videoBytes` | string | Bytes consumed by videos only. String for the same reason. |
| `totalItems` | number | Total non-deleted media items (photos + videos). Safe as a JS number. |
| `photoCount` | number | Non-deleted photo count. |
| `videoCount` | number | Non-deleted video count. |
| `totalFaces` | number | Total rows in the `faces` table (all circles, all statuses). |
| `taggedItems` | number | Media items with at least one AI-applied tag (`media_tag_status.tag_count > 0` and not soft-deleted). |

### `enrichment_jobs` — Global Job Support

The `enrichment_jobs` table has `media_item_id` and `circle_id` columns that are **nullable**. A null `media_item_id` indicates a global/system job not scoped to a specific media item or circle. The `storage_insights` handler uses this: it enqueues jobs with `mediaItemId: null, circleId: null`.

Idempotency for global jobs deduplicates on `(type='storage_insights', media_item_id IS NULL)` — if a `storage_insights` job is already `pending` or `running`, a second `enqueue()` call returns the existing job without creating a duplicate.

See [Enrichment Queue spec](enrichment-queue.md) for the full queue data model and worker behavior.

---

## 3. Metric Definitions and Aggregation Logic

`InsightsService.runComputation()` delegates to `computeMetrics()`, which runs three parallel database queries via `Promise.all`:

### Query 1 — Media type breakdown (bytes + counts)

```sql
SELECT mi.type AS type,
       COUNT(*)::bigint AS cnt,
       COALESCE(SUM(so.size), 0)::bigint AS bytes
FROM media_items mi
JOIN storage_objects so ON so.id = mi.storage_object_id
WHERE mi.deleted_at IS NULL
GROUP BY mi.type
```

**Why an INNER JOIN to `storage_objects`?** The join ensures only media items that have a linked storage object contribute to the byte totals. Orphan storage objects (upload-only rows not yet linked to a `media_item`) and upload-in-progress states are excluded. This makes the figure "media storage" rather than "raw bucket size."

**`COALESCE(SUM(so.size), 0)`** handles groups where `size` is null (e.g. a storage object row that has not yet had its size set); it prevents null from propagating to the BigInt total.

The query returns at most two rows (one for `type='photo'`, one for `type='video'`). The service reads both rows to extract `photoCnt`, `photoBytesBig`, `videoCnt`, and `videoBytesBig`. `totalBytes` is the sum of both byte values.

**Why BigInt?** `SUM(so.size)` over a large library can exceed `Number.MAX_SAFE_INTEGER` (roughly 9 PB). PostgreSQL returns the aggregate as a `bigint`; Prisma surfaces it as a JavaScript `BigInt`. The service converts to string before storing in JSONB.

### Query 2 — Total detected faces

```typescript
this.prisma.face.count()
```

A simple `COUNT(*)` over the `faces` table with no filters. Counts every face row across all circles, including faces assigned to a person and unassigned (unknown) faces. Does not filter by `deleted_at` because the `faces` table has no soft-delete column.

### Query 3 — Tagged items

```typescript
this.prisma.mediaTagStatus.count({
  where: {
    tagCount: { gt: 0 },
    mediaItem: { deletedAt: null },
  },
})
```

Counts `media_tag_status` rows where `tag_count > 0` and the linked media item is not soft-deleted. A media item is considered "tagged" if the AI tagging pipeline assigned at least one tag on its last successful run. Items that were tagged but later had all AI tags removed (empty model response on re-run) will have `tag_count = 0` and will not be counted.

---

## 4. Snapshot Lifecycle

### States

```
StorageInsightsHandler.process() called by worker
       │
       ├─── runComputation() succeeds ──► INSERT (status=ready, metrics=..., computed_at=now())
       │                                          │
       │                                          └─► DELETE older rows (prune to one)
       │
       └─── runComputation() throws ──► worker records lastError on enrichment_jobs row
                                         (attempts++ ; retried up to MAX_ATTEMPTS=3)
```

The in-flight and failure state is no longer tracked in `insights_snapshots`. It is tracked on the `enrichment_jobs` row and surfaced via the `refresh` object on `GET /api/admin/insights`.

### Pruning

After each successful compute, the service deletes all `insights_snapshots` rows except the newly inserted row:

```typescript
await this.prisma.insightsSnapshot.deleteMany({
  where: { id: { not: snapshot.id } },
});
```

This keeps the table to a single row at steady state: the latest ready snapshot.

### Concurrency Guarantee

The enrichment queue provides the single-in-flight guarantee. `EnrichmentJobService.enqueue()` checks for an existing `pending` or `running` job with the same `type` and null `mediaItemId` before inserting. Only one `storage_insights` job is ever active at a time. The previous in-process boolean flag (`this.computing`) has been removed from `InsightsService`.

---

## 5. Queue-Based Compute Architecture

Metric computation is performed by the `storage_insights` enrichment handler. This section describes the full flow from schedule trigger or manual request through to snapshot write.

### Components

| Component | File | Role |
|-----------|------|------|
| `StorageInsightsHandler` | `apps/api/src/insights/storage-insights.handler.ts` | Enrichment handler; type `'storage_insights'`; self-registers on `onModuleInit` |
| `InsightsService.runComputation()` | `apps/api/src/insights/insights.service.ts` | Runs three DB queries, writes a `ready` snapshot, prunes older rows |
| `InsightsService.enqueueRefresh()` | `apps/api/src/insights/insights.service.ts` | Calls `EnrichmentJobService.enqueue()` with `mediaItemId: null, circleId: null` |
| `InsightsService.getRefreshState()` | `apps/api/src/insights/insights.service.ts` | Queries the most recent `storage_insights` enrichment job row for state |
| `InsightsRefreshTask` | `apps/api/src/insights/insights-refresh.task.ts` | Hourly cron; gates on interval; calls `enqueueRefresh(backfill, 100)` |
| `InsightsController` | `apps/api/src/insights/insights.controller.ts` | Exposes `GET /admin/insights` and `POST /admin/insights/refresh` |
| `EnrichmentJobWorker` | `apps/api/src/enrichment/enrichment-job.worker.ts` | Generic worker; polls queue; dispatches to `StorageInsightsHandler` |

### Handler Registration

`StorageInsightsHandler` follows the standard self-registration pattern:

```typescript
@Injectable()
export class StorageInsightsHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'storage_insights';

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly insights: InsightsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(_job: EnrichmentJob): Promise<void> {
    await this.insights.runComputation();
  }
}
```

The handler ignores the job payload — `storage_insights` is a global job with no per-item context.

### Enqueue API

```typescript
// InsightsService
async enqueueRefresh(reason: JobReason, priority: number): Promise<EnrichmentJob> {
  return this.enrichmentJobService.enqueue({
    type: 'storage_insights',
    mediaItemId: null,   // global job — no media item
    circleId: null,      // global job — no circle
    reason,
    priority,
  });
}
```

Idempotency: if a `storage_insights` job is already `pending` or `running`, the existing job is returned without creating a duplicate.

### Worker Processing

The generic `EnrichmentJobWorker` claims and processes `storage_insights` jobs the same way it handles any other job type. Key properties:

- **MAX_ATTEMPTS = 3**: if `runComputation()` throws, the job retries up to two more times before reaching `failed` status.
- **Priority 0** (manual refresh via POST) pre-empts **priority 100** (scheduled refresh).
- **Visible in `/admin/jobs`**: the job appears in the admin job dashboard with `type='storage_insights'` and can be retried or deleted manually.

---

## 6. Cron and Interval-Gating Logic

**File:** `apps/api/src/insights/insights-refresh.task.ts`

The `InsightsRefreshTask` is a NestJS scheduled task using `@nestjs/schedule`. It runs on a fixed `@Cron(CronExpression.EVERY_HOUR)` schedule — every clock hour. On each tick the task **enqueues** a `storage_insights` enrichment job; it does not compute directly.

### Why Hourly Cron with an Interval Gate?

Running the aggregation too frequently wastes database resources for metrics that change slowly. Running it too infrequently means the dashboard is stale. The design separates the poll granularity (fixed 1 hour cron) from the configured refresh interval (admin-configurable, default 4 hours).

### Interval-Gate Logic

On each tick, the task:

1. Reads `storage.insights.refreshIntervalHours` from system settings (default 4 if the key is absent).
2. Checks the current refresh state — if a `storage_insights` job is already `pending` or `running`, returns early (the queue idempotency would also prevent a duplicate, but the early-exit avoids log noise).
3. Fetches the latest ready snapshot.
4. Checks whether `now - snapshot.computedAt >= refreshIntervalHours * 3_600_000`.
5. If the interval has not elapsed, the task returns early without enqueuing.
6. If the interval has elapsed (or no snapshot exists), calls `enqueueRefresh(JobReason.backfill, 100)`.

```
Tick at :00 → refresh already pending → SKIP
Tick at :00 → last computed 3h 55m ago → interval is 4h → SKIP
Tick at :00 → last computed 4h 02m ago → interval is 4h → ENQUEUE (priority 100)
Tick at :00 → no snapshot exists → ENQUEUE (priority 100)
```

### Effective Minimum Interval

The cron fires at most once per hour. Even if `refreshIntervalHours` is set to `1`, the actual minimum gap between recomputes is bounded by the cron poll granularity: approximately 1 hour. Setting `refreshIntervalHours` to `0` or a value below `1` is prevented by the system settings validation schema (minimum 1).

### Error Handling

If `enqueueRefresh()` throws, the task catches the error, logs it at `error` level, and does not rethrow. The cron continues to fire on the next tick. If the worker's execution of a queued job fails, the job is retried up to MAX_ATTEMPTS=3 times; permanent failure is recorded in the `enrichment_jobs` row and surfaced via `refresh.lastError` on `GET /admin/insights`.

---

## 7. System Setting

**Key:** `storage.insights.refreshIntervalHours`

| Property | Value |
|----------|-------|
| Type | integer |
| Minimum | 1 |
| Maximum | 168 (one week) |
| Default | 4 |
| Storage | `system_settings` JSONB, nested under `storage.insights.refreshIntervalHours` |
| Admin UI | System Settings admin page |

This setting controls how many hours must elapse between automatic cron-driven refreshes. It does not throttle manual refreshes via `POST /api/admin/insights/refresh` — an admin can enqueue a job at any time. However, the idempotency check means enqueuing while a job is already pending or running returns the existing job rather than creating a second one.

---

## 8. API Endpoints and RBAC

Both endpoints are mounted under `/api/admin/insights` and require the `Admin` system role. No new permissions were added; the endpoints reuse existing `system_settings:read` and `system_settings:write` to distinguish read-only dashboard access from write (refresh) access.

### `GET /api/admin/insights`

- **Auth:** Admin role + `system_settings:read`
- **Request body:** none
- **Behavior:** Parallel queries for the latest `ready` snapshot and the current `storage_insights` enrichment job state. Returns both.
- **Response 200 (ready snapshot, no job in flight):**
  ```json
  {
    "status": "ready",
    "metrics": {
      "totalBytes": "128849018880",
      "photoBytes": "107374182400",
      "videoBytes": "21474836480",
      "totalItems": 4200,
      "photoCount": 4100,
      "videoCount": 100,
      "totalFaces": 9300,
      "taggedItems": 2100
    },
    "computedAt": "2026-06-20T08:00:00.000Z",
    "durationMs": 312,
    "refresh": {
      "state": "idle",
      "jobId": null,
      "lastError": null
    }
  }
  ```
- **Response 200 (no snapshot, job pending):**
  ```json
  {
    "status": "empty",
    "metrics": null,
    "computedAt": null,
    "durationMs": null,
    "refresh": {
      "state": "pending",
      "jobId": "a1b2c3d4-...",
      "lastError": null
    }
  }
  ```

**`refresh.state` values:**

| Value | Meaning |
|-------|---------|
| `idle` | No active job; last job succeeded (or no job has ever run) |
| `pending` | Job is queued, waiting for the worker to claim it |
| `running` | Worker is currently executing the computation |
| `failed` | Job failed permanently after MAX_ATTEMPTS=3; `lastError` contains the error message |

### `POST /api/admin/insights/refresh`

- **Auth:** Admin role + `system_settings:write`
- **Request body:** none (body-less)
- **Behavior:** Calls `InsightsService.enqueueRefresh(JobReason.rerun, 0)`. Returns immediately with the job ID and current state. Does not wait for computation to complete.
- **Response 201:**
  ```json
  {
    "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "state": "pending"
  }
  ```
- **If a job is already in flight:** Returns the existing job's ID and state (`pending` or `running`) — no duplicate is created.
- **Polling:** The frontend polls `GET /api/admin/insights` and watches `refresh.state`. When state transitions to `idle`, the `metrics` and `computedAt` fields reflect the freshly computed snapshot. When state transitions to `failed`, `refresh.lastError` contains the failure reason.

### RBAC Summary

| Resource | Permission | Granted To |
|----------|------------|------------|
| Read latest snapshot + refresh state | `system_settings:read` | Admin only |
| Enqueue a refresh job | `system_settings:write` | Admin only |
| Retry/delete job in queue | `jobs:write` | Admin only (via `/admin/jobs` dashboard) |

No new permission scopes were created for this feature.

---

## 9. Frontend Dashboard

**Route:** `/admin/insights`

**Sidebar entry:** "Storage Insights"

**File:** `apps/web/src/pages/Admin/StorageInsightsPage.tsx`

The page is guarded by `usePermissions().isAdmin`; non-admin users are redirected to `/` via React Router `<Navigate>`.

### Layout and Components

The page is organized into three tiers:

**Tier 1 — Hero KPI cards** (four cards in a responsive grid)

| Card | Metric | Accent color |
|------|--------|-------------|
| Total Storage | `totalBytes` formatted as human-readable bytes | Primary |
| Total Items | `totalItems` compact count; subtitle shows `photoCount · videoCount` breakdown | Blue |
| Detected Faces | `totalFaces` compact count | Amber |
| Tagged Items | `taggedItems` compact count; subtitle shows percentage coverage of total items | Green |

Components used: `KpiCard` (`apps/web/src/components/insights/KpiCard.tsx`)

**Tier 2 — Composition donuts** (Photos vs Videos card)

Two `@mui/x-charts` PieChart-based composition donuts rendered side by side (stacked on mobile):

- **By storage**: photo bytes vs video bytes; center label shows total formatted bytes.
- **By count**: `photoCount` vs `videoCount`; center label shows total item count.

Components used: `CompositionDonut` (`apps/web/src/components/insights/CompositionDonut.tsx`)

**Tier 3 — Proportion bar** (inline within the composition card)

A horizontal bar segmented into photo and video proportions by byte size, with a caption "Storage breakdown by media type."

Component used: `ProportionBar` (`apps/web/src/components/insights/ProportionBar.tsx`)

### Header Controls

- **Freshness pill:** `FreshnessPill` (`apps/web/src/components/insights/FreshnessPill.tsx`) displays the `computedAt` timestamp as a relative "last updated" label and `durationMs` as "computed in Xms". Rendered only when `data` is available.
- **Refresh now button:** Calls `POST /api/admin/insights/refresh` via the `useInsights` hook. After receiving `{ jobId, state }`, the hook begins polling `GET /api/admin/insights` until `refresh.state` transitions to `idle` or `failed`. Shows a spinner while the job is `pending` or `running`; surfaces `lastError` on failure.

### States

| State | Trigger | Display |
|-------|---------|---------|
| Loading | Initial data fetch in progress | `KpiSkeleton` placeholder cards |
| Empty | `data.status === 'empty'` and `refresh.state === 'idle'` | Centered card with storage icon, "No insights computed yet" message, and a "Compute now" button |
| Refreshing | `refresh.state === 'pending'` or `'running'` | Existing metrics (or skeleton if none yet) with a refresh progress indicator |
| Failed | `refresh.state === 'failed'` | `Alert` with `refresh.lastError` and a "Retry" action button |
| Error | Network or API error | MUI `Alert` with severity `error` and a "Retry" action button |
| Loaded | `metrics` is non-null and `refresh.state === 'idle'` | All three tiers rendered |

### Data Fetching

Data is fetched and mutation is triggered through the `useInsights` hook (`apps/web/src/hooks/useInsights.ts`). The hook exposes `{ data, loading, refreshing, error, refresh }`.

When `data.refresh.state` is `pending` or `running` on page load (a scheduled job is already in flight), the hook automatically begins polling without requiring the user to click "Refresh now."

---

## 10. Gotchas and Implementation Notes

### BigInt Serialization

PostgreSQL `SUM(bigint)` values are returned by Prisma as JavaScript `BigInt`. `BigInt` values cannot be serialized by `JSON.stringify` (they throw `TypeError: Do not know how to serialize a BigInt`). The service converts all three byte fields to strings via `.toString()` before storing them in the JSONB `metrics` column.

Callers — including the frontend — must treat `totalBytes`, `photoBytes`, and `videoBytes` as strings, not numbers. The frontend utility `formatBytes` parses them as `BigInt` before formatting.

### Soft-Delete Exclusion

All item counts and byte sums filter on `mi.deleted_at IS NULL`. Items soft-deleted by users do not contribute to any metric. This applies to:

- The `COUNT(*)` and `SUM(so.size)` in the media type query.
- The `taggedItems` count via `mediaItem: { deletedAt: null }`.

The `totalFaces` count is the single exception: the `faces` table has no `deleted_at` column, so all face rows are counted regardless of the status of their parent media item.

### Media Storage vs Bucket Size

The byte sums use an `INNER JOIN media_items JOIN storage_objects`. This means:

- Storage objects not yet linked to a media item (e.g., an upload in progress) are excluded.
- Storage objects whose parent media item is soft-deleted are excluded (due to `WHERE mi.deleted_at IS NULL`).
- The figure reflects bytes consumed by live, committed media items — not the raw total bytes in the S3 bucket.

Admins who expect the number to match their S3 bucket `ListObjectsV2` total should be aware of this distinction. The dashboard metric will always be less than or equal to the raw bucket size.

### Effective 1-Hour Minimum Interval

The cron fires every clock hour (`CronExpression.EVERY_HOUR`). Even if `refreshIntervalHours` is set to its minimum value of `1`, recomputes cannot happen more frequently than once per hour. In practice the gap will be between 1 and 2 hours depending on when the last compute finished relative to the hour boundary.

### Manual Refresh Idempotency

`POST /api/admin/insights/refresh` calls `enqueueRefresh(JobReason.rerun, 0)`. The `EnrichmentJobService.enqueue()` idempotency check prevents duplicate jobs when a job is already `pending` or `running`. The returned `{ jobId, state }` will reference the existing job in that case. An admin can call POST repeatedly and will always get a reference to a single in-flight job — no pile-up.

### Admin Jobs Dashboard Visibility

`storage_insights` jobs appear in the `/admin/jobs` dashboard under `type='storage_insights'`. Admins can:
- Filter by `type=storage_insights` to see only insights jobs.
- Retry a permanently failed job via `POST /api/admin/jobs/:id/retry`.
- Delete old succeeded job rows for housekeeping.

Failed jobs should be reviewed in the jobs dashboard when `GET /admin/insights` reports `refresh.state === 'failed'`.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 2026 | AI Assistant | Initial specification |
| 1.1 | June 2026 | AI Assistant | Refactored: computation moved to enrichment queue; POST returns async {jobId,state}; GET adds refresh state object; removed in-process lock; documented nullable enrichment_jobs columns |
