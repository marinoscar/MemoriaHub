import { Inject, Injectable, forwardRef } from '@nestjs/common';
import {
  DuplicateGroupStatus,
  Prisma,
  ReviewRun,
  ReviewRunAction,
  ReviewRunSubject,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DuplicateService } from '../../dedup/duplicate.service';
import {
  ReviewRunCursor,
  ReviewRunEvaluatePage,
  ReviewRunExecutionContext,
  ReviewRunSubjectPreview,
  ReviewRunSubjectStrategy,
} from '../review-run-subject.strategy';

/** Keyset cursor for the (capturedAt DESC NULLS LAST, id DESC) scan. */
interface DuplicateCursor extends ReviewRunCursor {
  capturedAt: Date | null;
  id: string;
}

/**
 * Duplicate review queue strategy (issue #190).
 *
 * Structurally identical to the burst strategy — resolve keeps the group's
 * `suggestedBestItemId` and archives/trashes the rest, dismiss ungroups every
 * member — delegating to `DuplicateService.resolveOneDuplicateGroup` /
 * `dismissOneDuplicateGroup`. No deferred effects: unlike burst resolution,
 * resolving a duplicate group triggers no follow-up enqueues.
 *
 * The eligibility filter is now a real SQL predicate over the PERSISTED
 * `duplicate_groups.confidence` column (see
 * `DuplicateDetectionService.recomputeGroupMeta`), which is what removes the old
 * 500-group cap: the pre-run implementation had to load a bounded candidate set
 * and recompute tightest-pair CLIP similarity per group in application code.
 */
@Injectable()
export class DuplicateGroupReviewStrategy implements ReviewRunSubjectStrategy {
  readonly subject = ReviewRunSubject.duplicate_group;
  readonly subjectColumn = 'duplicateGroupId' as const;
  readonly supportedActions = [
    ReviewRunAction.resolve_archive,
    ReviewRunAction.resolve_trash,
    ReviewRunAction.dismiss,
  ] as const;

  constructor(
    private readonly prisma: PrismaService,
    // Circular by nature: DuplicateService injects ReviewRunService (wrapped in its own
    // forwardRef), and ReviewRunService pulls in this strategy via the subject registry —
    // this is the reverse edge of that same cycle, so it needs forwardRef too.
    @Inject(forwardRef(() => DuplicateService))
    private readonly duplicateService: DuplicateService,
  ) {}

  // ---------------------------------------------------------------------------
  // Evaluate
  // ---------------------------------------------------------------------------

  async evaluatePage(
    run: ReviewRun,
    cursor: ReviewRunCursor | null,
    pageSize: number,
  ): Promise<ReviewRunEvaluatePage> {
    // Resolve matches AT/ABOVE the floor, dismiss BELOW it. `not: null` is
    // explicit in BOTH directions: a group whose tightest-pair similarity is
    // genuinely uncomputable (fewer than two members carry an embedding) is
    // never auto-resolved AND never auto-dismissed, matching the pre-run
    // behaviour where a null maxSim was skipped by both paths.
    const floor = run.threshold / 100;
    const confidence: Prisma.FloatNullableFilter =
      run.action === ReviewRunAction.dismiss
        ? { not: null, lt: floor }
        : { not: null, gte: floor };

    const baseWhere: Prisma.DuplicateGroupWhereInput = {
      circleId: run.circleId,
      status: DuplicateGroupStatus.pending,
      confidence,
    };
    const c = cursor as DuplicateCursor | null;
    const where: Prisma.DuplicateGroupWhereInput = c
      ? { AND: [baseWhere, buildAfterCursor(c)] }
      : baseWhere;

    const rows = await this.prisma.duplicateGroup.findMany({
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
    _ctx: ReviewRunExecutionContext,
  ): Promise<'applied' | 'skipped'> {
    const group = await this.prisma.duplicateGroup.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        circleId: true,
        status: true,
        suggestedBestItemId: true,
        items: {
          where: { deletedAt: null, archivedAt: null },
          select: { id: true },
        },
      },
    });

    // Gone, or already resolved/dismissed by hand since evaluation → skip.
    if (!group || group.status !== DuplicateGroupStatus.pending) return 'skipped';

    // Nullable only because the starting user may have been deleted; both
    // audit_events.actor_user_id and duplicate_groups.resolved_by_id accept null.
    const actorId = run.startedById as string;

    if (run.action === ReviewRunAction.dismiss) {
      await this.duplicateService.dismissOneDuplicateGroup(
        { id: group.id, items: group.items },
        actorId,
      );
      return 'applied';
    }

    const liveMemberIds = group.items.map((i) => i.id);
    if (!group.suggestedBestItemId || !liveMemberIds.includes(group.suggestedBestItemId)) {
      return 'skipped';
    }

    const keepIds = [group.suggestedBestItemId];
    const removeIds = liveMemberIds.filter((id) => id !== group.suggestedBestItemId);
    const action = run.action === ReviewRunAction.resolve_trash ? 'trash' : 'archive';

    await this.duplicateService.resolveOneDuplicateGroup(
      group,
      keepIds,
      removeIds,
      action,
      actorId,
    );
    return 'applied';
  }

  // ---------------------------------------------------------------------------
  // Hydrate
  // ---------------------------------------------------------------------------

  async hydrateItems(groupIds: string[]): Promise<Map<string, ReviewRunSubjectPreview>> {
    const groups = await this.prisma.duplicateGroup.findMany({
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
 * id DESC) ordering.
 */
function buildAfterCursor(cursor: DuplicateCursor): Prisma.DuplicateGroupWhereInput {
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
