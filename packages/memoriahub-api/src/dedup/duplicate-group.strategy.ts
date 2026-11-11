import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { MEMORIAHUB_PRISMA } from '../ports/index.js';
import {
  ReviewRunSubjectRegistry,
  type ReviewRunCursor,
  type ReviewRunEvaluatePage,
  type ReviewRunExecutionContext,
  type ReviewRunRow,
  type ReviewRunSubjectPreview,
  type ReviewRunSubjectStrategy,
} from '../review-runs/index.js';
import type { DedupDb } from './data/dedup-db.js';
import { DuplicateService } from './duplicate.service.js';

const DUPLICATE_GROUP_PENDING = 'pending';

/** Keyset cursor for the (capturedAt DESC NULLS LAST, id DESC) scan. */
interface DuplicateCursor extends ReviewRunCursor {
  capturedAt: Date | null;
  id: string;
}

/**
 * Duplicate review queue strategy (issue #190), registered with the review-run engine's
 * `ReviewRunSubjectRegistry` when the module starts.
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
/**
 * The duplicate-group review strategy.
 *
 * @stability experimental
 */
@Injectable()
export class DuplicateGroupReviewStrategy implements ReviewRunSubjectStrategy, OnModuleInit {
  /** The review queue this strategy serves. */
  readonly subject = 'duplicate_group' as const;
  /** The `review_run_items` column the subject ids live in. */
  readonly subjectColumn = 'duplicateGroupId' as const;
  /** Bulk resolve (archive or trash the rest) and dismiss. */
  readonly supportedActions = ['resolve_archive', 'resolve_trash', 'dismiss'] as const;

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: DedupDb,
    private readonly duplicateService: DuplicateService,
    private readonly registry: ReviewRunSubjectRegistry,
  ) {}

  /** Registers the strategy with the review-run engine (the slice knows no review queue). */
  onModuleInit(): void {
    this.registry.register(this);
  }

  // ---------------------------------------------------------------------------
  // Evaluate
  // ---------------------------------------------------------------------------

  /** One keyset page of pending groups on the side of the confidence threshold the run's action names. */
  async evaluatePage(
    run: ReviewRunRow,
    cursor: ReviewRunCursor | null,
    pageSize: number,
  ): Promise<ReviewRunEvaluatePage> {
    // Resolve matches AT/ABOVE the floor, dismiss BELOW it. `not: null` is
    // explicit in BOTH directions: a group whose tightest-pair similarity is
    // genuinely uncomputable (fewer than two members carry an embedding) is
    // never auto-resolved AND never auto-dismissed, matching the pre-run
    // behaviour where a null maxSim was skipped by both paths.
    const floor = run.threshold / 100;
    const confidence: Record<string, unknown> =
      run.action === 'dismiss'
        ? { not: null, lt: floor }
        : { not: null, gte: floor };

    const baseWhere: Record<string, unknown> = {
      circleId: run.circleId,
      status: DUPLICATE_GROUP_PENDING,
      confidence,
    };
    const c = cursor as DuplicateCursor | null;
    const where: Record<string, unknown> = c
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

  /** Resolves or dismisses one group through the review service's primitives; skips one resolved by hand since evaluation. */
  async executeItem(
    run: ReviewRunRow,
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
    if (!group || group.status !== DUPLICATE_GROUP_PENDING) return 'skipped';

    // Nullable only because the starting user may have been deleted; both
    // audit_events.actor_user_id and duplicate_groups.resolved_by_id accept null.
    const actorId = run.startedById as string;

    if (run.action === 'dismiss') {
      await this.duplicateService.dismissOneDuplicateGroup(
        { id: group.id, items: group.items },
        actorId,
      );
      return 'applied';
    }

    const liveMemberIds = group.items.map((i: { id: string }) => i.id);
    if (!group.suggestedBestItemId || !liveMemberIds.includes(group.suggestedBestItemId)) {
      return 'skipped';
    }

    const keepIds = [group.suggestedBestItemId];
    const removeIds = liveMemberIds.filter((id: string) => id !== group.suggestedBestItemId);
    const action = run.action === 'resolve_trash' ? 'trash' : 'archive';

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

  /** The preview of each group: its suggested best, else its earliest member. */
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
function buildAfterCursor(cursor: DuplicateCursor): Record<string, unknown> {
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
