# Enrichment Queue — Generic Background Job System

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | June 2026 |

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
10. [Admin Jobs Dashboard](#10-admin-jobs-dashboard)
11. [How to Add a New Enrichment Capability](#11-how-to-add-a-new-enrichment-capability)
12. [Configuration](#12-configuration)
13. [Operational Notes](#13-operational-notes)
14. [Future Extension Ideas](#14-future-extension-ideas)

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
| `attempts` | Int (default 0) | Number of processing attempts |
| `lastError` | String? | Error message from most recent failure |
| `createdAt` | DateTime | When the job was created |
| `startedAt` | DateTime? | When the worker last claimed this job |
| `finishedAt` | DateTime? | When the job reached `succeeded` or permanent `failed` |

### JobStatus Enum

| Value | Meaning |
|-------|---------|
| `pending` | Waiting to be claimed by the worker |
| `running` | Currently being processed |
| `succeeded` | Completed successfully |
| `failed` | Failed permanently (exhausted retry attempts) |

### JobReason Enum

| Value | Meaning |
|-------|---------|
| `upload` | Triggered automatically when media was uploaded |
| `rerun` | Triggered manually by a user on a specific item |
| `backfill` | Triggered by an admin backfill operation over existing library items |

### Indices

```
[status, priority, createdAt]  — primary claim index (worker query)
[mediaItemId]                  — fast lookup by media item
[type, status]                 — admin stats and type-scoped queries
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

- **OnModuleInit:** Sets up the polling interval using `setInterval`.
- **OnModuleDestroy:** Clears the interval to stop polling on graceful shutdown.

### Disabling the Worker

The worker checks two environment variables on each tick:

```
ENRICHMENT_WORKER_ENABLED  (checked first)
FACE_WORKER_ENABLED        (legacy alias, checked second)
```

If either is set to `'false'`, the worker skips all processing for that tick. Useful in test environments and CI to prevent background jobs from interfering with tests.

### Poll Interval

```
ENRICHMENT_JOB_POLL_MS ?? FACE_JOB_POLL_MS ?? '5000'
```

Parsed as an integer and passed to `setInterval`. Default: 5000 ms.

### Concurrency

```
ENRICHMENT_WORKER_CONCURRENCY ?? FACE_WORKER_CONCURRENCY ?? '1'
```

Parsed as an integer. Controls how many jobs the worker attempts to claim and process in a single tick. Default: 1.

### Tick Logic

```
tick():
  if this.running → skip (previous tick still executing)
  this.running = true
  try:
    for i in 0..concurrency:
      job = atomicClaim()          // transaction: findFirst + update to running
      if no job: break
      dispatch(job)                // call handler.process(job)
  finally:
    this.running = false
```

The `this.running` flag prevents concurrent tick executions if a tick takes longer than the poll interval.

### Atomic Claim

The claim is wrapped in a Prisma `$transaction`:

```typescript
const job = await prisma.enrichmentJob.findFirst({
  where: { status: JobStatus.pending },
  orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
});
if (!job) return null;
await prisma.enrichmentJob.update({
  where: { id: job.id, status: JobStatus.pending }, // guard: still pending
  data: { status: JobStatus.running, startedAt: new Date() },
});
```

The status guard in the `update` ensures that if two worker processes run simultaneously (e.g. during a deploy overlap), only one can claim a given job.

### MAX_ATTEMPTS = 3

| Outcome | Action |
|---------|--------|
| `handler.process()` returns normally | `status = succeeded`, `finishedAt = now()` |
| `handler.process()` throws, attempts < 3 | `attempts++`, `status = pending` (retry) |
| `handler.process()` throws, attempts >= 3 | `attempts++`, `status = failed`, `finishedAt = now()`, `lastError = error.message` |
| `registry.get(type)` returns `undefined` | `status = failed` immediately (no retry), `lastError = "No handler registered..."` |

Unknown handler types fail immediately without retry. This prevents an infinite retry loop for jobs created before a handler was removed.

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

## 10. Admin Jobs Dashboard

The `/admin/jobs` page provides full visibility and control over the queue. All endpoints require Admin role.

### EnrichmentAdminService Constants

```typescript
const STUCK_RUNNING_MINUTES = 10;
```

A job is considered "stuck" if its `status` is `running` and `startedAt` is older than 10 minutes (or the value passed to `reset-stuck`).

### Stats

`GET /api/admin/jobs/stats` (`jobs:read`) runs three parallel queries and returns:

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
  stuckRunning: number;       // jobs running > STUCK_RUNNING_MINUTES
}
```

### Job List

`GET /api/admin/jobs?status=&type=&page=&pageSize=` (`jobs:read`):

Paginated. Optional `status` and `type` filters. Returns `lastError` for failed rows.

### Per-Row Actions

| Endpoint | Permission | Behavior |
|----------|------------|---------|
| `POST /api/admin/jobs/:id/retry` | `jobs:write` | Resets job to `pending`, clears `attempts=0`, clears `lastError`, clears `startedAt` and `finishedAt`. Returns 400 if job is currently `running`. |
| `DELETE /api/admin/jobs/:id` | `jobs:write` | Permanently deletes the job row. Returns 400 if job is currently `running`. |

### Bulk Actions

| Endpoint | Permission | Behavior |
|----------|------------|---------|
| `POST /api/admin/jobs/retry-failed` | `jobs:write` | `updateMany` all `failed` jobs to `pending`. Optional body `{ type }` to scope by job type. |
| `POST /api/admin/jobs/reset-stuck` | `jobs:write` | `updateMany` all `running` jobs with `startedAt` older than `olderThanMinutes` (default 10) back to `pending`. |

---

## 11. How to Add a New Enrichment Capability

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

## 12. Configuration

| Variable | Default | Notes |
|----------|---------|-------|
| `ENRICHMENT_WORKER_ENABLED` | `'true'` | Set to `'false'` to disable the worker. Checked before the legacy variable. |
| `FACE_WORKER_ENABLED` | `'true'` | Legacy alias. Either variable set to `'false'` disables the worker. |
| `ENRICHMENT_JOB_POLL_MS` | `'5000'` | Worker poll interval in milliseconds. |
| `FACE_JOB_POLL_MS` | `'5000'` | Legacy alias for `ENRICHMENT_JOB_POLL_MS`. |
| `ENRICHMENT_WORKER_CONCURRENCY` | `'1'` | Jobs to attempt per tick. |
| `FACE_WORKER_CONCURRENCY` | `'1'` | Legacy alias for `ENRICHMENT_WORKER_CONCURRENCY`. |

For variables specific to the `face_detection` handler (thresholds, providers, image dimensions), see [face-recognition.md — Configuration](face-recognition.md#13-configuration-and-environment-variables).

---

## 13. Operational Notes

**Stuck-running recovery.** If the worker process crashes or the container restarts while a job is in `running` status, that job will never transition out of `running` on its own. Use `POST /api/admin/jobs/reset-stuck { olderThanMinutes: 10 }` to return stale running jobs to `pending`. The default 10-minute threshold is conservative; adjust `olderThanMinutes` if your handlers are expected to take longer.

**Idempotency.** `enqueue()` checks for existing `pending` or `running` jobs with the same `type` and `mediaItemId`. Calling enqueue multiple times for the same photo is safe. This means the backfill endpoint and the upload listener can both call enqueue without creating duplicate work, and a backfill can be retried without double-processing items that were already queued.

**Error isolation.** A thrown error in one handler's `process()` is caught by the worker and recorded in `lastError`. The worker continues to the next job. An unregistered handler type marks the job failed without crashing the worker. One bad job does not block other jobs.

**Deleting succeeded jobs.** `DELETE /api/admin/jobs/:id` is safe for housekeeping. Succeeded jobs accumulate over time; periodic deletion of old succeeded rows is safe and keeps the table compact. Failed jobs should be reviewed and either retried or deleted.

**Observability.** The worker logs at `debug` level on each tick and `error` level on handler failures. Job `lastError` content is visible in the admin dashboard. For distributed tracing, each handler invocation inherits the worker's OpenTelemetry span.

---

## 14. Future Extension Ideas

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
