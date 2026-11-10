import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_METRICS,
  MEMORIAHUB_PRISMA,
  type MemoriahubAccessPort,
  type MemoriahubJobsPort,
  type MemoriahubMetricsPort,
} from '../../ports/index.js';
import type { MediaDb } from '../data/media-db.js';
import { MediaThumbnailService } from '../thumbnails/media-thumbnail.service.js';
import {
  TRASH_EMPTY_ITEM_STATUS,
  TRASH_EMPTY_RUN_STATUS,
  type TrashEmptyRunItemStatus,
  type TrashEmptyRunRow,
  type TrashEmptyRunStatus,
} from './trash-empty.constants.js';

/** Statuses counted against the per-circle concurrency guard (in-flight runs). */
const ACTIVE_RUN_STATUSES: TrashEmptyRunStatus[] = [
  TRASH_EMPTY_RUN_STATUS.evaluating,
  TRASH_EMPTY_RUN_STATUS.running,
];

/** Terminal run statuses (no further transition). */
const TERMINAL_RUN_STATUSES: TrashEmptyRunStatus[] = [
  TRASH_EMPTY_RUN_STATUS.completed,
  TRASH_EMPTY_RUN_STATUS.completed_with_errors,
  TRASH_EMPTY_RUN_STATUS.failed,
  TRASH_EMPTY_RUN_STATUS.cancelled,
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
/**
 * Starts, cancels and reads empty-trash runs, and fans a run out into execute-batch jobs.
 *
 * @stability experimental
 */
@Injectable()
/**
 * Trash empty run service.
 *
 * @stability experimental
 */
export class TrashEmptyRunService {
  private readonly logger = new Logger(TrashEmptyRunService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: MediaDb,
    @Inject(MEMORIAHUB_ACCESS) private readonly circleMembership: MemoriahubAccessPort,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    private readonly thumbnails: MediaThumbnailService,
    // App metrics (RETRO-T3, #628): `app.runs.finished{engine=trash_empty,outcome=cancelled}`. Optional for hand-built tests.
    @Optional() @Inject(MEMORIAHUB_METRICS) private readonly metrics?: MemoriahubMetricsPort,
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
    await this.circleMembership.requireOwnerRole(
      userId,
      circleId,
      perms,
      'admin',
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

    const run = (await this.prisma.trashEmptyRun.create({
      data: {
        circleId,
        status: TRASH_EMPTY_RUN_STATUS.evaluating,
        startedById: userId,
      },
    })) as TrashEmptyRunRow;

    await this.jobs.enqueue({
      type: 'trash_empty_evaluate',
      reason: 'rerun',
      subjectType: 'circle',
      subjectId: circleId,
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
    const run = (await this.prisma.trashEmptyRun.findUnique({ where: { id: runId } })) as TrashEmptyRunRow | null;
    if (!run) throw new NotFoundException(`Trash-empty run ${runId} not found`);

    await this.circleMembership.requireOwnerRole(
      userId,
      run.circleId,
      perms,
      'admin',
    );

    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      throw new BadRequestException('Run already finished');
    }

    await this.prisma.trashEmptyRun.update({
      where: { id: run.id },
      data: { status: TRASH_EMPTY_RUN_STATUS.cancelled, finishedAt: new Date() },
    });
    this.metrics?.add('runsFinished', 1, { engine: 'trash_empty', outcome: 'cancelled' });

    this.logger.log({
      event: 'trash_empty_run.cancelled',
      runId: run.id,
      circleId: run.circleId,
      actorUserId: userId,
    });
    await this.audit(userId, 'trash_empty_run:cancelled', run.id, {});

    return { runId: run.id, status: TRASH_EMPTY_RUN_STATUS.cancelled };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Run detail incl. counters + per-item status tally (circle viewer). */
  async getRunDetail(runId: string, userId: string, perms: string[]) {
    const run = (await this.prisma.trashEmptyRun.findUnique({ where: { id: runId } })) as TrashEmptyRunRow | null;
    if (!run) throw new NotFoundException(`Trash-empty run ${runId} not found`);

    await this.circleMembership.requireOwnerRole(
      userId,
      run.circleId,
      perms,
      'viewer',
    );

    const statusGroups = await this.prisma.trashEmptyRunItem.groupBy({
      by: ['status'],
      where: { runId },
      _count: { _all: true },
    });
    const itemStatusCounts: Record<string, number> = {};
    for (const g of statusGroups) itemStatusCounts[g.status as string] = g._count._all;

    return { ...this.serializeRun(run), itemStatusCounts };
  }

  /** Paginated run items with batched signed thumbnails (circle viewer). */
  async listRunItems(
    runId: string,
    query: { status?: TrashEmptyRunItemStatus; page: number; pageSize: number },
    userId: string,
    perms: string[],
  ) {
    const run = (await this.prisma.trashEmptyRun.findUnique({ where: { id: runId } })) as TrashEmptyRunRow | null;
    if (!run) throw new NotFoundException(`Trash-empty run ${runId} not found`);

    await this.circleMembership.requireOwnerRole(
      userId,
      run.circleId,
      perms,
      'viewer',
    );

    const { page, pageSize, status } = query;
    const where: Record<string, unknown> = {
      runId,
      ...(status ? { status } : {}),
    };

    const [items, totalItems] = (await this.prisma.$transaction(async (tx: MediaDb) => [
      await tx.trashEmptyRunItem.findMany({
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
      await tx.trashEmptyRunItem.count({ where }),
    ])) as [Array<{ id: string; mediaItemId: string; status: TrashEmptyRunItemStatus; error: string | null; updatedAt: Date }>, number];

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
      where: { runId, status: TRASH_EMPTY_ITEM_STATUS.matched },
      select: { mediaItemId: true },
    });
    const ids = items.map((i) => i.mediaItemId);

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE);
      await this.jobs.enqueue({
        type: 'trash_empty_execute_batch',
        reason: 'rerun',
        subjectType: 'circle',
        subjectId: circleId,
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
  serializeRun(run: TrashEmptyRunRow) {
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
          meta,
        },
      })
      .catch(() => undefined);
  }
}
