import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CircleRole, DuplicateGroupStatus, JobReason, MediaType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { hammingDistance } from '../burst/burst-detection.service';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { DuplicateQueryDto } from './dto/duplicate-query.dto';
import { ResolveDuplicateDto } from './dto/resolve-duplicate.dto';
import { BulkResolveDuplicateDto } from './dto/bulk-resolve-duplicate.dto';
import { BulkResolveDuplicateThresholdDto } from './dto/bulk-resolve-duplicate-threshold.dto';

/** Hard cap on the number of groups a single threshold-based bulk resolve touches. */
const MAX_THRESHOLD_RESOLVE = 500;

type DuplicateKind = 'exact_variant' | 'edited' | 'similar';

interface GroupMemberRow {
  id: string;
  metadata: Prisma.JsonValue | null;
  width: number | null;
  height: number | null;
  perceptualHash: string | null;
  sharpnessScore: number | null;
  capturedAt: Date | null;
  takenLat: number | null;
  takenLng: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  contentHash: string | null;
  storageObject: { size: bigint } | null;
}

/**
 * Normalizes an array of numbers to [0, 1]. When all values are equal,
 * returns 0.5 for each (mirrors BurstDetectionService.normalize).
 */
function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

@Injectable()
export class DuplicateService {
  private readonly logger = new Logger(DuplicateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: CircleMembershipService,
    private readonly enrichmentJobService: EnrichmentJobService,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
    private readonly resolver: StorageProviderResolver,
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
      const thumbObj = await this.prisma.storageObject.findFirst({
        where: { storageKey: key },
        select: { storageProvider: true, bucket: true },
      });
      const provider = thumbObj
        ? await this.resolver.getProviderFor(thumbObj.storageProvider, thumbObj.bucket)
        : this.storageProvider;
      return await provider.getSignedDownloadUrl(key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to sign thumbnail URL for key ${key}: ${msg}`);
      return null;
    }
  }

  private async signOriginal(mediaItemId: string): Promise<string | null> {
    try {
      const item = await this.prisma.mediaItem.findUnique({
        where: { id: mediaItemId },
        select: { storageObjectId: true },
      });
      if (!item) return null;
      const storageObj = await this.prisma.storageObject.findUnique({
        where: { id: item.storageObjectId },
        select: { storageKey: true, storageProvider: true, bucket: true },
      });
      if (!storageObj) return null;
      const provider = await this.resolver.getProviderFor(storageObj.storageProvider, storageObj.bucket);
      return await provider.getSignedDownloadUrl(storageObj.storageKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to sign original URL for MediaItem ${mediaItemId}: ${msg}`);
      return null;
    }
  }

  /**
   * Kind classification heuristic (computed at read time, never persisted):
   *   - 'exact_variant': the group's tightest embedding similarity is >= 0.99
   *     AND its tightest hash Hamming distance is <= 2 — near-byte-identical copies.
   *   - 'edited': linked (grouped) but members diverge in dimensions or hash
   *     distance beyond the exact-variant threshold — a real edit occurred
   *     (crop, filter, recompress) between otherwise-matching photos.
   *   - 'similar': anything else that met the matching threshold.
   */
  private async computeGroupKind(
    members: GroupMemberRow[],
  ): Promise<{ kind: DuplicateKind; maxSim: number | null; minHamming: number | null }> {
    const memberIds = members.map((m) => m.id);
    if (memberIds.length < 2) return { kind: 'similar', maxSim: null, minHamming: null };

    const pairwiseRows = await this.prisma.$queryRaw<{ sim: unknown }[]>`
      SELECT (1 - (a.embedding <=> b.embedding)) AS sim
      FROM media_visual_embedding a
      JOIN media_visual_embedding b ON b.media_item_id > a.media_item_id
      WHERE a.media_item_id = ANY(${memberIds}::uuid[]) AND b.media_item_id = ANY(${memberIds}::uuid[])
    `;
    const maxSim = pairwiseRows.length > 0 ? Math.max(...pairwiseRows.map((r) => Number(r.sim))) : null;

    const withHash = members.filter((m): m is GroupMemberRow & { perceptualHash: string } => m.perceptualHash !== null);
    let minHamming: number | null = null;
    for (let i = 0; i < withHash.length; i++) {
      for (let j = i + 1; j < withHash.length; j++) {
        const dist = hammingDistance(BigInt(withHash[i].perceptualHash), BigInt(withHash[j].perceptualHash));
        if (minHamming === null || dist < minHamming) minHamming = dist;
      }
    }

    if (maxSim !== null && maxSim >= 0.99 && minHamming !== null && minHamming <= 2) {
      return { kind: 'exact_variant', maxSim, minHamming };
    }

    const uniqueDims = new Set(
      members.filter((m) => m.width != null && m.height != null).map((m) => `${m.width}x${m.height}`),
    );
    const hashesDiverge = minHamming !== null && minHamming > 2;
    if (uniqueDims.size > 1 || hashesDiverge) {
      return { kind: 'edited', maxSim, minHamming };
    }

    return { kind: 'similar', maxSim, minHamming };
  }

  /**
   * Best-copy score (computed at read time):
   *   0.35 * norm(width*height) + 0.30 * (exifRichness/3)
   *   + 0.20 * norm(sharpnessScore) + 0.15 * norm(fileSize)
   * exifRichness = hasCapturedAt + hasGps + hasCamera (0-3).
   */
  private computeBestCopyScores(
    members: GroupMemberRow[],
  ): { scores: Map<string, number>; bestId: string | null } {
    if (members.length === 0) return { scores: new Map(), bestId: null };

    const resValues = members.map((m) => (m.width ?? 0) * (m.height ?? 0));
    const sharpValues = members.map((m) => m.sharpnessScore ?? 0);
    const sizeValues = members.map((m) => Number(m.storageObject?.size ?? 0n));
    const exifValues = members.map((m) => {
      let richness = 0;
      if (m.capturedAt) richness++;
      if (m.takenLat != null && m.takenLng != null) richness++;
      if (m.cameraMake || m.cameraModel) richness++;
      return richness;
    });

    const resScores = normalize(resValues);
    const sharpScores = normalize(sharpValues);
    const sizeScores = normalize(sizeValues);

    const scores = new Map<string, number>();
    let bestId: string | null = null;
    let bestScore = -Infinity;

    members.forEach((m, i) => {
      const score =
        0.35 * resScores[i] + 0.3 * (exifValues[i] / 3) + 0.2 * sharpScores[i] + 0.15 * sizeScores[i];
      scores.set(m.id, score);
      if (score > bestScore) {
        bestScore = score;
        bestId = m.id;
      }
    });

    return { scores, bestId };
  }

  private readonly MEMBER_SELECT = {
    id: true,
    metadata: true,
    width: true,
    height: true,
    perceptualHash: true,
    sharpnessScore: true,
    capturedAt: true,
    takenLat: true,
    takenLng: true,
    cameraMake: true,
    cameraModel: true,
    contentHash: true,
    storageObject: { select: { size: true } },
  } as const;

  // ---------------------------------------------------------------------------
  // List duplicate groups
  // ---------------------------------------------------------------------------

  async listDuplicateGroups(query: DuplicateQueryDto, userId: string, perms: string[]) {
    const { circleId, status, kind, page, pageSize } = query;

    await this.membership.assertCircleAccess(userId, circleId, perms, CircleRole.viewer);

    const groups = await this.prisma.duplicateGroup.findMany({
      where: { circleId, status: status as DuplicateGroupStatus },
      orderBy: [{ capturedAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        status: true,
        mediaCount: true,
        capturedAt: true,
        suggestedBestItemId: true,
        items: {
          where: { deletedAt: null, archivedAt: null },
          select: this.MEMBER_SELECT,
        },
      },
    });

    const enriched = await Promise.all(
      groups.map(async (group) => {
        const { kind: kindClass, maxSim } = await this.computeGroupKind(group.items);
        const { bestId } = this.computeBestCopyScores(group.items);

        if (bestId && bestId !== group.suggestedBestItemId) {
          await this.prisma.duplicateGroup
            .update({ where: { id: group.id }, data: { suggestedBestItemId: bestId } })
            .catch(() => undefined);
        }

        return {
          ...group,
          kind: kindClass,
          confidence: maxSim ?? 0,
          suggestedBestItemId: bestId ?? group.suggestedBestItemId,
        };
      }),
    );

    const filtered = kind ? enriched.filter((g) => g.kind === kind) : enriched;
    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const pageGroups = filtered.slice(start, start + pageSize);

    const data = await Promise.all(
      pageGroups.map(async (group) => {
        const coverThumbnailUrls = await Promise.all(
          group.items.slice(0, 4).map((item) => this.signThumb(item.metadata)),
        );

        return {
          id: group.id,
          status: group.status,
          kind: group.kind,
          confidence: group.confidence,
          mediaCount: group.mediaCount,
          suggestedBestItemId: group.suggestedBestItemId,
          capturedAt: group.capturedAt,
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
  // Get single duplicate group detail
  // ---------------------------------------------------------------------------

  async getDuplicateGroup(id: string, userId: string, perms: string[]) {
    const group = await this.prisma.duplicateGroup.findUnique({
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
          where: { deletedAt: null, archivedAt: null },
          select: this.MEMBER_SELECT,
        },
      },
    });

    if (!group) {
      throw new NotFoundException(`Duplicate group ${id} not found`);
    }

    await this.membership.assertCircleAccess(userId, group.circleId, perms, CircleRole.viewer);

    const { kind, maxSim } = await this.computeGroupKind(group.items);
    const { scores, bestId } = this.computeBestCopyScores(group.items);
    const suggestedBestItemId = bestId ?? group.suggestedBestItemId;

    if (bestId && bestId !== group.suggestedBestItemId) {
      await this.prisma.duplicateGroup
        .update({ where: { id: group.id }, data: { suggestedBestItemId: bestId } })
        .catch(() => undefined);
    }

    // similarityToBest: cosine similarity of each member's embedding to the
    // suggested-best member's embedding (null when either side has no embedding).
    let similarityMap = new Map<string, number>();
    if (suggestedBestItemId) {
      const simRows = await this.prisma.$queryRaw<{ id: string; sim: unknown }[]>`
        SELECT e.media_item_id AS id, (1 - (e.embedding <=> best.embedding)) AS sim
        FROM media_visual_embedding e
        JOIN media_visual_embedding best ON best.media_item_id = ${suggestedBestItemId}::uuid
        WHERE e.media_item_id = ANY(${group.items.map((m) => m.id)}::uuid[])
      `;
      similarityMap = new Map(simRows.map((r) => [r.id, Number(r.sim)]));
    }

    const members = await Promise.all(
      group.items.map(async (item) => ({
        id: item.id,
        thumbnailUrl: await this.signThumb(item.metadata),
        previewUrl: await this.signOriginal(item.id),
        width: item.width,
        height: item.height,
        fileSize: item.storageObject ? Number(item.storageObject.size) : null,
        capturedAt: item.capturedAt,
        cameraMake: item.cameraMake,
        cameraModel: item.cameraModel,
        hasGps: item.takenLat != null && item.takenLng != null,
        contentHash: item.contentHash ? item.contentHash.slice(0, 12) : null,
        sharpnessScore: item.sharpnessScore,
        qualityScore: scores.get(item.id) ?? null,
        similarityToBest: similarityMap.get(item.id) ?? null,
        isSuggestedBest: item.id === suggestedBestItemId,
      })),
    );

    return {
      data: {
        id: group.id,
        circleId: group.circleId,
        status: group.status,
        kind,
        confidence: maxSim ?? 0,
        mediaCount: group.mediaCount,
        capturedAt: group.capturedAt,
        suggestedBestItemId,
        resolvedById: group.resolvedById,
        resolvedAt: group.resolvedAt,
        members,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Resolve duplicate group
  // ---------------------------------------------------------------------------

  async resolveDuplicateGroup(id: string, dto: ResolveDuplicateDto, userId: string, perms: string[]) {
    const group = await this.prisma.duplicateGroup.findUnique({
      where: { id },
      select: {
        id: true,
        circleId: true,
        status: true,
        items: {
          where: { deletedAt: null, archivedAt: null },
          select: { id: true },
        },
      },
    });

    if (!group) {
      throw new NotFoundException(`Duplicate group ${id} not found`);
    }

    await this.membership.assertCircleAccess(userId, group.circleId, perms, CircleRole.collaborator);

    if (dto.action === 'trash' && !perms.includes(PERMISSIONS.MEDIA_DELETE)) {
      throw new BadRequestException('media:delete permission is required to trash duplicate items');
    }

    if (group.status !== DuplicateGroupStatus.pending) {
      throw new BadRequestException(
        `Duplicate group ${id} is not in pending status (current: ${group.status})`,
      );
    }

    const groupMemberIds = new Set(group.items.map((i) => i.id));
    const invalidIds = dto.keepIds.filter((k) => !groupMemberIds.has(k));
    if (invalidIds.length > 0) {
      throw new BadRequestException(
        `keepIds contains IDs not belonging to this group: ${invalidIds.join(', ')}`,
      );
    }

    const removeIds = group.items.map((i) => i.id).filter((id) => !dto.keepIds.includes(id));

    await this.resolveOneDuplicateGroup(group, dto.keepIds, removeIds, dto.action, userId);

    return {
      data: {
        removed: removeIds.length,
        kept: dto.keepIds.length,
        action: dto.action,
        groupStatus: 'resolved',
      },
    };
  }

  /**
   * Applies the side-effects of resolving a single duplicate group. Assumes all
   * inputs are already validated (group is pending, keep/remove IDs belong to
   * the group, trash-permission checked). Each call runs its own transaction so
   * a later failure never rolls back earlier successes in a bulk operation.
   * Unlike burst resolution, there is no dedup re-enqueue step.
   */
  private async resolveOneDuplicateGroup(
    group: { id: string; circleId: string },
    keepIds: string[],
    removeIds: string[],
    action: 'archive' | 'trash',
    userId: string,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.mediaItem.updateMany({
        where: { id: { in: removeIds } },
        data: action === 'trash' ? { deletedAt: new Date() } : { archivedAt: new Date() },
      }),
      this.prisma.duplicateGroup.update({
        where: { id: group.id },
        data: {
          status: DuplicateGroupStatus.resolved,
          resolvedById: userId,
          resolvedAt: new Date(),
          resolutionAction: action,
          keptCount: keepIds.length,
          removedCount: removeIds.length,
        },
      }),
    ]);

    await this.createAuditEvent(userId, 'duplicate_group:resolved', group.id, {
      keepIds,
      action,
      removedCount: removeIds.length,
    });

    this.logger.log(
      `Duplicate group ${group.id} resolved by user ${userId}: kept=${keepIds.length}, ${action}=${removeIds.length}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Bulk resolve duplicate groups (auto-keep suggestedBest)
  // ---------------------------------------------------------------------------

  async bulkResolveDuplicateGroups(dto: BulkResolveDuplicateDto, userId: string, perms: string[]) {
    await this.membership.assertCircleAccess(userId, dto.circleId, perms, CircleRole.collaborator);

    if (dto.action === 'trash' && !perms.includes(PERMISSIONS.MEDIA_DELETE)) {
      throw new BadRequestException('media:delete permission is required to trash duplicate items');
    }

    const dedupedIds = [...new Set(dto.ids)];

    const groups = await this.prisma.duplicateGroup.findMany({
      where: { id: { in: dedupedIds } },
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
        group.status !== DuplicateGroupStatus.pending ||
        !group.suggestedBestItemId ||
        !liveMemberIds.includes(group.suggestedBestItemId)
      ) {
        skipped++;
        continue;
      }

      const keepIds = [group.suggestedBestItemId];
      const removeIds = liveMemberIds.filter((id) => id !== group.suggestedBestItemId);

      try {
        await this.resolveOneDuplicateGroup(group, keepIds, removeIds, dto.action, userId);
        resolvedGroups++;
        keptCount += keepIds.length;
        removedCount += removeIds.length;
      } catch (err) {
        this.logger.warn(
          `Failed to resolve duplicate group ${group.id} in bulk operation: ${err instanceof Error ? err.message : String(err)}`,
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
  // Bulk resolve duplicate groups by confidence threshold
  // ---------------------------------------------------------------------------

  /**
   * Bulk-resolve every pending duplicate group in a circle whose read-time
   * confidence (tightest-pair CLIP similarity from computeGroupKind) is at/above
   * `threshold / 100`. For each eligible group, keeps its suggested-best item
   * and applies the chosen action to the rest.
   *
   * Unlike burst confidence, duplicate confidence is NOT a persisted column —
   * it is computed at read time via computeGroupKind(members). The candidate set
   * is therefore CAPPED to MAX_THRESHOLD_RESOLVE groups first; the per-group
   * computeGroupKind cost (one pairwise SQL query each) is bounded by that cap.
   */
  async bulkResolveDuplicateGroupsByThreshold(
    dto: BulkResolveDuplicateThresholdDto,
    userId: string,
    perms: string[],
  ) {
    await this.membership.assertCircleAccess(userId, dto.circleId, perms, CircleRole.collaborator);

    if (dto.action === 'trash' && !perms.includes(PERMISSIONS.MEDIA_DELETE)) {
      throw new BadRequestException('media:delete permission is required to trash duplicate items');
    }

    const groups = await this.prisma.duplicateGroup.findMany({
      where: { circleId: dto.circleId, status: DuplicateGroupStatus.pending },
      take: MAX_THRESHOLD_RESOLVE,
      select: {
        id: true,
        circleId: true,
        status: true,
        suggestedBestItemId: true,
        items: {
          where: { deletedAt: null, archivedAt: null },
          select: this.MEMBER_SELECT,
        },
      },
    });

    const minSim = dto.threshold / 100;

    let skipped = 0;
    let errors = 0;
    let resolvedGroups = 0;
    let keptCount = 0;
    let removedCount = 0;

    for (const group of groups) {
      // Read-time confidence gate: skip groups below the threshold (and legacy
      // groups whose maxSim cannot be computed).
      const { maxSim } = await this.computeGroupKind(group.items);
      if (maxSim == null || maxSim < minSim) {
        skipped++;
        continue;
      }

      const liveMemberIds = group.items.map((i) => i.id);

      // Mirror the id-based bulk skip conditions.
      if (
        group.status !== DuplicateGroupStatus.pending ||
        !group.suggestedBestItemId ||
        !liveMemberIds.includes(group.suggestedBestItemId)
      ) {
        skipped++;
        continue;
      }

      const keepIds = [group.suggestedBestItemId];
      const removeIds = liveMemberIds.filter((id) => id !== group.suggestedBestItemId);

      try {
        await this.resolveOneDuplicateGroup(group, keepIds, removeIds, dto.action, userId);
        resolvedGroups++;
        keptCount += keepIds.length;
        removedCount += removeIds.length;
      } catch (err) {
        this.logger.warn(
          `Failed to resolve duplicate group ${group.id} in threshold bulk operation: ${err instanceof Error ? err.message : String(err)}`,
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
  // Dismiss duplicate group
  // ---------------------------------------------------------------------------

  async dismissDuplicateGroup(id: string, userId: string, perms: string[]) {
    const group = await this.prisma.duplicateGroup.findUnique({
      where: { id },
      select: {
        id: true,
        circleId: true,
        status: true,
        items: { select: { id: true } },
      },
    });

    if (!group) {
      throw new NotFoundException(`Duplicate group ${id} not found`);
    }

    await this.membership.assertCircleAccess(userId, group.circleId, perms, CircleRole.collaborator);

    if (group.status !== DuplicateGroupStatus.pending) {
      throw new BadRequestException(
        `Duplicate group ${id} is not in pending status (current: ${group.status})`,
      );
    }

    const memberCount = group.items.length;

    await this.prisma.$transaction([
      this.prisma.mediaItem.updateMany({
        where: { duplicateGroupId: id },
        data: { duplicateGroupId: null },
      }),
      this.prisma.duplicateGroup.update({
        where: { id },
        data: {
          status: DuplicateGroupStatus.dismissed,
          resolvedById: userId,
          resolvedAt: new Date(),
        },
      }),
    ]);

    await this.createAuditEvent(userId, 'duplicate_group:dismissed', id, {
      ungrouped: memberCount,
    });

    this.logger.log(`Duplicate group ${id} dismissed by user ${userId}: ungrouped ${memberCount} items`);

    return {
      data: {
        groupStatus: 'dismissed',
        ungrouped: memberCount,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Per-item rerun
  // ---------------------------------------------------------------------------

  async rerunDuplicateDetection(mediaItemId: string, userId: string, perms: string[]) {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, deletedAt: true, type: true },
    });

    if (!mediaItem || mediaItem.deletedAt) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    await this.membership.assertCircleAccess(userId, mediaItem.circleId, perms, CircleRole.collaborator);

    if (mediaItem.type !== MediaType.photo) {
      throw new BadRequestException('Duplicate detection only applies to photos');
    }

    const job = await this.enrichmentJobService.enqueue({
      type: 'duplicate_detection',
      mediaItemId,
      circleId: mediaItem.circleId,
      reason: JobReason.rerun,
      priority: 0,
    });

    this.logger.log(`Rerun duplicate detection job ${job.id} enqueued for MediaItem ${mediaItemId} by user ${userId}`);

    return { data: { jobId: job.id, status: job.status } };
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
        targetType: 'duplicate_group',
        targetId,
        meta: meta as Prisma.InputJsonValue,
      },
    });
  }
}
