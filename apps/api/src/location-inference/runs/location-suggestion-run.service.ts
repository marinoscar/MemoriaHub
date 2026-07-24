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
  LocationSuggestionRun,
  LocationSuggestionRunAction,
  LocationSuggestionRunItemStatus,
  LocationSuggestionRunStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CircleMembershipService } from '../../circles/circle-membership.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { MediaThumbnailService } from '../../media/media-thumbnail.service';

/** Statuses counted against the per-circle concurrency guard (in-flight runs). */
const ACTIVE_RUN_STATUSES: LocationSuggestionRunStatus[] = [
  LocationSuggestionRunStatus.evaluating,
  LocationSuggestionRunStatus.running,
];

/** Terminal run statuses (no further transition). */
const TERMINAL_RUN_STATUSES: LocationSuggestionRunStatus[] = [
  LocationSuggestionRunStatus.completed,
  LocationSuggestionRunStatus.completed_with_errors,
  LocationSuggestionRunStatus.failed,
  LocationSuggestionRunStatus.cancelled,
];

/**
 * Number of matched suggestions per `location_suggestion_run_execute_batch` job.
 * A small local constant (mirrors the trash-empty precedent, whose BATCH_SIZE in
 * turn mirrors the workflow `batchSize` default).
 */
const BATCH_SIZE = 200;

/**
 * Location-suggestion bulk accept/reject — run lifecycle service.
 *
 * Mirrors TrashEmptyRunService: an async, run-based bulk resolve engine for the
 * Location Inference review queue. The snapshotted confidence threshold
 * partitions the pending queue by action: an accept run accepts every pending
 * LocationSuggestion AT/ABOVE the threshold (coords written,
 * coordSource='inferred', geocode job enqueued), while a reject run rejects
 * every pending LocationSuggestion BELOW the threshold — driven through the
 * enrichment queue via a run record (evaluate → chunked execute-batch jobs →
 * race-safe finalize) instead of a single synchronous O(N) request.
 *
 * Circle authorization is enforced here (collaborator to start/cancel — matching
 * the per-item accept/reject/bulk-accept authority — viewer to read); the queue
 * handlers never re-authorize.
 */
@Injectable()
export class LocationSuggestionRunService {
  private readonly logger = new Logger(LocationSuggestionRunService.name);

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
   * Start a bulk accept/reject run for a circle. Requires collaborator (same
   * authority as the per-item accept/reject and the old synchronous bulk-accept).
   * Rejects with 409 if a run is already in-flight for the circle.
   */
  async createRun(
    circleId: string,
    action: LocationSuggestionRunAction,
    threshold: number,
    userId: string,
    perms: string[],
  ) {
    await this.circleMembership.assertCircleAccess(
      userId,
      circleId,
      perms,
      CircleRole.collaborator,
    );

    // Per-circle concurrency guard (served by the (circle_id, status) index).
    const active = await this.prisma.locationSuggestionRun.count({
      where: { circleId, status: { in: ACTIVE_RUN_STATUSES } },
    });
    if (active >= 1) {
      throw new ConflictException(
        'A location-suggestion run is already in progress for this circle',
      );
    }

    const run = await this.prisma.locationSuggestionRun.create({
      data: {
        circleId,
        action,
        threshold,
        status: LocationSuggestionRunStatus.evaluating,
        startedById: userId,
      },
    });

    await this.enrichmentJobs.enqueue({
      type: 'location_suggestion_run_evaluate',
      mediaItemId: null,
      circleId,
      reason: JobReason.rerun,
      priority: 20,
      skipDedup: true,
      payload: { runId: run.id },
    });

    this.logger.log({
      event: 'location_suggestion_run.started',
      runId: run.id,
      circleId,
      action,
      threshold,
      actorUserId: userId,
    });
    await this.audit(userId, 'location_suggestion_run:started', run.id, {
      circleId,
      action,
      threshold,
    });

    return this.serializeRun(run);
  }

  /**
   * Cancel a non-terminal run (collaborator). The execute handler's cooperative
   * cancellation check stops further batches; suggestions already resolved stay
   * resolved.
   */
  async cancelRun(runId: string, userId: string, perms: string[]) {
    const run = await this.prisma.locationSuggestionRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Location-suggestion run ${runId} not found`);

    await this.circleMembership.assertCircleAccess(
      userId,
      run.circleId,
      perms,
      CircleRole.collaborator,
    );

    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      throw new BadRequestException('Run already finished');
    }

    await this.prisma.locationSuggestionRun.update({
      where: { id: run.id },
      data: { status: LocationSuggestionRunStatus.cancelled, finishedAt: new Date() },
    });

    this.logger.log({
      event: 'location_suggestion_run.cancelled',
      runId: run.id,
      circleId: run.circleId,
      actorUserId: userId,
    });
    await this.audit(userId, 'location_suggestion_run:cancelled', run.id, {});

    return { runId: run.id, status: LocationSuggestionRunStatus.cancelled };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Run detail incl. counters + per-item status tally (circle viewer). */
  async getRunDetail(runId: string, userId: string, perms: string[]) {
    const run = await this.prisma.locationSuggestionRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Location-suggestion run ${runId} not found`);

    await this.circleMembership.assertCircleAccess(
      userId,
      run.circleId,
      perms,
      CircleRole.viewer,
    );

    const statusGroups = await this.prisma.locationSuggestionRunItem.groupBy({
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
    query: { status?: LocationSuggestionRunItemStatus; page: number; pageSize: number },
    userId: string,
    perms: string[],
  ) {
    const run = await this.prisma.locationSuggestionRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Location-suggestion run ${runId} not found`);

    await this.circleMembership.assertCircleAccess(
      userId,
      run.circleId,
      perms,
      CircleRole.viewer,
    );

    const { page, pageSize, status } = query;
    const where: Prisma.LocationSuggestionRunItemWhereInput = {
      runId,
      ...(status ? { status } : {}),
    };

    const [items, totalItems] = await this.prisma.$transaction([
      this.prisma.locationSuggestionRunItem.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          suggestionId: true,
          status: true,
          error: true,
          updatedAt: true,
          // Resolve the media item THROUGH the suggestion (run-item has no
          // mediaItemId column — its subject is the suggestion).
          suggestion: {
            select: {
              mediaItemId: true,
              lat: true,
              lng: true,
              confidence: true,
              mediaItem: {
                select: {
                  id: true,
                  type: true,
                  capturedAt: true,
                  originalFilename: true,
                  width: true,
                  height: true,
                  metadata: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.locationSuggestionRunItem.count({ where }),
    ]);

    // Batched thumbnail signing for the page's media items — one StorageObject
    // query for the whole page.
    const keyToUrl = await this.thumbnails.signThumbsBatched(
      items
        .map((i) =>
          this.thumbnails.extractThumbKey(i.suggestion?.mediaItem?.metadata ?? null),
        )
        .filter((k): k is string => k !== null),
    );

    const rows = items.map((i) => {
      const m = i.suggestion?.mediaItem ?? null;
      const key = this.thumbnails.extractThumbKey(m?.metadata ?? null);
      return {
        id: i.id,
        suggestionId: i.suggestionId,
        mediaItemId: i.suggestion?.mediaItemId ?? null,
        status: i.status,
        error: i.error,
        updatedAt: i.updatedAt,
        lat: i.suggestion?.lat ?? null,
        lng: i.suggestion?.lng ?? null,
        confidence: i.suggestion?.confidence ?? null,
        media: m
          ? {
              type: m.type,
              capturedAt: m.capturedAt,
              filename: m.originalFilename,
              width: m.width,
              height: m.height,
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
   * Enqueue one `location_suggestion_run_execute_batch` job per chunk of
   * still-'matched' run items (by suggestionId), sized by BATCH_SIZE. Kept on
   * the service so the evaluate handler and any future caller share one batching
   * implementation.
   */
  async enqueueExecuteBatches(runId: string, circleId: string): Promise<void> {
    const items = await this.prisma.locationSuggestionRunItem.findMany({
      where: { runId, status: LocationSuggestionRunItemStatus.matched },
      select: { suggestionId: true },
    });
    const ids = items.map((i) => i.suggestionId);

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE);
      await this.enrichmentJobs.enqueue({
        type: 'location_suggestion_run_execute_batch',
        mediaItemId: null,
        circleId,
        reason: JobReason.rerun,
        priority: 100,
        skipDedup: true,
        payload: { runId, suggestionIds: chunk },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Serialize a run row for API responses (counters included). */
  serializeRun(run: LocationSuggestionRun) {
    return {
      id: run.id,
      circleId: run.circleId,
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
          targetType: 'location_suggestion_run',
          targetId,
          meta: meta as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
  }
}
