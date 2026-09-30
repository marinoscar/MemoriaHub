import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob, JobReason } from '@prisma/client';

import { EnrichmentHandler } from '../../../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../../../enrichment/enrichment-handler.registry';
import { EnrichmentJobService } from '../../../enrichment/enrichment-job.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { BroadcastDeliveryService, BroadcastRecipient } from '../broadcast-delivery.service';
import {
  BROADCAST_CHUNK_SIZE,
  BROADCAST_CHUNK_TYPE,
  BROADCAST_JOB_PRIORITY,
  BROADCAST_SEND_CONCURRENCY,
  BROADCAST_STATUS_RECHECK_INTERVAL,
  audienceWhere,
  broadcastIdOf,
} from '../broadcast-constants';
import { broadcastJobDeleteRefusal } from '../broadcast-job-delete-guard';

// =============================================================================
// broadcast_chunk — deliver one page of the audience (epic #481, issue #488)
// =============================================================================
//
// Pages up to BROADCAST_CHUNK_SIZE users (`id > cursorUserId`, id order, the
// shared audienceWhere(cutoff) predicate), delivers each through
// BroadcastDeliveryService with BROADCAST_SEND_CONCURRENCY in flight, and every
// BROADCAST_STATUS_RECHECK_INTERVAL recipients:
//
//   1. COMMITS PROGRESS with a compare-and-swap on the cursor it started from
//      (`where cursorUserId = <previous>`). If another execution already moved
//      the cursor (a reaped-but-alive zombie next to its replacement, or an
//      admin retry beside a resume), this chain stops: at most one group is
//      delivered twice, never the whole remaining audience.
//   2. RE-CHECKS STATUS: a cancel stops the fan-out within one group.
//
// A full page enqueues its successor (skipDedup — mandatory, see the start
// handler); a short page flips the broadcast `sending` → `sent`.
//
// Delivery problems never throw (inbox/email are best-effort and log on their
// own); only a database fault throws, which the queue retries — resuming from
// the last committed cursor. A permanently failed chunk flips the broadcast to
// `failed` via BroadcastFailureListener; resume continues from the cursor.
//
// SERVER-ONLY by omission (no node-result pair).
// =============================================================================

@Injectable()
export class BroadcastChunkHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = BROADCAST_CHUNK_TYPE;
  private readonly logger = new Logger(BroadcastChunkHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: EnrichmentJobService,
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly delivery: BroadcastDeliveryService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  canDelete(job: EnrichmentJob): Promise<string | null> {
    return broadcastJobDeleteRefusal(this.prisma, job);
  }

  async process(job: EnrichmentJob): Promise<void> {
    const broadcastId = broadcastIdOf(job.payload);
    if (!broadcastId) {
      this.logger.warn(`broadcast_chunk job ${job.id} carries no broadcastId; nothing to do`);
      return;
    }

    const broadcast = await this.prisma.notificationBroadcast.findUnique({ where: { id: broadcastId } });
    if (!broadcast) {
      this.logger.log(`Broadcast ${broadcastId} no longer exists; chunk job ${job.id} is a no-op`);
      return;
    }
    if (broadcast.status !== 'sending') {
      this.logger.log(`Broadcast ${broadcastId} is '${broadcast.status}'; chunk job ${job.id} sent nothing`);
      return;
    }
    if (!broadcast.audienceCutoff) {
      this.logger.error(`Broadcast ${broadcastId} is 'sending' with no audienceCutoff; refusing to page`);
      return;
    }

    const users: BroadcastRecipient[] = await this.prisma.user.findMany({
      where: {
        ...audienceWhere(broadcast.audienceCutoff),
        ...(broadcast.cursorUserId ? { id: { gt: broadcast.cursorUserId } } : {}),
      },
      select: { id: true, email: true },
      orderBy: { id: 'asc' },
      take: BROADCAST_CHUNK_SIZE,
    });

    let cursor = broadcast.cursorUserId;
    let delivered = 0;
    let emailFailures = 0;

    for (let offset = 0; offset < users.length; offset += BROADCAST_STATUS_RECHECK_INTERVAL) {
      if (offset > 0 && !(await this.stillSending(broadcastId))) {
        this.logger.log(`Broadcast ${broadcastId} stopped mid-chunk after ${delivered} recipient(s)`);
        return;
      }

      const group = users.slice(offset, offset + BROADCAST_STATUS_RECHECK_INTERVAL);
      emailFailures += await this.deliverGroup(broadcast, group);

      const next = group[group.length - 1].id;
      const committed = await this.prisma.notificationBroadcast.updateMany({
        where: { id: broadcastId, status: 'sending', cursorUserId: cursor },
        data: { cursorUserId: next, processedCount: { increment: group.length } },
      });
      if (committed.count === 0) {
        this.logger.warn(
          `Broadcast ${broadcastId}: cursor moved or status changed under chunk job ${job.id}; ` +
            `this chain stops here (no successor queued)`,
        );
        return;
      }
      cursor = next;
      delivered += group.length;
    }

    if (emailFailures > 0) {
      this.logger.warn(`Broadcast ${broadcastId}: ${emailFailures} email(s) failed in chunk job ${job.id}`);
    }

    if (users.length < BROADCAST_CHUNK_SIZE) {
      await this.finish(broadcastId, job.id);
      return;
    }

    const nextJob = await this.jobs.enqueue({
      type: BROADCAST_CHUNK_TYPE,
      mediaItemId: null,
      circleId: null,
      reason: JobReason.backfill,
      priority: BROADCAST_JOB_PRIORITY,
      payload: { broadcastId },
      skipDedup: true,
    });
    this.logger.log(
      `Broadcast ${broadcastId}: chunk job ${job.id} delivered ${delivered}; next chunk job ${nextJob.id}`,
    );
  }

  /** Deliver a group with bounded concurrency; returns the email failure count. */
  private async deliverGroup(
    broadcast: Parameters<BroadcastDeliveryService['deliver']>[0],
    group: BroadcastRecipient[],
  ): Promise<number> {
    let next = 0;
    let failures = 0;
    const worker = async (): Promise<void> => {
      while (next < group.length) {
        const recipient = group[next++];
        const result = await this.delivery.deliver(broadcast, recipient);
        if (result.email && !result.email.success && result.email.error !== 'email_disabled') {
          failures += 1;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(BROADCAST_SEND_CONCURRENCY, group.length) }, () => worker()),
    );
    return failures;
  }

  private async stillSending(broadcastId: string): Promise<boolean> {
    const row = await this.prisma.notificationBroadcast.findUnique({
      where: { id: broadcastId },
      select: { status: true },
    });
    return row?.status === 'sending';
  }

  private async finish(broadcastId: string, jobId: string): Promise<void> {
    const done = await this.prisma.notificationBroadcast.updateMany({
      where: { id: broadcastId, status: 'sending' },
      data: { status: 'sent', finishedAt: new Date() },
    });
    this.logger.log(
      done.count > 0
        ? `Broadcast ${broadcastId} finished sending (chunk job ${jobId})`
        : `Broadcast ${broadcastId} was no longer 'sending' at finish; left alone`,
    );
  }
}
