import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';

import { DuplicateDetectionService } from '../dedup/index.js';
import { MEDIA_PERMISSIONS as PERMISSIONS, MediaThumbnailService, enqueueEnrichmentJob } from '../media/index.js';
import { isFeatureEnabled } from '../core/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubAccessPort,
  type MemoriahubJobsPort,
  type MemoriahubSettingsPort,
} from '../ports/index.js';
import { ReviewRunService } from '../review-runs/index.js';
import { BURST_OBSERVER, type BurstObserver } from './burst-observer.js';
import type {
  BulkDismissBurstThresholdDto,
  BulkResolveBurstDto,
  BulkResolveBurstThresholdDto,
  BurstQueryDto,
  ResolveBurstDto,
} from './burst.dto.js';
import type { BurstDb } from './data/burst-db.js';

/** A member of a burst group as the detail read selects it (the hash is never selected: BigInt-unsafe). */
interface BurstMemberRow {
  id: string;
  capturedAt: Date | null;
  burstScore: number | null;
  sharpnessScore: number | null;
  width: number | null;
  height: number | null;
  metadata: unknown;
}

/** A burst group as the review list selects it. */
interface BurstListRow {
  id: string;
  circleId: string;
  status: string;
  mediaCount: number;
  capturedAt: Date | null;
  confidence: number | null;
  suggestedBestItemId: string | null;
  createdAt: Date;
  suggestedBestItem: { metadata: unknown } | null;
  items: Array<{ id: string; metadata: unknown }>;
}

const BurstGroupStatus = { pending: 'pending', resolved: 'resolved', dismissed: 'dismissed' } as const;
const MediaType = { photo: 'photo' } as const;

/**
 * BurstService: the burst review queue (list, detail, resolve, dismiss, bulk and threshold runs) and the
 * admin backfill. Its resolve and dismiss primitives are public because the review-run strategy wraps them.
 *
 * @stability experimental
 */
@Injectable()
export class BurstService {
  private readonly logger = new Logger(BurstService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: BurstDb,
    // Owner access (RETRO-K1): the first, unchanged check of every route.
    @Inject(MEMORIAHUB_ACCESS) private readonly membership: MemoriahubAccessPort,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly mediaThumbnailService: MediaThumbnailService,
    private readonly duplicateDetectionService: DuplicateDetectionService,
    // The review-run engine (RETRO-J9): these threshold endpoints start runs; the registered burst strategy
    // wraps this service's resolve/dismiss primitives.
    private readonly reviewRuns: ReviewRunService,
    // Webhooks (RETRO-H4, #603). Optional so unit tests that build the service by hand need no stub.
    @Optional() @Inject(BURST_OBSERVER) private readonly observer?: BurstObserver,
  ) {}

  /**
   * Re-enqueue duplicate_detection (priority 10, reason rerun) for a set of
   * media items after a burst group is resolved or dismissed — surviving /
   * ungrouped items were previously excluded from dedup matching while their
   * burst group was pending. Best-effort: gated by the duplicateDetection
   * feature flag, never throws (a dedup re-enqueue failure must not fail the
   * burst resolve/dismiss action).
   *
   * Public so the shared review-run engine can DEFER it: a bulk run passes
   * `{ deferDuplicateDetection: true }` to the resolve/dismiss primitives below
   * and calls this once per batch with the union of affected items, instead of
   * once per group (issue #190).
   */
  async reenqueueDuplicateDetection(circleId: string, mediaItemIds: string[]): Promise<void> {
    if (mediaItemIds.length === 0) return;
    try {
      const dedupOn = await isFeatureEnabled(this.settings, 'duplicateDetection');
      if (!dedupOn) return;

      for (const mediaItemId of mediaItemIds) {
        await enqueueEnrichmentJob(this.jobs, {
          type: 'duplicate_detection',
          mediaItemId,
          circleId,
          reason: 'rerun',
          priority: 10,
        });
      }
    } catch (err) {
      this.logger.warn(
        `Failed to re-enqueue duplicate_detection after burst resolution: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async getBurstMinGroupSize(): Promise<number> {
    const { value: burstConfig } = await this.settings.readSystem<{ minGroupSize?: number } | undefined>('burst');
    return burstConfig?.minGroupSize ?? 3;
  }

  // ---------------------------------------------------------------------------
  // List burst groups
  // ---------------------------------------------------------------------------

  /** Lists a circle's burst groups for the review queue (viewer). */
  async listBurstGroups(query: BurstQueryDto, userId: string, perms: string[]) {
    const { circleId, status, page, pageSize } = query;
    // Service specs construct this DTO from a bare object literal (bypassing the
    // Zod pipe), so the schema defaults may not have been applied at runtime.
    const by = query.sortBy ?? 'capturedAt';
    const dir = query.sortOrder ?? 'asc';

    await this.membership.requireOwnerRole(userId, circleId, perms, 'viewer');

    const minGroupSize = await this.getBurstMinGroupSize();
    const skip = (page - 1) * pageSize;

    const where = {
      circleId,
      status,
      mediaCount: { gte: minGroupSize },
    };

    // Secondary ordering for the non-default sorts: fall back to today's
    // chronological order, then id for determinism.
    const tail = [
      { capturedAt: { sort: 'asc', nulls: 'last' } },
      { id: 'asc' },
    ];

    // `capturedAt`/`confidence` are nullable (object form OK); `mediaCount` is
    // non-null (plain direction only). The default path (capturedAt/asc) yields
    // NULLS LAST, which is already Postgres's default for ASC — so the omitted
    // -params ordering is unchanged.
    const orderBy: Array<Record<string, unknown>> =
      by === 'confidence'
        ? [{ confidence: { sort: dir, nulls: 'last' } }, ...tail]
        : by === 'mediaCount'
          ? [{ mediaCount: dir }, ...tail]
          : [{ capturedAt: { sort: dir, nulls: 'last' } }, { id: dir }];

    const [groupRows, total] = await Promise.all([
      this.prisma.burstGroup.findMany({
        where,
        orderBy,
        skip,
        take: pageSize,
        select: {
          id: true,
          circleId: true,
          status: true,
          mediaCount: true,
          capturedAt: true,
          confidence: true,
          suggestedBestItemId: true,
          createdAt: true,
          suggestedBestItem: {
            select: { metadata: true },
          },
          items: {
            where: { deletedAt: null },
            orderBy: { capturedAt: 'asc' },
            take: 4,
            select: { id: true, metadata: true },
          },
        },
      }),
      this.prisma.burstGroup.count({ where }),
    ]);

    const groups = groupRows as BurstListRow[];

    // Collect all thumbnail keys across every group (member covers +
    // suggested-best) and sign them with a single batched StorageObject query.
    const keys: string[] = [];
    for (const group of groups) {
      for (const item of group.items) {
        const k = this.mediaThumbnailService.extractThumbKey(item.metadata);
        if (k) keys.push(k);
      }
      const sk = group.suggestedBestItem
        ? this.mediaThumbnailService.extractThumbKey(group.suggestedBestItem.metadata)
        : null;
      if (sk) keys.push(sk);
    }
    const keyToUrl = await this.mediaThumbnailService.signThumbsBatched(keys);
    const urlFor = (metadata: unknown): string | null => {
      const k = this.mediaThumbnailService.extractThumbKey(metadata);
      return k ? keyToUrl.get(k) ?? null : null;
    };

    const data = groups.map((group) => {
      const coverThumbnailUrls = group.items
        .map((item: { metadata: unknown }) => urlFor(item.metadata))
        .filter((url): url is string => url !== null);

      const suggestedBestThumbnailUrl = group.suggestedBestItem
        ? urlFor(group.suggestedBestItem.metadata)
        : null;

      return {
        id: group.id,
        circleId: group.circleId,
        status: group.status,
        mediaCount: group.mediaCount,
        capturedAt: group.capturedAt,
        confidence: group.confidence,
        suggestedBestItemId: group.suggestedBestItemId,
        suggestedBestThumbnailUrl,
        coverThumbnailUrls,
        createdAt: group.createdAt,
      };
    });

    return {
      items: data,
      meta: { total, page, pageSize },
    };
  }

  // ---------------------------------------------------------------------------
  // Get single burst group detail
  // ---------------------------------------------------------------------------

  /** One burst group with its members and signed thumbnails (viewer). */
  async getBurstGroup(id: string, userId: string, perms: string[]) {
    const group = await this.prisma.burstGroup.findUnique({
      where: { id },
      select: {
        id: true,
        circleId: true,
        status: true,
        mediaCount: true,
        capturedAt: true,
        confidence: true,
        suggestedBestItemId: true,
        resolvedById: true,
        resolvedAt: true,
        items: {
          where: { deletedAt: null },
          orderBy: { capturedAt: 'asc' },
          select: {
            id: true,
            capturedAt: true,
            burstScore: true,
            sharpnessScore: true,
            width: true,
            height: true,
            metadata: true,
            // perceptualHash is NOT included — BigInt unsafe and not needed by callers
          },
        },
      },
    });

    if (!group) {
      throw new NotFoundException(`Burst group ${id} not found`);
    }

    await this.membership.requireOwnerRole(userId, group.circleId, perms, 'viewer');

    const itemsWithUrls = await this.mediaThumbnailService.attachThumbnailUrls(group.items as BurstMemberRow[]);
    const membersWithUrls = itemsWithUrls.map((item) => ({
      id: item.id,
      capturedAt: item.capturedAt,
      burstScore: item.burstScore,
      sharpnessScore: item.sharpnessScore,
      thumbnailUrl: item.thumbnailUrl,
      width: item.width,
      height: item.height,
      isSuggestedBest: item.id === group.suggestedBestItemId,
    }));

    return {
      data: {
        id: group.id,
        circleId: group.circleId,
        status: group.status,
        mediaCount: group.mediaCount,
        capturedAt: group.capturedAt,
        confidence: group.confidence,
        suggestedBestItemId: group.suggestedBestItemId,
        resolvedById: group.resolvedById,
        resolvedAt: group.resolvedAt,
        members: membersWithUrls,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Resolve burst group
  // ---------------------------------------------------------------------------

  /** Resolves a pending group: keeps the chosen members, archives or trashes the rest (editor; trash needs `media:delete`). */
  async resolveBurstGroup(id: string, dto: ResolveBurstDto, userId: string, perms: string[]) {
    const group = await this.prisma.burstGroup.findUnique({
      where: { id },
      select: {
        id: true,
        circleId: true,
        status: true,
        items: {
          where: { deletedAt: null },
          select: { id: true },
        },
      },
    });

    if (!group) {
      throw new NotFoundException(`Burst group ${id} not found`);
    }

    await this.membership.requireOwnerRole(userId, group.circleId, perms, 'editor');

    if (dto.action === 'trash' && !perms.includes(PERMISSIONS.MEDIA_DELETE)) {
      throw new BadRequestException('media:delete permission is required to trash burst items');
    }

    if (group.status !== BurstGroupStatus.pending) {
      throw new BadRequestException(
        `Burst group ${id} is not in pending status (current: ${group.status})`,
      );
    }

    const groupMemberIds = new Set(group.items.map((i: { id: string }) => i.id));
    const invalidIds = dto.keepIds.filter((k) => !groupMemberIds.has(k));
    if (invalidIds.length > 0) {
      throw new BadRequestException(
        `keepIds contains IDs not belonging to this group: ${invalidIds.join(', ')}`,
      );
    }

    const deleteIds = group.items.map((i: { id: string }) => i.id).filter((id: string) => !dto.keepIds.includes(id));

    await this.resolveOneBurstGroup(group, dto.keepIds, deleteIds, dto.action, userId);

    return {
      data: {
        removed: deleteIds.length,
        kept: dto.keepIds.length,
        action: dto.action,
        groupStatus: 'resolved',
      },
    };
  }

  /**
   * Applies the side-effects of resolving a single burst group. Assumes all
   * inputs are already validated (group is pending, keep/remove IDs belong to
   * the group, trash-permission checked). Each call runs its own transaction so
   * a later failure never rolls back earlier successes in a bulk operation.
   *
   * Public so the shared review-run engine wraps this exact primitive rather
   * than forking it (issue #190). Pass `{ deferDuplicateDetection: true }` to
   * suppress the per-group dedup re-enqueue and batch it at the caller's level.
   */
  async resolveOneBurstGroup(
    group: { id: string; circleId: string },
    keepIds: string[],
    removeIds: string[],
    action: 'archive' | 'trash',
    userId: string,
    opts: { deferDuplicateDetection?: boolean } = {},
  ): Promise<void> {
    await this.prisma.$transaction([
      // Apply the chosen action to all non-kept members: trash (soft-delete via
      // deletedAt) or archive (archivedAt).
      this.prisma.mediaItem.updateMany({
        where: { id: { in: removeIds } },
        data: action === 'trash' ? { deletedAt: new Date() } : { archivedAt: new Date() },
      }),
      // Mark group resolved and record the resolution outcome
      this.prisma.burstGroup.update({
        where: { id: group.id },
        data: {
          status: BurstGroupStatus.resolved,
          resolvedById: userId,
          resolvedAt: new Date(),
          resolutionAction: action,
          keptCount: keepIds.length,
          removedCount: removeIds.length,
        },
      }),
    ]);

    // Webhook `media.item.trashed` (RETRO-H4) once the transaction committed; batched, never throws.
    if (action === 'trash') this.observer?.mediaTrashed(group.circleId, removeIds);

    await this.createAuditEvent(userId, 'burst_group:resolved', group.id, {
      keepIds,
      action,
      removedCount: removeIds.length,
    });

    this.logger.log(
      `Burst group ${group.id} resolved by user ${userId}: kept=${keepIds.length}, ${action}=${removeIds.length}`,
    );

    // Surviving (kept) items were excluded from dedup matching while this
    // burst group was pending — now that it's resolved, let them compete for
    // duplicate matches again.
    if (!opts.deferDuplicateDetection) {
      await this.reenqueueDuplicateDetection(group.circleId, keepIds);
    }
  }

  // ---------------------------------------------------------------------------
  // Bulk resolve burst groups (auto-keep suggestedBest)
  // ---------------------------------------------------------------------------

  /** Resolves up to 100 pending groups, keeping each group's suggested best (editor). */
  async bulkResolveBurstGroups(dto: BulkResolveBurstDto, userId: string, perms: string[]) {
    await this.membership.requireOwnerRole(userId, dto.circleId, perms, 'editor');

    if (dto.action === 'trash' && !perms.includes(PERMISSIONS.MEDIA_DELETE)) {
      throw new BadRequestException('media:delete permission is required to trash burst items');
    }

    const dedupedIds = [...new Set(dto.ids)];

    const groups = await this.prisma.burstGroup.findMany({
      where: { id: { in: dedupedIds } },
      select: {
        id: true,
        circleId: true,
        status: true,
        suggestedBestItemId: true,
        items: {
          where: { deletedAt: null },
          select: { id: true },
        },
      },
    });

    // Cross-circle protection: every requested ID must exist and belong to the
    // caller's circle, or the whole request is rejected.
    if (
      groups.length !== dedupedIds.length ||
      groups.some((g) => g.circleId !== dto.circleId)
    ) {
      throw new BadRequestException(
        'One or more group IDs were not found or belong to a different circle',
      );
    }

    let skipped = 0;
    let errors = 0;
    let resolvedGroups = 0;
    let keptCount = 0;
    let removedCount = 0;

    for (const group of groups) {
      const liveMemberIds = group.items.map((i: { id: string }) => i.id);

      // A group is skipped when it is not pending, has no suggested-best item,
      // or its suggested-best item is no longer a live member.
      if (
        group.status !== BurstGroupStatus.pending ||
        !group.suggestedBestItemId ||
        !liveMemberIds.includes(group.suggestedBestItemId)
      ) {
        skipped++;
        continue;
      }

      const keepIds = [group.suggestedBestItemId];
      const removeIds = liveMemberIds.filter((id: string) => id !== group.suggestedBestItemId);

      try {
        await this.resolveOneBurstGroup(group, keepIds, removeIds, dto.action, userId);
        resolvedGroups++;
        keptCount += keepIds.length;
        removedCount += removeIds.length;
      } catch (err) {
        this.logger.warn(
          `Failed to resolve burst group ${group.id} in bulk operation: ${err instanceof Error ? err.message : String(err)}`,
        );
        errors++;
      }
    }

    return {
      data: {
        resolvedGroups,
        keptCount,
        removedCount,
        action: dto.action,
        skipped,
        errors,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Bulk resolve burst groups by confidence threshold
  // ---------------------------------------------------------------------------

  /**
   * Start an async run that resolves every pending burst group in the circle
   * whose persisted `confidence` (0-1) is at/above `threshold / 100`, keeping
   * each group's suggested-best item and applying the chosen action to the rest.
   *
   * Since issue #190 this is a thin wrapper over the shared review-run engine:
   * the work is materialized into `review_run_items` by a `review_run_evaluate`
   * job and applied by chunked `review_run_execute_batch` jobs, so it is
   * uncapped (the old 500-group MAX_THRESHOLD_RESOLVE is gone), cancellable and
   * resumable across reloads. Authorization — collaborator, plus media:delete
   * for `trash` — is enforced inside ReviewRunService.createRun.
   */
  async bulkResolveBurstGroupsByThreshold(
    dto: BulkResolveBurstThresholdDto,
    userId: string,
    perms: string[],
  ) {
    const run = await this.reviewRuns.createRun({
      circleId: dto.circleId,
      subjectType: 'burst_group',
      action:
        dto.action === 'trash' ? 'resolve_trash' : 'resolve_archive',
      threshold: dto.threshold,
      userId,
      perms,
    });

    return { data: { runId: run.id, status: run.status, matchedCount: run.matchedCount } };
  }

  // ---------------------------------------------------------------------------
  // Dismiss burst group
  // ---------------------------------------------------------------------------

  /** Dismisses a pending group as not a burst: ungroups every member (editor). */
  async dismissBurstGroup(id: string, userId: string, perms: string[]) {
    const group = await this.prisma.burstGroup.findUnique({
      where: { id },
      select: {
        id: true,
        circleId: true,
        status: true,
        items: { select: { id: true } },
      },
    });

    if (!group) {
      throw new NotFoundException(`Burst group ${id} not found`);
    }

    await this.membership.requireOwnerRole(userId, group.circleId, perms, 'editor');

    if (group.status !== BurstGroupStatus.pending) {
      throw new BadRequestException(
        `Burst group ${id} is not in pending status (current: ${group.status})`,
      );
    }

    const memberCount = await this.dismissOneBurstGroup(group, userId);

    return {
      data: {
        groupStatus: 'dismissed',
        ungrouped: memberCount,
      },
    };
  }

  /**
   * Core dismiss primitive shared by the single-group and threshold-bulk paths.
   * Ungroups every member (clears `burstGroupId`/`burstScore`), marks the group
   * `dismissed`, then re-enqueues duplicate detection so the freed members can
   * compete for duplicate matches. Returns the ungrouped member count. Callers
   * are responsible for their own access / pending-status guards.
   *
   * Public so the shared review-run engine wraps this exact primitive rather
   * than forking it (issue #190). Pass `{ deferDuplicateDetection: true }` to
   * suppress the per-group dedup re-enqueue and batch it at the caller's level.
   */
  async dismissOneBurstGroup(
    group: { id: string; circleId: string; items: { id: string }[] },
    userId: string,
    opts: { deferDuplicateDetection?: boolean } = {},
  ): Promise<number> {
    const memberCount = group.items.length;

    await this.prisma.$transaction([
      // Clear burstGroupId and burstScore on all members
      this.prisma.mediaItem.updateMany({
        where: { burstGroupId: group.id },
        data: { burstGroupId: null, burstScore: null },
      }),
      // Mark group dismissed
      this.prisma.burstGroup.update({
        where: { id: group.id },
        data: {
          status: BurstGroupStatus.dismissed,
          resolvedById: userId,
          resolvedAt: new Date(),
        },
      }),
    ]);

    this.logger.log(
      `Burst group ${group.id} dismissed by user ${userId}: ungrouped ${memberCount} items`,
    );

    // All members are ungrouped (none deleted) — let them compete for
    // duplicate matches now that the burst group is no longer pending.
    if (!opts.deferDuplicateDetection) {
      await this.reenqueueDuplicateDetection(
        group.circleId,
        group.items.map((i: { id: string }) => i.id),
      );
    }

    return memberCount;
  }

  /**
   * Start an async run that dismisses every pending burst group in the circle
   * whose persisted `confidence` (0-1) is strictly below `threshold / 100`.
   * Members are ungrouped and the group marked dismissed — nothing is archived
   * or trashed, so dismiss never requires media:delete.
   *
   * Together with the resolve run above, one threshold partitions the pending
   * queue: resolve >= N%, dismiss < N%. Null-confidence legacy groups are
   * excluded from BOTH directions.
   */
  async bulkDismissBurstGroupsByThreshold(
    dto: BulkDismissBurstThresholdDto,
    userId: string,
    perms: string[],
  ) {
    const run = await this.reviewRuns.createRun({
      circleId: dto.circleId,
      subjectType: 'burst_group',
      action: 'dismiss',
      threshold: dto.threshold,
      userId,
      perms,
    });

    return { data: { runId: run.id, status: run.status, matchedCount: run.matchedCount } };
  }

  // ---------------------------------------------------------------------------
  // Backfill burst detection (internal — no membership check, no per-circle opt-in gate)
  // ---------------------------------------------------------------------------

  private async backfillCircleInternal(
    circleId: string,
    opts: { from?: string; to?: string; force?: boolean },
  ): Promise<number> {
    const { force = false, from, to } = opts;

    // Build optional capturedAt range filter from the from/to bounds
    const capturedAtFilter =
      from || to
        ? {
            capturedAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {};

    if (force) {
      // Enqueue all non-deleted photos in the circle (optionally filtered by date range)
      const items = await this.prisma.mediaItem.findMany({
        where: {
          circleId,
          type: MediaType.photo,
          deletedAt: null,
          ...capturedAtFilter,
        },
        select: { id: true },
      });

      let enqueued = 0;
      for (const item of items) {
        await enqueueEnrichmentJob(this.jobs, {
          type: 'burst_detection',
          mediaItemId: item.id,
          circleId,
          reason: 'backfill',
          priority: 100,
        });
        enqueued++;
      }

      this.logger.log(
        `Backfilled burst detection for circle ${circleId}: enqueued ${enqueued} items (force=true${from || to ? `, from=${from ?? '*'}, to=${to ?? '*'}` : ''})`,
      );
      return enqueued;
    } else {
      // Only enqueue items without an existing burstGroupId and without a succeeded burst_detection job
      const succeededJobMediaIds = await this.prisma.job.findMany({
        where: {
          type: 'burst_detection',
          subjectType: 'media_item',
          payload: { path: ['circleId'], equals: circleId },
          status: 'succeeded',
        },
        select: { subjectId: true },
      });
      const excludeIds = new Set(
        succeededJobMediaIds.map((j) => j.subjectId).filter((id): id is string => id !== null),
      );

      const items = await this.prisma.mediaItem.findMany({
        where: {
          circleId,
          type: MediaType.photo,
          deletedAt: null,
          burstGroupId: null,
          id: { notIn: [...excludeIds] },
          ...capturedAtFilter,
        },
        select: { id: true },
      });

      let enqueued = 0;
      for (const item of items) {
        await enqueueEnrichmentJob(this.jobs, {
          type: 'burst_detection',
          mediaItemId: item.id,
          circleId,
          reason: 'backfill',
          priority: 100,
        });
        enqueued++;
      }

      this.logger.log(
        `Backfilled burst detection for circle ${circleId}: enqueued ${enqueued} items (force=false${from || to ? `, from=${from ?? '*'}, to=${to ?? '*'}` : ''})`,
      );
      return enqueued;
    }
  }

  // ---------------------------------------------------------------------------
  // Backfill burst detection across ALL circles (Admin)
  // ---------------------------------------------------------------------------

  /** Queues `burst_detection` for every library, then evicts the photos already double-listed in a duplicate group. */
  async backfillAllCircles(opts: {
    from?: string;
    to?: string;
    force?: boolean;
  }): Promise<{ enqueued: number; circles: number; evictedDuplicateOverlaps: number }> {
    // Every shared library (a platform group) plus every personal library.
    const allCircles = (await this.membership.allScopeIds()).map((id) => ({ id }));

    let totalEnqueued = 0;
    const circleCount = allCircles.length;

    for (const circle of allCircles) {
      const count = await this.backfillCircleInternal(circle.id, opts);
      totalEnqueued += count;
    }

    // One-time remediation: heal photos already double-listed in both the
    // burst and duplicate review queues by evicting them from their duplicate
    // groups (burst wins). App-wide, synchronous, best-effort — a remediation
    // failure must not fail the backfill enqueue.
    let evictedDuplicateOverlaps = 0;
    try {
      const result = await this.duplicateDetectionService.evictExistingBurstOverlaps();
      evictedDuplicateOverlaps = result.evicted;
    } catch (err) {
      this.logger.warn(
        `Failed to evict existing burst/duplicate overlaps during backfill: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.logger.log(
      `Global burst backfill complete: ${totalEnqueued} job(s) enqueued across ${circleCount} circle(s), evicted ${evictedDuplicateOverlaps} duplicate overlap(s)`,
    );

    return { enqueued: totalEnqueued, circles: circleCount, evictedDuplicateOverlaps };
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  private async createAuditEvent(
    actorUserId: string,
    action: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action,
        targetType: 'burst_group',
        targetId,
        meta,
      },
    });
  }
}
