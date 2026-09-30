import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JobReason, NotificationBroadcast, Prisma } from '@prisma/client';

import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BroadcastDeliveryService } from './broadcast-delivery.service';
import {
  BROADCAST_CHUNK_TYPE,
  BROADCAST_JOB_PRIORITY,
  BROADCAST_START_TYPE,
  BroadcastChannel,
  audienceWhere,
  broadcastNotificationType,
} from './broadcast-constants';
import type { BroadcastListQuery } from './dto/broadcast-list-query.dto';
import type {
  BroadcastListResponse,
  BroadcastResponse,
  BroadcastTestResult,
} from './dto/broadcast-response.dto';
import type { CreateBroadcastInput } from './dto/create-broadcast.dto';

// =============================================================================
// BroadcastsService — everything /api/admin/broadcasts decides (#488)
// =============================================================================
//
// Writes a row and enqueues a job; the two job handlers deliver. The one
// direct send is `sendTest`, which delivers ONLY to the caller through the
// SAME BroadcastDeliveryService the fan-out uses.
//
// RULES:
//   1. The notification type is DERIVED from `critical`, never accepted.
//   2. A job is enqueued AFTER its row write has committed, outside any
//      $transaction — a worker must never claim a job whose row it cannot see.
//   3. Cancel/resume are CONDITIONAL writes (status in the WHERE), so they race
//      the handlers' compare-and-swaps in the database where exactly one wins.
// =============================================================================

const AUDIT_TARGET_TYPE = 'notification_broadcast';
const CANCELABLE_STATUSES = ['scheduled', 'sending', 'failed'] as const;
const MAX_RESUME_ERROR_LENGTH = 500;

const USER_SUMMARY = { select: { id: true, email: true, displayName: true } } as const;
const WITH_USERS = { createdBy: USER_SUMMARY, canceledBy: USER_SUMMARY } as const;

type BroadcastWithUsers = Prisma.NotificationBroadcastGetPayload<{ include: typeof WITH_USERS }>;

@Injectable()
export class BroadcastsService {
  private readonly logger = new Logger(BroadcastsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: EnrichmentJobService,
    private readonly delivery: BroadcastDeliveryService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Users a broadcast created now would reach — the same predicate the fan-out pages with. */
  async audience(): Promise<{ activeUsers: number }> {
    return { activeUsers: await this.prisma.user.count({ where: audienceWhere(new Date()) }) };
  }

  async list(query: BroadcastListQuery): Promise<BroadcastListResponse> {
    const { page, pageSize, status } = query;
    const where: Prisma.NotificationBroadcastWhereInput = status ? { status } : {};
    const [rows, totalItems] = await Promise.all([
      this.prisma.notificationBroadcast.findMany({
        where,
        include: WITH_USERS,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notificationBroadcast.count({ where }),
    ]);
    return {
      items: rows.map(toDto),
      meta: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
    };
  }

  async get(id: string): Promise<BroadcastResponse> {
    return toDto(await this.require(id));
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /** Record the broadcast as `scheduled`, then (after commit) queue its start job. */
  async create(dto: CreateBroadcastInput, adminUserId: string): Promise<BroadcastResponse> {
    const row = await this.prisma.notificationBroadcast.create({
      data: {
        title: dto.title,
        body: dto.body,
        link: dto.link ?? null,
        ctaLabel: dto.ctaLabel ?? null,
        critical: dto.critical,
        channels: [...dto.channels],
        status: 'scheduled',
        scheduledFor: dto.scheduledFor ?? null,
        createdById: adminUserId,
      },
      include: WITH_USERS,
    });

    const job = await this.enqueueStart(row.id, dto.scheduledFor);

    await this.audit(adminUserId, 'notification_broadcast.created', row.id, {
      type: broadcastNotificationType(dto.critical),
      channels: dto.channels,
      scheduledFor: dto.scheduledFor?.toISOString() ?? null,
    });
    this.logger.log(
      `Broadcast ${row.id} created by ${adminUserId}; start job ${job.id} ` +
        `${dto.scheduledFor ? `scheduled for ${dto.scheduledFor.toISOString()}` : 'queued now'}`,
    );
    return toDto(row);
  }

  /**
   * Stop a scheduled, sending or failed broadcast. A cancel of a `sending`
   * broadcast takes effect within one status-recheck group (25 recipients);
   * what was already delivered stays delivered. Queued job rows are left
   * alone — the handlers' status checks make them no-ops.
   */
  async cancel(id: string, adminUserId: string): Promise<BroadcastResponse> {
    const res = await this.prisma.notificationBroadcast.updateMany({
      where: { id, status: { in: [...CANCELABLE_STATUSES] } },
      data: { status: 'canceled', canceledAt: new Date(), canceledById: adminUserId },
    });
    if (res.count === 0) {
      const existing = await this.require(id);
      throw new ConflictException(
        `Broadcast ${id} is '${existing.status}' and can no longer be cancelled ` +
          `(only ${CANCELABLE_STATUSES.join(', ')} broadcasts can)`,
      );
    }
    const row = await this.require(id);
    await this.audit(adminUserId, 'notification_broadcast.canceled', id, {
      processedCount: row.processedCount,
    });
    return toDto(row);
  }

  /**
   * Continue a `failed` broadcast. With a frozen audience it flips back to
   * `sending` and queues a chunk that pages from the persisted cursor; if it
   * failed before it was ever claimed (no cutoff) it goes back to `scheduled`
   * and its start job is re-queued. Enqueue failure is compensated back to
   * `failed` so a resume can never strand the broadcast with no job.
   */
  async resume(id: string, adminUserId: string): Promise<BroadcastResponse> {
    const existing = await this.require(id);
    if (existing.status !== 'failed') {
      throw new ConflictException(
        `Broadcast ${id} is '${existing.status}' and cannot be resumed (only failed broadcasts can)`,
      );
    }
    const claimed = existing.audienceCutoff !== null;
    const flipped = await this.prisma.notificationBroadcast.updateMany({
      where: { id, status: 'failed' },
      data: { status: claimed ? 'sending' : 'scheduled', finishedAt: null, lastError: null },
    });
    if (flipped.count === 0) {
      const now = await this.require(id);
      throw new ConflictException(`Broadcast ${id} is '${now.status}' and cannot be resumed`);
    }

    try {
      if (claimed) {
        await this.jobs.enqueue({
          type: BROADCAST_CHUNK_TYPE,
          mediaItemId: null,
          circleId: null,
          reason: JobReason.rerun,
          priority: BROADCAST_JOB_PRIORITY,
          payload: { broadcastId: id },
          skipDedup: true,
        });
      } else {
        await this.enqueueStart(id, undefined, JobReason.rerun);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.prisma.notificationBroadcast.updateMany({
        where: { id, status: claimed ? 'sending' : 'scheduled' },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          lastError: `Resume could not queue a job: ${reason.slice(0, MAX_RESUME_ERROR_LENGTH)}`,
        },
      });
      throw err;
    }

    const row = await this.require(id);
    await this.audit(adminUserId, 'notification_broadcast.resumed', id, {
      processedCount: row.processedCount,
    });
    return toDto(row);
  }

  /** Delete the record. Refused while `sending` — cancel first. */
  async remove(id: string, adminUserId: string): Promise<void> {
    const row = await this.require(id);
    if (row.status === 'sending') {
      throw new ConflictException(`Broadcast ${id} is currently sending and cannot be deleted; cancel it first`);
    }
    await this.prisma.notificationBroadcast.delete({ where: { id } });
    await this.audit(adminUserId, 'notification_broadcast.deleted', id, { status: row.status });
  }

  /**
   * Deliver the composition to the CALLER only — no row, no job. The
   * recipient is never a parameter (that would be a spam relay).
   */
  async sendTest(dto: CreateBroadcastInput, adminUserId: string): Promise<BroadcastTestResult> {
    const me = await this.prisma.user.findUnique({
      where: { id: adminUserId },
      select: { id: true, email: true },
    });
    if (!me) throw new NotFoundException('Caller not found');

    const result = await this.delivery.deliver(
      {
        id: null,
        title: dto.title,
        body: dto.body,
        link: dto.link ?? null,
        ctaLabel: dto.ctaLabel ?? null,
        critical: dto.critical,
        channels: dto.channels,
      },
      me,
    );

    await this.audit(adminUserId, 'notification_broadcast.test_sent', adminUserId, {
      type: broadcastNotificationType(dto.critical),
      channels: dto.channels,
    });

    return {
      notificationType: broadcastNotificationType(dto.critical),
      channels: [...dto.channels],
      sentToUserId: me.id,
      email: result.email
        ? { success: result.email.success, error: result.email.error ?? null }
        : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private enqueueStart(broadcastId: string, scheduledFor?: Date, reason: JobReason = JobReason.backfill) {
    return this.jobs.enqueue({
      type: BROADCAST_START_TYPE,
      mediaItemId: null,
      circleId: null,
      reason,
      priority: BROADCAST_JOB_PRIORITY,
      payload: { broadcastId },
      // Global-job dedup keys on (type, mediaItemId IS NULL): without this a
      // second broadcast's start would be swallowed by the first's. The start
      // handler's compare-and-swap is the per-broadcast duplicate gate.
      skipDedup: true,
      ...(scheduledFor ? { scheduledFor } : {}),
    });
  }

  private async require(id: string): Promise<BroadcastWithUsers> {
    const row = await this.prisma.notificationBroadcast.findUnique({ where: { id }, include: WITH_USERS });
    if (!row) throw new NotFoundException(`Broadcast ${id} not found`);
    return row;
  }

  /**
   * One audit_events row per mutation. `meta` carries identifiers and shape,
   * NEVER the composed title/body — that lives only on the broadcast row.
   */
  private async audit(actorUserId: string, action: string, targetId: string, meta: Record<string, unknown>) {
    await this.prisma.auditEvent.create({
      data: { actorUserId, action, targetType: AUDIT_TARGET_TYPE, targetId, meta: meta as Prisma.InputJsonValue },
    });
  }
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export function toDto(row: NotificationBroadcast & Partial<Pick<BroadcastWithUsers, 'createdBy' | 'canceledBy'>>): BroadcastResponse {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    link: row.link,
    ctaLabel: row.ctaLabel,
    critical: row.critical,
    channels: row.channels as BroadcastChannel[],
    status: row.status,
    scheduledFor: iso(row.scheduledFor),
    audienceCutoff: iso(row.audienceCutoff),
    recipientCount: row.recipientCount,
    processedCount: row.processedCount,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    lastError: row.lastError,
    canceledAt: iso(row.canceledAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy ?? null,
    canceledBy: row.canceledBy ?? null,
  };
}
