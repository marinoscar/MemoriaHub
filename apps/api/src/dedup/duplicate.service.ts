import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import {
  CircleRole,
  DuplicateGroupStatus,
  JobReason,
  MediaType,
  Prisma,
  ReviewRunAction,
  ReviewRunSubject,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { hammingDistance } from '../burst/burst-detection.service';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { DuplicateQueryDto } from './dto/duplicate-query.dto';
import { ResolveDuplicateDto } from './dto/resolve-duplicate.dto';
import { BulkResolveDuplicateDto } from './dto/bulk-resolve-duplicate.dto';
import { BulkResolveDuplicateThresholdDto } from './dto/bulk-resolve-duplicate-threshold.dto';
import { BulkDismissDuplicateThresholdDto } from './dto/bulk-dismiss-duplicate-threshold.dto';
import { ReviewRunService } from '../review-runs/review-run.service';

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
    private readonly mediaThumbnailService: MediaThumbnailService,
    // Circular by nature: the review-run strategies wrap this service's
    // resolve/dismiss primitives, while these threshold endpoints start runs.
    @Inject(forwardRef(() => ReviewRunService))
    private readonly reviewRuns: ReviewRunService,
  ) {}

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Single-item thumbnail signing. Delegates to the shared
   * MediaThumbnailService. List paths batch signing via `signThumbsBatched`.
   */
  private async signThumb(metadata: Prisma.JsonValue | null): Promise<string | null> {
    return this.mediaThumbnailService.signThumb(metadata);
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

  /**
   * Fire-and-forget read-time write-back of `suggestedBestItemId` and
   * `confidence` when the freshly-computed values differ from what is stored.
   *
   * `DuplicateDetectionService.recomputeGroupMeta` is the authoritative writer
   * of `confidence` on every membership change (issue #190); this is purely a
   * self-heal backstop for groups last written before that column existed. It
   * deliberately never awaits and never throws — a stale display value must not
   * fail a read.
   */
  private persistGroupSelfHeal(
    group: { id: string; suggestedBestItemId: string | null; confidence: number | null },
    bestId: string | null,
    maxSim: number | null,
  ): void {
    const bestChanged = bestId !== null && bestId !== group.suggestedBestItemId;
    const confidenceChanged = maxSim !== group.confidence;
    if (!bestChanged && !confidenceChanged) return;

    void this.prisma.duplicateGroup
      .update({
        where: { id: group.id },
        data: {
          ...(bestChanged ? { suggestedBestItemId: bestId } : {}),
          ...(confidenceChanged ? { confidence: maxSim } : {}),
        },
      })
      .catch(() => undefined);
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
    // Service specs construct this DTO from a bare object literal (bypassing the
    // Zod pipe), so the schema defaults may not have been applied at runtime.
    const by = query.sortBy ?? 'capturedAt';
    const dir = query.sortOrder ?? 'asc';

    await this.membership.assertCircleAccess(userId, circleId, perms, CircleRole.viewer);

    // `capturedAt` is nullable (object form OK); `mediaCount` is non-null (plain
    // direction only). Confidence is computed per group AFTER the query, so it
    // keeps today's base order here and is sorted in memory further below.
    const baseOrder: Prisma.DuplicateGroupOrderByWithRelationInput[] = [
      { capturedAt: { sort: 'asc', nulls: 'last' } },
      { createdAt: 'asc' },
      { id: 'asc' },
    ];
    const orderBy: Prisma.DuplicateGroupOrderByWithRelationInput[] =
      by === 'capturedAt'
        ? [{ capturedAt: { sort: dir, nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }]
        : by === 'mediaCount'
          ? [{ mediaCount: dir }, { capturedAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }]
          : baseOrder;

    const groups = await this.prisma.duplicateGroup.findMany({
      where: { circleId, status: status as DuplicateGroupStatus },
      orderBy,
      select: {
        id: true,
        status: true,
        mediaCount: true,
        capturedAt: true,
        confidence: true,
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

        // Fire-and-forget read-time self-heal. DuplicateDetectionService
        // .recomputeGroupMeta is the authoritative writer of both columns
        // (issue #190); this is the backstop for rows written before that
        // existed, and for any drift the backfill job has not reached yet.
        this.persistGroupSelfHeal(group, bestId, maxSim);

        return {
          ...group,
          kind: kindClass,
          confidence: maxSim ?? 0,
          // Raw (possibly null) similarity, used only for in-memory sorting
          // below — never emitted. The wire field stays `confidence`.
          rawConfidence: maxSim,
          suggestedBestItemId: bestId ?? group.suggestedBestItemId,
        };
      }),
    );

    const filtered = kind ? enriched.filter((g) => g.kind === kind) : enriched;

    // Confidence is computed per group at read time, so it cannot be ordered in
    // SQL — sort here instead. Groups with an uncomputable (null) similarity go
    // LAST in both directions. Array#sort is stable, so the DB base order above
    // is the natural tiebreaker; no explicit tiebreaker comparator is needed.
    if (by === 'confidence') {
      filtered.sort((a, b) => {
        if (a.rawConfidence === null && b.rawConfidence === null) return 0;
        if (a.rawConfidence === null) return 1;
        if (b.rawConfidence === null) return -1;
        return dir === 'asc'
          ? a.rawConfidence - b.rawConfidence
          : b.rawConfidence - a.rawConfidence;
      });
    }

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const pageGroups = filtered.slice(start, start + pageSize);

    // Collect the (up to 4) cover keys across every page group and sign them
    // with a single batched StorageObject query.
    const coverKeys: string[] = [];
    for (const group of pageGroups) {
      for (const item of group.items.slice(0, 4)) {
        const k = this.mediaThumbnailService.extractThumbKey(item.metadata);
        if (k) coverKeys.push(k);
      }
    }
    const keyToUrl = await this.mediaThumbnailService.signThumbsBatched(coverKeys);

    const data = pageGroups.map((group) => {
      const coverThumbnailUrls = group.items
        .slice(0, 4)
        .map((item) => {
          const k = this.mediaThumbnailService.extractThumbKey(item.metadata);
          return k ? keyToUrl.get(k) ?? null : null;
        })
        .filter((url): url is string => url !== null);

      return {
        id: group.id,
        status: group.status,
        kind: group.kind,
        confidence: group.confidence,
        mediaCount: group.mediaCount,
        suggestedBestItemId: group.suggestedBestItemId,
        capturedAt: group.capturedAt,
        coverThumbnailUrls,
      };
    });

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
        confidence: true,
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

    // Same fire-and-forget self-heal as the list path.
    this.persistGroupSelfHeal(group, bestId, maxSim);

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

    // Batch-sign member thumbnails with one StorageObject query; original
    // previews are still signed per-item (each maps to its own object).
    const thumbKeys = group.items
      .map((item) => this.mediaThumbnailService.extractThumbKey(item.metadata))
      .filter((k): k is string => k !== null);
    const thumbKeyToUrl =
      await this.mediaThumbnailService.signThumbsBatched(thumbKeys);

    const members = await Promise.all(
      group.items.map(async (item) => ({
        id: item.id,
        thumbnailUrl: (() => {
          const k = this.mediaThumbnailService.extractThumbKey(item.metadata);
          return k ? thumbKeyToUrl.get(k) ?? null : null;
        })(),
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
   *
   * Public so the shared review-run engine wraps this exact primitive rather
   * than forking it (issue #190).
   */
  async resolveOneDuplicateGroup(
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
   * Start an async run that resolves every pending duplicate group in the circle
   * whose confidence (tightest-pair CLIP similarity, 0-1) is at/above
   * `threshold / 100`, keeping each group's suggested-best item and applying the
   * chosen action to the rest.
   *
   * Since issue #190 this is a thin wrapper over the shared review-run engine,
   * and duplicate confidence is a PERSISTED column (written by
   * DuplicateDetectionService.recomputeGroupMeta) rather than a read-time
   * computation — so the eligibility filter is a real SQL predicate, the old
   * 500-group MAX_THRESHOLD_RESOLVE cap is gone, and the run is cancellable and
   * resumable. Authorization — collaborator, plus media:delete for `trash` — is
   * enforced inside ReviewRunService.createRun.
   */
  async bulkResolveDuplicateGroupsByThreshold(
    dto: BulkResolveDuplicateThresholdDto,
    userId: string,
    perms: string[],
  ) {
    const run = await this.reviewRuns.createRun({
      circleId: dto.circleId,
      subjectType: ReviewRunSubject.duplicate_group,
      action:
        dto.action === 'trash'
          ? ReviewRunAction.resolve_trash
          : ReviewRunAction.resolve_archive,
      threshold: dto.threshold,
      userId,
      perms,
    });

    return { data: { runId: run.id, status: run.status, matchedCount: run.matchedCount } };
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

    const memberCount = await this.dismissOneDuplicateGroup(group, userId);

    return {
      data: {
        groupStatus: 'dismissed',
        ungrouped: memberCount,
      },
    };
  }

  /**
   * Core dismiss primitive shared by the single-group and threshold-bulk paths.
   * Ungroups every member (clears `duplicateGroupId`), marks the group
   * `dismissed`, and writes the `duplicate_group:dismissed` audit event. Returns
   * the ungrouped member count. Callers are responsible for their own access /
   * pending-status guards. Unlike burst dismiss, no dedup re-enqueue happens.
   *
   * Public so the shared review-run engine wraps this exact primitive rather
   * than forking it (issue #190).
   */
  async dismissOneDuplicateGroup(
    group: { id: string; items: { id: string }[] },
    userId: string,
  ): Promise<number> {
    const memberCount = group.items.length;

    await this.prisma.$transaction([
      this.prisma.mediaItem.updateMany({
        where: { duplicateGroupId: group.id },
        data: { duplicateGroupId: null },
      }),
      this.prisma.duplicateGroup.update({
        where: { id: group.id },
        data: {
          status: DuplicateGroupStatus.dismissed,
          resolvedById: userId,
          resolvedAt: new Date(),
        },
      }),
    ]);

    await this.createAuditEvent(userId, 'duplicate_group:dismissed', group.id, {
      ungrouped: memberCount,
    });

    this.logger.log(
      `Duplicate group ${group.id} dismissed by user ${userId}: ungrouped ${memberCount} items`,
    );

    return memberCount;
  }

  /**
   * Start an async run that dismisses every pending duplicate group in the
   * circle whose persisted `confidence` (0-1) is strictly below
   * `threshold / 100`. Members are ungrouped and the group marked dismissed —
   * nothing is archived or trashed, so dismiss never requires media:delete.
   *
   * Together with the resolve run above, one threshold partitions the pending
   * queue: resolve >= N%, dismiss < N%. Groups whose confidence is null
   * (uncomputable — fewer than two members carry an embedding) are excluded from
   * BOTH directions.
   */
  async bulkDismissDuplicateGroupsByThreshold(
    dto: BulkDismissDuplicateThresholdDto,
    userId: string,
    perms: string[],
  ) {
    const run = await this.reviewRuns.createRun({
      circleId: dto.circleId,
      subjectType: ReviewRunSubject.duplicate_group,
      action: ReviewRunAction.dismiss,
      threshold: dto.threshold,
      userId,
      perms,
    });

    return { data: { runId: run.id, status: run.status, matchedCount: run.matchedCount } };
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
