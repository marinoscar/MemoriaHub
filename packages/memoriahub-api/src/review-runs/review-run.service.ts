import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { ReviewRunAction, ReviewRunSubject } from '@marinoscar/memoriahub-contract/review-runs';

import { MEDIA_PERMISSIONS, MediaThumbnailService, enqueueEnrichmentJob } from '../media/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_METRICS,
  MEMORIAHUB_PRISMA,
  type MemoriahubAccessPort,
  type MemoriahubJobsPort,
  type MemoriahubMetricsPort,
} from '../ports/index.js';
import type { ReviewRunsDb } from './data/review-runs-db.js';
import { ReviewRunSubjectRegistry } from './review-run-subject.registry.js';
import type { ReviewRunSubjectColumn } from './review-run-subject.strategy.js';
import {
  REVIEW_RUN_ITEM_STATUS,
  REVIEW_RUN_STATUS,
  type ReviewRunItemStatus,
  type ReviewRunRow,
  type ReviewRunStatus,
} from './review-runs.constants.js';

/**
 * Statuses counted against the per-(circle, subjectType) concurrency guard.
 *
 * @stability experimental
 */
export const ACTIVE_RUN_STATUSES: ReviewRunStatus[] = [REVIEW_RUN_STATUS.evaluating, REVIEW_RUN_STATUS.running];

/**
 * Terminal run statuses (no further transition).
 *
 * @stability experimental
 */
export const TERMINAL_RUN_STATUSES: ReviewRunStatus[] = [
  REVIEW_RUN_STATUS.completed,
  REVIEW_RUN_STATUS.completed_with_errors,
  REVIEW_RUN_STATUS.failed,
  REVIEW_RUN_STATUS.cancelled,
];

/**
 * Number of matched subjects per `review_run_execute_batch` job. A small local constant (mirrors the
 * trash-empty precedent, whose BATCH_SIZE in turn mirrors the workflow `batchSize` default).
 *
 * @stability experimental
 */
export const BATCH_SIZE = 200;

/**
 * Minimal shape of a `review_run_items` row carrying all three arc columns.
 *
 * @stability experimental
 */
export interface SubjectColumnRow {
  burstGroupId: string | null;
  duplicateGroupId: string | null;
  locationSuggestionId: string | null;
}

/**
 * Reads the populated exclusive-arc column for a strategy's subject type.
 *
 * @param row - a run item row.
 * @param column - the strategy's column.
 * @stability experimental
 */
export function subjectIdOf(row: SubjectColumnRow, column: ReviewRunSubjectColumn): string | null {
  return row[column];
}

/**
 * Shared bulk review-queue run lifecycle service (issue #190).
 *
 * One async run model behind every bulk review action: burst resolve/dismiss-by-threshold, duplicate
 * resolve/dismiss-by-threshold, and location-suggestion bulk accept/reject. It generalizes the evaluate,
 * chunked execute-batch, progress-polling, cancel model proven by `WorkflowRun` and `TrashEmptyRun`.
 *
 * AUTHORIZATION LIVES ONLY HERE: collaborator to start/cancel, viewer to read, plus `media:delete`
 * additionally required when the action is `resolve_trash`. The queue handlers never re-authorize; they run
 * under the authority snapshotted at run creation.
 *
 * The concurrency guard is per `(circleId, subjectType)`, not per circle: a burst run and a
 * location-accept run may be in flight simultaneously, but two burst runs may not (409).
 *
 * @stability experimental
 */
@Injectable()
export class ReviewRunService {
  private readonly logger = new Logger(ReviewRunService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: ReviewRunsDb,
    @Inject(MEMORIAHUB_ACCESS) private readonly circleMembership: MemoriahubAccessPort,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    private readonly thumbnails: MediaThumbnailService,
    private readonly registry: ReviewRunSubjectRegistry,
    // App metrics (RETRO-T3, #628): `app.runs.finished{engine=review,outcome=cancelled}`. Optional for hand-built tests.
    @Optional() @Inject(MEMORIAHUB_METRICS) private readonly metrics?: MemoriahubMetricsPort,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Starts a bulk review run for one queue in a circle. Requires per-circle collaborator (the same
   * authority as the equivalent single-subject action), plus `media:delete` when the action trashes media.
   * Rejects with 409 when a run for the SAME queue is already in flight for the circle.
   *
   * @param input - the run to start.
   */
  async createRun(input: {
    circleId: string;
    subjectType: ReviewRunSubject;
    action: ReviewRunAction;
    threshold: number;
    userId: string;
    perms: string[];
  }) {
    const { circleId, subjectType, action, threshold, userId, perms } = input;

    const strategy = this.registry.find(subjectType);
    if (!strategy) {
      throw new BadRequestException(`Unknown review-run subject type: ${subjectType}`);
    }
    if (!strategy.supportedActions.includes(action)) {
      throw new BadRequestException(`Action ${action} is not supported for review subject ${subjectType}`);
    }

    await this.circleMembership.requireOwnerRole(userId, circleId, perms, 'editor');

    // Trashing media is a strictly higher authority than archiving/dismissing: the same gate the per-group
    // resolve endpoints apply.
    if (action === 'resolve_trash' && !perms.includes(MEDIA_PERMISSIONS.MEDIA_DELETE)) {
      throw new BadRequestException('media:delete permission is required to trash review items');
    }

    // Per-(circle, subjectType) concurrency guard, served by the (circle_id, subject_type, status) index.
    const active = await this.prisma.reviewRun.count({
      where: { circleId, subjectType, status: { in: ACTIVE_RUN_STATUSES } },
    });
    if (active >= 1) {
      throw new ConflictException(`A ${subjectType} review run is already in progress for this circle`);
    }

    const run = (await this.prisma.reviewRun.create({
      data: {
        circleId,
        subjectType,
        action,
        threshold,
        status: REVIEW_RUN_STATUS.evaluating,
        startedById: userId,
      },
    })) as ReviewRunRow;

    await enqueueEnrichmentJob(this.jobs, {
      type: 'review_run_evaluate',
      circleId,
      reason: 'rerun',
      priority: 20,
      skipDedup: true,
      payload: { runId: run.id },
    });

    this.logger.log({
      event: 'review_run.started',
      runId: run.id,
      circleId,
      subjectType,
      action,
      threshold,
      actorUserId: userId,
    });
    await this.audit(userId, 'review_run:started', run.id, { circleId, subjectType, action, threshold });

    return this.serializeRun(run);
  }

  /**
   * Cancels a non-terminal run (collaborator). The execute handler's cooperative cancellation check stops
   * further batches; subjects already resolved stay resolved.
   *
   * @param runId - the run.
   * @param userId - the caller.
   * @param perms - the caller's permissions.
   */
  async cancelRun(runId: string, userId: string, perms: string[]) {
    const run = (await this.prisma.reviewRun.findUnique({ where: { id: runId } })) as ReviewRunRow | null;
    if (!run) throw new NotFoundException(`Review run ${runId} not found`);

    await this.circleMembership.requireOwnerRole(userId, run.circleId, perms, 'editor');

    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      throw new BadRequestException('Run already finished');
    }

    await this.prisma.reviewRun.update({
      where: { id: run.id },
      data: { status: REVIEW_RUN_STATUS.cancelled, finishedAt: new Date() },
    });
    this.metrics?.add('runsFinished', 1, { engine: 'review', outcome: 'cancelled' });

    this.logger.log({
      event: 'review_run.cancelled',
      runId: run.id,
      circleId: run.circleId,
      subjectType: run.subjectType,
      actorUserId: userId,
    });
    await this.audit(userId, 'review_run:cancelled', run.id, { subjectType: run.subjectType });

    return { runId: run.id, status: REVIEW_RUN_STATUS.cancelled };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * Run detail including counters and the per-item status tally (circle viewer).
   *
   * @param runId - the run.
   * @param userId - the caller.
   * @param perms - the caller's permissions.
   */
  async getRunDetail(runId: string, userId: string, perms: string[]) {
    const run = (await this.prisma.reviewRun.findUnique({ where: { id: runId } })) as ReviewRunRow | null;
    if (!run) throw new NotFoundException(`Review run ${runId} not found`);

    await this.circleMembership.requireOwnerRole(userId, run.circleId, perms, 'viewer');

    const statusGroups = (await this.prisma.reviewRunItem.groupBy({
      by: ['status'],
      where: { runId },
      _count: { _all: true },
    })) as Array<{ status: string; _count: { _all: number } }>;
    const itemStatusCounts: Record<string, number> = {};
    for (const g of statusGroups) itemStatusCounts[g.status] = g._count._all;

    return { ...this.serializeRun(run), itemStatusCounts };
  }

  /**
   * Paginated run items with batched signed thumbnails (circle viewer).
   *
   * @param runId - the run.
   * @param query - status filter and page.
   * @param userId - the caller.
   * @param perms - the caller's permissions.
   */
  async listRunItems(
    runId: string,
    query: { status?: ReviewRunItemStatus; page: number; pageSize: number },
    userId: string,
    perms: string[],
  ) {
    const run = (await this.prisma.reviewRun.findUnique({ where: { id: runId } })) as ReviewRunRow | null;
    if (!run) throw new NotFoundException(`Review run ${runId} not found`);

    await this.circleMembership.requireOwnerRole(userId, run.circleId, perms, 'viewer');

    const { page, pageSize, status } = query;
    const where: Record<string, unknown> = {
      runId,
      ...(status ? { status } : {}),
    };

    const [items, totalItems] = (await this.prisma.$transaction([
      this.prisma.reviewRunItem.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          subjectType: true,
          burstGroupId: true,
          duplicateGroupId: true,
          locationSuggestionId: true,
          status: true,
          error: true,
          updatedAt: true,
        },
      }),
      this.prisma.reviewRunItem.count({ where }),
    ])) as [Array<SubjectColumnRow & { id: string; subjectType: string; status: string; error: string | null; updatedAt: Date }>, number];

    const strategy = this.registry.get(run.subjectType);
    const subjectIds = items
      .map((i) => subjectIdOf(i, strategy.subjectColumn))
      .filter((id): id is string => id !== null);

    // Subject -> media projection, then ONE batched StorageObject query for the whole page's thumbnail keys.
    const previews = subjectIds.length > 0 ? await strategy.hydrateItems(subjectIds) : new Map();
    const keyToUrl = await this.thumbnails.signThumbsBatched(
      [...previews.values()]
        .map((p) => this.thumbnails.extractThumbKey(p.metadata ?? null))
        .filter((k): k is string => k !== null),
    );

    // The exclusive arc (three nullable FK columns + CHECK constraints) is a storage-integrity concern; the
    // API flattens it to ONE `subjectId` so clients never branch on which column is populated.
    const rows = items.map((i) => {
      const subjectId = subjectIdOf(i, strategy.subjectColumn);
      const preview = subjectId ? previews.get(subjectId) ?? null : null;
      const key = preview ? this.thumbnails.extractThumbKey(preview.metadata ?? null) : null;
      return {
        id: i.id,
        subjectId,
        subjectType: i.subjectType,
        status: i.status,
        error: i.error,
        updatedAt: i.updatedAt,
        media: preview
          ? {
              type: preview.type,
              capturedAt: preview.capturedAt,
              filename: preview.filename,
              width: preview.width,
              height: preview.height,
            }
          : null,
        thumbnailUrl: key ? keyToUrl.get(key) ?? null : null,
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
   * Enqueues one `review_run_execute_batch` job per chunk of still-'matched' run items, sized by
   * {@link BATCH_SIZE}. Kept on the service so the evaluate handler and any future caller share one batching
   * implementation.
   *
   * @param runId - the run.
   * @param circleId - the run's circle.
   * @param subjectType - the run's queue.
   */
  async enqueueExecuteBatches(runId: string, circleId: string, subjectType: ReviewRunSubject): Promise<void> {
    const strategy = this.registry.get(subjectType);
    const items = (await this.prisma.reviewRunItem.findMany({
      where: { runId, status: REVIEW_RUN_ITEM_STATUS.matched },
      select: { burstGroupId: true, duplicateGroupId: true, locationSuggestionId: true },
    })) as SubjectColumnRow[];
    const ids = items.map((i) => subjectIdOf(i, strategy.subjectColumn)).filter((id): id is string => id !== null);

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE);
      await enqueueEnrichmentJob(this.jobs, {
        type: 'review_run_execute_batch',
        circleId,
        reason: 'rerun',
        priority: 100,
        skipDedup: true,
        payload: { runId, subjectIds: chunk },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Serializes a run row for API responses (counters included).
   *
   * @param run - the row.
   */
  serializeRun(run: ReviewRunRow) {
    return {
      id: run.id,
      circleId: run.circleId,
      subjectType: run.subjectType,
      action: run.action,
      threshold: run.threshold,
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

  private async audit(actorUserId: string, action: string, targetId: string, meta: Record<string, unknown>): Promise<void> {
    await this.prisma.auditEvent
      .create({
        data: {
          actorUserId,
          action,
          targetType: 'review_run',
          targetId,
          meta,
        },
      })
      .catch(() => undefined);
  }
}
