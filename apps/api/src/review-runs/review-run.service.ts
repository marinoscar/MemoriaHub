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
  ReviewRun,
  ReviewRunAction,
  ReviewRunItemStatus,
  ReviewRunStatus,
  ReviewRunSubject,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ReviewRunSubjectRegistry } from './review-run-subject.registry';
import { ReviewRunSubjectColumn } from './review-run-subject.strategy';

/** Statuses counted against the per-(circle, subjectType) concurrency guard. */
export const ACTIVE_RUN_STATUSES: ReviewRunStatus[] = [
  ReviewRunStatus.evaluating,
  ReviewRunStatus.running,
];

/** Terminal run statuses (no further transition). */
export const TERMINAL_RUN_STATUSES: ReviewRunStatus[] = [
  ReviewRunStatus.completed,
  ReviewRunStatus.completed_with_errors,
  ReviewRunStatus.failed,
  ReviewRunStatus.cancelled,
];

/**
 * Number of matched subjects per `review_run_execute_batch` job. A small local
 * constant (mirrors the trash-empty / location-suggestion precedent, whose
 * BATCH_SIZE in turn mirrors the workflow `batchSize` default).
 */
export const BATCH_SIZE = 200;

/** Minimal shape of a `review_run_items` row carrying all three arc columns. */
interface SubjectColumnRow {
  burstGroupId: string | null;
  duplicateGroupId: string | null;
  locationSuggestionId: string | null;
}

/** Read the populated exclusive-arc column for a strategy's subject type. */
export function subjectIdOf(
  row: SubjectColumnRow,
  column: ReviewRunSubjectColumn,
): string | null {
  return row[column];
}

/**
 * Shared bulk review-queue run lifecycle service (issue #190).
 *
 * One async run model behind every bulk review action: burst
 * resolve/dismiss-by-threshold, duplicate resolve/dismiss-by-threshold, and
 * location-suggestion bulk accept/reject. Generalizes the evaluate -> chunked
 * execute-batch -> progress-polling -> cancel model already proven by
 * WorkflowRun / TrashEmptyRun / LocationSuggestionRun (the last of which this
 * service absorbs outright).
 *
 * AUTHORIZATION LIVES ONLY HERE — collaborator to start/cancel, viewer to read,
 * plus `media:delete` additionally required when the action is `resolve_trash`.
 * The queue handlers never re-authorize; they run under the authority
 * snapshotted at run creation.
 *
 * The concurrency guard is per `(circleId, subjectType)`, not per circle: a
 * burst run and a location-accept run may be in flight simultaneously, but two
 * burst runs may not (409).
 */
@Injectable()
export class ReviewRunService {
  private readonly logger = new Logger(ReviewRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembership: CircleMembershipService,
    private readonly enrichmentJobs: EnrichmentJobService,
    private readonly thumbnails: MediaThumbnailService,
    private readonly registry: ReviewRunSubjectRegistry,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start a bulk review run for one queue in a circle. Requires per-circle
   * collaborator (the same authority as the equivalent single-subject action),
   * plus `media:delete` when the action trashes media. Rejects with 409 when a
   * run for the SAME queue is already in flight for the circle.
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

    const strategy = this.registry.get(subjectType);
    if (!strategy) {
      throw new BadRequestException(`Unknown review-run subject type: ${subjectType}`);
    }
    if (!strategy.supportedActions.includes(action)) {
      throw new BadRequestException(
        `Action ${action} is not supported for review subject ${subjectType}`,
      );
    }

    await this.circleMembership.assertCircleAccess(
      userId,
      circleId,
      perms,
      CircleRole.collaborator,
    );

    // Trashing media is a strictly higher authority than archiving/dismissing —
    // the same gate the per-group resolve endpoints apply.
    if (action === ReviewRunAction.resolve_trash && !perms.includes(PERMISSIONS.MEDIA_DELETE)) {
      throw new BadRequestException('media:delete permission is required to trash review items');
    }

    // Per-(circle, subjectType) concurrency guard, served by the
    // (circle_id, subject_type, status) index.
    const active = await this.prisma.reviewRun.count({
      where: { circleId, subjectType, status: { in: ACTIVE_RUN_STATUSES } },
    });
    if (active >= 1) {
      throw new ConflictException(
        `A ${subjectType} review run is already in progress for this circle`,
      );
    }

    const run = await this.prisma.reviewRun.create({
      data: {
        circleId,
        subjectType,
        action,
        threshold,
        status: ReviewRunStatus.evaluating,
        startedById: userId,
      },
    });

    await this.enrichmentJobs.enqueue({
      type: 'review_run_evaluate',
      mediaItemId: null,
      circleId,
      reason: JobReason.rerun,
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
    await this.audit(userId, 'review_run:started', run.id, {
      circleId,
      subjectType,
      action,
      threshold,
    });

    return this.serializeRun(run);
  }

  /**
   * Cancel a non-terminal run (collaborator). The execute handler's cooperative
   * cancellation check stops further batches; subjects already resolved stay
   * resolved.
   */
  async cancelRun(runId: string, userId: string, perms: string[]) {
    const run = await this.prisma.reviewRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Review run ${runId} not found`);

    await this.circleMembership.assertCircleAccess(
      userId,
      run.circleId,
      perms,
      CircleRole.collaborator,
    );

    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      throw new BadRequestException('Run already finished');
    }

    await this.prisma.reviewRun.update({
      where: { id: run.id },
      data: { status: ReviewRunStatus.cancelled, finishedAt: new Date() },
    });

    this.logger.log({
      event: 'review_run.cancelled',
      runId: run.id,
      circleId: run.circleId,
      subjectType: run.subjectType,
      actorUserId: userId,
    });
    await this.audit(userId, 'review_run:cancelled', run.id, { subjectType: run.subjectType });

    return { runId: run.id, status: ReviewRunStatus.cancelled };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Run detail incl. counters + per-item status tally (circle viewer). */
  async getRunDetail(runId: string, userId: string, perms: string[]) {
    const run = await this.prisma.reviewRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Review run ${runId} not found`);

    await this.circleMembership.assertCircleAccess(userId, run.circleId, perms, CircleRole.viewer);

    const statusGroups = await this.prisma.reviewRunItem.groupBy({
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
    query: { status?: ReviewRunItemStatus; page: number; pageSize: number },
    userId: string,
    perms: string[],
  ) {
    const run = await this.prisma.reviewRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Review run ${runId} not found`);

    await this.circleMembership.assertCircleAccess(userId, run.circleId, perms, CircleRole.viewer);

    const { page, pageSize, status } = query;
    const where: Prisma.ReviewRunItemWhereInput = {
      runId,
      ...(status ? { status } : {}),
    };

    const [items, totalItems] = await this.prisma.$transaction([
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
    ]);

    const strategy = this.registry.get(run.subjectType);
    const subjectIds = items
      .map((i) => subjectIdOf(i, strategy.subjectColumn))
      .filter((id): id is string => id !== null);

    // Subject -> media projection, then ONE batched StorageObject query for the
    // whole page's thumbnail keys.
    const previews = subjectIds.length > 0 ? await strategy.hydrateItems(subjectIds) : new Map();
    const keyToUrl = await this.thumbnails.signThumbsBatched(
      [...previews.values()]
        .map((p) => this.thumbnails.extractThumbKey(p.metadata ?? null))
        .filter((k): k is string => k !== null),
    );

    // The exclusive arc (three nullable FK columns + CHECK constraints) is a
    // storage-integrity concern; the API flattens it to ONE `subjectId` so
    // clients never branch on which column is populated.
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
   * Enqueue one `review_run_execute_batch` job per chunk of still-'matched' run
   * items, sized by BATCH_SIZE. Kept on the service so the evaluate handler and
   * any future caller share one batching implementation.
   */
  async enqueueExecuteBatches(
    runId: string,
    circleId: string,
    subjectType: ReviewRunSubject,
  ): Promise<void> {
    const strategy = this.registry.get(subjectType);
    const items = await this.prisma.reviewRunItem.findMany({
      where: { runId, status: ReviewRunItemStatus.matched },
      select: { burstGroupId: true, duplicateGroupId: true, locationSuggestionId: true },
    });
    const ids = items
      .map((i) => subjectIdOf(i, strategy.subjectColumn))
      .filter((id): id is string => id !== null);

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE);
      await this.enrichmentJobs.enqueue({
        type: 'review_run_execute_batch',
        mediaItemId: null,
        circleId,
        reason: JobReason.rerun,
        priority: 100,
        skipDedup: true,
        payload: { runId, subjectIds: chunk },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Serialize a run row for API responses (counters included). */
  serializeRun(run: ReviewRun) {
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
          targetType: 'review_run',
          targetId,
          meta: meta as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
  }
}
