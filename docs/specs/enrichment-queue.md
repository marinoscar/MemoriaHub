# Enrichment Queue — Generic Background Job System

| Field | Value |
|-------|-------|
| **Version** | 1.8 |
| **Last Updated** | July 2026 |

---

## Table of Contents

1. [Purpose and Rationale](#1-purpose-and-rationale)
2. [Data Model](#2-data-model)
3. [Components Overview](#3-components-overview)
4. [EnrichmentHandler Interface](#4-enrichmenthandler-interface)
5. [EnrichmentHandlerRegistry](#5-enrichmenthandlerregistry)
6. [Self-Registration Pattern](#6-self-registration-pattern)
7. [EnrichmentJobService.enqueue](#7-enrichmentjobserviceenqueue)
8. [EnrichmentJobWorker](#8-enrichmentjobworker)
9. [Priority Conventions](#9-priority-conventions)
10. [Upload Enrichment Trigger Model](#10-upload-enrichment-trigger-model)
11. [Admin Jobs Dashboard](#11-admin-jobs-dashboard)
12. [How to Add a New Enrichment Capability](#12-how-to-add-a-new-enrichment-capability)
13. [Configuration](#13-configuration)
14. [Operational Notes](#14-operational-notes)
15. [Registered Handlers Reference](#15-registered-handlers-reference)
16. [Future Extension Ideas](#16-future-extension-ideas)

---

## 1. Purpose and Rationale

The enrichment queue is a PostgreSQL-backed background job system purpose-built for media enrichment tasks. It requires no external message broker (no BullMQ, no Redis, no RabbitMQ).

### Why a Separate Queue

The synchronous upload chain (`OBJECT_UPLOADED_EVENT` → storage → metadata extraction) must complete quickly to give the user immediate feedback. Enrichment tasks — face detection, AI captioning, perceptual hashing, scene classification — can take seconds per photo, depend on external sidecars or cloud APIs, and must be:

- **Re-runnable:** a user can request re-detection on a single photo.
- **Retryable:** transient failures should not require manual intervention.
- **Backfillable:** enabling a new capability should be applicable to existing library items.
- **Observable:** operators need to see what is pending, running, failing, and stuck.

Embedding these properties into the synchronous upload path would couple upload latency to enrichment latency. The queue decouples them cleanly.

### Any Enrichment Type Can Plug In

The queue is not face-detection-specific. Every enrichment handler registers itself with a string `type`. The worker fetches jobs by status and dispatches to the registered handler for that type. Adding a new AI capability requires implementing one interface and registering one handler — the worker, retry logic, priority system, and admin dashboard are inherited automatically.

The worked example throughout this document is `face_detection`. See **[docs/specs/face-recognition.md](face-recognition.md)** for the full face-detection specification.

---

## 2. Data Model

### enrichment_jobs table

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `type` | String | Handler type identifier (e.g. `'face_detection'`, `'storage_insights'`) |
| `mediaItemId` | UUID? | FK to `media_items` (cascade delete); **nullable** — null for global/system jobs not scoped to a media item |
| `circleId` | UUID? | Scoping for RBAC and isolation; **nullable** — null for global/system jobs |
| `status` | JobStatus | Current job state |
| `reason` | JobReason | What caused the job to be created |
| `priority` | Int (default 0) | Lower value = claimed sooner |
| `providerKey` | String? | Hint to handler: which provider to use |
| `modelVersion` | String? | Hint to handler: which model version |
| `payload` | JsonB? | Handler-specific additional parameters |
| `attempts` | Int (default 0) | Number of normal processing attempts (does not count rate-limit hits) |
| `lastError` | String? | Error message from most recent failure |
| `scheduledFor` | DateTime? | When the job becomes eligible to be claimed again; null = eligible now. Set by the worker on both normal-failure backoff and rate-limit deferral. |
| `rateLimitedAt` | DateTime? | Timestamp of the most recent rate-limit hit, for debugging and admin display. |
| `rateLimitHits` | Int (default 0) | Running count of rate-limit deferrals on this job; tracked separately from `attempts`. |
| `createdAt` | DateTime | When the job was created |
| `startedAt` | DateTime? | When the worker last claimed this job |
| `finishedAt` | DateTime? | When the job reached `succeeded` or permanent `failed` |

### JobStatus Enum

| Value | Meaning |
|-------|---------|
| `pending` | Waiting to be claimed by the worker (or backed off — see `scheduledFor`) |
| `running` | Currently being processed |
| `succeeded` | Completed successfully |
| `failed` | Failed permanently (exhausted retry or rate-limit-hit cap) |

### JobReason Enum

| Value | Meaning |
|-------|---------|
| `upload` | Triggered automatically when media was uploaded |
| `rerun` | Triggered manually by a user on a specific item |
| `backfill` | Triggered by an admin backfill operation over existing library items |

### Indices

```
[status, scheduledFor, priority, createdAt]  — primary claim index (worker skips backed-off jobs)
[mediaItemId]                                — fast lookup by media item
[type, status]                               — admin stats and type-scoped queries
```

### Priority Semantics

Lower numeric priority means the job is claimed sooner. The worker claims the oldest `pending` job with the lowest `priority` value. Within the same priority, jobs are claimed in `createdAt` ascending order (FIFO).

---

## 3. Components Overview

| Component | File | Role |
|-----------|------|------|
| `EnrichmentHandler` interface | `apps/api/src/enrichment/enrichment-handler.interface.ts` | Contract every handler must implement |
| `EnrichmentHandlerRegistry` | `apps/api/src/enrichment/enrichment-handler.registry.ts` | In-memory Map from type string to handler instance |
| `EnrichmentJobService` | `apps/api/src/enrichment/enrichment-job.service.ts` | Enqueue logic with idempotency check |
| `EnrichmentJobWorker` | `apps/api/src/enrichment/enrichment-job.worker.ts` | Polling loop, atomic claim, retry, dispatch |
| `EnrichmentAdminService` + `EnrichmentAdminController` | `apps/api/src/enrichment/enrichment-admin.*.ts` | Stats, retry, reset-stuck, delete endpoints |
| `EnrichmentModule` | `apps/api/src/enrichment/enrichment.module.ts` | NestJS module; exports `EnrichmentJobService` and `EnrichmentHandlerRegistry` |

---

## 4. EnrichmentHandler Interface

```typescript
// apps/api/src/enrichment/enrichment-handler.interface.ts

export const ENRICHMENT_HANDLER = Symbol('ENRICHMENT_HANDLER');

export interface EnrichmentHandler {
  readonly type: string;
  process(job: EnrichmentJob): Promise<void>;
}
```

**Contract:**

- `type` is the string that matches `enrichment_jobs.type`. It must be unique across all registered handlers.
- `process(job)` receives the full `EnrichmentJob` Prisma record. It should throw on unrecoverable or transient errors — the worker catches thrown errors and applies retry logic.
- Handlers are responsible for maintaining their own domain-specific status records. For face detection, `FaceDetectionService` updates `MediaFaceStatus`. Handlers must not rely on the generic job record for domain status — the job record only tracks queue-level state.

**Image Rule:** Any handler that reads image pixels MUST obtain them via `prepareImageForProcessing(buffer, { maxDim? })` from `apps/api/src/storage/processing/image-orientation.util.ts`. Never decode raw bytes directly. EXIF orientation must be applied before any pixel-level processing. See [Section 9 of face-recognition.md](face-recognition.md#9-exif-orientation) for the utility's behavior.

---

## 5. EnrichmentHandlerRegistry

`apps/api/src/enrichment/enrichment-handler.registry.ts` maintains a simple `Map<string, EnrichmentHandler>`.

```typescript
register(handler: EnrichmentHandler): void
  // Stores handler in map by type.
  // Logs a warning if a handler for that type is already registered.

get(type: string): EnrichmentHandler | undefined
  // Returns the handler for the given type, or undefined if not found.

types(): string[]
  // Returns all registered type strings.
```

The worker calls `registry.get(job.type)` for each claimed job. If `undefined` is returned, the job is immediately marked `failed` with error message `"No handler registered for enrichment job type '...'"`. This is not a crash — other jobs continue processing.

---

## 6. Self-Registration Pattern

### Why This Pattern Exists

The natural NestJS approach for aggregating handlers from multiple feature modules would be a multi-provider token:

```typescript
// This does NOT work across module boundaries:
{ provide: ENRICHMENT_HANDLER, useClass: FaceDetectionHandler, multi: true }
```

NestJS throws `UnknownExportException` when a feature module tries to export a multi-provided token that was declared in another module. The DI container cannot aggregate multi-provider tokens across module boundaries.

### Solution: OnModuleInit Self-Registration

Each handler implements `OnModuleInit` and calls `registry.register(this)` in `onModuleInit()`. This bypasses the multi-provider limitation entirely.

```typescript
// apps/api/src/face/processing/face-detection.handler.ts

import { Injectable, OnModuleInit } from '@nestjs/common';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { FaceDetectionService } from './face-detection.service';

@Injectable()
export class FaceDetectionHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'face_detection';

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly faceDetectionService: FaceDetectionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    await this.faceDetectionService.processMediaItem(job);
  }
}
```

**Two requirements must be met for this to work:**

1. The handler class must appear in its feature module's `providers: []` array so NestJS instantiates it.
2. The feature module must import `EnrichmentModule` so `EnrichmentHandlerRegistry` is available for injection.

```typescript
// apps/api/src/face/face.module.ts (excerpt)
@Module({
  imports: [EnrichmentModule, ...],
  providers: [FaceDetectionHandler, FaceDetectionService, ...],
})
export class FaceModule {}
```

**Do NOT use `{ provide: ENRICHMENT_HANDLER, multi: true }` across module boundaries.** It will throw at startup.

---

## 7. EnrichmentJobService.enqueue

`EnrichmentJobService` in `apps/api/src/enrichment/enrichment-job.service.ts`.

### EnqueueInput Type

```typescript
interface EnqueueInput {
  type: string;                      // Handler type identifier
  mediaItemId: string | null;        // Target media item UUID; null for global/system jobs
  circleId: string | null;           // Circle UUID for scoping; null for global/system jobs
  reason: JobReason;                 // upload | rerun | backfill
  priority?: number;                 // Default: 0
  providerKey?: string;              // Optional hint
  modelVersion?: string;             // Optional hint
  payload?: Record<string, unknown>; // Handler-specific data
}
```

### Idempotency

Before inserting, the service checks:

```typescript
prisma.enrichmentJob.findFirst({
  where: {
    type: input.type,
    mediaItemId: input.mediaItemId,
    status: { in: [JobStatus.pending, JobStatus.running] },
  },
})
```

If an existing `pending` or `running` job is found for the same `type` and `mediaItemId`, the service returns the existing job without creating a duplicate. This means calling `enqueue` repeatedly for the same photo is safe — the backfill endpoint and the upload listener can both call `enqueue` without creating redundant work.

For **global/system jobs** (null `mediaItemId`), the idempotency check matches on `(type, mediaItemId IS NULL)`. Only one global job of a given type can be pending or running at a time. The `storage_insights` handler uses this pattern — see [Storage Insights spec](storage-insights.md) for details.

If no existing job is found, a new job is created with `status: pending` and the provided priority.

---

## 8. EnrichmentJobWorker

`apps/api/src/enrichment/enrichment-job.worker.ts`.

### Lifecycle

The worker is a **continuous worker pool**: `ENRICHMENT_WORKER_CONCURRENCY` long-lived async loops, each independently running **claim one job → process it → repeat**, sleeping `pollMs` whenever the queue is empty. There is no `setInterval` tick and no `Promise.all` batch barrier — the batched-tick model it replaced claimed up to N jobs and then waited for the slowest of them (`await Promise.all(...)`) before the next tick could start, so a single slow or hung job stalled the whole queue and left slots idle.

- **OnApplicationBootstrap:** Reads `pollMs` and the pool size (`ENRICHMENT_WORKER_CONCURRENCY`, min 1) once, logs `pool size N, poll interval Pms`, then starts N `runLoop(i)` loops (not awaited — they run for the worker's lifetime). **The pool size is fixed at startup** — unlike the old model, which re-read concurrency on every tick, changing the pool size now requires a restart. This is intentional: each loop is a persistent claim→process cycle, not a per-tick allocation. Pool startup lives in `OnApplicationBootstrap` rather than `OnModuleInit` specifically because NestJS guarantees `OnApplicationBootstrap` fires only after **every** module's `OnModuleInit` has resolved app-wide — including each enrichment handler's own self-registration call (see [Section 6](#6-self-registration-pattern)). `OnModuleInit` carries no such cross-module ordering guarantee: the worker's own `OnModuleInit` could run before a handler module elsewhere in the DI graph had finished registering itself. This was a real production bug — during boot, the offline reverse-geocoder's synchronous dataset load blocked the event loop for several seconds, and jobs claimed in that window (`face_detection`, `burst_detection`, `duplicate_detection`, `location_inference`) whose handlers hadn't yet self-registered were marked permanently `failed` via the "no handler registered" branch, with no retry. Starting the pool in `OnApplicationBootstrap` closes this race structurally, with no arbitrary startup delay involved.
- **OnModuleDestroy:** Sets `shuttingDown = true` (each loop exits after its current cycle), clears all outstanding empty-queue sleep timers so shutdown is prompt, and logs `EnrichmentJobWorker stopping`.

### Key Benefit

Because each loop processes exactly one job at a time and there is no batch barrier, **one hung or slow job (bounded by the active per-job timeout) only stalls its own slot — never the other loops or the queue as a whole.** The remaining loops keep claiming and processing, and the freed slot resumes as soon as its job settles or times out.

### Disabling the Worker

The worker checks two environment variables once in `onApplicationBootstrap`:

```
ENRICHMENT_WORKER_ENABLED  (checked first)
FACE_WORKER_ENABLED        (legacy alias, checked second)
```

If either is set to `'false'`, `onApplicationBootstrap` returns early and **no loops start** — the pool is never created. Useful in test environments and CI to prevent background jobs from interfering with tests.

### Poll Interval

```
ENRICHMENT_JOB_POLL_MS ?? FACE_JOB_POLL_MS ?? '5000'
```

Parsed as an integer at startup. Each loop sleeps this long whenever a claim finds the queue empty, then tries again. Default: 5000 ms.

### Concurrency (Pool Size)

```
ENRICHMENT_WORKER_CONCURRENCY ?? FACE_WORKER_CONCURRENCY ?? '1'   (min 1)
```

Parsed as an integer at startup. This is the number of long-lived loops in the pool — i.e. how many jobs can be processed **concurrently**. Default: 1. Fixed for the process's lifetime (see Lifecycle above).

### Loop Logic

```
runLoop(slot):
  while not shuttingDown:
    processed = tick()             // claim + process ONE job; try/catch logs loop errors
    if not processed and not shuttingDown:
      sleep(pollMs)                // queue was empty — back off before retrying

tick():                           // single claim+process cycle; the unit-test seam
  job = claimOne()                 // serialized claim (see below); null if queue empty
  if no job: return false
  processJob(job)                  // runs OUTSIDE the claim lock — concurrent across loops
  return true
```

There is no `running` guard and no batch — each loop drives its own slot independently. `processJob` runs outside the claim mutex, so processing is fully concurrent across the pool.

### Serialized Claims (in-process mutex)

Multiple loops in the same process could otherwise select the same `pending` row: Prisma's `$transaction(findFirst → update)` runs at read-committed isolation, where two overlapping transactions can both `findFirst` the same row before either `update`s it to `running`. To prevent double-claiming, `claimOne()` serializes claims with a **promise-chain mutex**:

```typescript
private async claimOne(): Promise<EnrichmentJob | null> {
  let release!: () => void;
  const prev = this.claimLock;
  this.claimLock = new Promise<void>((r) => (release = r));
  await prev;                       // wait for the previous claim to finish
  try {
    return await this.claimNextJob(); // the atomic claim below, one at a time
  } finally {
    release();                      // let the next loop claim
  }
}
```

Only the claim is serialized; the returned job is processed by the caller **outside** the lock, so slow processing never blocks other loops from claiming.

> **LIMITATION — single-process only.** This in-process mutex makes claims safe **within one API process**. It does **not** coordinate across processes: running MULTIPLE API replicas against the same database could still double-claim, because each replica has its own independent `claimLock`. Cross-process safety would require a database-level claim — e.g. `SELECT … FOR UPDATE SKIP LOCKED` or a conditional `UPDATE … WHERE status = 'pending'` that returns the affected row — so that the database, not an in-memory promise chain, arbitrates the race. That hardening is a documented follow-up; today the deployment model is a single API process running the worker pool.

### Atomic Claim

The claim is wrapped in a Prisma `$transaction`:

```typescript
const job = await prisma.enrichmentJob.findFirst({
  where: {
    status: JobStatus.pending,
    OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
  },
  orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
});
if (!job) return null;
await prisma.enrichmentJob.update({
  where: { id: job.id },
  data: { status: JobStatus.running, startedAt: new Date(), scheduledFor: null },
});
```

The `scheduledFor` filter ensures that backed-off jobs are invisible to the worker until their deferral period has elapsed. The transaction ensures only one worker process can claim a given job even during a deploy overlap.

### Retry and Backoff

The worker handles two distinct failure modes separately. Normal errors and rate-limit errors are tracked with separate counters so that a burst of throttle responses never consumes the normal-failure retry budget.

**Normal failure path:**

| Outcome | Action |
|---------|--------|
| `handler.process()` returns normally | `status = succeeded`, `finishedAt = now()` |
| Throws a non-rate-limit error, `attempts < MAX_ATTEMPTS` | `attempts++`, `status = pending`, `scheduledFor = now + backoff` |
| Throws a non-rate-limit error, `attempts >= MAX_ATTEMPTS` | `attempts++`, `status = failed`, `finishedAt = now()`, `lastError = message` |
| `registry.get(type)` returns `undefined` | `status = failed` immediately (no retry), `lastError = "No handler registered..."` |

The backoff delay uses equal-jitter exponential backoff: `delay = exp/2 + rand() * (exp/2)` where `exp = min(RETRY_MAX_MS, RETRY_BASE_MS * 2^(attempt-1))`. Default values give delays of roughly 1–2 s, 2–4 s, then permanent failure on the third attempt.

**Rate-limit deferral path:**

When a handler throws a `RateLimitError`, or when the worker's `classifyRateLimit()` fallback identifies an HTTP 429 or an AWS throttling exception in an unclassified error, the job enters a separate rate-limit deferral path:

| Outcome | Action |
|---------|--------|
| Rate-limit error, `rateLimitHits < RL_MAX_HITS` | `rateLimitHits++`, `rateLimitedAt = now()`, `status = pending`, `scheduledFor = now + rl_backoff`; `attempts` is **not** incremented |
| Rate-limit error, `rateLimitHits >= RL_MAX_HITS` | `rateLimitHits++`, `status = failed`, `finishedAt = now()`, `lastError = message` |

Rate-limit backoff uses the same equal-jitter formula with longer base and cap values. If the provider supplies a `Retry-After` header (integer seconds or HTTP-date), the computed jitter is floored at that value so the worker never retries before the provider allows.

**Rate-limit detection:**

Handlers throw `RateLimitError` directly for known provider responses (auto-tagging handler → Anthropic/OpenAI HTTP 429; face detection handler → AWS Rekognition throttling exceptions). The worker also calls `classifyRateLimit(err)` as a fallback, which detects HTTP 429 via `err.status`, `err.response.status`, or `err.$metadata.httpStatusCode`, and AWS throttling by error name (`ThrottlingException`, `TooManyRequestsException`, `ProvisionedThroughputExceededException`, `RequestLimitExceeded`, `SlowDown`).

Unknown handler types fail immediately without retry. This prevents an infinite retry loop for jobs created before a handler was removed.

### Active Per-Job Timeout

Each `handler.process(job)` call is raced against an active timeout controlled by `ENRICHMENT_JOB_TIMEOUT_MS` (default `600000`, i.e. 10 minutes; `0` disables it). If the handler runs longer than this budget, the worker abandons the wait: the timeout rejects with a plain `Error` (`enrichment job execution timed out after <ms>ms (type="...")`), which — being neither a `RateLimitError` nor a `classifyRateLimit` match — flows through the **normal-failure retry path** exactly like any other thrown error: `attempts++`, exponential backoff via `scheduledFor`, retry while `attempts < MAX_ATTEMPTS`, then permanent `failed` with the timeout message as `lastError`.

The point of the active timeout is that the worker slot is **freed immediately** when the timeout fires. Before this, a hung handler call blocked the worker indefinitely — at `ENRICHMENT_WORKER_CONCURRENCY=1` a single hang stalled the entire queue, and recovery depended solely on the `EnrichmentStuckResetTask` cron (runs every 10 min, resets jobs `running` past the stuck threshold — see [Section 11 — Stuck Threshold](#stuck-threshold-settings-driven), currently a settings-driven value defaulting to 3 minutes), up to a ≈13-minute worst case at the current default. With the active timeout, one hang no longer stalls the queue: the tick completes, the slot is released, and the next tick claims the following job.

Two caveats follow from JavaScript's execution model:

- **The underlying work is not force-cancelled.** JS cannot abort a running promise; the abandoned `handler.process` promise is left to settle in the background. `Promise.race` still attaches reactions to it, so a late rejection does **not** surface as an `unhandledRejection`. Set `ENRICHMENT_JOB_TIMEOUT_MS` comfortably above the longest *legitimate* single-job runtime (e.g. long video face detection) so valid work is never killed mid-flight.
- **`EnrichmentStuckResetTask` remains as a crash backstop.** The active timeout only covers a handler that hangs while the worker process is alive. If the worker process itself dies (OOM kill, container restart) mid-job, the row is orphaned in `running` with no live timer to fire. The stuck-reset cron still recovers those rows — see [Section 14](#14-operational-notes).

---

## 9. Priority Conventions

| Reason | Priority Value | Typical Trigger |
|--------|---------------|-----------------|
| `rerun` | 0 | User-triggered single-photo rerun |
| `upload` | 10 | Auto-enqueue on media upload |
| `backfill` | 100 | Admin backfill over existing library |

The worker claims `pending` jobs ordered by `priority ASC, createdAt ASC`. A user-triggered rerun (priority 0) will be processed before any pending upload jobs (priority 10), which are processed before any backfill jobs (priority 100).

Within the same priority level, jobs are processed FIFO (oldest `createdAt` first).

---

## 10. Upload Enrichment Trigger Model

When a `MediaItem` is successfully created via `POST /api/media` (non-dedup path), `MediaService.createMedia` calls `MediaEnrichmentService.enqueueUploadEnrichment(...)` synchronously — awaited before the 201 response is returned. The `face_detection`, `auto_tagging`, and `burst_detection` job rows therefore exist in the database before the client receives its response, making enrichment scheduling reliable regardless of client type (CLI, web, Android) or upload timing.

### Single Source of Truth

`MediaEnrichmentService.enqueueUploadEnrichment` in `apps/api/src/media/enrichment/media-enrichment.service.ts` is the sole authoritative place where upload-time enrichment is scheduled. The previous design used three separate `@OnEvent(OBJECT_PROCESSED_EVENT)` listeners (`TaggingEnqueueListener`, `FaceEnqueueListener`, `BurstEnqueueListener`), which silently produced no jobs for CLI uploads because the storage-processing event fired before the `MediaItem` row existed. Those listeners have been removed.

### Backstop Event Listener

A single `MediaEnrichmentEnqueueListener` still listens for `OBJECT_PROCESSED_EVENT`. It resolves the `MediaItem` from the `storageObjectId` and calls the same `MediaEnrichmentService.enqueueUploadEnrichment` method. This covers any path where storage processing completes after `MediaItem` registration (re-processing, edge-case ordering). Because `EnrichmentJobService.enqueue` is idempotent (see [Section 7](#7-enrichmentjobserviceenqueue)), the synchronous call and the backstop event are safe to fire in any order — the second call finds an existing `pending` or `running` job and returns without creating a duplicate.

### Gating

`enqueueUploadEnrichment` applies the following gates before enqueuing any job:

- **Media type:** Photos only. Video and other types are skipped.
- **Soft-delete:** Skipped if `deletedAt` is non-null.
- **Per-type feature flags and env kill-switches:**

| Job type | System setting | Env kill-switch | Default |
|----------|---------------|-----------------|---------|
| `face_detection` | `features.faceRecognition` | `FACE_AUTO_DETECT=false` | off |
| `auto_tagging` | `features.autoTagging` | `AUTO_TAG_ENABLED=false` | off |
| `burst_detection` | `features.burstDetection` | `BURST_DETECTION_ENABLED=false` | off |

If a feature flag is off or its env kill-switch is `false`, that job type is not enqueued; other types are still evaluated independently.

- **Priorities:** face detection = 10, burst detection = 10, auto_tagging = 20 (within the standard upload priority band; see [Section 9](#9-priority-conventions)).

When a job is enqueued, its per-item status row is also upserted to `pending` (`MediaFaceStatus` for face detection, `MediaTagStatus` for auto-tagging), so status endpoints reflect the queued state immediately.

### Feature Flag Caching

`SystemSettingsService.getSettings()` maintains a 5-second in-memory TTL cache, invalidated on any `replaceSettings` or `patchSettings` call. This prevents bulk imports (many concurrent `createMedia` calls) from hammering the database on every feature-flag read.

### Metadata Sync Is Separate

EXIF extraction and typed-column sync (`capturedAt`, dimensions, geo) are **not** part of the upload enrichment trigger. They run in the storage object-processing chain: `MediaService.createMedia` calls `MediaMetadataSyncService.syncFromStorageObject(...)` immediately after creating the `MediaItem`, and `MediaMetadataSyncService` also listens on `OBJECT_PROCESSED_EVENT` to handle the case where processing completes after registration. The `metadata_extraction` enrichment job type exists only for on-demand rerun and admin backfill — it is never enqueued at upload time. See [metadata-rerun.md](metadata-rerun.md) for details.

### Client Responsibility

Enrichment is entirely server-side. Clients (CLI, web, Android) never call `EnrichmentJobService.enqueue` directly. The canonical moment for scheduling upload enrichment is `MediaItem` creation in `createMedia`.

---

## 11. Admin Jobs Dashboard

The `/admin/jobs` page provides full visibility and control over the queue. All endpoints require Admin role.

### Stuck Threshold (Settings-Driven)

The stuck threshold is no longer a hard-coded constant. `EnrichmentAdminService.getStuckThresholdMinutes()` resolves it from the `jobs.stuckThresholdMinutes` system setting (integer, 1–120, default **3** minutes; falls back to the legacy `ENRICHMENT_STUCK_MINUTES` env var, clamped to 120, when the setting is unset — see `defaultStuckThresholdMinutes()` in `apps/api/src/common/types/settings.types.ts`). Runtime-editable in Admin Settings (`StorageSettings.tsx`, jobs section, next to job history retention) — no restart required.

This single resolved value now feeds **all three** stuck-job consumers, which previously disagreed (a hard-coded 10 minutes in the stats query and reset endpoint vs. a 15-minute `ENRICHMENT_STUCK_MINUTES` default in the cron):

- `GET /api/admin/jobs/stats` `stuckRunning` count
- `POST /api/admin/jobs/reset-stuck` default (when `olderThanMinutes` is omitted)
- The `EnrichmentStuckResetTask` cron (its own env parsing was removed in favor of calling `resetStuck()` with no argument)

A job is considered "stuck" if its `status` is `running` and either `startedAt` is older than the threshold, **or** `startedAt IS NULL` and `createdAt` is older than the threshold (see "Zombie rows" below).

### Stats

`GET /api/admin/jobs/stats` (`jobs:read`) runs four parallel queries and returns:

```typescript
{
  total: number;
  byStatus: {
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
  };
  byType: JobStatsByType[];   // per-type breakdown
  stuckRunning: number;       // jobs running past stuckThresholdMinutes (incl. startedAt=null zombies)
  stuckThresholdMinutes: number; // effective threshold used for stuckRunning (settings-driven)
  scheduled: number;          // pending jobs with scheduledFor > now (backed off)
}
```

The `scheduled` count lets operators distinguish jobs actively waiting in the queue (`pending` with null or past `scheduledFor`) from jobs that are temporarily deferred due to a failure or rate-limit backoff. The `/admin/jobs` frontend surfaces this as a "Scheduled (backing off)" stat tile. The `stuckThresholdMinutes` field lets the frontend render the "Reset stuck" button's label dynamically (e.g. "Reset stuck (>3 min)") instead of hard-coding a number that could drift from the actual configured setting.

### Zombie Rows (`startedAt IS NULL`)

A running job whose `startedAt` was never stamped — the claim write landed but the follow-up stamp was lost (process death between claim and stamp, or a lost write) — was previously invisible to `stuckRunning`, the reset endpoint, and the cron, because all three compared against `startedAt` and a SQL comparison against `NULL` is never true. These rows were stuck permanently: `retry`/`delete` refuse rows in `running` status, and a null-`startedAt` running row for a singleton job type also blocked new enqueues via the pending/running dedup check. The shared where-clause (`EnrichmentAdminService.stuckRunningWhere`) now includes an explicit `OR: [{ startedAt: null, createdAt: { lt: threshold } }]` branch, aged by `createdAt` instead, so these zombie rows are counted in `stuckRunning` and recoverable via both the reset endpoint and the cron.

### Job List

`GET /api/admin/jobs?status=&type=&page=&pageSize=&scheduled=` (`jobs:read`):

Paginated. Optional `status`, `type`, and `scheduled` filters. Returns `lastError` for failed rows.

The `scheduled=true` query parameter restricts the result to pending jobs that are currently in backoff (`scheduledFor > now`). When `scheduled=true`, the `status` filter is ignored (it is always forced to `pending`). The `type` filter still applies. Use this filter to see which jobs are waiting on a backoff delay and when they will next be eligible.

Each returned item now includes three additional fields:

| Field | Type | Description |
|-------|------|-------------|
| `scheduledFor` | ISO 8601 \| null | When the job becomes eligible for the worker to claim; null = eligible now |
| `rateLimitedAt` | ISO 8601 \| null | Timestamp of the most recent rate-limit hit; null if the job has never been rate-limited |
| `rateLimitHits` | number | Total rate-limit deferrals this job has accumulated |

The `/admin/jobs` dashboard surfaces a per-row "backing off" badge when `scheduledFor` is in the future, and provides a filter toggle to show only backed-off jobs.

### Per-Row Actions

| Endpoint | Permission | Behavior |
|----------|------------|---------|
| `POST /api/admin/jobs/:id/retry` | `jobs:write` | Resets job to `pending`, clears `attempts=0`, clears `lastError`, clears `startedAt` and `finishedAt`. Returns 400 if job is currently `running`. |
| `DELETE /api/admin/jobs/:id` | `jobs:write` | Permanently deletes the job row. Returns 400 if job is currently `running`. |

### Bulk Actions

| Endpoint | Permission | Behavior |
|----------|------------|---------|
| `POST /api/admin/jobs/retry-failed` | `jobs:write` | `updateMany` all `failed` jobs to `pending`. Optional body `{ type }` to scope by job type. |
| `POST /api/admin/jobs/reset-stuck` | `jobs:write` | `updateMany` all stuck `running` jobs (incl. `startedAt IS NULL` zombies, aged by `createdAt`) back to `pending`, clearing `startedAt` and `scheduledFor`. `olderThanMinutes` in the request body is now optional with no hard-coded default — when omitted, the `jobs.stuckThresholdMinutes` system setting (default 3 minutes) is used. |

---

## 12. How to Add a New Enrichment Capability

This section is the primary reference for developers adding a new AI or processing capability to the system. Follow these steps in order. Use `face_detection` as the worked example.

---

### Step 1: Create the Handler Class

Create a file in your feature module directory. Implement `EnrichmentHandler` with `{ provide: Injectable }`.

```typescript
// apps/api/src/my-feature/my-feature.handler.ts

import { Injectable } from '@nestjs/common';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentJob } from '@prisma/client';

@Injectable()
export class MyFeatureHandler implements EnrichmentHandler {
  readonly type = 'my_feature_type';  // must be unique; matches enrichment_jobs.type

  async process(job: EnrichmentJob): Promise<void> {
    // Implement your enrichment logic here.
    // Throw on failure — the worker will retry up to MAX_ATTEMPTS times.
    // Maintain your own domain-specific status table (e.g. my_feature_status).
    // Do NOT rely on the enrichment_jobs row for domain status.
  }
}
```

**Face detection example:** `FaceDetectionHandler.type = 'face_detection'`. Its `process()` delegates to `FaceDetectionService.processMediaItem(job)`, which maintains the `media_face_status` table.

---

### Step 2: Implement Self-Registration via OnModuleInit

Add `OnModuleInit` and inject `EnrichmentHandlerRegistry`.

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';

@Injectable()
export class MyFeatureHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'my_feature_type';

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly myFeatureService: MyFeatureService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);  // self-register on startup
  }

  async process(job: EnrichmentJob): Promise<void> {
    await this.myFeatureService.processJob(job);
  }
}
```

**Do NOT use `{ provide: ENRICHMENT_HANDLER, multi: true }`.** It throws `UnknownExportException` across module boundaries. See [Section 6](#6-self-registration-pattern) for full explanation.

---

### Step 3: Register in Your Feature Module

The handler must appear in `providers: []` and the module must import `EnrichmentModule`.

```typescript
// apps/api/src/my-feature/my-feature.module.ts

import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { MyFeatureHandler } from './my-feature.handler';
import { MyFeatureService } from './my-feature.service';

@Module({
  imports: [EnrichmentModule],         // makes EnrichmentHandlerRegistry injectable
  providers: [MyFeatureHandler, MyFeatureService],
  exports: [MyFeatureService],
})
export class MyFeatureModule {}
```

**Face detection example:** `FaceModule` imports `EnrichmentModule` and lists `FaceDetectionHandler` in `providers`.

---

### Step 4: Enqueue Jobs from Your Feature Code

Enqueue from one or more of these places depending on your use case:

**a. On upload (event listener):**

```typescript
// Listens for OBJECT_PROCESSED_EVENT; enqueues at priority 10
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';

@Injectable()
export class MyFeatureEnqueueListener {
  constructor(private readonly enrichmentJobService: EnrichmentJobService) {}

  @OnEvent(OBJECT_PROCESSED_EVENT)
  async handleObjectProcessed(event: ObjectProcessedEvent): Promise<void> {
    if (event.mediaType !== MediaType.photo) return;
    await this.enrichmentJobService.enqueue({
      type: 'my_feature_type',
      mediaItemId: event.mediaItemId,
      circleId: event.circleId,
      reason: JobReason.upload,
      priority: 10,
    });
  }
}
```

**b. On user request (controller, per-item rerun):**

```typescript
await this.enrichmentJobService.enqueue({
  type: 'my_feature_type',
  mediaItemId: params.id,
  circleId: item.circleId,
  reason: JobReason.rerun,
  priority: 0,   // highest priority
});
```

**c. Backfill (admin endpoint):**

```typescript
// Loop over all eligible media items, enqueue at priority 100
await this.enrichmentJobService.enqueue({
  type: 'my_feature_type',
  mediaItemId: item.id,
  circleId: item.circleId,
  reason: JobReason.backfill,
  priority: 100,   // lowest priority
});
```

**Face detection example:** `FaceEnqueueListener` handles upload (priority 10). `FaceDetectionController.rerunDetection()` handles reruns (priority 0). `FaceDetectionController.backfill()` handles admin backfill (priority 100).

---

### Step 5: Use prepareImageForProcessing for Image-Based Handlers

If your handler needs to read pixels:

```typescript
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';

const { buffer, width, height } = await prepareImageForProcessing(rawBuffer, {
  maxDim: 2000,  // optional; downscales longest side to this value
});

// Use `buffer` for all pixel-level operations.
// `width` and `height` are the upright display dimensions after EXIF rotation.
// If sharp fails, buffer = rawBuffer and width = height = 0 (handler must tolerate this).
```

NEVER pass raw S3 bytes to an image model or computer vision provider. EXIF orientation must be applied first.

---

### Step 6: It Appears in the Jobs Dashboard Automatically

Once the handler is registered, any job with `type = 'my_feature_type'` will appear in:
- `GET /api/admin/jobs/stats` — in the `byType` breakdown.
- `GET /api/admin/jobs?type=my_feature_type` — filterable job list.
- Per-row retry and delete actions.
- Bulk retry-failed (scoped by type).

No dashboard code changes are needed.

---

## 13. Configuration

### Worker lifecycle

| Variable | Default | Notes |
|----------|---------|-------|
| `ENRICHMENT_WORKER_ENABLED` | `'true'` | Set to `'false'` to disable the worker. Checked before the legacy variable. |
| `FACE_WORKER_ENABLED` | `'true'` | Legacy alias. Either variable set to `'false'` disables the worker. |
| `ENRICHMENT_JOB_POLL_MS` | `'5000'` | Worker poll interval in milliseconds. |
| `FACE_JOB_POLL_MS` | `'5000'` | Legacy alias for `ENRICHMENT_JOB_POLL_MS`. |
| `ENRICHMENT_WORKER_CONCURRENCY` | `'1'` | Worker-pool size — the number of long-lived worker loops, fixed at startup. Each loop independently claims and processes one job at a time; there is no batch barrier, so a slow/hung job only stalls its own slot. Raise for throughput; the per-provider throttle gate keeps higher values 429-safe. Memory scales with this value (each concurrent job buffers a decoded image). See [Section 8 — Concurrency (Pool Size)](#concurrency-pool-size). |
| `FACE_WORKER_CONCURRENCY` | `'1'` | Legacy alias for `ENRICHMENT_WORKER_CONCURRENCY`. |
| `ENRICHMENT_JOB_TIMEOUT_MS` | `600000` | Active per-job execution timeout (ms). A handler running longer is aborted, its worker slot freed, and the job routed through the normal-failure retry path (`attempts++`, backoff, permanent-fail after `ENRICHMENT_MAX_ATTEMPTS`). `0` disables. Must exceed the longest legitimate single-job runtime. See [Section 8 — Active Per-Job Timeout](#active-per-job-timeout). |
| `ENRICHMENT_STUCK_MINUTES` | _(unset)_ | **Legacy fallback only.** The stuck threshold is now a runtime System Setting, `jobs.stuckThresholdMinutes` (integer, 1–120, default **3** minutes), editable in Admin Settings without a restart — see [Section 11 — Stuck Threshold (Settings-Driven)](#stuck-threshold-settings-driven). This env var is consulted only to compute the setting's *default* the first time it is read (`defaultStuckThresholdMinutes()`), clamped to 120; once the setting has an explicit value in the database, this env var has no further effect. This is a CRASH backstop only — live handler hangs are handled by `ENRICHMENT_JOB_TIMEOUT_MS`. The effective threshold must exceed the longest legitimate single-job runtime, or long-running-but-legitimate jobs get reset to `pending` and may be picked up and run a second time concurrently with the still-running original. |

### Normal-failure retry

| Variable | Default | Notes |
|----------|---------|-------|
| `ENRICHMENT_MAX_ATTEMPTS` | `3` | Maximum processing attempts before a job is permanently failed. |
| `ENRICHMENT_RETRY_BASE_MS` | `2000` | Base delay (ms) for the first retry backoff. Equal-jitter exponential; actual delay is roughly `base/2..base` for attempt 1, `base..2*base` for attempt 2, etc. |
| `ENRICHMENT_RETRY_MAX_MS` | `60000` | Maximum backoff cap (ms) for normal retries. |

### Rate-limit deferral

| Variable | Default | Notes |
|----------|---------|-------|
| `ENRICHMENT_RATELIMIT_BASE_MS` | `30000` | Base delay (ms) for the first rate-limit deferral. Same equal-jitter formula as normal retries. |
| `ENRICHMENT_RATELIMIT_MAX_MS` | `900000` | Maximum backoff cap (ms) for rate-limit deferrals (15 minutes). |
| `ENRICHMENT_RATELIMIT_MAX_HITS` | `10` | Maximum rate-limit deferrals before a job is permanently failed. |

Rate-limit hits do not consume `ENRICHMENT_MAX_ATTEMPTS`. A job can exhaust its normal retry budget independently of how many times it has been rate-limited, and vice versa.

For variables specific to the `face_detection` handler (thresholds, providers, image dimensions), see [face-recognition.md — Configuration](face-recognition.md#13-configuration-and-environment-variables).

### Tuning for large runs / bulk backfills

All worker configuration in this section is set via environment variables (in `infra/compose/.env`, see `.env.example`) and takes effect on API restart. Job *history* retention — as opposed to worker behavior — is a runtime System Setting, not an environment variable; see "Job history retention" below.

**Recommended presets:**

| Profile | Settings |
|---------|----------|
| **Large backfill, capable host** | `ENRICHMENT_WORKER_CONCURRENCY=4`, `ENRICHMENT_JOB_TIMEOUT_MS=150000` (~2.5 min), `jobs.stuckThresholdMinutes` raised via Admin Settings if handlers legitimately run longer than the 3-minute default |
| **Memory-constrained VPS (≈1 GB)** | Keep `ENRICHMENT_WORKER_CONCURRENCY=1–2`; lower `TAG_MAX_IMAGE_DIM`/`FACE_MAX_IMAGE_DIM` to 768–1024; set `NODE_OPTIONS=--max-old-space-size=512`; raise `ENRICHMENT_RATELIMIT_MAX_HITS`/`ENRICHMENT_RATELIMIT_MAX_MS` for very long runs whose provider quota window takes hours to recover |
| **Fast, isolated run** | Higher concurrency (e.g. 4–8) if the host has ample RAM/CPU and the configured providers tolerate it |

`ENRICHMENT_JOB_TIMEOUT_MS` must always be set comfortably above the longest LEGITIMATE single-job runtime (e.g. long video face detection) so valid work is never killed mid-flight — the same caveat already stated in [Section 8 — Active Per-Job Timeout](#active-per-job-timeout).

**On-demand control (no restart required):**

- `POST /api/admin/jobs/reset-stuck` body `{ olderThanMinutes? }` — immediately frees stuck running jobs; omit `olderThanMinutes` to use the configured `jobs.stuckThresholdMinutes` setting.
- `POST /api/admin/jobs/retry-failed` (optional body `{ type }`) — requeues failed jobs.
- `GET /api/admin/jobs/stats` and `GET /api/admin/jobs/insights` — monitor live counts and ETA.

See [Section 11 — Admin Jobs Dashboard](#11-admin-jobs-dashboard) for full detail on these endpoints.

**Job history retention** is a runtime System Setting, NOT an environment variable — `jobs.history.retentionDays` (default 30) and `jobs.history.purgeEnabled` (default true), editable in Admin Settings, control the nightly `job_history_purge` job. See [job-insights.md](job-insights.md).

For the full provider rate-limit classification matrix and OOM/crash recovery runbook, see [bulk-import-resilience.md](bulk-import-resilience.md). For **memory sizing on a small/cheap VPS** — heap cap vs off-heap, why bulk imports OOM, per-container-size presets, and real throughput/failure numbers from a ~20k-job import — see [bulk-upload-vps-tuning.md](bulk-upload-vps-tuning.md).

---

## 14. Operational Notes

**Stuck-running recovery.** If the worker process crashes or the container restarts while a job is in `running` status, that job will never transition out of `running` on its own. This is the crash backstop that the automatic `EnrichmentStuckResetTask` cron and the manual `POST /api/admin/jobs/reset-stuck` endpoint exist for — both return stale running jobs to `pending`, resolving the threshold from the `jobs.stuckThresholdMinutes` system setting (default 3 minutes) when no explicit `olderThanMinutes` is given. Note this is distinct from a handler that *hangs* while the worker is still alive: that case is now handled promptly by the active per-job timeout (`ENRICHMENT_JOB_TIMEOUT_MS`, see [Section 8 — Active Per-Job Timeout](#active-per-job-timeout)), which frees the slot without waiting for the stuck-reset cron. The stuck-reset path only covers rows orphaned by a dead worker process. **The threshold must exceed the longest legitimate single-job runtime** — set too low, a still-legitimately-running job gets reset to `pending` and can be re-claimed and run a second time concurrently with the original; adjust `jobs.stuckThresholdMinutes` in Admin Settings if your handlers are expected to take longer than the 3-minute default.

**Zombie rows (`startedAt IS NULL`).** A running job whose `startedAt` stamp write was lost — the row was claimed but the process died or errored before the follow-up update — is now included in stuck detection (aged by `createdAt` instead of `startedAt`) rather than sitting permanently un-recoverable. See [Section 11 — Zombie Rows](#zombie-rows-startedat-is-null).

**Terminal status write retry.** `EnrichmentJobWorker.safeTerminalUpdate` wraps every terminal status write (success, failure, rate-limit deferral) with a single retry: if the initial `enrichmentJob.update` throws (e.g. a transient DB error), the worker waits 1 second and retries once. If the retry also fails, the error is logged and swallowed — the worker slot is freed rather than blocked, and the row is left in `running` for the stuck-reset cron/threshold to recover on its next pass, rather than being silently lost or livelocking the worker.

**Idempotency.** `enqueue()` checks for existing `pending` or `running` jobs with the same `type` and `mediaItemId`. Calling enqueue multiple times for the same photo is safe. This means the backfill endpoint and the upload listener can both call enqueue without creating duplicate work, and a backfill can be retried without double-processing items that were already queued.

**Error isolation.** A thrown error in one handler's `process()` is caught by the worker and recorded in `lastError`. The worker continues to the next job. An unregistered handler type marks the job failed without crashing the worker. One bad job does not block other jobs.

**Deleting succeeded jobs.** `DELETE /api/admin/jobs/:id` is safe for housekeeping. Succeeded jobs accumulate over time; periodic deletion of old succeeded rows is safe and keeps the table compact. Failed jobs should be reviewed and either retried or deleted.

**Observability.** The worker logs at `debug` level on each tick and `error` level on handler failures. Job `lastError` content is visible in the admin dashboard. For distributed tracing, each handler invocation inherits the worker's OpenTelemetry span.

---

## 15. Registered Handlers Reference

The following handlers are registered in the current production codebase. Each implements `EnrichmentHandler`, self-registers via `onModuleInit`, and appears automatically in the `/admin/jobs` dashboard.

| Handler type | Module | Scope | Scheduled by | Notes |
|---|---|---|---|---|
| `face_detection` | `FaceModule` | per media item | upload event + rerun + backfill | Per-circle opt-in; see [face-recognition.md](face-recognition.md) |
| `auto_tagging` | `TaggingModule` | per media item | upload event + rerun + backfill | Per-circle opt-in; see [auto-tagging.md](auto-tagging.md) |
| `burst_detection` | `BurstModule` | per media item | upload event + rerun + backfill | Per-circle opt-in; see [burst-detection.md](burst-detection.md) |
| `metadata_extraction` | `MediaModule` | per media item | rerun + backfill only (no upload enqueue) | No per-circle opt-in; see [metadata-rerun.md](metadata-rerun.md) |
| `storage_insights` | `InsightsModule` | global (`mediaItemId: null`) | hourly cron (`InsightsRefreshTask`) | Interval-gated; manual via `POST /api/admin/insights/refresh`; see [storage-insights.md](storage-insights.md) |
| `trash_purge` | `MediaModule` | global (`mediaItemId: null`) | hourly cron (`TrashPurgeTask`) | Hard-deletes trashed `media_items` past `storage.trash.retentionDays` cutoff; see [archive-trash.md](archive-trash.md) |
| `job_history_purge` | `EnrichmentModule` | global (`mediaItemId: null`) | nightly cron (`JobHistoryPurgeTask`, midnight) | Batch-deletes terminal `enrichment_jobs` rows (`succeeded`/`failed`) with `finishedAt` older than `jobs.history.retentionDays`; 5 000-row batches; pending/running rows never deleted; gated by `jobs.history.purgeEnabled`; see [job-insights.md](job-insights.md) |
| `social_media_detection` | `SocialMediaModule` | per media item (video only) | upload event (videos, when enabled) + rerun + backfill | Gate for `video_face_detection` — see "Gate-then-fan-out pattern" below; two-tier (ffprobe metadata/filename + on-server OCR) classifier for TikTok/Instagram/Facebook re-shares; see [social-media-detection.md](social-media-detection.md) |

### Gate-then-fan-out pattern (video enrichment)

`social_media_detection` is a variant on the standard per-item handler shape: it is not just another independent enrichment type running alongside the others, it is a **gate** in front of `video_face_detection`. When `features.socialMediaDetection` is on, a video upload enqueues `social_media_detection` INSTEAD OF `video_face_detection` directly. The handler classifies the video (metadata/filename rules, falling back to OCR when inconclusive) and then either:

- **Detected** — applies tags and stops; `video_face_detection` is never enqueued for that item, saving the face-detection compute entirely.
- **Clean** — enqueues the withheld `video_face_detection` job itself, via `MediaEnrichmentService.enqueueVideoPostDetectionEnrichment(item, reason)`, mapping priority from the original triggering reason (`rerun` → 0, `upload` → 20, `backfill` → 100) so the fanned-out job inherits the same urgency class.

When the feature is off (or killed via `SOCIAL_MEDIA_DETECTION_ENABLED=false`), the upload path enqueues `video_face_detection` directly — behavior is unchanged from before this feature existed. This "withhold, classify, then conditionally fan out the next job" shape is unique to this handler among the table above; every other handler here runs independently once enqueued. See [social-media-detection.md §2](social-media-detection.md#2-gate-then-fan-out-processing-flow) for the full flow diagram and the defensive gates (`VideoFaceDetectionHandler`, `FaceBackfillService`) that also protect against a flagged video re-entering face-detection compute.

### Global handler pattern

`storage_insights` and `trash_purge` are **global handlers** — they run across all circles and are not scoped to a single media item. They share two properties:

- `mediaItemId: null` and `circleId: null` on the `enrichment_jobs` row.
- Idempotency deduplicates on `(type, mediaItemId IS NULL)` — only one global job of a given type can be pending or running at a time.
- The handler ignores the job payload; all context comes from system settings or a full-table query.

---

## 16. Future Extension Ideas

The following capabilities would each become one new handler on the existing queue infrastructure:

| Capability | Handler type | Notes |
|------------|-------------|-------|
| Object and scene detection | `'scene_detection'` | Classify content (beach, birthday, food) for semantic search |
| AI captioning | `'caption_generation'` | Generate natural-language captions for search indexing |
| Perceptual duplicate detection | `'perceptual_hash'` | pHash/dHash-based near-duplicate flagging (tier-2 dedup beyond SHA-256) |
| Low-value / screenshot detection | `'quality_classification'` | Filter out receipts, screenshots, blurry photos |
| Video metadata extraction | `'video_metadata'` | Duration, codec, resolution from video files |

Each of these would: implement `EnrichmentHandler`, self-register via `onModuleInit`, enqueue from the appropriate upload listener or admin endpoint, and appear automatically in the jobs dashboard.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 2026 | AI Assistant | Initial reference document |
| 1.1 | June 2026 | AI Assistant | Rate-limit & scheduled backoff: new `scheduledFor`, `rateLimitedAt`, `rateLimitHits` columns; two-path retry model; `RateLimitError` detection; new env knobs; updated claim query; admin stats `scheduled` field; job list `scheduled=true` filter and new item fields |
| 1.2 | June 2026 | AI Assistant | Upload enrichment trigger model (Section 10): synchronous enqueue in `createMedia` via `MediaEnrichmentService`; single backstop `MediaEnrichmentEnqueueListener`; gating table with feature flags and env kill-switches; feature-flag caching; metadata sync separation; client-never-enqueues principle |
| 1.3 | June 2026 | AI Assistant | Registered handlers reference (Section 15): add `job_history_purge` global handler — nightly cron purge of terminal job rows past retention cutoff |
| 1.4 | July 2026 | AI Assistant | Registered handlers reference (Section 15): add `social_media_detection` handler and the new "Gate-then-fan-out pattern" subsection describing how it withholds and conditionally re-enqueues `video_face_detection` |
| 1.5 | July 2026 | AI Assistant | Active per-job execution timeout: new `ENRICHMENT_JOB_TIMEOUT_MS` knob races each `handler.process` call, frees the worker slot immediately on timeout, and routes the hang through the normal-failure retry path; Section 8 subsection, Section 13 config row, Section 14 stuck-reset clarification (cron is now a crash backstop only) |
| 1.6 | July 2026 | AI Assistant | Continuous worker pool: replaced the `setInterval` tick + `Promise.all` batch model with N long-lived claim→process→repeat loops (pool size fixed at startup from `ENRICHMENT_WORKER_CONCURRENCY`), so one hung/slow job only stalls its own slot, never the queue; claims serialized by an in-process promise-chain mutex (`claimOne`); Section 8 Lifecycle/Loop Logic/Serialized Claims rewrite; added single-process-only limitation note (multi-replica needs `FOR UPDATE SKIP LOCKED`) |
| 1.7 | July 2026 | AI Assistant | Section 13 config table: fixed stale `ENRICHMENT_WORKER_CONCURRENCY` note (was "jobs per tick", now correctly describes the fixed-at-startup worker-pool size, consistent with Section 8); added missing `ENRICHMENT_STUCK_MINUTES` row; added new "Tuning for large runs / bulk backfills" subsection with recommended presets, on-demand admin controls, and job-history-retention pointer |
| 1.8 | July 2026 | AI Assistant | Corrected worker lifecycle hook: pool startup (and the enable/disable env-var check) moved from `OnModuleInit` to `OnApplicationBootstrap` to close a module-registration race causing permanently-failed jobs during boot (Section 8, Section 8 "Disabling the Worker") |
| 1.9 | July 2026 | AI Assistant | Settings-driven stuck threshold: new `jobs.stuckThresholdMinutes` system setting (1–120, default 3 min, falls back to legacy `ENRICHMENT_STUCK_MINUTES` env var) now shared by `GET /api/admin/jobs/stats` (`stuckRunning`, new `stuckThresholdMinutes` field), `POST /api/admin/jobs/reset-stuck` (`olderThanMinutes` now optional, no hard-coded default), and the `EnrichmentStuckResetTask` cron, replacing three previously-disagreeing thresholds (10/10/15 min); zombie-row fix for `running` jobs with `startedAt IS NULL`, previously invisible to all three stuck-job consumers; `EnrichmentJobWorker.safeTerminalUpdate` retries a failed terminal status write once before leaving the row for the stuck-reset cron; Section 11 rewrite, Section 13 config row, Section 14 operational notes |
