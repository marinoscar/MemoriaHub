import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CircleRole,
  JobReason,
  Prisma,
  TrashEmptyRun,
  TrashEmptyRunItemStatus,
  TrashEmptyRunStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CircleMembershipService } from '../../circles/circle-membership.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { MediaThumbnailService } from '../media-thumbnail.service';

/** Statuses counted against the per-circle concurrency guard (in-flight runs). */
const ACTIVE_RUN_STATUSES: TrashEmptyRunStatus[] = [
  TrashEmptyRunStatus.evaluating,
  TrashEmptyRunStatus.running,
];

/** Terminal run statuses (no further transition). */
const TERMINAL_RUN_STATUSES: TrashEmptyRunStatus[] = [
  TrashEmptyRunStatus.completed,
  TrashEmptyRunStatus.completed_with_errors,
  TrashEmptyRunStatus.failed,
  TrashEmptyRunStatus.cancelled,
];

/**
 * Number of matched items per `trash_empty_execute_batch` job. A small local
 * constant rather than a system setting — empty-trash has no user-tunable knob
 * and 200 mirrors the workflow `batchSize` default that the execute-batch
 * pattern was copied from.
 */
const BATCH_SIZE = 200;

/**
 * Empty-Trash at scale — run lifecycle service (issue #165).
 *
 * A strict simplification of the Media Workflow Automation run pattern: no
 * conditions, no action list, no approval gate. Every trashed media item in one
 * circle is hard-deleted asynchronously through the enrichment queue via a run
 * record (evaluate → chunked execute-batch jobs → race-safe finalize).
 *
 * Owns run creation (→ evaluating + enqueues trash_empty_evaluate), the shared
 * batch fan-out (enqueueExecuteBatches, called by the evaluate handler), reads,
 * and cancellation. Circle authorization is enforced here (circle_admin to
 * start/cancel, viewer to read); the queue handlers never re-authorize.
 */
@Injectable()
export class TrashEmptyRunService {
  private readonly logger = new Logger(TrashEmptyRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembership: CircleMembershipService,
    private readonly enrichmentJobs: EnrichmentJobService,
    private readonly thumbnails: MediaThumbnailService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start an empty-trash run for a circle. Requires circle_admin (same authority
   * as the old synchronous emptyTrash). Rejects with 409 if a run is already
   * in-flight for the circle.
   */
  async createRun(circleId: string, userId: string, perms: string[]) {
    await this.circleMembership.assertCircleAccess(
      userId,
      circleId,
      perms,
      CircleRole.circle_admin,
    );

    // Per-circle concurrency guard (served by the (circle_id, status) index).
    const active = await this.prisma.trashEmptyRun.count({
      where: { circleId, status: { in: ACTIVE_RUN_STATUSES } },
    });
    if (active >= 1) {
      throw new ConflictException(
        'A trash-empty run is already in progress for this circle',
      );
    }

    const run = await this.prisma.trashEmptyRun.create({
      data: {
        circleId,
        status: TrashEmptyRunStatus.evaluating,
        startedById: userId,
      },
    });

    await this.enrichmentJobs.enqueue({
      type: 'trash_empty_evaluate',
      mediaItemId: null,
      circleId,
      reason: JobReason.rerun,
      priority: 20,
      skipDedup: true,
      payload: { runId: run.id },
    });

    this.logger.log({
      event: 'trash_empty_run.started',
      runId: run.id,
      circleId,
      actorUserId: userId,
    });
    await this.audit(userId, 'trash_empty_run:started', run.id, { circleId });

    return this.serializeRun(run);
  }

  /**
   * Cancel a non-terminal run (circle_admin). The execute handler's cooperative
   * cancellation check stops further deletes; items already purged stay purged.
   */
  async cancelRun(runId: string, userId: string, perms: string[]) {
    const run = await this.prisma.trashEmptyRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Trash-empty run ${runId} not found`);

    await this.circleMembership.assertCircleAccess(
      userId,
      run.circleId,
      perms,
      CircleRole.circle_admin,
    );

    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      throw new BadRequestException('Run already finished');
    }

    await this.prisma.trashEmptyRun.update({
      where: { id: run.id },
      data: { status: TrashEmptyRunStatus.cancelled, finishedAt: new Date() },
    });

    this.logger.log({
      event: 'trash_empty_run.cancelled',
      runId: run.id,
      circleId: run.circleId,
      actorUserId: userId,
    });
    await this.audit(userId, 'trash_empty_run:cancelled', run.id, {});

    return { runId: run.id, status: TrashEmptyRunStatus.cancelled };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Run detail incl. counters + per-item status tally (circle viewer). */
  async getRunDetail(runId: string, userId: string, perms: string[]) {
    const run = await this.prisma.trashEmptyRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Trash-empty run ${runId} not found`);

    await this.circleMembership.assertCircleAccess(
      userId,
      run.circleId,
      perms,
      CircleRole.viewer,
    );

    const statusGroups = await this.prisma.trashEmptyRunItem.groupBy({
      by: ['status'],
      where: { runId },
      _count: { _all: true },
    });
    const itemStatusCounts: Record<string, number> = {};
    for (const g of statusGroups) itemStatusCounts[g.status] = g._count._all;

    return { ...this.serializeRun(run), itemStatusCounts };
  }

  /** Paginated run items with batched signed thumbnails (circle viewer). */
  async listRunItems(
    runId: string,
    query: { status?: TrashEmptyRunItemStatus; page: number; pageSize: number },
    userId: string,
    perms: string[],
  ) {
    const run = await this.prisma.trashEmptyRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Trash-empty run ${runId} not found`);

    await this.circleMembership.assertCircleAccess(
      userId,
      run.circleId,
      perms,
      CircleRole.viewer,
    );

    const { page, pageSize, status } = query;
    const where: Prisma.TrashEmptyRunItemWhereInput = {
      runId,
      ...(status ? { status } : {}),
    };

    const [items, totalItems] = await this.prisma.$transaction([
      this.prisma.trashEmptyRunItem.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          mediaItemId: true,
          status: true,
          error: true,
          updatedAt: true,
        },
      }),
      this.prisma.trashEmptyRunItem.count({ where }),
    ]);

    // Batched thumbnail signing for the page's media items. Items already purged
    // (their MediaItem row is gone) resolve to a null thumbnail — expected, since
    // a successful purge cascade-deletes the run-item row anyway.
    const mediaRows = await this.prisma.mediaItem.findMany({
      where: { id: { in: items.map((i) => i.mediaItemId) } },
      select: {
        id: true,
        type: true,
        capturedAt: true,
        originalFilename: true,
        width: true,
        height: true,
        metadata: true,
      },
    });
    const signed = await this.thumbnails.attachThumbnailUrls(mediaRows);
    const byId = new Map(signed.map((m) => [m.id, m]));

    const rows = items.map((i) => {
      const m = byId.get(i.mediaItemId);
      return {
        id: i.id,
        mediaItemId: i.mediaItemId,
        status: i.status,
        error: i.error,
        updatedAt: i.updatedAt,
        media: m
          ? {
              type: m.type,
              capturedAt: m.capturedAt,
              filename: m.originalFilename,
              width: m.width,
              height: m.height,
            }
          : null,
        thumbnailUrl: m ? m.thumbnailUrl : null,
      };
    });

    return {
      items: rows,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Shared batch fan-out (used by the evaluate handler)
  // ---------------------------------------------------------------------------

  /**
   * Enqueue one `trash_empty_execute_batch` job per chunk of still-'matched'
   * item mediaItemIds, sized by BATCH_SIZE. Kept on the service (mirroring the
   * workflow precedent) so the evaluate handler and any future caller share one
   * batching implementation.
   */
  async enqueueExecuteBatches(runId: string, circleId: string): Promise<void> {
    const items = await this.prisma.trashEmptyRunItem.findMany({
      where: { runId, status: TrashEmptyRunItemStatus.matched },
      select: { mediaItemId: true },
    });
    const ids = items.map((i) => i.mediaItemId);

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE);
      await this.enrichmentJobs.enqueue({
        type: 'trash_empty_execute_batch',
        mediaItemId: null,
        circleId,
        reason: JobReason.rerun,
        priority: 100,
        skipDedup: true,
        payload: { runId, itemIds: chunk },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Serialize a run row for API responses (counters included). */
  serializeRun(run: TrashEmptyRun) {
    return {
      id: run.id,
      circleId: run.circleId,
      status: run.status,
      matchedCount: run.matchedCount,
      processedCount: run.processedCount,
      succeededCount: run.succeededCount,
      failedCount: run.failedCount,
      skippedCount: run.skippedCount,
      startedById: run.startedById,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      lastError: run.lastError,
    };
  }

  private async audit(
    actorUserId: string,
    action: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent
      .create({
        data: {
          actorUserId,
          action,
          targetType: 'trash_empty_run',
          targetId,
          meta: meta as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
  }
}
