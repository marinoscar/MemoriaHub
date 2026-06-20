# Storage Insights — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | June 2026 |
| **Status** | Implemented |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Data Model](#2-data-model)
3. [Metric Definitions and Aggregation Logic](#3-metric-definitions-and-aggregation-logic)
4. [Snapshot Lifecycle](#4-snapshot-lifecycle)
5. [Cron and Interval-Gating Logic](#5-cron-and-interval-gating-logic)
6. [System Setting](#6-system-setting)
7. [API Endpoints and RBAC](#7-api-endpoints-and-rbac)
8. [Frontend Dashboard](#8-frontend-dashboard)
9. [Gotchas and Implementation Notes](#9-gotchas-and-implementation-notes)

---

## 1. Overview and Goals

Storage Insights is a global, admin-only dashboard that surfaces media storage metrics aggregated across all circles. It answers questions that span the entire library — total bytes stored, how storage is split between photos and videos, total item counts, how many faces have been detected, and how many items carry AI-generated tags.

### Goals

- Give admins a quick, reliable read on storage growth without running manual SQL.
- Keep queries off the hot path: metrics are precomputed and cached in a snapshot table rather than recomputed on every page load.
- Provide a manual escape hatch (hard refresh) so admins can see up-to-date data immediately when needed.
- Reuse existing `system_settings:read` / `system_settings:write` permissions — no new RBAC surface.

### Non-Goals

- Historical trend data or per-circle breakdowns are not provided. Only the most recent aggregate snapshot is kept.
- The dashboard does not track raw bucket size (bytes in S3 for all objects). It tracks media storage — bytes attributable to non-deleted media items.

---

## 2. Data Model

### `insights_snapshots` Table

One row per compute run. After each successful run, older rows are pruned so at most one row survives.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `status` | `InsightsSnapshotStatus` | See enum below |
| `metrics` | JSONB | Null until status reaches `ready`; holds `InsightsMetrics` (see below) |
| `computed_at` | Timestamptz | Timestamp of when the compute finished; null until `ready` |
| `duration_ms` | Integer | Wall-clock milliseconds the compute took; null until `ready` |
| `error` | Text | Error message if status is `failed`; null otherwise |
| `created_at` | Timestamptz | When the row was inserted (`computing` status) |

### `InsightsSnapshotStatus` Enum

| Value | Meaning |
|-------|---------|
| `computing` | Aggregation query is in progress; `metrics` and `computed_at` are null |
| `ready` | Aggregation succeeded; `metrics` and `computed_at` are populated |
| `failed` | Aggregation threw an error; `error` column contains the message |

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

---

## 3. Metric Definitions and Aggregation Logic

The service (`apps/api/src/insights/insights.service.ts`) runs three parallel database queries via `Promise.all`:

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
INSERT (status=computing)
       │
       ├─── computeMetrics() succeeds ──► UPDATE (status=ready, metrics=..., computed_at=now())
       │                                          │
       │                                          └─► DELETE older rows (prune to one)
       │
       └─── computeMetrics() throws ──► UPDATE (status=failed, error=message)
```

### Pruning

After each successful compute, the service deletes all `insights_snapshots` rows except the newly updated row:

```typescript
await this.prisma.insightsSnapshot.deleteMany({
  where: { id: { not: updated.id } },
});
```

This keeps the table to a single row at steady state: the latest ready snapshot. Failed rows are also pruned if a subsequent compute succeeds.

### In-Process Concurrency Guard

`InsightsService` maintains a `computing: boolean` flag. If `recompute()` is called while a compute is already in flight (e.g., a manual refresh arrives while the cron is running), the second caller immediately returns the current latest snapshot rather than starting a second concurrent aggregation:

```typescript
if (this.computing) {
  const existing = await this.getLatest();
  if (existing) return existing;
  throw new Error('Insights recompute already in progress and no existing snapshot available');
}
```

This guard is in-process only. If multiple API replicas run simultaneously (horizontal scale), both could start a compute. For the typical single-replica MemoriaHub deployment this is not an issue; in a multi-replica setup the worst case is two parallel aggregation queries and two snapshot rows, one of which is pruned by whichever replica finishes last.

### `getLatest()`

Returns the most recently created row with `status='ready'`. The `status='computing'` and `status='failed'` rows are excluded from this query, so a failed or in-progress compute never surfaces as the "latest" data on the dashboard.

---

## 5. Cron and Interval-Gating Logic

**File:** `apps/api/src/insights/insights-refresh.task.ts`

The `InsightsRefreshTask` is a NestJS scheduled task using `@nestjs/schedule`. It runs on a fixed `@Cron(CronExpression.EVERY_HOUR)` schedule — every clock hour.

### Why Hourly Cron with an Interval Gate?

Running the aggregation too frequently wastes database resources for metrics that change slowly. Running it too infrequently means the dashboard is stale. The design separates the poll granularity (fixed 1 hour cron) from the configured refresh interval (admin-configurable, default 4 hours).

### Interval-Gate Logic

On each tick, the task:

1. Reads `storage.insights.refreshIntervalHours` from system settings (default 4 if the key is absent).
2. Fetches the latest ready snapshot.
3. Checks whether `now - snapshot.computedAt >= refreshIntervalHours * 3_600_000`.
4. If the interval has not elapsed, the task returns early without calling `recompute()`.
5. If the interval has elapsed (or no snapshot exists), `recompute()` is called.

```
Tick at :00 → last computed 3h 55m ago → interval is 4h → SKIP
Tick at :00 → last computed 4h 02m ago → interval is 4h → RECOMPUTE
Tick at :00 → no snapshot exists → RECOMPUTE
```

### Effective Minimum Interval

The cron fires at most once per hour. Even if `refreshIntervalHours` is set to `1`, the actual minimum gap between recomputes is bounded by the cron poll granularity: approximately 1 hour. Setting `refreshIntervalHours` to `0` or a value below `1` is prevented by the system settings validation schema (minimum 1).

### Error Handling

If `recompute()` throws, the task catches the error, logs it at `error` level, and does not rethrow. The cron continues to fire on the next tick. The `insights_snapshots` table will have a row with `status='failed'` in this case.

---

## 6. System Setting

**Key:** `storage.insights.refreshIntervalHours`

| Property | Value |
|----------|-------|
| Type | integer |
| Minimum | 1 |
| Maximum | 168 (one week) |
| Default | 4 |
| Storage | `system_settings` JSONB, nested under `storage.insights.refreshIntervalHours` |
| Admin UI | System Settings admin page |

This setting controls how many hours must elapse between automatic cron-driven recomputes. It does not throttle manual hard refreshes via `POST /api/admin/insights/refresh` — an admin can always force a recompute regardless of when the last one ran.

---

## 7. API Endpoints and RBAC

Both endpoints are mounted under `/api/admin/insights` and require the `Admin` system role. No new permissions were added; the endpoints reuse existing `system_settings:read` and `system_settings:write` to distinguish read-only dashboard access from write (refresh) access.

### Response DTO

Both endpoints return an `InsightsSnapshotDto`:

```typescript
interface InsightsSnapshotDto {
  status: 'ready' | 'empty';
  metrics: InsightsMetrics | null;
  computedAt: string | null;   // ISO 8601 string
  durationMs: number | null;
}
```

The `empty` status indicates no ready snapshot exists in the database (never computed or last compute failed). The `ready` status indicates `metrics`, `computedAt`, and `durationMs` are all populated.

### `GET /api/admin/insights`

- **Auth:** Admin role + `system_settings:read`
- **Request body:** none
- **Behavior:** Queries `insights_snapshots` for the most recently created row with `status='ready'`. If no such row exists, returns the `empty` DTO.
- **Response 200 (ready):**
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
    "durationMs": 312
  }
  ```
- **Response 200 (empty):**
  ```json
  {
    "status": "empty",
    "metrics": null,
    "computedAt": null,
    "durationMs": null
  }
  ```

### `POST /api/admin/insights/refresh`

- **Auth:** Admin role + `system_settings:write`
- **Request body:** none (body-less)
- **Behavior:** Calls `InsightsService.recompute()` synchronously. Waits for the aggregation to complete and returns the freshly computed snapshot. This bypasses the interval gate — an admin can force a recompute at any time regardless of when the last automatic refresh ran.
- **Response 201 (always `ready` on success):**
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
    "computedAt": "2026-06-20T10:15:00.000Z",
    "durationMs": 298
  }
  ```
- **Error:** If a compute is already in progress, the in-process guard returns the current snapshot; if none exists yet, a 500 is raised.

### RBAC Summary

| Resource | Permission | Granted To |
|----------|------------|------------|
| Read latest snapshot | `system_settings:read` | Admin only |
| Force recompute | `system_settings:write` | Admin only |

No new permission scopes were created for this feature.

---

## 8. Frontend Dashboard

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
- **Refresh now button:** Calls `POST /api/admin/insights/refresh` via the `useInsights` hook. Shows a spinner while refreshing; label changes to "Updated!" for 3 seconds on success.

### States

| State | Trigger | Display |
|-------|---------|---------|
| Loading | Initial data fetch in progress | `KpiSkeleton` placeholder cards |
| Empty | `data.status === 'empty'` or `metrics` is null | Centered card with storage icon, "No insights computed yet" message, and a "Compute now" button |
| Error | Network or API error | MUI `Alert` with severity `error` and a "Retry" action button |
| Loaded | `metrics` is non-null | All three tiers rendered |

### Data Fetching

Data is fetched and mutation is triggered through the `useInsights` hook (`apps/web/src/hooks/useInsights.ts`). The hook exposes `{ data, loading, refreshing, error, refresh }`.

---

## 9. Gotchas and Implementation Notes

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

The interval gate checks `now - computedAt < intervalMs` and skips the recompute when true. "Now" is evaluated at tick time, not at the time the cron was scheduled. Clock drift and container restarts can cause slight variation.

### Manual Refresh Bypasses the Interval Gate

`POST /api/admin/insights/refresh` calls `recompute()` directly, skipping the interval check. An admin can trigger as many hard refreshes as they want. The in-process guard prevents two concurrent aggregation queries from the same replica, but it does not enforce any per-request rate limit.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 2026 | AI Assistant | Initial specification |
