import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CircleRole, JobReason, JobStatus, MediaType, Prisma, SimilarityGroupStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { SimilarityQueryDto } from './dto/similarity-query.dto';
import { ResolveSimilarityDto } from './dto/resolve-similarity.dto';
import { SimilarityBackfillDto } from './dto/similarity-backfill.dto';

@Injectable()
export class SimilarityService {
  private readonly logger = new Logger(SimilarityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: CircleMembershipService,
    private readonly enrichmentJobService: EnrichmentJobService,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
  ) {}

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
      return await this.storageProvider.getSignedDownloadUrl(key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to sign thumbnail URL for key ${key}: ${msg}`);
      return null;
    }
  }

  private async getSimilarityMinGroupSize(): Promise<number> {
    const settings = await this.prisma.systemSettings.findUnique({
      where: { key: 'global' },
      select: { value: true },
    });
    const value = (settings?.value as Record<string, unknown> | null) ?? {};
    const simConfig = value['similarity'] as { minGroupSize?: number } | undefined;
    return simConfig?.minGroupSize ?? 2;
  }

  // ---------------------------------------------------------------------------
  // List similarity groups
  // ---------------------------------------------------------------------------

  async listSimilarityGroups(query: SimilarityQueryDto, userId: string, perms: string[]) {
    const { circleId, status, page, pageSize } = query;

    await this.membership.assertCircleAccess(userId, circleId, perms, CircleRole.viewer);

    const minGroupSize = await this.getSimilarityMinGroupSize();
    const skip = (page - 1) * pageSize;

    const where = {
      circleId,
      status: status as SimilarityGroupStatus,
      mediaCount: { gte: minGroupSize },
    };

    const [groups, total] = await Promise.all([
      this.prisma.similarityGroup.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          circleId: true,
          status: true,
          mediaCount: true,
          createdAt: true,
          suggestedBestItemId: true,
          suggestedBestItem: {
            select: { metadata: true },
          },
          items: {
            where: { deletedAt: null },
            orderBy: { importedAt: 'asc' },
            take: 4,
            select: { id: true, metadata: true },
          },
        },
      }),
      this.prisma.similarityGroup.count({ where }),
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
          createdAt: group.createdAt,
          suggestedBestItemId: group.suggestedBestItemId,
          suggestedBestThumbnailUrl,
          coverThumbnailUrls: coverThumbnailUrls.filter((url): url is string => url !== null),
        };
      }),
    );

    return {
      items: data,
      meta: { total, page, pageSize },
    };
  }

  // ---------------------------------------------------------------------------
  // Get single similarity group detail
  // ---------------------------------------------------------------------------

  async getSimilarityGroup(id: string, userId: string, perms: string[]) {
    const group = await this.prisma.similarityGroup.findUnique({
      where: { id },
      select: {
        id: true,
        circleId: true,
        status: true,
        mediaCount: true,
        createdAt: true,
        suggestedBestItemId: true,
        resolvedById: true,
        resolvedAt: true,
        items: {
          where: { deletedAt: null },
          orderBy: { importedAt: 'asc' },
          select: {
            id: true,
            similarityScore: true,
            sharpnessScore: true,
            width: true,
            height: true,
            metadata: true,
            importedAt: true,
            capturedAt: true,
          },
        },
      },
    });

    if (!group) {
      throw new NotFoundException(`Similarity group ${id} not found`);
    }

    await this.membership.assertCircleAccess(userId, group.circleId, perms, CircleRole.viewer);

    const membersWithUrls = await Promise.all(
      group.items.map(async (item) => ({
        id: item.id,
        similarityScore: item.similarityScore,
        sharpnessScore: item.sharpnessScore,
        width: item.width,
        height: item.height,
        thumbnailUrl: await this.signThumb(item.metadata),
        capturedAt: item.capturedAt,
        importedAt: item.importedAt,
        isSuggestedBest: item.id === group.suggestedBestItemId,
      })),
    );

    return {
      data: {
        id: group.id,
        circleId: group.circleId,
        status: group.status,
        mediaCount: group.mediaCount,
        createdAt: group.createdAt,
        suggestedBestItemId: group.suggestedBestItemId,
        resolvedById: group.resolvedById,
        resolvedAt: group.resolvedAt,
        members: membersWithUrls,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Resolve similarity group
  // ---------------------------------------------------------------------------

  async resolveSimilarityGroup(
    id: string,
    dto: ResolveSimilarityDto,
    userId: string,
    perms: string[],
  ) {
    const group = await this.prisma.similarityGroup.findUnique({
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
      throw new NotFoundException(`Similarity group ${id} not found`);
    }

    await this.membership.assertCircleAccess(userId, group.circleId, perms, CircleRole.collaborator);

    if (group.status !== SimilarityGroupStatus.pending) {
      throw new BadRequestException(
        `Similarity group ${id} is not in pending status (current: ${group.status})`,
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
      this.prisma.similarityGroup.update({
        where: { id },
        data: {
          status: SimilarityGroupStatus.resolved,
          resolvedById: userId,
          resolvedAt: new Date(),
        },
      }),
    ]);

    this.logger.log(
      `Similarity group ${id} resolved by user ${userId}: kept=${dto.keepIds.length}, deleted=${deleteIds.length}`,
    );

    return {
      data: {
        deleted: deleteIds.length,
        kept: dto.keepIds.length,
        groupStatus: 'resolved',
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Dismiss similarity group
  // ---------------------------------------------------------------------------

  async dismissSimilarityGroup(id: string, userId: string, perms: string[]) {
    const group = await this.prisma.similarityGroup.findUnique({
      where: { id },
      select: {
        id: true,
        circleId: true,
        status: true,
        items: { select: { id: true } },
      },
    });

    if (!group) {
      throw new NotFoundException(`Similarity group ${id} not found`);
    }

    await this.membership.assertCircleAccess(userId, group.circleId, perms, CircleRole.collaborator);

    if (group.status !== SimilarityGroupStatus.pending) {
      throw new BadRequestException(
        `Similarity group ${id} is not in pending status (current: ${group.status})`,
      );
    }

    const memberCount = group.items.length;

    await this.prisma.$transaction([
      // Clear similarityGroupId and similarityScore on all members
      this.prisma.mediaItem.updateMany({
        where: { similarityGroupId: id },
        data: { similarityGroupId: null, similarityScore: null },
      }),
      // Mark group dismissed
      this.prisma.similarityGroup.update({
        where: { id },
        data: {
          status: SimilarityGroupStatus.dismissed,
          resolvedById: userId,
          resolvedAt: new Date(),
        },
      }),
    ]);

    this.logger.log(
      `Similarity group ${id} dismissed by user ${userId}: ungrouped ${memberCount} items`,
    );

    return {
      data: {
        groupStatus: 'dismissed',
        ungrouped: memberCount,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Backfill similarity detection
  // ---------------------------------------------------------------------------

  async backfillSimilarityDetection(dto: SimilarityBackfillDto, userId: string, perms: string[]) {
    const { circleId, force, from, to } = dto;

    await this.membership.assertCircleAccess(userId, circleId, perms, CircleRole.collaborator);

    const circle = await this.prisma.circle.findUnique({
      where: { id: circleId },
      select: { visualDedupEnabled: true },
    });

    if (!circle) {
      throw new NotFoundException(`Circle ${circleId} not found`);
    }

    if (!circle.visualDedupEnabled) {
      throw new BadRequestException(
        `Circle ${circleId} does not have visual deduplication enabled. Enable it first via PUT /api/circles/${circleId}/dedup-settings`,
      );
    }

    // Build optional capturedAt range filter
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
          type: 'similarity_detection',
          mediaItemId: item.id,
          circleId,
          reason: JobReason.backfill,
          priority: 100,
        });
        enqueued++;
      }

      this.logger.log(
        `Backfilled similarity detection for circle ${circleId}: enqueued ${enqueued} items (force=true${from || to ? `, from=${from ?? '*'}, to=${to ?? '*'}` : ''})`,
      );
      return { data: { enqueued } };
    } else {
      // Only enqueue items without a similarityGroupId and without a succeeded job
      const succeededJobMediaIds = await this.prisma.enrichmentJob.findMany({
        where: {
          type: 'similarity_detection',
          circleId,
          status: JobStatus.succeeded,
        },
        select: { mediaItemId: true },
      });
      const excludeIds = new Set(
        succeededJobMediaIds
          .map((j) => j.mediaItemId)
          .filter((id): id is string => id !== null),
      );

      const items = await this.prisma.mediaItem.findMany({
        where: {
          circleId,
          type: MediaType.photo,
          deletedAt: null,
          similarityGroupId: null,
          id: { notIn: [...excludeIds] },
          ...capturedAtFilter,
        },
        select: { id: true },
      });

      let enqueued = 0;
      for (const item of items) {
        await this.enrichmentJobService.enqueue({
          type: 'similarity_detection',
          mediaItemId: item.id,
          circleId,
          reason: JobReason.backfill,
          priority: 100,
        });
        enqueued++;
      }

      this.logger.log(
        `Backfilled similarity detection for circle ${circleId}: enqueued ${enqueued} items (force=false${from || to ? `, from=${from ?? '*'}, to=${to ?? '*'}` : ''})`,
      );
      return { data: { enqueued } };
    }
  }

  // ---------------------------------------------------------------------------
  // Per-circle dedup settings
  // ---------------------------------------------------------------------------

  async getDedupSettings(circleId: string, user: RequestUser) {
    await this.membership.assertCircleAccess(
      user.id,
      circleId,
      user.permissions,
      CircleRole.viewer,
    );

    const circle = await this.prisma.circle.findUnique({
      where: { id: circleId },
      select: { visualDedupEnabled: true },
    });
    if (!circle) throw new NotFoundException(`Circle ${circleId} not found`);

    return { visualDedupEnabled: circle.visualDedupEnabled };
  }

  async updateDedupSettings(circleId: string, enabled: boolean, user: RequestUser) {
    await this.membership.assertCircleAccess(
      user.id,
      circleId,
      user.permissions,
      CircleRole.circle_admin,
    );

    const updated = await this.prisma.circle.update({
      where: { id: circleId },
      data: { visualDedupEnabled: enabled },
      select: { visualDedupEnabled: true },
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: user.id,
        action: 'circle:dedup_settings_update',
        targetType: 'circle',
        targetId: circleId,
        meta: { visualDedupEnabled: enabled } as any,
      },
    });

    this.logger.log(
      `Circle ${circleId} visualDedupEnabled=${enabled} set by user ${user.id}`,
    );

    return { visualDedupEnabled: updated.visualDedupEnabled };
  }
}
