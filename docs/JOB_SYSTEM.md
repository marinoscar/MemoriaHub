# Job Management System Documentation

This document describes the background job processing system used in MemoriaHub for media processing tasks like thumbnail and preview generation.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Database Schema](#database-schema)
4. [Job Types and Queues](#job-types-and-queues)
5. [Job Lifecycle](#job-lifecycle)
6. [Worker Service](#worker-service)
7. [Job Handlers](#job-handlers)
8. [Admin API](#admin-api)
9. [CLI Commands](#cli-commands)
10. [Configuration](#configuration)
11. [Error Handling and Retries](#error-handling-and-retries)
12. [Observability](#observability)
13. [Troubleshooting](#troubleshooting)

---

## Overview

The job management system provides asynchronous processing of media assets after upload. When a user uploads a photo or video, the system automatically queues jobs to:

- Generate thumbnails (300x300px square crops)
- Generate previews (max 1200px dimension)
- Extract metadata (EXIF, GPS coordinates)
- AI processing (face detection, object recognition) - future

The system uses a PostgreSQL-based job queue with:
- Multiple queues for different workload types
- Configurable concurrency per queue
- Exponential backoff retry logic
- Graceful shutdown support
- Full observability (logs, metrics, traces)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          API Service                                 │
│  ┌──────────────────┐    ┌──────────────────┐                       │
│  │  Upload Service  │───▶│  ProcessingJob   │                       │
│  │                  │    │   Repository     │                       │
│  └──────────────────┘    └────────┬─────────┘                       │
│                                   │                                  │
│  ┌──────────────────┐             │                                  │
│  │  Admin Controller│◀────────────┤                                  │
│  │  (Job Management)│             │                                  │
│  └──────────────────┘             │                                  │
└───────────────────────────────────┼─────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         PostgreSQL                                   │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    processing_jobs                           │    │
│  │  ┌─────────┬─────────┬──────────┬──────────┬───────────┐   │    │
│  │  │   id    │  type   │  status  │  queue   │  priority │   │    │
│  │  ├─────────┼─────────┼──────────┼──────────┼───────────┤   │    │
│  │  │  uuid1  │ thumb   │ pending  │ default  │    10     │   │    │
│  │  │  uuid2  │ preview │ pending  │ default  │     5     │   │    │
│  │  │  uuid3  │ thumb   │processing│ default  │    10     │   │    │
│  │  └─────────┴─────────┴──────────┴──────────┴───────────┘   │    │
│  └─────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬─────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Worker Service                                │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                      Orchestrator                             │   │
│  │  - Manages worker lifecycle                                   │   │
│  │  - Creates queue pollers                                      │   │
│  │  - Handles graceful shutdown                                  │   │
│  └────────────────────────────┬─────────────────────────────────┘   │
│                               │                                      │
│  ┌────────────────────────────┼────────────────────────────────┐    │
│  │                            ▼                                 │    │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐             │    │
│  │  │  Default   │  │   Large    │  │  Priority  │  Queue      │    │
│  │  │   Poller   │  │   Files    │  │   Poller   │  Pollers    │    │
│  │  │ (4 conc.)  │  │  (1 conc.) │  │ (2 conc.)  │             │    │
│  │  └──────┬─────┘  └─────┬──────┘  └─────┬──────┘             │    │
│  └─────────┼──────────────┼───────────────┼────────────────────┘    │
│            │              │               │                          │
│            └──────────────┼───────────────┘                          │
│                           ▼                                          │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                       Job Router                              │   │
│  │  - Routes jobs to handlers by type                           │   │
│  │  - Tracks job execution metrics                              │   │
│  └────────────────────────────┬─────────────────────────────────┘   │
│                               │                                      │
│  ┌────────────────────────────┼────────────────────────────────┐    │
│  │                            ▼                                 │    │
│  │  ┌────────────────┐  ┌────────────────┐                     │    │
│  │  │   Thumbnail    │  │    Preview     │  Job Handlers       │    │
│  │  │    Handler     │  │    Handler     │                     │    │
│  │  └───────┬────────┘  └───────┬────────┘                     │    │
│  └──────────┼───────────────────┼──────────────────────────────┘    │
│             │                   │                                    │
│             └─────────┬─────────┘                                    │
│                       ▼                                              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Image Processor (Sharp)                    │   │
│  │  - Thumbnail: 300x300 center crop, JPEG quality 80           │   │
│  │  - Preview: Max 1200px, preserve aspect, JPEG quality 85     │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Video Processor (FFmpeg)                   │   │
│  │  - Frame extraction at min(1s, 10% of duration)              │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Database Schema

### Processing Jobs Table

```sql
CREATE TABLE processing_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,

    -- Job identification
    job_type VARCHAR(50) NOT NULL,
    priority INTEGER DEFAULT 0,
    payload JSONB DEFAULT '{}',

    -- Status tracking
    status VARCHAR(20) DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    last_error TEXT,

    -- Queue routing
    queue VARCHAR(50) DEFAULT 'default',
    worker_id VARCHAR(100),
    result JSONB,

    -- Tracing
    trace_id VARCHAR(64),

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    next_retry_at TIMESTAMP WITH TIME ZONE
);

-- Optimized index for job polling (critical for performance)
CREATE INDEX idx_processing_jobs_queue_polling
    ON processing_jobs (queue, status, priority DESC, created_at ASC)
    WHERE status = 'pending';

-- Index for finding jobs by worker (for graceful shutdown)
CREATE INDEX idx_processing_jobs_worker_id
    ON processing_jobs (worker_id)
    WHERE status = 'processing';

-- Index for retry scheduling
CREATE INDEX idx_processing_jobs_retry
    ON processing_jobs (next_retry_at)
    WHERE status = 'pending';
```

---

## Job Types and Queues

### Job Types

| Type | Description | Priority |
|------|-------------|----------|
| `extract_metadata` | Extract EXIF data from images | 15 |
| `generate_thumbnail` | Create 300x300px thumbnail | 10 |
| `generate_preview` | Create 1200px max preview | 5 |
| `reverse_geocode` | Convert GPS to location name | 3 |
| `detect_faces` | AI face detection | 2 |
| `detect_objects` | AI object/scene detection | 1 |
| `index_search` | Full-text search indexing | 0 |

### Queues

| Queue | Concurrency | Poll Interval | Timeout | Use Case |
|-------|-------------|---------------|---------|----------|
| `default` | 4 | 5 seconds | 5 min | Standard image processing |
| `large_files` | 1 | 5 seconds | 10 min | Files > 100MB |
| `priority` | 2 | 2 seconds | 5 min | User-initiated re-processing |
| `ai` | 1 | 10 seconds | 10 min | ML/AI tasks (disabled by default) |

### Parallel vs Sequential Execution

Jobs run **in parallel** within each queue's concurrency limit, not strictly sequentially:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         WORKER SERVICE                                   │
│                                                                          │
│  DEFAULT QUEUE (concurrency: 4)                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                    │
│  │ Slot 1   │ │ Slot 2   │ │ Slot 3   │ │ Slot 4   │                    │
│  │ thumbnail│ │ thumbnail│ │ preview  │ │ preview  │  ← 4 jobs running  │
│  │ asset-A  │ │ asset-B  │ │ asset-A  │ │ asset-C  │    simultaneously  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘                    │
│                                                                          │
│  AI QUEUE (concurrency: 1)                                               │
│  ┌──────────┐                                                           │
│  │ Slot 1   │  ← Only one AI job runs at a time (sequential)            │
│  │ face     │                                                           │
│  │ detect   │                                                           │
│  └──────────┘                                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key points:**

1. **Within a queue**: Jobs run in parallel up to the concurrency limit
2. **Job selection order**: Higher priority first, then oldest first
3. **No per-asset sequencing**: Thumbnail and preview for the same asset can run simultaneously
4. **Sequential queues**: `large_files` (concurrency: 1) and `ai` (concurrency: 1) process one job at a time

**Example**: If you upload 10 photos, up to 4 thumbnail/preview jobs will process simultaneously in the default queue.

### Enforcing Sequential Processing

If you need jobs for the same asset to run in order (e.g., metadata extraction before AI), you have two options:

**Option 1: Use a Sequential Queue**
```typescript
// AI queue has concurrency: 1, so jobs run one at a time
{ jobType: 'detect_faces', queue: 'ai', priority: 2 }
```

**Option 2: Chain Jobs (handler creates next job on completion)**
```typescript
// In a handler's process() method:
async process(context: JobContext): Promise<ProcessingJobResult> {
  // Do work...

  // Queue the next job in the pipeline
  await processingJobRepository.create({
    assetId: context.job.assetId,
    jobType: 'detect_faces',
    queue: 'ai',
    traceId: context.job.traceId,
  });

  return result;
}
```

---

## Job Lifecycle

```
                    ┌─────────────────────────────────────────┐
                    │              UPLOAD                      │
                    │  Asset created with status=UPLOADED      │
                    └────────────────────┬────────────────────┘
                                         │
                                         ▼
                    ┌─────────────────────────────────────────┐
                    │         UPLOAD COMPLETED                 │
                    │  - File stored in S3                    │
                    │  - EXIF metadata extracted              │
                    │  - Asset status → METADATA_EXTRACTED    │
                    │  - Jobs queued (thumbnail + preview)    │
                    └────────────────────┬────────────────────┘
                                         │
                                         ▼
┌────────────────────────────────────────────────────────────────────┐
│                          JOB PENDING                                │
│  status=pending, queue=default, priority=10                        │
│  Waiting in queue for worker to acquire                            │
└────────────────────────────┬───────────────────────────────────────┘
                             │
                             │ Worker polls and acquires
                             │ (FOR UPDATE SKIP LOCKED)
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│                        JOB PROCESSING                               │
│  status=processing, worker_id=<worker>, started_at=NOW()           │
│                                                                     │
│  Handler executes:                                                  │
│  1. Download original from S3                                       │
│  2. Process with Sharp/FFmpeg                                       │
│  3. Upload derivative to S3                                         │
│  4. Update asset metadata                                           │
└─────────────────┬──────────────────────────┬───────────────────────┘
                  │                          │
          Success │                          │ Error
                  ▼                          ▼
┌─────────────────────────┐    ┌─────────────────────────────────────┐
│    JOB COMPLETED        │    │           JOB FAILED                 │
│  status=completed       │    │  attempts < max_attempts?            │
│  completed_at=NOW()     │    │                                      │
│  result={outputKey...}  │    │  YES: status=pending                 │
│                         │    │       next_retry_at=NOW()+backoff    │
│  Asset status updated:  │    │                                      │
│  DERIVATIVES_READY      │    │  NO:  status=failed                  │
│  (if all jobs done)     │    │       Manual retry required          │
└─────────────────────────┘    └─────────────────────────────────────┘
```

### Status Values

| Status | Description |
|--------|-------------|
| `pending` | Queued, waiting for worker |
| `processing` | Worker is actively processing |
| `completed` | Successfully finished |
| `failed` | Failed after max retries |
| `cancelled` | Manually cancelled by admin |

---

## Worker Service

### Entry Point

The worker service starts in `apps/worker/src/index.ts`:

```typescript
import { orchestrator } from './core/index.js';

async function main() {
  // Start the worker
  await orchestrator.start();

  // Handle graceful shutdown
  process.on('SIGTERM', () => orchestrator.stop());
  process.on('SIGINT', () => orchestrator.stop());
}

main().catch(console.error);
```

### Orchestrator

The orchestrator (`apps/worker/src/core/orchestrator.ts`) manages the worker lifecycle:

```typescript
class Orchestrator {
  // Start all queue pollers
  async start(): Promise<void> {
    // 1. Verify database connection
    // 2. Verify S3 connection
    // 3. Create QueuePoller for each enabled queue
    // 4. Start all pollers
  }

  // Graceful shutdown
  async stop(): Promise<void> {
    // 1. Stop accepting new jobs
    // 2. Wait for active jobs to complete (up to timeout)
    // 3. Abort remaining jobs (release back to pending)
    // 4. Close database pool
  }

  // Health check
  async checkHealth(): Promise<HealthStatus> {
    // Check database and S3 connectivity
  }
}
```

### Queue Poller

Each queue has its own poller (`apps/worker/src/core/queue-poller.ts`):

```typescript
class QueuePoller {
  private activeJobs = new Map<string, AbortController>();

  async poll(): Promise<void> {
    // While running and can accept more jobs:
    while (this.running && this.activeJobs.size < this.concurrency) {
      const job = await this.acquireNextJob();
      if (!job) break;

      // Process asynchronously (don't await)
      this.processJob(job);
    }

    // Schedule next poll
    setTimeout(() => this.poll(), this.pollIntervalMs);
  }

  private async acquireNextJob(): Promise<ProcessingJob | null> {
    // Atomic acquisition using FOR UPDATE SKIP LOCKED
    return repository.acquireJob(this.queue, this.workerId);
  }
}
```

### Job Router

The job router (`apps/worker/src/core/job-router.ts`) dispatches jobs to handlers:

```typescript
class JobRouter {
  private handlers = new Map<ProcessingJobType, JobHandler>();

  register(handler: JobHandler): void {
    this.handlers.set(handler.jobType, handler);
  }

  async route(context: JobContext): Promise<ProcessingJobResult> {
    const handler = this.handlers.get(context.job.jobType);
    if (!handler) {
      throw new Error(`No handler for job type: ${context.job.jobType}`);
    }
    return handler.process(context);
  }
}
```

---

## Job Handlers

### Base Handler

All handlers extend `BaseHandler` (`apps/worker/src/handlers/base.handler.ts`):

```typescript
abstract class BaseHandler implements JobHandler {
  abstract readonly jobType: ProcessingJobType;
  abstract process(context: JobContext): Promise<ProcessingJobResult>;

  // Helper methods available to all handlers:

  protected async getAsset(context: JobContext): Promise<MediaAsset> {
    // Fetch asset from database
  }

  protected async downloadOriginal(
    bucket: string,
    key: string,
    context: JobContext
  ): Promise<Buffer> {
    // Download from S3
  }

  protected async uploadDerivative(
    bucket: string,
    key: string,
    buffer: Buffer,
    context: JobContext
  ): Promise<void> {
    // Upload to S3 with caching headers
  }

  protected buildDerivativeKey(
    libraryId: string,
    assetId: string,
    type: 'thumbnails' | 'previews'
  ): string {
    return `libraries/${libraryId}/${type}/${assetId}.jpg`;
  }

  protected async checkAndUpdateDerivativeStatus(
    assetId: string,
    context: JobContext
  ): Promise<void> {
    // If all derivatives complete, update asset status
  }
}
```

### Thumbnail Handler

Creates 300x300px square center-crop thumbnails (`apps/worker/src/handlers/thumbnail.handler.ts`):

```typescript
class ThumbnailHandler extends BaseHandler {
  readonly jobType = 'generate_thumbnail';

  async process(context: JobContext): Promise<ProcessingJobResult> {
    const asset = await this.getAsset(context);

    // Download original
    const originalBuffer = await this.downloadOriginal(
      asset.storageBucket,
      asset.storageKey,
      context
    );

    let inputBuffer: Buffer;

    // Handle different media types
    if (asset.mediaType === 'video') {
      inputBuffer = await this.extractVideoFrame(originalBuffer, asset.id, context);
    } else if (this.isAnimatedFormat(asset.mimeType)) {
      inputBuffer = await imageProcessor.extractFirstFrame(originalBuffer);
    } else {
      inputBuffer = originalBuffer;
    }

    // Generate thumbnail (300x300 center crop)
    const thumbnail = await imageProcessor.generateThumbnail(inputBuffer);

    // Upload to S3
    const thumbnailKey = this.buildDerivativeKey(asset.libraryId, asset.id, 'thumbnails');
    await this.uploadDerivative(asset.storageBucket, thumbnailKey, thumbnail.buffer, context);

    // Update asset
    await mediaAssetRepository.updateThumbnailKey(asset.id, thumbnailKey);
    await this.checkAndUpdateDerivativeStatus(asset.id, context);

    return {
      outputKey: thumbnailKey,
      outputSize: thumbnail.size,
      outputWidth: thumbnail.width,
      outputHeight: thumbnail.height,
      durationMs: Date.now() - context.startTime,
    };
  }
}
```

### Preview Handler

Creates preview images with max 1200px dimension (`apps/worker/src/handlers/preview.handler.ts`):

```typescript
class PreviewHandler extends BaseHandler {
  readonly jobType = 'generate_preview';

  async process(context: JobContext): Promise<ProcessingJobResult> {
    // Similar to ThumbnailHandler, but:
    // - Uses imageProcessor.generatePreview() instead
    // - Max dimension 1200px (preserves aspect ratio)
    // - JPEG quality 85 (vs 80 for thumbnail)
    // - Updates previewKey instead of thumbnailKey
  }
}
```

### Image Processor

Sharp-based image processing (`apps/worker/src/processors/image.processor.ts`):

```typescript
class ImageProcessor {
  async generateThumbnail(input: Buffer): Promise<ProcessedImage> {
    const image = sharp(input)
      .rotate()  // Auto-rotate based on EXIF
      .resize(300, 300, {
        fit: 'cover',
        position: 'centre',
      })
      .jpeg({ quality: 80 });

    const buffer = await image.toBuffer();
    const metadata = await sharp(buffer).metadata();

    return {
      buffer,
      size: buffer.length,
      width: metadata.width,
      height: metadata.height,
    };
  }

  async generatePreview(input: Buffer): Promise<ProcessedImage> {
    const image = sharp(input)
      .rotate()
      .resize(1200, 1200, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 });

    // ... similar to generateThumbnail
  }

  async extractFirstFrame(input: Buffer): Promise<Buffer> {
    // Extract first frame from animated GIF/WebP
    return sharp(input, { animated: false }).toBuffer();
  }
}
```

### Video Processor

FFmpeg-based frame extraction (`apps/worker/src/processors/video.processor.ts`):

```typescript
class VideoProcessor {
  async extractFrame(inputPath: string): Promise<FrameExtractionResult> {
    // Get video duration
    const duration = await this.getDuration(inputPath);

    // Calculate timestamp: min(1 second, 10% of duration)
    const timestamp = duration ? Math.min(1, duration * 0.1) : 0;

    // Extract frame
    const outputPath = path.join(tempDir, `frame-${Date.now()}.jpg`);
    await this.extractFrameAtTimestamp(inputPath, outputPath, timestamp);

    return { framePath: outputPath, timestamp, durationSeconds: duration };
  }

  private extractFrameAtTimestamp(
    inputPath: string,
    outputPath: string,
    timestamp: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .seekInput(timestamp)
        .frames(1)
        .outputOptions(['-vf', 'select=eq(n\\,0)', '-q:v', '2'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
  }
}
```

---

## Admin API

All admin endpoints require authentication and admin role.

**Base Path:** `/api/admin`

### Endpoints

#### List Jobs

```http
GET /api/admin/jobs
```

Query parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter by status (pending/processing/completed/failed/cancelled) |
| `jobType` | string | Filter by job type |
| `queue` | string | Filter by queue |
| `assetId` | UUID | Filter by asset ID |
| `libraryId` | UUID | Filter by library ID |
| `createdAfter` | ISO datetime | Filter jobs created after this time |
| `createdBefore` | ISO datetime | Filter jobs created before this time |
| `page` | number | Page number (default: 1) |
| `limit` | number | Items per page (default: 50, max: 100) |
| `sortBy` | string | Sort field (createdAt/startedAt/completedAt/priority) |
| `sortOrder` | string | Sort direction (asc/desc) |

Response:

```json
{
  "jobs": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "assetId": "660e8400-e29b-41d4-a716-446655440001",
      "jobType": "generate_thumbnail",
      "queue": "default",
      "priority": 10,
      "status": "completed",
      "attempts": 1,
      "maxAttempts": 3,
      "result": {
        "outputKey": "libraries/abc/thumbnails/def.jpg",
        "outputSize": 15420,
        "outputWidth": 300,
        "outputHeight": 300,
        "durationMs": 1234
      },
      "createdAt": "2024-01-15T10:30:00Z",
      "startedAt": "2024-01-15T10:30:05Z",
      "completedAt": "2024-01-15T10:30:06Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 150,
    "totalPages": 3
  }
}
```

#### Get Job Details

```http
GET /api/admin/jobs/:id
```

Returns full job details including payload, result, and error information.

#### Create Job Manually

```http
POST /api/admin/jobs
```

Request body:

```json
{
  "assetId": "660e8400-e29b-41d4-a716-446655440001",
  "jobType": "generate_thumbnail",
  "queue": "priority",
  "priority": 50,
  "payload": {}
}
```

#### Retry Failed Job

```http
POST /api/admin/jobs/:id/retry
```

Resets a failed job to pending status for reprocessing.

#### Cancel Job

```http
POST /api/admin/jobs/:id/cancel
```

Cancels a pending or processing job.

#### Delete Job

```http
DELETE /api/admin/jobs/:id
```

Permanently deletes a job record.

#### Batch Retry

```http
POST /api/admin/jobs/batch/retry
```

Request body:

```json
{
  "jobIds": ["uuid1", "uuid2"],
  // OR
  "filters": {
    "jobType": "generate_thumbnail",
    "queue": "default"
  }
}
```

#### Get Statistics

```http
GET /api/admin/jobs/stats
```

Response:

```json
{
  "total": 10000,
  "byStatus": {
    "pending": 50,
    "processing": 4,
    "completed": 9800,
    "failed": 146,
    "cancelled": 0
  },
  "byType": {
    "generate_thumbnail": 5000,
    "generate_preview": 5000
  },
  "byQueue": {
    "default": { "pending": 40, "processing": 3, "completed": 9000, "failed": 100 },
    "large_files": { "pending": 5, "processing": 1, "completed": 500, "failed": 20 },
    "priority": { "pending": 5, "processing": 0, "completed": 300, "failed": 26 }
  },
  "processingRate": {
    "lastHour": 150,
    "last24Hours": 2500
  },
  "avgDurationMs": {
    "generate_thumbnail": 1200,
    "generate_preview": 2500
  },
  "failureRate": {
    "lastHour": 0.02,
    "last24Hours": 0.015
  }
}
```

#### Find Stuck Jobs

```http
GET /api/admin/jobs/stuck
```

Finds jobs stuck in processing state for more than 30 minutes.

#### Reset Stuck Jobs

```http
POST /api/admin/jobs/stuck/reset
```

Resets stuck jobs back to pending status.

---

## CLI Commands

The `dev.ps1` script provides job management commands:

```powershell
# Show queue statistics
.\scripts\dev.ps1 jobs status

# List jobs
.\scripts\dev.ps1 jobs list
.\scripts\dev.ps1 jobs list --status=failed
.\scripts\dev.ps1 jobs list --type=generate_thumbnail

# Get job details
.\scripts\dev.ps1 jobs get <job-id>

# Retry a failed job
.\scripts\dev.ps1 jobs retry <job-id>

# Retry all failed jobs
.\scripts\dev.ps1 jobs retry-all-failed

# Cancel a pending job
.\scripts\dev.ps1 jobs cancel <job-id>

# Find stuck jobs
.\scripts\dev.ps1 jobs stuck

# Reset stuck jobs to pending
.\scripts\dev.ps1 jobs reset-stuck

# Queue jobs for assets missing derivatives
.\scripts\dev.ps1 jobs backfill
```

---

## Configuration

### Environment Variables

```bash
# Worker identification
WORKER_ID=worker-1                    # Custom worker ID (auto-generated if not set)

# Queue configuration
WORKER_DEFAULT_CONCURRENCY=4          # Parallel jobs for default queue
WORKER_LARGE_FILES_CONCURRENCY=1      # Parallel jobs for large files
WORKER_PRIORITY_CONCURRENCY=2         # Parallel jobs for priority queue
WORKER_AI_CONCURRENCY=1               # Parallel jobs for AI queue
WORKER_AI_ENABLED=false               # Enable AI queue

# Polling intervals
WORKER_POLL_INTERVAL_MS=5000          # Default poll interval
WORKER_PRIORITY_POLL_INTERVAL_MS=2000 # Priority queue polls faster
WORKER_AI_POLL_INTERVAL_MS=10000      # AI queue polls slower

# Timeouts
WORKER_JOB_TIMEOUT_MS=300000          # 5 minutes for standard jobs
WORKER_LARGE_FILES_TIMEOUT_MS=600000  # 10 minutes for large files
WORKER_SHUTDOWN_TIMEOUT_MS=30000      # 30 seconds for graceful shutdown

# Processing settings
THUMBNAIL_SIZE=300                    # Thumbnail dimension
THUMBNAIL_QUALITY=80                  # JPEG quality
PREVIEW_MAX_SIZE=1200                 # Preview max dimension
PREVIEW_QUALITY=85                    # JPEG quality
LARGE_FILE_THRESHOLD_MB=100           # Threshold for large_files queue
MAX_FILE_SIZE_MB=500                  # Maximum file size

# Retry settings
WORKER_MAX_ATTEMPTS=5                 # Max retry attempts
WORKER_RETRY_BASE_DELAY_MS=30000      # Base retry delay (30s)
WORKER_RETRY_MAX_DELAY_MS=3600000     # Max retry delay (1 hour)

# Temp files
TEMP_DIR=/tmp/worker                  # Temp file directory

# Server
WORKER_PORT=3001                      # Health check server port
WORKER_METRICS_PATH=/metrics          # Prometheus metrics path
```

### Configuration File

The worker configuration is defined in `apps/worker/src/config/worker.config.ts`:

```typescript
export const workerConfig = {
  workerId: process.env.WORKER_ID || generateWorkerId(),

  queues: {
    default: {
      concurrency: parseInt(process.env.WORKER_DEFAULT_CONCURRENCY || '4'),
      pollIntervalMs: parseInt(process.env.WORKER_POLL_INTERVAL_MS || '5000'),
      jobTimeoutMs: parseInt(process.env.WORKER_JOB_TIMEOUT_MS || '300000'),
      enabled: true,
    },
    large_files: {
      concurrency: parseInt(process.env.WORKER_LARGE_FILES_CONCURRENCY || '1'),
      pollIntervalMs: parseInt(process.env.WORKER_POLL_INTERVAL_MS || '5000'),
      jobTimeoutMs: parseInt(process.env.WORKER_LARGE_FILES_TIMEOUT_MS || '600000'),
      enabled: true,
    },
    priority: {
      concurrency: parseInt(process.env.WORKER_PRIORITY_CONCURRENCY || '2'),
      pollIntervalMs: parseInt(process.env.WORKER_PRIORITY_POLL_INTERVAL_MS || '2000'),
      jobTimeoutMs: parseInt(process.env.WORKER_JOB_TIMEOUT_MS || '300000'),
      enabled: true,
    },
    ai: {
      concurrency: parseInt(process.env.WORKER_AI_CONCURRENCY || '1'),
      pollIntervalMs: parseInt(process.env.WORKER_AI_POLL_INTERVAL_MS || '10000'),
      jobTimeoutMs: parseInt(process.env.WORKER_LARGE_FILES_TIMEOUT_MS || '600000'),
      enabled: process.env.WORKER_AI_ENABLED === 'true',
    },
  },

  processing: {
    thumbnail: {
      size: parseInt(process.env.THUMBNAIL_SIZE || '300'),
      quality: parseInt(process.env.THUMBNAIL_QUALITY || '80'),
    },
    preview: {
      maxSize: parseInt(process.env.PREVIEW_MAX_SIZE || '1200'),
      quality: parseInt(process.env.PREVIEW_QUALITY || '85'),
    },
  },

  retry: {
    maxAttempts: parseInt(process.env.WORKER_MAX_ATTEMPTS || '5'),
    baseDelayMs: parseInt(process.env.WORKER_RETRY_BASE_DELAY_MS || '30000'),
    maxDelayMs: parseInt(process.env.WORKER_RETRY_MAX_DELAY_MS || '3600000'),
  },

  shutdown: {
    timeoutMs: parseInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS || '30000'),
  },
};
```

---

## Error Handling and Retries

### Retry Strategy

The system uses exponential backoff with the following formula:

```
delay = min(baseDelay * 2^attempts, maxDelay)
```

Default values:
- Base delay: 30 seconds
- Max delay: 1 hour
- Max attempts: 5

Example retry schedule:
| Attempt | Delay |
|---------|-------|
| 1 | 30 seconds |
| 2 | 1 minute |
| 3 | 2 minutes |
| 4 | 4 minutes |
| 5 | 8 minutes (then fails) |

### Error Categories

| Error Type | Retryable | Action |
|------------|-----------|--------|
| Transient S3 error | Yes | Retry with backoff |
| Database connection | Yes | Retry with backoff |
| Invalid image format | No | Fail immediately |
| Asset not found | No | Fail immediately |
| Timeout exceeded | Yes | Retry with backoff |
| Out of memory | No | Fail (needs investigation) |

### Graceful Shutdown

When the worker receives SIGTERM/SIGINT:

1. Stop accepting new jobs
2. Wait for active jobs to complete (up to `shutdownTimeoutMs`)
3. If timeout exceeded, abort remaining jobs
4. Release aborted jobs back to pending status
5. Close database connections
6. Exit process

```typescript
// Jobs are released back to pending, not failed
await repository.releaseJob(jobId);
// Sets: status='pending', worker_id=NULL, started_at=NULL
```

---

## Observability

### Logging

All job processing is logged with structured JSON:

```json
{
  "timestamp": "2024-01-15T10:30:05.123Z",
  "level": "info",
  "service": "worker",
  "workerId": "worker-1-12345",
  "traceId": "abc123def456",
  "eventType": "processing_job.completed",
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "jobType": "generate_thumbnail",
  "assetId": "660e8400-e29b-41d4-a716-446655440001",
  "durationMs": 1234,
  "outputSize": 15420
}
```

Key event types:
- `processing_job.created` - Job queued
- `processing_job.acquired` - Worker claimed job
- `processing_job.started` - Processing began
- `processing_job.completed` - Success
- `processing_job.failed` - Failed (with error)
- `processing_job.retry_scheduled` - Will retry
- `queue.started` - Queue poller started
- `queue.stopped` - Queue poller stopped

### Metrics

Prometheus metrics exposed at `/metrics`:

```prometheus
# Job counters
jobs_processed_total{type="generate_thumbnail",status="completed"} 5000
jobs_processed_total{type="generate_thumbnail",status="failed"} 50

# Job duration histogram
job_duration_seconds_bucket{type="generate_thumbnail",le="1"} 4500
job_duration_seconds_bucket{type="generate_thumbnail",le="5"} 4950
job_duration_seconds_bucket{type="generate_thumbnail",le="10"} 5000

# Queue depth
job_queue_depth{queue="default"} 25
job_queue_depth{queue="priority"} 2

# Active jobs
worker_active_jobs{queue="default"} 4
worker_active_jobs{queue="large_files"} 1

# Retry counter
job_retries_total{type="generate_thumbnail"} 75
```

### Health Endpoints

```http
# Liveness probe - is the process alive?
GET /healthz
Response: { "status": "ok", "workerId": "worker-1", "uptime": 3600 }

# Readiness probe - are dependencies ready?
GET /readyz
Response: { "status": "ok", "checks": { "database": "ok", "s3": "ok" } }

# Detailed status
GET /status
Response: {
  "workerId": "worker-1",
  "running": true,
  "shuttingDown": false,
  "queues": [
    { "name": "default", "activeJobs": 4, "maxConcurrency": 4 },
    { "name": "large_files", "activeJobs": 0, "maxConcurrency": 1 }
  ]
}
```

### Tracing

Jobs include `traceId` that links to the original upload request:

```
Upload Request (traceId: abc123)
  └── Create Jobs (traceId: abc123)
       ├── generate_thumbnail (traceId: abc123)
       └── generate_preview (traceId: abc123)
```

View traces in Jaeger at http://localhost:16686.

---

## Troubleshooting

### Common Issues

#### Jobs Stuck in Processing

**Symptoms:** Jobs remain in `processing` status for extended periods.

**Diagnosis:**
```powershell
.\scripts\dev.ps1 jobs stuck
```

**Solutions:**
1. Check if worker is running: `docker ps | grep worker`
2. Check worker logs: `.\scripts\dev.ps1 logs worker`
3. Reset stuck jobs: `.\scripts\dev.ps1 jobs reset-stuck`

#### High Failure Rate

**Symptoms:** Many jobs in `failed` status.

**Diagnosis:**
```powershell
.\scripts\dev.ps1 jobs list --status=failed
.\scripts\dev.ps1 jobs get <job-id>  # Check last_error
```

**Common Causes:**
- S3 connectivity issues
- Invalid image formats
- Out of memory (large files)
- FFmpeg not installed (video processing)

**Solutions:**
1. Check S3 connectivity
2. Increase memory limits
3. Ensure FFmpeg is installed in Docker image
4. Retry failed jobs: `.\scripts\dev.ps1 jobs retry-all-failed`

#### Worker Not Processing Jobs

**Symptoms:** Jobs remain in `pending` status.

**Diagnosis:**
1. Check worker status: `.\scripts\dev.ps1 status`
2. Check worker health: `curl http://localhost:3001/readyz`
3. Check worker logs: `.\scripts\dev.ps1 logs worker`

**Solutions:**
1. Restart worker: `docker compose restart worker`
2. Check database connectivity
3. Verify queue configuration

#### Thumbnails Not Appearing

**Symptoms:** Uploads complete but no thumbnails visible.

**Diagnosis:**
```sql
SELECT id, thumbnail_key, preview_key, status
FROM media_assets
WHERE thumbnail_key IS NULL
  AND status != 'UPLOADED';
```

**Solutions:**
1. Check if jobs were created: `.\scripts\dev.ps1 jobs list --type=generate_thumbnail`
2. Backfill missing jobs: `.\scripts\dev.ps1 jobs backfill`
3. Check worker logs for processing errors

### Useful Queries

```sql
-- Count jobs by status
SELECT status, COUNT(*) FROM processing_jobs GROUP BY status;

-- Find jobs for a specific asset
SELECT * FROM processing_jobs WHERE asset_id = '<asset-uuid>';

-- Find recent failures
SELECT id, job_type, last_error, created_at
FROM processing_jobs
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 20;

-- Check processing times
SELECT job_type,
       AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_seconds
FROM processing_jobs
WHERE status = 'completed'
GROUP BY job_type;

-- Find jobs stuck in processing
SELECT * FROM processing_jobs
WHERE status = 'processing'
  AND started_at < NOW() - INTERVAL '30 minutes';
```

---

## Related Documentation

- [Architecture Overview](ARCHITECTURE.md)
- [API Reference](API.md)
- [Database Schema](DATABASE.md)
- [Observability Guide](OBSERVABILITY.md)
- [Troubleshooting Guide](TROUBLESHOOTING.md)
