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
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { FEATURE_KEYS } from '../common/types/settings.types';
import { BurstQueryDto } from './dto/burst-query.dto';
import { ResolveBurstDto } from './dto/resolve-burst.dto';

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
    private readonly systemSettings: SystemSettingsService,
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

  private async signThumb(metadata: Prisma.JsonValue | null): Promise<string | null> {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }
    const meta = metadata as Record<string, unknown>;
    const key = meta['thumbnailStorageKey'];
    if (typeof key !== 'string' || !key) {
      return null;
    }
    try {
      // Look up the thumbnail StorageObject row to find which provider+bucket it lives on.
      // This handles the case where thumbnails were uploaded to R2 (or any non-default provider)
      // while the static STORAGE_PROVIDER token still points at the legacy S3 bucket.
      const thumbObj = await this.prisma.storageObject.findFirst({
        where: { storageKey: key },
        select: { storageProvider: true, bucket: true },
      });
      const provider = thumbObj
        ? await this.resolver.getProviderFor(thumbObj.storageProvider, thumbObj.bucket)
        : this.storageProvider; // fallback: row not found, use static provider
      return await provider.getSignedDownloadUrl(key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to sign thumbnail URL for key ${key}: ${msg}`);
      return null;
    }
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

    const data = await Promise.all(
      groups.map(async (group) => {
        const coverThumbnailUrls = await Promise.all(
          group.items.map((item) => this.signThumb(item.metadata)),
        );

        const suggestedBestThumbnailUrl = group.suggestedBestItem
          ? await this.signThumb(group.suggestedBestItem.metadata)
          : null;

        return {
          id: group.id,
          circleId: group.circleId,
          status: group.status,
          mediaCount: group.mediaCount,
          capturedAt: group.capturedAt,
          suggestedBestItemId: group.suggestedBestItemId,
          suggestedBestThumbnailUrl,
          coverThumbnailUrls: coverThumbnailUrls.filter((url): url is string => url !== null),
          createdAt: group.createdAt,
        };
      }),
    );

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

    const membersWithUrls = await Promise.all(
      group.items.map(async (item) => ({
        id: item.id,
        capturedAt: item.capturedAt,
        burstScore: item.burstScore,
        sharpnessScore: item.sharpnessScore,
        thumbnailUrl: await this.signThumb(item.metadata),
        width: item.width,
        height: item.height,
        isSuggestedBest: item.id === group.suggestedBestItemId,
      })),
    );

    return {
      data: {
        id: group.id,
        circleId: group.circleId,
        status: group.status,
        mediaCount: group.mediaCount,
        capturedAt: group.capturedAt,
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

    await this.prisma.$transaction([
      // Soft-delete all non-kept members
      this.prisma.mediaItem.updateMany({
        where: { id: { in: deleteIds } },
        data: { deletedAt: new Date() },
      }),
      // Mark group resolved
      this.prisma.burstGroup.update({
        where: { id },
        data: {
          status: BurstGroupStatus.resolved,
          resolvedById: userId,
          resolvedAt: new Date(),
        },
      }),
    ]);

    this.logger.log(
      `Burst group ${id} resolved by user ${userId}: kept=${dto.keepIds.length}, deleted=${deleteIds.length}`,
    );

    // Surviving (kept) items were excluded from dedup matching while this
    // burst group was pending — now that it's resolved, let them compete for
    // duplicate matches again.
    await this.reenqueueDuplicateDetection(group.circleId, dto.keepIds);

    return {
      data: {
        deleted: deleteIds.length,
        kept: dto.keepIds.length,
        groupStatus: 'resolved',
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
  }): Promise<{ enqueued: number; circles: number }> {
    const allCircles = await this.prisma.circle.findMany({
      select: { id: true },
    });

    let totalEnqueued = 0;
    const circleCount = allCircles.length;

    for (const circle of allCircles) {
      const count = await this.backfillCircleInternal(circle.id, opts);
      totalEnqueued += count;
    }

    this.logger.log(
      `Global burst backfill complete: ${totalEnqueued} job(s) enqueued across ${circleCount} circle(s)`,
    );

    return { enqueued: totalEnqueued, circles: circleCount };
  }
}
