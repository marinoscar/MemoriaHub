import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BurstGroupStatus, CircleRole, JobReason, JobStatus, MediaType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { FEATURE_KEYS } from '../common/types/settings.types';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { DuplicateDetectionService } from '../dedup/duplicate-detection.service';
import { BurstQueryDto } from './dto/burst-query.dto';
import { ResolveBurstDto } from './dto/resolve-burst.dto';
import { BulkResolveBurstDto } from './dto/bulk-resolve-burst.dto';
import { BulkResolveBurstThresholdDto } from './dto/bulk-resolve-burst-threshold.dto';

/** Hard cap on the number of groups a single threshold-based bulk resolve touches. */
const MAX_THRESHOLD_RESOLVE = 500;

@Injectable()
export class BurstService {
  private readonly logger = new Logger(BurstService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: CircleMembershipService,
    private readonly enrichmentJobService: EnrichmentJobService,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
    private readonly resolver: StorageProviderResolver,
    private readonly mediaThumbnailService: MediaThumbnailService,
    private readonly systemSettings: SystemSettingsService,
    private readonly duplicateDetectionService: DuplicateDetectionService,
  ) {}

  /**
   * Re-enqueue duplicate_detection (priority 10, reason rerun) for a set of
   * media items after a burst group is resolved or dismissed — surviving /
   * ungrouped items were previously excluded from dedup matching while their
   * burst group was pending. Best-effort: gated by the duplicateDetection
   * feature flag, never throws (a dedup re-enqueue failure must not fail the
   * burst resolve/dismiss action).
   */
  private async reenqueueDuplicateDetection(circleId: string, mediaItemIds: string[]): Promise<void> {
    if (mediaItemIds.length === 0) return;
    try {
      const dedupOn = await this.systemSettings.isFeatureEnabled(FEATURE_KEYS.DUPLICATE_DETECTION);
      if (!dedupOn) return;

      for (const mediaItemId of mediaItemIds) {
        await this.enrichmentJobService.enqueue({
          type: 'duplicate_detection',
          mediaItemId,
          circleId,
          reason: JobReason.rerun,
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

  /**
   * Single-item thumbnail signing. Delegates to the shared
   * MediaThumbnailService so provider resolution + fallback + error handling
   * live in one place. List paths batch signing via `signThumbsBatched`.
   */
  private async signThumb(metadata: Prisma.JsonValue | null): Promise<string | null> {
    return this.mediaThumbnailService.signThumb(metadata);
  }

  private async getBurstMinGroupSize(): Promise<number> {
    const settings = await this.prisma.systemSettings.findUnique({
      where: { key: 'global' },
      select: { value: true },
    });
    const value = (settings?.value as Record<string, unknown> | null) ?? {};
    const burstConfig = value['burst'] as { minGroupSize?: number } | undefined;
    return burstConfig?.minGroupSize ?? 3;
  }

  // ---------------------------------------------------------------------------
  // List burst groups
  // ---------------------------------------------------------------------------

  async listBurstGroups(query: BurstQueryDto, userId: string, perms: string[]) {
    const { circleId, status, page, pageSize } = query;

    await this.membership.assertCircleAccess(userId, circleId, perms, CircleRole.viewer);

    const minGroupSize = await this.getBurstMinGroupSize();
    const skip = (page - 1) * pageSize;

    const where = {
      circleId,
      status: status as BurstGroupStatus,
      mediaCount: { gte: minGroupSize },
    };

    const [groups, total] = await Promise.all([
      this.prisma.burstGroup.findMany({
        where,
        orderBy: { capturedAt: 'asc' },
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
    const urlFor = (metadata: Prisma.JsonValue | null): string | null => {
      const k = this.mediaThumbnailService.extractThumbKey(metadata);
      return k ? keyToUrl.get(k) ?? null : null;
    };

    const data = groups.map((group) => {
      const coverThumbnailUrls = group.items
        .map((item) => urlFor(item.metadata))
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

    await this.membership.assertCircleAccess(userId, group.circleId, perms, CircleRole.viewer);

    const itemsWithUrls = await this.mediaThumbnailService.attachThumbnailUrls(
      group.items,
    );
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

    await this.membership.assertCircleAccess(userId, group.circleId, perms, CircleRole.collaborator);

    if (dto.action === 'trash' && !perms.includes(PERMISSIONS.MEDIA_DELETE)) {
      throw new BadRequestException('media:delete permission is required to trash burst items');
    }

    if (group.status !== BurstGroupStatus.pending) {
      throw new BadRequestException(
        `Burst group ${id} is not in pending status (current: ${group.status})`,
      );
    }

    const groupMemberIds = new Set(group.items.map((i) => i.id));
    const invalidIds = dto.keepIds.filter((k) => !groupMemberIds.has(k));
    if (invalidIds.length > 0) {
      throw new BadRequestException(
        `keepIds contains IDs not belonging to this group: ${invalidIds.join(', ')}`,
      );
    }

    const deleteIds = group.items.map((i) => i.id).filter((id) => !dto.keepIds.includes(id));

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
   */
  private async resolveOneBurstGroup(
    group: { id: string; circleId: string },
    keepIds: string[],
    removeIds: string[],
    action: 'archive' | 'trash',
    userId: string,
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
    await this.reenqueueDuplicateDetection(group.circleId, keepIds);
  }

  // ---------------------------------------------------------------------------
  // Bulk resolve burst groups (auto-keep suggestedBest)
  // ---------------------------------------------------------------------------

  async bulkResolveBurstGroups(dto: BulkResolveBurstDto, userId: string, perms: string[]) {
    await this.membership.assertCircleAccess(userId, dto.circleId, perms, CircleRole.collaborator);

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
      const liveMemberIds = group.items.map((i) => i.id);

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
      const removeIds = liveMemberIds.filter((id) => id !== group.suggestedBestItemId);

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
   * Bulk-resolve every pending burst group in a circle whose persisted
   * `confidence` (0–1) is at/above `threshold / 100`. For each eligible group,
   * keeps its suggested-best item and applies the chosen action to the rest.
   *
   * Confidence is a persisted Float? column, so the eligibility filter runs in
   * SQL. The `gte` naturally excludes null-confidence legacy groups — intended.
   * Bounded to MAX_THRESHOLD_RESOLVE groups per call.
   */
  async bulkResolveBurstGroupsByThreshold(
    dto: BulkResolveBurstThresholdDto,
    userId: string,
    perms: string[],
  ) {
    await this.membership.assertCircleAccess(userId, dto.circleId, perms, CircleRole.collaborator);

    if (dto.action === 'trash' && !perms.includes(PERMISSIONS.MEDIA_DELETE)) {
      throw new BadRequestException('media:delete permission is required to trash burst items');
    }

    const groups = await this.prisma.burstGroup.findMany({
      where: {
        circleId: dto.circleId,
        status: BurstGroupStatus.pending,
        confidence: { gte: dto.threshold / 100 },
      },
      take: MAX_THRESHOLD_RESOLVE,
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

    let skipped = 0;
    let errors = 0;
    let resolvedGroups = 0;
    let keptCount = 0;
    let removedCount = 0;

    for (const group of groups) {
      const liveMemberIds = group.items.map((i) => i.id);

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
      const removeIds = liveMemberIds.filter((id) => id !== group.suggestedBestItemId);

      try {
        await this.resolveOneBurstGroup(group, keepIds, removeIds, dto.action, userId);
        resolvedGroups++;
        keptCount += keepIds.length;
        removedCount += removeIds.length;
      } catch (err) {
        this.logger.warn(
          `Failed to resolve burst group ${group.id} in threshold bulk operation: ${err instanceof Error ? err.message : String(err)}`,
        );
        errors++;
      }
    }

    // Count still-pending eligible groups after this batch resolved some, so the
    // caller knows whether another pass is needed (a single call is capped at
    // MAX_THRESHOLD_RESOLVE). Groups that were skipped or errored above remain
    // pending and are therefore still counted here — correct, as they still
    // need attention.
    const remaining = await this.prisma.burstGroup.count({
      where: {
        circleId: dto.circleId,
        status: BurstGroupStatus.pending,
        confidence: { gte: dto.threshold / 100 },
      },
    });

    return {
      data: {
        resolvedGroups,
        keptCount,
        removedCount,
        action: dto.action,
        skipped,
        errors,
        remaining,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Dismiss burst group
  // ---------------------------------------------------------------------------

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

    await this.membership.assertCircleAccess(userId, group.circleId, perms, CircleRole.collaborator);

    if (group.status !== BurstGroupStatus.pending) {
      throw new BadRequestException(
        `Burst group ${id} is not in pending status (current: ${group.status})`,
      );
    }

    const memberCount = group.items.length;

    await this.prisma.$transaction([
      // Clear burstGroupId and burstScore on all members
      this.prisma.mediaItem.updateMany({
        where: { burstGroupId: id },
        data: { burstGroupId: null, burstScore: null },
      }),
      // Mark group dismissed
      this.prisma.burstGroup.update({
        where: { id },
        data: {
          status: BurstGroupStatus.dismissed,
          resolvedById: userId,
          resolvedAt: new Date(),
        },
      }),
    ]);

    this.logger.log(`Burst group ${id} dismissed by user ${userId}: ungrouped ${memberCount} items`);

    // All members are ungrouped (none deleted) — let them compete for
    // duplicate matches now that the burst group is no longer pending.
    await this.reenqueueDuplicateDetection(group.circleId, group.items.map((i) => i.id));

    return {
      data: {
        groupStatus: 'dismissed',
        ungrouped: memberCount,
      },
    };
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
        await this.enrichmentJobService.enqueue({
          type: 'burst_detection',
          mediaItemId: item.id,
          circleId,
          reason: JobReason.backfill,
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
      const succeededJobMediaIds = await this.prisma.enrichmentJob.findMany({
        where: {
          type: 'burst_detection',
          circleId,
          status: JobStatus.succeeded,
        },
        select: { mediaItemId: true },
      });
      const excludeIds = new Set(
        succeededJobMediaIds.map((j) => j.mediaItemId).filter((id): id is string => id !== null),
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
        await this.enrichmentJobService.enqueue({
          type: 'burst_detection',
          mediaItemId: item.id,
          circleId,
          reason: JobReason.backfill,
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

  async backfillAllCircles(opts: {
    from?: string;
    to?: string;
    force?: boolean;
  }): Promise<{ enqueued: number; circles: number; evictedDuplicateOverlaps: number }> {
    const allCircles = await this.prisma.circle.findMany({
      select: { id: true },
    });

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
        meta: meta as Prisma.InputJsonValue,
      },
    });
  }
}
