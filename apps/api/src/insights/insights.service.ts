// =============================================================================
// Insights Service
// =============================================================================
//
// Computes and caches a global storage-metrics snapshot across all circles.
// Computation is driven by the enrichment queue (StorageInsightsHandler) to
// provide retries, restart-survival, and visibility in the jobs dashboard.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, InsightsSnapshot, JobReason, JobStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { EnrichmentJob } from '@prisma/client';

export interface InsightsMetrics {
  totalBytes: string;   // BigInt serialised as string for JSON safety
  photoBytes: string;
  videoBytes: string;
  totalItems: number;
  photoCount: number;
  videoCount: number;
  totalFaces: number;
  taggedItems: number;
}

export interface RefreshState {
  state: 'idle' | 'pending' | 'running' | 'failed';
  jobId: string | null;
  lastError: string | null;
}

// Raw row shape returned by $queryRaw for the media type query
interface MediaTypeRow {
  type: string;
  cnt: bigint;
  bytes: bigint;
}

@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  // ---------------------------------------------------------------------------
  // computeMetrics
  // ---------------------------------------------------------------------------

  async computeMetrics(): Promise<InsightsMetrics> {
    const [rows, totalFaces, taggedItems] = await Promise.all([
      this.prisma.$queryRaw<MediaTypeRow[]>`
        SELECT mi.type AS type,
               COUNT(*)::bigint AS cnt,
               COALESCE(SUM(so.size), 0)::bigint AS bytes
        FROM media_items mi
        JOIN storage_objects so ON so.id = mi.storage_object_id
        WHERE mi.deleted_at IS NULL
        GROUP BY mi.type
      `,
      this.prisma.face.count(),
      this.prisma.mediaTagStatus.count({
        where: {
          tagCount: { gt: 0 },
          mediaItem: { deletedAt: null },
        },
      }),
    ]);

    let photoCnt = BigInt(0);
    let photoBytesBig = BigInt(0);
    let videoCnt = BigInt(0);
    let videoBytesBig = BigInt(0);

    for (const row of rows) {
      if (row.type === 'photo') {
        photoCnt = row.cnt;
        photoBytesBig = row.bytes;
      } else if (row.type === 'video') {
        videoCnt = row.cnt;
        videoBytesBig = row.bytes;
      }
    }

    const totalBytesBig = photoBytesBig + videoBytesBig;

    return {
      totalBytes: totalBytesBig.toString(),
      photoBytes: photoBytesBig.toString(),
      videoBytes: videoBytesBig.toString(),
      totalItems: Number(photoCnt) + Number(videoCnt),
      photoCount: Number(photoCnt),
      videoCount: Number(videoCnt),
      totalFaces,
      taggedItems,
    };
  }

  // ---------------------------------------------------------------------------
  // getLatest
  // ---------------------------------------------------------------------------

  async getLatest(): Promise<InsightsSnapshot | null> {
    return this.prisma.insightsSnapshot.findFirst({
      where: { status: 'ready' },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ---------------------------------------------------------------------------
  // runComputation
  // ---------------------------------------------------------------------------
  //
  // The actual computation step called by StorageInsightsHandler.process().
  // Writes a ready snapshot row and prunes older snapshot rows.
  // Throws on error so the worker can record lastError and retry.
  // The in-process concurrency lock has been removed — the enrichment queue
  // guarantees a single in-flight job per (type, mediaItemId IS NULL) via
  // enqueue idempotency and atomic job claim.
  // ---------------------------------------------------------------------------

  async runComputation(): Promise<InsightsSnapshot> {
    const start = Date.now();
    const metrics = await this.computeMetrics();
    const durationMs = Date.now() - start;

    const snapshot = await this.prisma.insightsSnapshot.create({
      data: {
        status: 'ready',
        metrics: metrics as unknown as Prisma.JsonObject,
        computedAt: new Date(),
        durationMs,
      },
    });

    // Prune older snapshots — keep only the latest ready one
    await this.prisma.insightsSnapshot.deleteMany({
      where: { id: { not: snapshot.id } },
    });

    this.logger.log(`Insights snapshot computed in ${durationMs}ms`);
    return snapshot;
  }

  // ---------------------------------------------------------------------------
  // enqueueRefresh
  // ---------------------------------------------------------------------------
  //
  // Enqueues a storage_insights enrichment job. Uses null mediaItemId/circleId
  // so the queue idempotency deduplicates by (type, mediaItemId IS NULL).
  // ---------------------------------------------------------------------------

  async enqueueRefresh(reason: JobReason, priority: number): Promise<EnrichmentJob> {
    return this.enrichmentJobService.enqueue({
      type: 'storage_insights',
      mediaItemId: null,
      circleId: null,
      reason,
      priority,
    });
  }

  // ---------------------------------------------------------------------------
  // getRefreshState
  // ---------------------------------------------------------------------------
  //
  // Returns the in-flight/last-known state of the storage_insights job by
  // querying the most recent enrichment job row of this type.
  // ---------------------------------------------------------------------------

  async getRefreshState(): Promise<RefreshState> {
    const job = await this.prisma.enrichmentJob.findFirst({
      where: { type: 'storage_insights' },
      orderBy: { createdAt: 'desc' },
    });

    if (!job) {
      return { state: 'idle', jobId: null, lastError: null };
    }

    switch (job.status) {
      case JobStatus.pending:
        return { state: 'pending', jobId: job.id, lastError: null };
      case JobStatus.running:
        return { state: 'running', jobId: job.id, lastError: null };
      case JobStatus.failed:
        return { state: 'failed', jobId: job.id, lastError: job.lastError };
      case JobStatus.succeeded:
      default:
        return { state: 'idle', jobId: null, lastError: null };
    }
  }
}
