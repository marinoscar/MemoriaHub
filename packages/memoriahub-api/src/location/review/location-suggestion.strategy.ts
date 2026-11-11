import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { MEMORIAHUB_JOBS, MEMORIAHUB_PRISMA, type MemoriahubJobsPort } from '../../ports/index.js';
import {
  ReviewRunSubjectRegistry,
  type ReviewRunCursor,
  type ReviewRunEvaluatePage,
  type ReviewRunExecutionContext,
  type ReviewRunRow,
  type ReviewRunSubjectPreview,
  type ReviewRunSubjectStrategy,
} from '../../review-runs/index.js';
import type { LocationDb } from '../data/location-db.js';
import { enqueueGeocodeJob } from '../geo/enqueue-geocode.js';

/** The `LocationSuggestionStatus` values the strategy reads and writes. */
const SUGGESTION_STATUS = { pending: 'pending', accepted: 'accepted', rejected: 'rejected' } as const;

/** Keyset cursor for the (createdAt DESC, id DESC) scan. */
interface LocationCursor extends ReviewRunCursor {
  createdAt: Date;
  id: string;
}

/**
 * Location-suggestion review queue strategy (issue #190).
 *
 * Carries forward the accept/reject transaction body that used to live inside
 * `LocationSuggestionRunExecuteBatchHandler`, unchanged in behaviour:
 *   - accept → write takenLat/takenLng + coordSource='inferred' on the media
 *     item, mark the suggestion accepted, and enqueue a dedup-safe `geocode`
 *     job AFTER the transaction commits (deferred here rather than inline, so a
 *     rolled-back coord write can never leave an orphaned geocode job behind)
 *   - reject → mark the suggestion rejected; no coord write, no geocode job
 *
 * Unlike the burst/duplicate queues, `LocationSuggestion.confidence` is a
 * NON-nullable Float, so there are no NULL rows to exclude from the threshold
 * filter in either direction.
 */
/**
 * The location-suggestion review strategy.
 *
 * @stability experimental
 */
@Injectable()
export class LocationSuggestionReviewStrategy implements ReviewRunSubjectStrategy, OnModuleInit {
  /** The review queue this strategy serves. */
  readonly subject = 'location_suggestion' as const;

  /** The `review_run_items` column the subject ids live in. */
  readonly subjectColumn = 'locationSuggestionId' as const;

  /** Bulk accept and reject. */
  readonly supportedActions = ['accept', 'reject'] as const;

  private readonly logger = new Logger(LocationSuggestionReviewStrategy.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: LocationDb,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    private readonly registry: ReviewRunSubjectRegistry,
  ) {}

  /** Registers the strategy with the review-run engine. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  // ---------------------------------------------------------------------------
  // Evaluate
  // ---------------------------------------------------------------------------

  /**
   * One keyset page of pending suggestions on the side of the threshold the run's action names.
   *
   * @param run - the run.
   * @param cursor - the previous page's cursor.
   * @param pageSize - the page size.
   */
  async evaluatePage(
    run: ReviewRunRow,
    cursor: ReviewRunCursor | null,
    pageSize: number,
  ): Promise<ReviewRunEvaluatePage> {
    // The confidence filter partitions the pending queue at the threshold by
    // action: an ACCEPT run matches suggestions AT/ABOVE the floor (accept the
    // high-confidence ones), a REJECT run matches those BELOW it (reject the
    // low-confidence noise).
    const floor = run.threshold / 100;
    const confidence: Record<string, number> = run.action === 'accept' ? { gte: floor } : { lt: floor };

    const baseWhere: Record<string, unknown> = {
      circleId: run.circleId,
      status: SUGGESTION_STATUS.pending,
      confidence,
    };
    const c = cursor as LocationCursor | null;
    const where: Record<string, unknown> = c
      ? { AND: [baseWhere, buildAfterCursor(c)] }
      : baseWhere;

    const rows = (await this.prisma.locationSuggestion.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pageSize,
      select: { id: true, createdAt: true },
    })) as Array<{ id: string; createdAt: Date }>;

    if (rows.length === 0) return { subjectIds: [], nextCursor: null };

    const last = rows[rows.length - 1];
    return {
      subjectIds: rows.map((r) => r.id),
      nextCursor: { createdAt: last.createdAt, id: last.id },
    };
  }

  // ---------------------------------------------------------------------------
  // Execute
  // ---------------------------------------------------------------------------

  /**
   * Accepts or rejects one suggestion; skips one resolved by hand since evaluation.
   *
   * @param run - the run.
   * @param suggestionId - the suggestion.
   * @param ctx - the batch accumulator (accepted items queue a geocode).
   */
  async executeItem(
    run: ReviewRunRow,
    suggestionId: string,
    ctx: ReviewRunExecutionContext,
  ): Promise<'applied' | 'skipped'> {
    const suggestion = await this.prisma.locationSuggestion.findUnique({
      where: { id: suggestionId },
      select: { id: true, mediaItemId: true, circleId: true, lat: true, lng: true, status: true },
    });

    // Someone resolved this suggestion individually since evaluation, or it
    // vanished → skip (don't clobber a manual decision).
    if (!suggestion || suggestion.status !== SUGGESTION_STATUS.pending) return 'skipped';

    if (run.action === 'accept') {
      await this.prisma.$transaction([
        this.prisma.mediaItem.update({
          where: { id: suggestion.mediaItemId },
          data: {
            takenLat: suggestion.lat,
            takenLng: suggestion.lng,
            coordSource: 'inferred',
          },
        }),
        this.prisma.locationSuggestion.update({
          where: { id: suggestion.id },
          data: {
            status: SUGGESTION_STATUS.accepted,
            resolvedById: run.startedById,
            resolvedAt: new Date(),
          },
        }),
      ]);
      ctx.geocode.push({
        mediaItemId: suggestion.mediaItemId,
        circleId: suggestion.circleId,
      });
      return 'applied';
    }

    // reject — no coord write, no geocode job.
    await this.prisma.locationSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: SUGGESTION_STATUS.rejected,
        resolvedById: run.startedById,
        resolvedAt: new Date(),
      },
    });
    return 'applied';
  }

  /**
   * Enqueue geocode jobs for accepted items after all transactions committed.
   * Dedup-safe default (no skipDedup) — collapses with any pending geocode for
   * the same item.
   */
  async deferredEffects(_run: ReviewRunRow, ctx: ReviewRunExecutionContext): Promise<void> {
    for (const g of ctx.geocode) {
      await enqueueGeocodeJob(
        this.jobs,
        this.prisma,
        { mediaItemId: g.mediaItemId, circleId: g.circleId, reason: 'backfill', priority: 100 },
        this.logger,
      )
        .catch((err) =>
          this.logger.warn(
            `geocode enqueue failed for media item ${g.mediaItemId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
    }
  }

  // ---------------------------------------------------------------------------
  // Hydrate
  // ---------------------------------------------------------------------------

  /**
   * Resolves suggestion ids to the media items they are about, for run-item listings.
   *
   * @param suggestionIds - the suggestions of one page.
   */
  async hydrateItems(suggestionIds: string[]): Promise<Map<string, ReviewRunSubjectPreview>> {
    const suggestions = (await this.prisma.locationSuggestion.findMany({
      where: { id: { in: suggestionIds } },
      select: {
        id: true,
        mediaItemId: true,
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
    })) as Array<{ id: string; mediaItemId: string; mediaItem: any }>;

    const out = new Map<string, ReviewRunSubjectPreview>();
    for (const s of suggestions) {
      const m = s.mediaItem;
      out.set(s.id, {
        mediaItemId: s.mediaItemId,
        type: m?.type ?? null,
        capturedAt: m?.capturedAt ?? null,
        filename: m?.originalFilename ?? null,
        width: m?.width ?? null,
        height: m?.height ?? null,
        metadata: m?.metadata ?? null,
      });
    }
    return out;
  }
}

/**
 * Keyset "strictly after cursor" predicate for the (createdAt DESC, id DESC)
 * ordering. createdAt is non-null (@default(now)), so this is a plain
 * lexicographic descent with no NULLS-LAST branch.
 */
function buildAfterCursor(cursor: LocationCursor): Record<string, unknown> {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] },
    ],
  };
}
