import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import {
  BurstGroupStatus,
  Prisma,
  ReviewRun,
  ReviewRunAction,
  ReviewRunSubject,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BurstService } from '../../burst/burst.service';
import {
  ReviewRunCursor,
  ReviewRunEvaluatePage,
  ReviewRunExecutionContext,
  ReviewRunSubjectPreview,
  ReviewRunSubjectStrategy,
} from '../review-run-subject.strategy';

/** Keyset cursor for the (capturedAt DESC NULLS LAST, id DESC) scan. */
interface BurstCursor extends ReviewRunCursor {
  capturedAt: Date | null;
  id: string;
}

/**
 * Burst review queue strategy (issue #190).
 *
 * Resolve keeps each group's `suggestedBestItemId` and archives/trashes the
 * rest; dismiss ungroups every member. Both delegate straight to
 * `BurstService.resolveOneBurstGroup` / `dismissOneBurstGroup` — the exact
 * primitives the single-group endpoints use — so bulk and single-group actions
 * can never drift.
 *
 * The dedup re-enqueue those primitives normally fire per group is DEFERRED and
 * batched here: one `deferredEffects` pass per execute-batch job instead of one
 * enqueue loop per group.
 */
@Injectable()
export class BurstGroupReviewStrategy implements ReviewRunSubjectStrategy {
  readonly subject = ReviewRunSubject.burst_group;
  readonly subjectColumn = 'burstGroupId' as const;
  readonly supportedActions = [
    ReviewRunAction.resolve_archive,
    ReviewRunAction.resolve_trash,
    ReviewRunAction.dismiss,
  ] as const;

  private readonly logger = new Logger(BurstGroupReviewStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    // Circular by nature: BurstService injects ReviewRunService (wrapped in its own
    // forwardRef), and ReviewRunService pulls in this strategy via the subject registry —
    // this is the reverse edge of that same cycle, so it needs forwardRef too.
    @Inject(forwardRef(() => BurstService))
    private readonly burstService: BurstService,
  ) {}

  // ---------------------------------------------------------------------------
  // Evaluate
  // ---------------------------------------------------------------------------

  async evaluatePage(
    run: ReviewRun,
    cursor: ReviewRunCursor | null,
    pageSize: number,
  ): Promise<ReviewRunEvaluatePage> {
    // A resolve run matches groups AT/ABOVE the confidence floor (the
    // high-confidence bursts worth collapsing); a dismiss run matches those
    // BELOW it (the noise). `not: null` is explicit in BOTH directions:
    // null-confidence legacy groups are never auto-resolved AND never
    // auto-dismissed, matching the pre-run synchronous behaviour.
    const floor = run.threshold / 100;
    const confidence: Prisma.FloatNullableFilter =
      run.action === ReviewRunAction.dismiss
        ? { not: null, lt: floor }
        : { not: null, gte: floor };

    const baseWhere: Prisma.BurstGroupWhereInput = {
      circleId: run.circleId,
      status: BurstGroupStatus.pending,
      confidence,
    };
    const c = cursor as BurstCursor | null;
    const where: Prisma.BurstGroupWhereInput = c
      ? { AND: [baseWhere, buildAfterCursor(c)] }
      : baseWhere;

    const rows = await this.prisma.burstGroup.findMany({
      where,
      orderBy: [{ capturedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      take: pageSize,
      select: { id: true, capturedAt: true },
    });

    if (rows.length === 0) return { subjectIds: [], nextCursor: null };

    const last = rows[rows.length - 1];
    return {
      subjectIds: rows.map((r) => r.id),
      nextCursor: { capturedAt: last.capturedAt, id: last.id },
    };
  }

  // ---------------------------------------------------------------------------
  // Execute
  // ---------------------------------------------------------------------------

  async executeItem(
    run: ReviewRun,
    groupId: string,
    ctx: ReviewRunExecutionContext,
  ): Promise<'applied' | 'skipped'> {
    const group = await this.prisma.burstGroup.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        circleId: true,
        status: true,
        suggestedBestItemId: true,
        items: { where: { deletedAt: null }, select: { id: true } },
      },
    });

    // Gone, or already resolved/dismissed by hand since evaluation → skip; never
    // clobber a manual decision.
    if (!group || group.status !== BurstGroupStatus.pending) return 'skipped';

    // The run's authority was checked once at creation; `startedById` is
    // nullable only because the starting user may have been deleted since, and
    // both `audit_events.actor_user_id` and `burst_groups.resolved_by_id` are
    // nullable columns, so a null actor is recorded rather than rejected.
    const actorId = run.startedById as string;

    if (run.action === ReviewRunAction.dismiss) {
      await this.burstService.dismissOneBurstGroup(group, actorId, {
        deferDuplicateDetection: true,
      });
      // Every member is ungrouped (none removed) — all of them may re-compete
      // for duplicate matches.
      for (const item of group.items) {
        ctx.reenqueueDuplicateDetection.push({
          mediaItemId: item.id,
          circleId: group.circleId,
        });
      }
      return 'applied';
    }

    const liveMemberIds = group.items.map((i) => i.id);
    // Same skip conditions as the id-based bulk resolve: no suggested-best item,
    // or a suggested-best that is no longer a live member.
    if (!group.suggestedBestItemId || !liveMemberIds.includes(group.suggestedBestItemId)) {
      return 'skipped';
    }

    const keepIds = [group.suggestedBestItemId];
    const removeIds = liveMemberIds.filter((id) => id !== group.suggestedBestItemId);
    const action = run.action === ReviewRunAction.resolve_trash ? 'trash' : 'archive';

    await this.burstService.resolveOneBurstGroup(group, keepIds, removeIds, action, actorId, {
      deferDuplicateDetection: true,
    });

    for (const id of keepIds) {
      ctx.reenqueueDuplicateDetection.push({ mediaItemId: id, circleId: group.circleId });
    }
    return 'applied';
  }

  /**
   * One batched dedup re-enqueue for the whole chunk, fired after every
   * per-group transaction has committed.
   */
  async deferredEffects(run: ReviewRun, ctx: ReviewRunExecutionContext): Promise<void> {
    if (ctx.reenqueueDuplicateDetection.length === 0) return;

    const byCircle = new Map<string, Set<string>>();
    for (const entry of ctx.reenqueueDuplicateDetection) {
      const set = byCircle.get(entry.circleId) ?? new Set<string>();
      set.add(entry.mediaItemId);
      byCircle.set(entry.circleId, set);
    }

    for (const [circleId, ids] of byCircle) {
      await this.burstService
        .reenqueueDuplicateDetection(circleId, [...ids])
        .catch((err) =>
          this.logger.warn(
            `review_run ${run.id}: batched duplicate_detection re-enqueue failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
    }
  }

  // ---------------------------------------------------------------------------
  // Hydrate
  // ---------------------------------------------------------------------------

  async hydrateItems(groupIds: string[]): Promise<Map<string, ReviewRunSubjectPreview>> {
    const groups = await this.prisma.burstGroup.findMany({
      where: { id: { in: groupIds } },
      select: {
        id: true,
        suggestedBestItem: {
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
        items: {
          orderBy: { capturedAt: 'asc' },
          take: 1,
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
    for (const group of groups) {
      // Prefer the suggested-best cover; fall back to the earliest member so a
      // dismissed/ungrouped group still renders something.
      const media = group.suggestedBestItem ?? group.items[0] ?? null;
      out.set(group.id, {
        mediaItemId: media?.id ?? null,
        type: media?.type ?? null,
        capturedAt: media?.capturedAt ?? null,
        filename: media?.originalFilename ?? null,
        width: media?.width ?? null,
        height: media?.height ?? null,
        metadata: media?.metadata ?? null,
      });
    }
    return out;
  }
}

/**
 * Keyset "strictly after cursor" predicate for the (capturedAt DESC NULLS LAST,
 * id DESC) ordering — same shape as the trash-empty / workflow evaluate scans.
 */
function buildAfterCursor(cursor: BurstCursor): Prisma.BurstGroupWhereInput {
  if (cursor.capturedAt === null) {
    return { capturedAt: null, id: { lt: cursor.id } };
  }
  return {
    OR: [
      { capturedAt: { lt: cursor.capturedAt } },
      { AND: [{ capturedAt: cursor.capturedAt }, { id: { lt: cursor.id } }] },
      { capturedAt: null },
    ],
  };
}
