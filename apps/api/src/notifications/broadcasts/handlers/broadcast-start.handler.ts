import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob, JobReason } from '@prisma/client';

import { EnrichmentHandler } from '../../../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../../../enrichment/enrichment-handler.registry';
import { EnrichmentJobService } from '../../../enrichment/enrichment-job.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  BROADCAST_CHUNK_TYPE,
  BROADCAST_JOB_PRIORITY,
  BROADCAST_START_TYPE,
  audienceWhere,
  broadcastIdOf,
} from '../broadcast-constants';
import { broadcastJobDeleteRefusal } from '../broadcast-job-delete-guard';

// =============================================================================
// broadcast_start — claim, freeze, count, hand off (epic #481, issue #488)
// =============================================================================
//
// Sends NOTHING. Turns a `scheduled` broadcast into a `sending` one exactly
// once, freezes the audience (`audienceCutoff`), records its size and enqueues
// the first `broadcast_chunk`. Scheduling is free: the job is enqueued with
// `scheduledFor`, so the claim query ignores it until due — durable across
// restarts, no second cron-based scheduler.
//
// THE COMPARE-AND-SWAP (`updateMany where status='scheduled'`) is the real
// duplicate gate: a concurrent start, an admin re-run of a succeeded start
// job, and a cancel that lands between read and write all race in the
// database, where exactly one wins. `audienceCutoff` is written in that same
// statement and never again.
//
// IDEMPOTENT PAST THE CLAIM: if the process dies after the claim but before
// the first chunk is queued, the retry finds the broadcast `sending` with no
// cursor, no progress and no chunk job, and finishes the hand-off with the
// STORED cutoff instead of stranding it.
//
// SERVER-ONLY by omission (no nodeResultSchema/persistNodeResult): a node has
// no database access. That omission puts the type in the
// ENRICHMENT_WORKER_MODE=system claim set automatically.
// =============================================================================

@Injectable()
export class BroadcastStartHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = BROADCAST_START_TYPE;
  private readonly logger = new Logger(BroadcastStartHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: EnrichmentJobService,
    private readonly registry: EnrichmentHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  canDelete(job: EnrichmentJob): Promise<string | null> {
    return broadcastJobDeleteRefusal(this.prisma, job);
  }

  /** Throws on a database error so the queue retries. */
  async process(job: EnrichmentJob): Promise<void> {
    const broadcastId = broadcastIdOf(job.payload);
    if (!broadcastId) {
      this.logger.warn(`broadcast_start job ${job.id} carries no broadcastId; nothing to do`);
      return;
    }

    const broadcast = await this.prisma.notificationBroadcast.findUnique({
      where: { id: broadcastId },
      select: { id: true, status: true, audienceCutoff: true, cursorUserId: true, processedCount: true },
    });
    if (!broadcast) {
      // Deleted while scheduled — a no-op, not a failure.
      this.logger.log(`Broadcast ${broadcastId} no longer exists; start job ${job.id} is a no-op`);
      return;
    }

    if (broadcast.status === 'sending') {
      await this.resumeHandOff(job, broadcast);
      return;
    }

    const now = new Date();
    const claimed = await this.prisma.notificationBroadcast.updateMany({
      where: { id: broadcastId, status: 'scheduled' },
      data: { status: 'sending', startedAt: now, audienceCutoff: now },
    });
    if (claimed.count === 0) {
      this.logger.log(
        `Broadcast ${broadcastId} is '${broadcast.status}', not 'scheduled'; start job ${job.id} is a no-op`,
      );
      return;
    }

    const handed = await this.handOff(broadcastId, now);
    this.logger.log(
      handed
        ? `Broadcast ${broadcastId} claimed: ${handed.recipientCount} recipient(s); first chunk job ${handed.chunkJobId}`
        : `Broadcast ${broadcastId} was cancelled right after its claim; no chunk queued`,
    );
  }

  private async resumeHandOff(
    job: EnrichmentJob,
    broadcast: { id: string; audienceCutoff: Date | null; cursorUserId: string | null; processedCount: number },
  ): Promise<void> {
    if (!broadcast.audienceCutoff || broadcast.cursorUserId !== null || broadcast.processedCount > 0) {
      this.logger.log(`Broadcast ${broadcast.id} already under way; start job ${job.id} is a no-op`);
      return;
    }
    const existingChunk = await this.prisma.enrichmentJob.findFirst({
      where: { type: BROADCAST_CHUNK_TYPE, payload: { path: ['broadcastId'], equals: broadcast.id } },
      select: { id: true },
    });
    if (existingChunk) {
      this.logger.log(
        `Broadcast ${broadcast.id} already has chunk job ${existingChunk.id}; start job ${job.id} is a no-op`,
      );
      return;
    }
    const handed = await this.handOff(broadcast.id, broadcast.audienceCutoff);
    if (handed) {
      this.logger.log(
        `Start job ${job.id} finished an interrupted hand-off for broadcast ${broadcast.id} ` +
          `(chunk job ${handed.chunkJobId})`,
      );
    }
  }

  /** Count → record (conditional on still `sending`) → enqueue first chunk. */
  private async handOff(
    broadcastId: string,
    cutoff: Date,
  ): Promise<{ recipientCount: number; chunkJobId: string } | null> {
    const recipientCount = await this.prisma.user.count({ where: audienceWhere(cutoff) });
    const recorded = await this.prisma.notificationBroadcast.updateMany({
      where: { id: broadcastId, status: 'sending' },
      data: { recipientCount },
    });
    if (recorded.count === 0) return null;

    const chunk = await this.jobs.enqueue({
      type: BROADCAST_CHUNK_TYPE,
      mediaItemId: null,
      circleId: null,
      reason: JobReason.backfill,
      priority: BROADCAST_JOB_PRIORITY,
      payload: { broadcastId },
      // MANDATORY: global jobs dedup on (type, mediaItemId IS NULL), which
      // would collapse every broadcast's chunks — and a chunk enqueues its
      // successor while itself still `running` — into one row.
      skipDedup: true,
    });
    return { recipientCount, chunkJobId: chunk.id };
  }
}
