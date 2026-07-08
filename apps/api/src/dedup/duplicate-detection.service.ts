import { Injectable, Logger } from '@nestjs/common';
import { BurstGroupStatus, DuplicateGroupStatus, MediaType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { computeAndPersistVisualHash } from '../storage/processing/hash-backfill.util';
import { hammingDistance } from '../burst/burst-detection.service';
import { VisualEmbeddingService } from './visual-embedding.service';

const DEFAULT_DEDUP_CONFIG = {
  similarityThreshold: 0.96,
  hashMaxDistance: 6,
  knnCandidates: 20,
};

/**
 * DuplicateDetectionService
 *
 * Detects visually-identical photos (e.g. WhatsApp re-shares: recompressed,
 * resized, or filtered copies with different content hashes/EXIF) and groups
 * them into DuplicateGroup rows for human review — mirroring the burst
 * review-queue model (see BurstDetectionService).
 *
 * Two-tier matching, OR-combined:
 *   1. CLIP visual embedding cosine similarity (pgvector KNN) — catches
 *      recompressed/resized/filtered copies that no longer hash-match.
 *   2. dHash Hamming distance — catches near-identical byte-level copies
 *      even when no visual embedding is available (degraded mode).
 *
 * Grouping uses the same union-find create/join/merge-into-oldest approach
 * as BurstDetectionService. Best-copy scoring and kind classification are
 * READ-TIME computations performed by DuplicateService when a group is
 * listed/fetched — this service only maintains membership, mediaCount, and
 * the chronological capturedAt (earliest member).
 */
@Injectable()
export class DuplicateDetectionService {
  private readonly logger = new Logger(DuplicateDetectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: StorageProviderResolver,
    private readonly systemSettings: SystemSettingsService,
    private readonly visualEmbeddingService: VisualEmbeddingService,
  ) {}

  async processMediaItem(mediaItemId: string): Promise<void> {
    const rawItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        type: true,
        deletedAt: true,
        archivedAt: true,
        circleId: true,
        capturedAt: true,
        perceptualHash: true,
        storageObjectId: true,
        burstGroupId: true,
        duplicateGroupId: true,
      },
    });

    if (!rawItem) {
      this.logger.warn(`MediaItem ${mediaItemId} not found; skipping duplicate detection`);
      return;
    }

    if (rawItem.deletedAt || rawItem.archivedAt) {
      this.logger.debug(`MediaItem ${mediaItemId} is deleted/archived; skipping duplicate detection`);
      return;
    }

    if (rawItem.type !== MediaType.photo) {
      this.logger.debug(`MediaItem ${mediaItemId} is not a photo; skipping duplicate detection`);
      return;
    }

    // Skip entirely while the item is still in an unreviewed (pending) burst
    // group — burst review may soft-delete or reshuffle members, so running
    // dedup concurrently would race against that review.
    if (rawItem.burstGroupId) {
      const burstGroup = await this.prisma.burstGroup.findUnique({
        where: { id: rawItem.burstGroupId },
        select: { status: true },
      });
      if (burstGroup?.status === BurstGroupStatus.pending) {
        this.logger.debug(
          `MediaItem ${mediaItemId} is in a pending burst group; skipping duplicate detection`,
        );
        return;
      }
    }

    let item = rawItem;

    // Ensure dHash for legacy items lacking one (same on-demand backfill path
    // burst detection uses).
    if (item.perceptualHash === null && item.storageObjectId) {
      try {
        const computed = await computeAndPersistVisualHash(
          this.prisma,
          this.resolver,
          item.id,
          item.storageObjectId,
          this.logger,
        );
        if (computed) {
          item = { ...item, perceptualHash: computed.perceptualHash.toString() };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `MediaItem ${mediaItemId}: on-demand hash computation failed (will retry): ${msg}`,
        );
        throw err;
      }
    }

    // Ensure a visual embedding exists — best-effort; degraded mode returns
    // 'unavailable' and we fall back to hash-only matching below.
    await this.visualEmbeddingService.ensureEmbedding(mediaItemId);

    const settings = await this.systemSettings.getSettings();
    const dedupConfig = settings.dedup ?? DEFAULT_DEDUP_CONFIG;

    const subjectBurstGroupId = item.burstGroupId;
    const circleId = item.circleId;

    // ---------------------------------------------------------------------
    // Tier 1: KNN visual-embedding candidates (empty array when the subject
    // has no embedding — the inner JOIN on its own embedding row yields zero
    // rows, which is the desired degraded-mode fallback).
    // ---------------------------------------------------------------------
    const knnRows = await this.prisma.$queryRaw<{ id: string; sim: unknown }[]>`
      SELECT m.id AS id, (1 - (e.embedding <=> se.embedding)) AS sim
      FROM media_visual_embedding e
      JOIN media_items m ON m.id = e.media_item_id
      JOIN media_visual_embedding se ON se.media_item_id = ${mediaItemId}::uuid
      WHERE e.circle_id = ${circleId}::uuid
        AND m.id != ${mediaItemId}::uuid
        AND m.deleted_at IS NULL
        AND m.archived_at IS NULL
        AND m.type = 'photo'
        AND NOT EXISTS (
          SELECT 1 FROM burst_groups bg WHERE bg.id = m.burst_group_id AND bg.status = 'pending'
        )
        AND (m.burst_group_id IS NULL OR m.burst_group_id IS DISTINCT FROM ${subjectBurstGroupId}::uuid)
      ORDER BY e.embedding <=> se.embedding
      LIMIT ${dedupConfig.knnCandidates}
    `;

    // ---------------------------------------------------------------------
    // Tier 2: hash-only candidates (circle-scoped, uses the
    // (circle_id, perceptual_hash) index).
    // ---------------------------------------------------------------------
    const hashCandidates = item.perceptualHash
      ? await this.prisma.mediaItem.findMany({
          where: {
            circleId,
            type: MediaType.photo,
            deletedAt: null,
            archivedAt: null,
            id: { not: mediaItemId },
            perceptualHash: { not: null },
            OR: [{ burstGroupId: null }, { burstGroup: { status: { not: BurstGroupStatus.pending } } }],
            ...(subjectBurstGroupId ? { NOT: { burstGroupId: subjectBurstGroupId } } : {}),
          },
          select: { id: true, perceptualHash: true },
        })
      : [];

    const matchedIds = new Set<string>();

    for (const row of knnRows) {
      if (Number(row.sim) >= dedupConfig.similarityThreshold) {
        matchedIds.add(row.id);
      }
    }

    if (item.perceptualHash) {
      const subjectHash = BigInt(item.perceptualHash);
      for (const candidate of hashCandidates) {
        if (!candidate.perceptualHash) continue;
        const dist = hammingDistance(subjectHash, BigInt(candidate.perceptualHash));
        if (dist <= dedupConfig.hashMaxDistance) {
          matchedIds.add(candidate.id);
        }
      }
    }

    matchedIds.delete(mediaItemId);

    if (matchedIds.size === 0) {
      this.logger.debug(`No duplicate candidates found for MediaItem ${mediaItemId}`);
      return;
    }

    const linkedCandidates = await this.prisma.mediaItem.findMany({
      where: { id: { in: [...matchedIds] } },
      select: { id: true, duplicateGroupId: true, capturedAt: true },
    });

    // -----------------------------------------------------------------
    // Union-find group resolution (create / join / merge-into-oldest),
    // mirroring BurstDetectionService.processMediaItem.
    // -----------------------------------------------------------------
    const existingGroupIds = [
      ...new Set(
        linkedCandidates.map((c) => c.duplicateGroupId).filter((id): id is string => id !== null),
      ),
    ];

    let targetGroupId: string;

    if (existingGroupIds.length === 0) {
      const earliestCapturedAt = [item.capturedAt, ...linkedCandidates.map((c) => c.capturedAt)]
        .filter((d): d is Date => d !== null)
        .reduce<Date | null>((min, d) => (!min || d < min ? d : min), null);

      const newGroup = await this.prisma.duplicateGroup.create({
        data: {
          circleId,
          status: DuplicateGroupStatus.pending,
          capturedAt: earliestCapturedAt,
          mediaCount: linkedCandidates.length + 1,
        },
        select: { id: true },
      });
      targetGroupId = newGroup.id;

      await this.prisma.mediaItem.updateMany({
        where: { id: { in: [item.id, ...linkedCandidates.map((c) => c.id)] } },
        data: { duplicateGroupId: targetGroupId },
      });

      this.logger.log(
        `Created duplicate group ${targetGroupId} with ${linkedCandidates.length + 1} members (circleId=${circleId})`,
      );
    } else if (existingGroupIds.length === 1) {
      targetGroupId = existingGroupIds[0];

      await this.prisma.mediaItem.update({
        where: { id: item.id },
        data: { duplicateGroupId: targetGroupId },
      });

      this.logger.log(`Assigned MediaItem ${mediaItemId} to existing duplicate group ${targetGroupId}`);
    } else {
      const groups = await this.prisma.duplicateGroup.findMany({
        where: { id: { in: existingGroupIds } },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });

      targetGroupId = groups[0].id;
      const groupsToMerge = groups.slice(1).map((g) => g.id);

      await this.prisma.mediaItem.updateMany({
        where: { duplicateGroupId: { in: groupsToMerge } },
        data: { duplicateGroupId: targetGroupId },
      });

      await this.prisma.mediaItem.update({
        where: { id: item.id },
        data: { duplicateGroupId: targetGroupId },
      });

      await this.prisma.duplicateGroup.deleteMany({
        where: { id: { in: groupsToMerge } },
      });

      this.logger.log(
        `Merged ${groupsToMerge.length} duplicate group(s) into ${targetGroupId} for MediaItem ${mediaItemId}`,
      );
    }

    await this.recomputeGroupMeta(targetGroupId);
  }

  /**
   * Recompute mediaCount and the chronological capturedAt (earliest active
   * member) for a duplicate group after membership changes. Deletes the
   * group if it has fallen below the invariant `mediaCount >= 2` — either
   * emptied out entirely, or shrunk to a single lone member whose
   * duplicateGroupId is then cleared (a 1-member duplicate group is
   * meaningless). Defensive — membership can shrink via trash/archive
   * actions or burst eviction elsewhere.
   */
  private async recomputeGroupMeta(groupId: string): Promise<void> {
    const members = await this.prisma.mediaItem.findMany({
      where: { duplicateGroupId: groupId, deletedAt: null, archivedAt: null },
      select: { id: true, capturedAt: true },
    });

    if (members.length === 0) {
      await this.prisma.duplicateGroup.delete({ where: { id: groupId } }).catch(() => undefined);
      return;
    }

    if (members.length === 1) {
      // A duplicate group is invariant `mediaCount >= 2`; a lone survivor is
      // no longer a duplicate — clear its membership and delete the group.
      await this.prisma.mediaItem.updateMany({
        where: { id: members[0].id },
        data: { duplicateGroupId: null },
      });
      await this.prisma.duplicateGroup.delete({ where: { id: groupId } }).catch(() => undefined);
      return;
    }

    const earliestCapturedAt = members
      .map((m) => m.capturedAt)
      .filter((d): d is Date => d !== null)
      .reduce<Date | null>((min, d) => (!min || d < min ? d : min), null);

    await this.prisma.duplicateGroup.update({
      where: { id: groupId },
      data: {
        mediaCount: members.length,
        ...(earliestCapturedAt ? { capturedAt: earliestCapturedAt } : {}),
      },
    });
  }

  /**
   * Evict a set of media items from whatever duplicate group they currently
   * belong to, then recompute/clean the affected groups. Used by burst
   * detection: burst wins over duplicate detection, so once an item lands in
   * a burst group it must be pulled out of any near-duplicate group it was
   * prematurely placed in (upload ordering race — see the duplicate-detection
   * spec). Idempotent: items with a null duplicateGroupId are no-ops.
   */
  async evictFromDuplicateGroups(itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;

    const linked = await this.prisma.mediaItem.findMany({
      where: { id: { in: itemIds }, duplicateGroupId: { not: null } },
      select: { id: true, duplicateGroupId: true },
    });

    if (linked.length === 0) return;

    const affectedGroupIds = [
      ...new Set(linked.map((m) => m.duplicateGroupId).filter((id): id is string => id !== null)),
    ];

    await this.prisma.mediaItem.updateMany({
      where: { id: { in: linked.map((m) => m.id) } },
      data: { duplicateGroupId: null },
    });

    for (const groupId of affectedGroupIds) {
      await this.recomputeGroupMeta(groupId);
    }

    this.logger.log(
      `Evicted ${linked.length} item(s) from ${affectedGroupIds.length} duplicate group(s) (burst wins)`,
    );
  }

  /**
   * One-time remediation for photos already double-listed in both the burst
   * and duplicate review queues (uploads processed before the eviction fix
   * existed). Finds every media item that is BOTH in a pending burst group
   * AND in a duplicate group, optionally scoped to a circle, evicts them from
   * their duplicate groups, and returns the count evicted.
   */
  async evictExistingBurstOverlaps(circleId?: string): Promise<{ evicted: number }> {
    const overlaps = await this.prisma.mediaItem.findMany({
      where: {
        ...(circleId ? { circleId } : {}),
        duplicateGroupId: { not: null },
        burstGroup: { status: BurstGroupStatus.pending },
      },
      select: { id: true },
    });

    if (overlaps.length === 0) {
      return { evicted: 0 };
    }

    await this.evictFromDuplicateGroups(overlaps.map((o) => o.id));

    return { evicted: overlaps.length };
  }
}
