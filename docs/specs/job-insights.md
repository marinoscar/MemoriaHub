# Job Queue Insights — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.1 |
| **Last Updated** | July 2026 |
| **Status** | Implemented |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [On-Demand Aggregate Model](#2-on-demand-aggregate-model)
3. [Lock-Safety Rationale](#3-lock-safety-rationale)
4. [Response Shape](#4-response-shape)
5. [ETA Formula and Basis Semantics](#5-eta-formula-and-basis-semantics)
6. [API Endpoint and RBAC](#6-api-endpoint-and-rbac)
7. [Job History Retention](#7-job-history-retention)
8. [Frontend Dashboard](#8-frontend-dashboard)
9. [CLI Dashboard](#9-cli-dashboard)
10. [Gotchas and Implementation Notes](#10-gotchas-and-implementation-notes)

---

## 1. Overview and Goals

The Job Queue Insights feature gives administrators real-time visibility into the enrichment job queue: how many jobs are pending, running, failed, or rate-limited; how long each job type is taking on average; and an estimated completion time (ETA) for the remaining work. The primary use case is monitoring large bulk imports — thousands of photos being tagged, face-detected, or geocoded — where operators need to know whether the queue is healthy and roughly how long until it drains.

### Goals

- Surface live queue health (pending, running, failed, rate-limited, backing off, retried) at a glance.
- Provide per-type duration percentiles (avg, p50, p95) and throughput so operators can identify slow handlers.
- Compute an ETA for the remaining queue based on observed throughput, scoped to a configurable recent window.
- Make the aggregate read-only and on-demand — no background polling, no snapshot table, no new database tables.
- Stay lock-safe: the aggregate queries must never block the enrichment worker.
- Provide both a web UI (`/admin/settings/jobs/insights`) and a CLI terminal dashboard (`memoriahub jobs`).

### Non-Goals

- Historical trend storage: insights are computed fresh on each request against the live `enrichment_jobs` table.
- Per-circle or per-user breakdowns: all aggregates are global across all job types and circles.
- Real-time push: the web page and CLI poll at a configurable interval; there is no WebSocket or SSE feed.

---

## 2. On-Demand Aggregate Model

Unlike Storage Insights (which pre-computes a snapshot on a schedule), Job Queue Insights computes everything on-demand when `GET /api/admin/jobs/insights` is called. There is no snapshot table, no cron, and no background worker involved in the aggregation.

Each request runs two categories of SQL:

**Live counts** — status aggregates over all rows in `enrichment_jobs` (no date filter, full table):
- `COUNT(*)` total
- `COUNT(*) GROUP BY status` for pending / running / succeeded / failed
- `COUNT(*) WHERE scheduledFor > now AND status = pending` for scheduled (backing off)
- `COUNT(*) WHERE rateLimitHits > 0 AND status IN (pending, running)` for rate-limited
- `COUNT(*) WHERE attempts > 1` for retried
- `COUNT(*) GROUP BY type` for per-type breakdowns of total, pending, running, succeeded, failed

**History aggregates** — duration and throughput over succeeded jobs only, bounded to the last `windowDays` days (default 7, max 90):
- `AVG(EXTRACT(EPOCH FROM (finishedAt - startedAt)) * 1000)` — average duration in ms
- `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ...)` — p50 (median) duration in ms
- `PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ...)` — p95 duration in ms
- `COUNT(*) FILTER (WHERE finishedAt >= now() - interval '1 hour') / 60.0` — throughput per minute (succeeded in last 60 minutes / 60)

The duration window (`windowDays`) prevents the aggregate from scanning the entire history table on instances with millions of succeeded rows. The default of 7 days captures recent performance without including data from before the last tuning change.

### `getStats()` Supporting Indexes and Caching (issue #135)

`getInsights()`'s `live` block is produced by calling `EnrichmentAdminService.getStats()` internally (also the backing query for the standalone `GET /api/admin/jobs/stats`, polled every 5s by the Job Queue dashboard). `getStats()` runs two full-table `groupBy` aggregates — `by: ['status']` and `by: ['type', 'status']` — with no `WHERE` clause. Migration `20260719010000_enrichment_jobs_stats_perf_indexes` adds three indexes to cut the cost of these and of the duration/retry aggregates above:

- `enrichment_jobs_status_type_id_idx` on `(status, type, id)` — a single covering index answering both unconditional `groupBy` calls via Index-Only Scan (the leading `status` key serves the plain status groupBy, the trailing `type` key serves the `(type, status)` groupBy, and `id` is included so `COUNT(id)` never touches the heap).
- `enrichment_jobs_attempts_gt1_idx`, partial on `WHERE attempts > 1` — speeds up the `retried` count (Section 4) since only a small fraction of rows match.
- `enrichment_jobs_succeeded_duration_idx`, partial on `WHERE status='succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL`, keyed `(finished_at, started_at, type)` — serves the windowed duration aggregates above plus the un-windowed lifetime duration query in Section 7.

`getStats()` additionally caches its result in-process for 2s (`STATS_CACHE_TTL_MS`), shorter than the dashboard's 5s poll interval so a single tab never visibly observes stale data. This collapses concurrent/rapid callers — multiple admin tabs polling, or `getInsights()` invoking `getStats()` moments after a plain stats poll — into one computed result instead of re-running the aggregates per call. There is no invalidation hook: mutation endpoints (retry, resetStuck, delete, ...) rely on the frontend's own `refresh()` call in `useJobs.ts` to pick up fresh data, the same passive-staleness tradeoff `SystemSettingsService.getSettings()`'s cache already makes elsewhere in the codebase.

**Deliberately not time-windowed.** Issue #135 itself proposed scoping `getStats()`'s `byStatus`/`byType` counts to a recent activity window instead of (or in addition to) indexing, to bound the aggregate's row count directly. This was investigated and rejected: `apps/web/src/pages/Admin/JobsPage.tsx` uses `stats.byStatus.failed === 0` to gate the "Retry all failed" button, and renders `stats.total` / `byStatus.*` / `byType[].total` as plain, unlabeled all-time counts. Windowing would silently break that button's correctness and put the stats cards out of sync with the jobs table's own all-time total (`meta.totalItems` from `listJobs`, which defaults to `processedWithin: 'all'`). The shipped fix is index-and-cache only — `getStats()`'s return shape and all-time semantics are unchanged. Do not reintroduce windowing here without also updating `JobsPage.tsx`'s consumption of these fields.

---

## 3. Lock-Safety Rationale

The enrichment worker uses `SELECT ... FOR UPDATE SKIP LOCKED` to atomically claim pending jobs, acquiring ROW EXCLUSIVE locks on claimed rows. A naive aggregate that used locking reads could compete with the worker and slow or block it during busy imports.

All queries in `GET /api/admin/jobs/insights` are pure `SELECT` statements — including the `PERCENTILE_CONT` ordered-set aggregates. These take only ACCESS SHARE locks on the `enrichment_jobs` table. ACCESS SHARE is fully compatible with ROW EXCLUSIVE: multiple readers and the worker can proceed simultaneously without blocking each other.

Additionally, the duration scan is bounded to `finishedAt >= now() - windowDays * interval '1 day'`. PostgreSQL can use the index on `(type, status)` and `finishedAt` to limit the scan to recent rows, so the aggregate cost scales with recent throughput rather than the total retained history.

The endpoint is called only on demand (user opens the web page or CLI polls), not on a continuous background schedule, so its total load on the database is proportional to human usage.

---

## 4. Response Shape

`GET /api/admin/jobs/insights?windowDays=<n>` returns a `JobInsights` object:

```json
{
  "computedAt": "2026-06-28T12:00:00.000Z",
  "windowDays": 7,
  "concurrency": 1,

  "live": {
    "total": 8420,
    "byStatus": {
      "pending": 3100,
      "running": 1,
      "succeeded": 5200,
      "failed": 119
    },
    "pending": 3100,
    "running": 1,
    "failed": 119,
    "scheduled": 14,
    "rateLimited": 3,
    "retried": 42,
    "byType": [
      {
        "type": "auto_tagging",
        "total": 5000,
        "pending": 2500,
        "running": 1,
        "succeeded": 2400,
        "failed": 99
      },
      {
        "type": "face_detection",
        "total": 3000,
        "pending": 600,
        "running": 0,
        "succeeded": 2380,
        "failed": 20
      }
    ]
  },

  "history": {
    "overall": {
      "samples": 4780,
      "avgMs": 3240,
      "p50Ms": 2900,
      "p95Ms": 8100,
      "throughputPerMin": 2.4
    },
    "byType": [
      {
        "type": "auto_tagging",
        "samples": 2400,
        "avgMs": 4200,
        "p50Ms": 3800,
        "p95Ms": 9500,
        "throughputPerMin": 1.2
      },
      {
        "type": "face_detection",
        "samples": 2380,
        "avgMs": 2200,
        "p50Ms": 1900,
        "p95Ms": 6200,
        "throughputPerMin": 1.2
      }
    ]
  },

  "eta": {
    "totalRemaining": 3101,
    "etaMs": 7462400,
    "basis": "live",
    "perType": [
      {
        "type": "auto_tagging",
        "remaining": 2501,
        "avgMs": 4200,
        "etcMs": 10504200
      },
      {
        "type": "face_detection",
        "remaining": 600,
        "avgMs": 2200,
        "etcMs": 1320000
      }
    ],
    "computedAt": "2026-06-28T12:00:00.000Z"
  }
}
```

### Field Definitions

**Top-level:**

| Field | Type | Description |
|-------|------|-------------|
| `computedAt` | ISO 8601 | Timestamp of when this response was assembled |
| `windowDays` | number | Duration window used for history aggregates (query param, default 7) |
| `concurrency` | number | `ENRICHMENT_WORKER_CONCURRENCY` env value used in ETA denominator |

**`live` object:**

| Field | Type | Description |
|-------|------|-------------|
| `total` | number | Total rows in `enrichment_jobs` |
| `byStatus` | object | Counts split by `pending / running / succeeded / failed` |
| `pending` | number | Shorthand for `byStatus.pending` |
| `running` | number | Shorthand for `byStatus.running` |
| `failed` | number | Shorthand for `byStatus.failed` |
| `scheduled` | number | Pending jobs currently in backoff (`scheduledFor > now`) |
| `rateLimited` | number | Jobs with `rateLimitHits > 0` and status `pending` or `running` |
| `retried` | number | Jobs with `attempts > 1` (have been attempted more than once) |
| `byType` | array | Per-type breakdown of total / pending / running / succeeded / failed |

**`history.overall` and `history.byType[]` objects:**

| Field | Type | Description |
|-------|------|-------------|
| `samples` | number | Count of succeeded jobs in the window whose duration was measurable |
| `avgMs` | number | Average duration in milliseconds |
| `p50Ms` | number | Median (50th percentile) duration in milliseconds |
| `p95Ms` | number | 95th percentile duration in milliseconds |
| `throughputPerMin` | number | Succeeded jobs in the last 60 minutes divided by 60 |

**`eta` object:**

| Field | Type | Description |
|-------|------|-------------|
| `totalRemaining` | number | `pending + running` across all types |
| `etaMs` | number \| null | Overall estimated time to completion in ms; null when `basis === 'none'` |
| `basis` | `'live'` \| `'partial'` \| `'none'` | Reliability indicator (see ETA section below) |
| `perType` | array | Per-type ETA breakdown |
| `computedAt` | ISO 8601 | Matches top-level `computedAt` |

**`eta.perType[]` items:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Job type string |
| `remaining` | number | Pending + running count for this type |
| `avgMs` | number | Average ms used for this type's ETA; may be a fallback value |
| `etcMs` | number \| null | Per-type estimated time to completion in ms |

---

## 5. ETA Formula and Basis Semantics

The ETA computation answers: given the current backlog and observed processing speed, how long until the queue is empty?

### Formula

```
etcMs_per_type = remaining_type × avgMs_type / concurrency
etaMs_overall  = max(etcMs_per_type) across all types with remaining > 0
```

The overall ETA is the maximum per-type ETA rather than the sum, because job types run concurrently on the same worker pool. The slowest bottleneck type determines when the queue drains.

`concurrency` is read from `ENRICHMENT_WORKER_CONCURRENCY` (default 1). With concurrency = 1, only one job runs at a time, so the division is a no-op. With concurrency = 2, jobs drain roughly twice as fast.

### Average Duration Fallback Hierarchy

For each job type with remaining > 0:

1. **Type-specific average:** Use `history.byType[type].avgMs` if the type has at least one sample in the history window.
2. **Overall average fallback:** Use `history.overall.avgMs` if no type-specific sample exists.
3. **Hardcoded fallback:** Use 5000 ms if there is no history at all (the window contains zero succeeded jobs).

### `basis` Values

| Value | Condition | Meaning |
|-------|-----------|---------|
| `'live'` | All types with remaining > 0 have type-specific history samples | ETA is computed entirely from observed data for each type |
| `'partial'` | At least one type uses the overall avg or hardcoded fallback | ETA is an estimate; some types lack type-specific history |
| `'none'` | No succeeded jobs exist at all (history window is empty or queue has never run) | No basis for an estimate; `etaMs` is null |

When `basis === 'partial'`, the web UI and CLI display a warning that the estimate is approximate. When `basis === 'none'`, the ETA section shows "No history available."

---

## 6. API Endpoint and RBAC

### `GET /api/admin/jobs/insights`

- **Auth:** Admin role + `jobs:read`
- **No new permissions** — reuses the existing `jobs:read` permission already granted to Admin users.
- **Query parameters:**

| Parameter | Type | Default | Maximum | Description |
|-----------|------|---------|---------|-------------|
| `windowDays` | integer | 7 | 90 | Number of days of succeeded-job history to include in duration aggregates |

- **Request body:** none
- **Behavior:** Runs all live count queries and history aggregate queries in parallel and assembles the `JobInsights` response. Returns immediately — no async work is triggered.
- **Response 200:** `JobInsights` object (see Section 4).
- **No side effects:** read-only; does not modify any job row.

### RBAC Summary

| Resource | Permission | Granted To |
|----------|------------|------------|
| Read live counts, duration aggregates, and ETA | `jobs:read` | Admin only |
| No write operations | — | — |

---

## 7. Job History Retention

As the enrichment queue grows over time, old `succeeded` and `failed` rows accumulate. The `job_history_purge` job type manages this retention automatically.

### System Settings

Two new system settings control retention behavior, editable in the System Settings admin page:

| Key | Type | Range | Default | Description |
|-----|------|-------|---------|-------------|
| `jobs.history.retentionDays` | integer | 1–365 | 30 | How many days of terminal job rows to retain. Rows with `finishedAt < now - retentionDays` are eligible for deletion. |
| `jobs.history.purgeEnabled` | boolean | — | true | When false, the nightly cron does not enqueue a purge job. Disable to pause purging during an incident investigation or forensic audit. |

Pending and running jobs are never deleted by the purge — it only targets terminal rows (`status IN (succeeded, failed)`) with a `finishedAt` past the retention cutoff.

### `job_history_purge` Enrichment Handler

The handler is a global enrichment job (no `mediaItemId`, no `circleId`). It runs in the same worker pool as all other handlers, so it inherits retries, priority, and admin-dashboard visibility automatically.

**Handler behavior:**

1. Reads `jobs.history.purgeEnabled` (default true) and `jobs.history.retentionDays` (default 30) from system settings. If purging is disabled, it returns without touching the table.
2. Selects up to 5 000 eligible terminal rows (`status IN ('succeeded','failed') AND finished_at < cutoff`), reading `type`, `status`, `started_at`, `finished_at`.
3. **Folds the batch into the lifetime rollup before deleting it.** Per-type deltas (succeeded/failed counts, summed duration + sample count for succeeded rows with both timestamps) are upserted into `job_stats_rollup`, and the batch `deleteMany` is issued — both inside a single `$transaction`, so a crash can never delete a row without counting it or count it without deleting it.
4. Repeats until a short batch (< 5 000) signals no rows remain.
5. The 5 000-row batch size keeps each transaction short, limiting the duration of its ROW EXCLUSIVE lock and avoiding long contention with the worker's SELECT FOR UPDATE.

### Lifetime Totals Rollup (`job_stats_rollup`)

To keep all-time analytics from being lost when history is purged, the purge folds each deleted batch into a `job_stats_rollup` table (PK `type`) holding `succeeded_count`, `failed_count`, `sum_duration_ms` (DOUBLE PRECISION — exact for integers up to 2^53 ms, sidestepping the JSON-unsafe BigInt pitfall), and `duration_samples` (the average denominator). Only exactly-mergeable aggregates are stored — counts and total duration → average. **Percentiles are deliberately not rolled up** (they cannot be merged from pre-aggregated buckets without a histogram/t-digest), so p50/p95 remain live-window-only.

`GET /api/admin/jobs/insights` exposes these as `lifetime.overall` and `lifetime.byType[]`, merging the rollup (purged rows) with un-windowed live aggregates (rows still in the table) so each row is counted exactly once. `POST /api/admin/jobs/insights/reset-history` (jobs:write) truncates the rollup to start analytics fresh; live job rows are unaffected.

**Scheduling:** The `JobHistoryPurgeTask` cron (`@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)`) runs nightly. On each tick it:

1. Checks `jobs.history.purgeEnabled`; if false, returns without enqueuing.
2. Checks whether a `job_history_purge` job is already `pending` or `running`; if so, returns (the idempotency guarantee prevents a queue pile-up).
3. Calls `EnrichmentJobService.enqueue({ type: 'job_history_purge', mediaItemId: null, circleId: null, reason: 'backfill', priority: 100 })`.

Priority 100 (lowest) ensures the purge runs as background housekeeping and never pre-empts active user-triggered or upload-triggered work.

**Visibility:** `job_history_purge` jobs appear in the `/admin/settings/jobs` queue dashboard under `type='job_history_purge'` and can be retried or deleted manually. A permanently failed purge job (after 3 attempts) surfaces in the jobs dashboard with `lastError` populated.

---

## 8. Frontend Dashboard

**Route:** `/admin/settings/jobs/insights`

**Access:** Admin role + `jobs:read`. Non-admin users are redirected to `/`.

**Entry points:**
- Settings hub Operations group: "Job Insights" link.
- Job Queue page (`/admin/settings/jobs`): "View insights & ETA" button in the page header.

### Layout

The page is organized into two tiers:

**Tier 1 — KPI cards** (responsive grid, stacked on mobile)

| Card | Metric | Notes |
|------|--------|-------|
| Overall ETC | `eta.etaMs` formatted as "Xh Ym" | Badge shows `basis` value; warning when `basis === 'partial'` |
| Avg Duration | `history.overall.avgMs` formatted as "Xs" | |
| Pending | `live.pending` | |
| Running | `live.running` | |
| Failed | `live.failed` | |
| Rate-Limited | `live.rateLimited` | |
| Backing Off | `live.scheduled` | Pending jobs deferred due to backoff |
| Retried | `live.retried` | Jobs that have been attempted more than once |
| Throughput | `history.overall.throughputPerMin` formatted as "/min" | |

**Tier 2 — Per-type table** (full-width, horizontally scrollable on mobile)

Columns: Type | Avg Duration | P95 | Throughput/min | Pending | Running | Failed | Per-type ETC

The table is sorted by `remaining` descending so the most backlogged types appear first.

### Polling

The page polls `GET /api/admin/jobs/insights` at a fixed 30-second interval by default. The interval is not configurable in the UI (use the CLI `--interval` flag for faster polling).

### Empty and Loading States

| State | Trigger | Display |
|-------|---------|---------|
| Loading | Initial fetch | Skeleton cards and table rows |
| No history | `eta.basis === 'none'` | ETC card shows "No history available"; table shows avg/p95 as "—" |
| Partial history | `eta.basis === 'partial'` | ETC card shows amber warning icon and "Estimate (partial data)" label |
| Error | Network or API error | MUI Alert with "Retry" button |
| Loaded | Normal response | All tiers rendered |

---

## 9. CLI Dashboard

**Command:** `memoriahub jobs` (alias: `memoriahub queue`)

**Requirements:** Admin personal access token (PAT) with `jobs:read` scope, configured via `MEMORIAHUB_TOKEN` environment variable or `--token` flag.

**Interactive entry point:** The CLI's interactive Ink TUI now organizes actions into a hierarchical menu; this dashboard is reachable via `Tools ▸ Job queue monitor` from the menu (previously the dashboard was only reachable as a standalone command). The headless `memoriahub jobs` (alias `queue`) command and all flags below are unchanged.

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--interval <seconds>` | integer | 5 | Polling interval for the live TUI dashboard |
| `--once` | boolean | false | Print a single headless snapshot to stdout and exit |
| `--json` | boolean | false | Print raw `JobInsights` JSON to stdout and exit (implies `--once`) |
| `--window <days>` | integer | 7 | Pass as `windowDays` to the API |

### Terminal Dashboard (Ink TUI)

When run without `--once` or `--json`, the command launches an Ink-based terminal UI that refreshes every `--interval` seconds. The layout mirrors the web page:

- **Header row:** Overall ETC, avg duration, throughput, pending, running, failed, rate-limited, backing off, retried.
- **Per-type table:** Type, avg, p95, throughput/min, pending, running, failed, per-type ETC.
- **Footer:** Last updated timestamp, poll interval, `basis` indicator.

The TUI gracefully handles terminal resize and degrades to a simplified layout on narrow terminals (< 80 columns).

Press `q` or `Ctrl+C` to exit the live dashboard.

### Headless Modes

`--once` prints a formatted snapshot table to stdout (same columns as the TUI) and exits with code 0 on success or 1 on API error. Suitable for scripting and CI status checks.

`--json` prints the raw `JobInsights` JSON object on a single line and exits. Suitable for piping into `jq` or other tools.

### Example Usage

```bash
# Live terminal dashboard, refresh every 5 seconds
memoriahub jobs

# Single snapshot, human-readable
memoriahub jobs --once

# Single snapshot, raw JSON piped to jq
memoriahub jobs --json | jq '.eta'

# Use a 30-day history window, poll every 10 seconds
memoriahub jobs --window 30 --interval 10
```

---

## 10. Gotchas and Implementation Notes

### Window Default and the Insights Retention Interaction

The history window (default 7 days) and the job history retention (`jobs.history.retentionDays`, default 30 days) are independent settings. If `jobs.history.retentionDays` is lowered below `windowDays`, the history scan will return fewer samples than expected — the rows no longer exist. In practice, the default values (7-day window, 30-day retention) leave a comfortable margin. Admins who lower retention below 7 days should also lower `windowDays` to match.

### `etaMs` Units

All duration fields in the response are in **milliseconds**, including `etaMs`, `etcMs`, `avgMs`, `p50Ms`, and `p95Ms`. The web UI and CLI format these for display (e.g., "2h 14m" for a large ETA, "3.2 s" for a short average duration). Raw API consumers must divide by 1000 to get seconds.

### `throughputPerMin` Precision

`throughputPerMin` is a floating-point number computed as `succeeded_in_last_60_min / 60.0`. Values below 0.1 will display as "< 0.1/min" in the UI. A value of 0.0 means no jobs succeeded in the last hour — which may indicate the queue is drained, the worker is stopped, or all recent jobs are failing.

### Basis `'none'` and Null `etaMs`

When `eta.basis === 'none'`, the `etaMs` field is `null` (not 0). API consumers must null-check before formatting. The web UI and CLI both handle this explicitly.

### Global Job Idempotency for `job_history_purge`

Like `storage_insights` and `trash_purge`, `job_history_purge` uses the global job idempotency check: `(type='job_history_purge', mediaItemId IS NULL)`. If the nightly cron fires while a previous purge is still running (possible if the queue has a very large number of rows to delete), the cron returns without creating a second job.

### Batch Size and Lock Duration

The 5 000-row batch DELETE uses a single statement with a `LIMIT`. Each batch holds a brief ROW EXCLUSIVE lock on the deleted rows. The worker's claim query uses `SELECT ... FOR UPDATE SKIP LOCKED`, so it skips any rows locked by the DELETE and continues processing other pending jobs without waiting. Purge and enrichment processing are fully concurrent.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 2026 | AI Assistant | Initial specification |
| 1.1 | July 2026 | AI Assistant | Document `getStats()` supporting indexes and 2s TTL cache (issue #135), and the rejected time-windowing alternative |
