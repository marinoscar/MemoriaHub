import { Injectable, Logger } from '@nestjs/common';
import {
  JobReason,
  LocationSuggestionStatus,
  Prisma,
  ReviewRun,
  ReviewRunAction,
  ReviewRunSubject,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import {
  ReviewRunCursor,
  ReviewRunEvaluatePage,
  ReviewRunExecutionContext,
  ReviewRunSubjectPreview,
  ReviewRunSubjectStrategy,
} from '../review-run-subject.strategy';

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
@Injectable()
export class LocationSuggestionReviewStrategy implements ReviewRunSubjectStrategy {
  readonly subject = ReviewRunSubject.location_suggestion;
  readonly subjectColumn = 'locationSuggestionId' as const;
  readonly supportedActions = [ReviewRunAction.accept, ReviewRunAction.reject] as const;

  private readonly logger = new Logger(LocationSuggestionReviewStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobs: EnrichmentJobService,
  ) {}

  // ---------------------------------------------------------------------------
  // Evaluate
  // ---------------------------------------------------------------------------

  async evaluatePage(
    run: ReviewRun,
    cursor: ReviewRunCursor | null,
    pageSize: number,
  ): Promise<ReviewRunEvaluatePage> {
    // The confidence filter partitions the pending queue at the threshold by
    // action: an ACCEPT run matches suggestions AT/ABOVE the floor (accept the
    // high-confidence ones), a REJECT run matches those BELOW it (reject the
    // low-confidence noise).
    const floor = run.threshold / 100;
    const confidence: Prisma.FloatFilter =
      run.action === ReviewRunAction.accept ? { gte: floor } : { lt: floor };

    const baseWhere: Prisma.LocationSuggestionWhereInput = {
      circleId: run.circleId,
      status: LocationSuggestionStatus.pending,
      confidence,
    };
    const c = cursor as LocationCursor | null;
    const where: Prisma.LocationSuggestionWhereInput = c
      ? { AND: [baseWhere, buildAfterCursor(c)] }
      : baseWhere;

    const rows = await this.prisma.locationSuggestion.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pageSize,
      select: { id: true, createdAt: true },
    });

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

  async executeItem(
    run: ReviewRun,
    suggestionId: string,
    ctx: ReviewRunExecutionContext,
  ): Promise<'applied' | 'skipped'> {
    const suggestion = await this.prisma.locationSuggestion.findUnique({
      where: { id: suggestionId },
      select: { id: true, mediaItemId: true, circleId: true, lat: true, lng: true, status: true },
    });

    // Someone resolved this suggestion individually since evaluation, or it
    // vanished → skip (don't clobber a manual decision).
    if (!suggestion || suggestion.status !== LocationSuggestionStatus.pending) return 'skipped';

    if (run.action === ReviewRunAction.accept) {
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
            status: LocationSuggestionStatus.accepted,
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
        status: LocationSuggestionStatus.rejected,
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
  async deferredEffects(_run: ReviewRun, ctx: ReviewRunExecutionContext): Promise<void> {
    for (const g of ctx.geocode) {
      await this.enrichmentJobs
        .enqueue({
          type: 'geocode',
          mediaItemId: g.mediaItemId,
          circleId: g.circleId,
          reason: JobReason.backfill,
          priority: 100,
        })
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

  async hydrateItems(suggestionIds: string[]): Promise<Map<string, ReviewRunSubjectPreview>> {
    const suggestions = await this.prisma.locationSuggestion.findMany({
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
    });

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
function buildAfterCursor(cursor: LocationCursor): Prisma.LocationSuggestionWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] },
    ],
  };
}
