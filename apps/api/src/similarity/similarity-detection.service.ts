import { Inject, Injectable, Logger } from '@nestjs/common';
import { EnrichmentJob, MediaType, SimilarityGroupStatus, JobReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { streamToBuffer } from '../storage/processing/processors/stream-utils';
import { computeVisualHash } from '../storage/processing/visual-hash.util';

/**
 * Converts a 64-bit dHash stored as an unsigned decimal string to a 64-character
 * '0'/'1' bit string suitable for writing to a Postgres bit(64) column via raw SQL.
 *
 * The perceptual_hash column stores the hash as an unsigned decimal string (TEXT)
 * because Postgres bigint is signed and cannot hold values with the high bit set.
 * For the dhash_bits bit(64) column we use BigInt arithmetic to extract each bit
 * positionally, avoiding any signed-integer overflow.
 */
export function dhashDecimalToBitString(decimal: string): string {
  let value = BigInt(decimal);
  const bits: string[] = new Array(64);
  for (let i = 63; i >= 0; i--) {
    bits[i] = (value & 1n) === 1n ? '1' : '0';
    value >>= 1n;
  }
  return bits.join('');
}

/**
 * Normalizes an array of numbers to [0, 1] within the group.
 * When all values are equal, returns 0.5 for each.
 */
function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

@Injectable()
export class SimilarityDetectionService {
  private readonly logger = new Logger(SimilarityDetectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
  ) {}

  /**
   * For photos uploaded before the visual-hash processor was introduced,
   * perceptualHash may be null. This method fetches image bytes from storage,
   * computes the hash on demand, and persists both perceptualHash and sharpnessScore.
   *
   * Transient errors are re-thrown so the enrichment queue retries.
   * Permanently unreadable images return null (logged, skipped).
   */
  private async computeAndPersistHashOnDemand(
    mediaItemId: string,
    storageObjectId: string,
  ): Promise<{ perceptualHash: bigint; sharpnessScore: number } | null> {
    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: storageObjectId },
      select: { storageKey: true },
    });

    if (!storageObject?.storageKey) {
      this.logger.warn(
        `MediaItem ${mediaItemId}: storageObject ${storageObjectId} not found or has no storageKey; cannot compute hash`,
      );
      return null;
    }

    const stream = await this.storageProvider.download(storageObject.storageKey);
    const buffer = await streamToBuffer(stream);

    const result = await computeVisualHash(buffer);

    if (!result) {
      this.logger.warn(
        `MediaItem ${mediaItemId}: computeVisualHash returned null for key ${storageObject.storageKey}; item will skip hash-based grouping`,
      );
      return null;
    }

    const { perceptualHash, sharpnessScore } = result;

    await this.prisma.mediaItem.update({
      where: { id: mediaItemId },
      data: {
        perceptualHash: perceptualHash.toString(),
        sharpnessScore,
      },
    });

    this.logger.log(
      `MediaItem ${mediaItemId}: on-demand hash computed and persisted (dHash=${perceptualHash}, sharpness=${sharpnessScore.toFixed(2)})`,
    );

    return { perceptualHash, sharpnessScore };
  }

  async processMediaItem(job: EnrichmentJob): Promise<void> {
    const mediaItemId = job.mediaItemId;
    if (!mediaItemId) {
      this.logger.warn(`similarity_detection job ${job.id} has no mediaItemId; skipping`);
      return;
    }

    // Step 1: Load the MediaItem
    const rawItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        type: true,
        mimeType: true,
        perceptualHash: true,
        sharpnessScore: true,
        width: true,
        height: true,
        circleId: true,
        deletedAt: true,
        similarityGroupId: true,
        storageObjectId: true,
      },
    });

    if (!rawItem) {
      this.logger.warn(`MediaItem ${mediaItemId} not found; skipping similarity detection`);
      return;
    }

    if (rawItem.deletedAt) {
      this.logger.debug(`MediaItem ${mediaItemId} is deleted; skipping similarity detection`);
      return;
    }

    // Only photos/images are supported for visual de-duplication
    if (rawItem.type !== MediaType.photo) {
      this.logger.debug(
        `MediaItem ${mediaItemId} is type ${rawItem.type}; skipping similarity detection`,
      );
      return;
    }

    // Build a mutable copy so we can patch perceptualHash/sharpnessScore below
    let item = { ...rawItem };

    // Step 1b: On-demand hash computation for legacy photos
    if (item.perceptualHash === null && item.storageObjectId) {
      try {
        const computed = await this.computeAndPersistHashOnDemand(
          item.id,
          item.storageObjectId,
        );
        if (computed) {
          item = {
            ...item,
            perceptualHash: computed.perceptualHash.toString(),
            sharpnessScore: computed.sharpnessScore,
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `MediaItem ${mediaItemId}: on-demand hash computation failed (will retry): ${msg}`,
        );
        throw err;
      }
    }

    // Step 2: Without a hash we cannot do visual deduplication
    if (!item.perceptualHash) {
      this.logger.debug(
        `MediaItem ${mediaItemId} has no perceptualHash; cannot do visual deduplication`,
      );
      return;
    }

    // Step 3: Ensure dhash_bits is populated via raw SQL bit(64) write
    const bitString = dhashDecimalToBitString(item.perceptualHash);
    await this.prisma.$executeRaw`
      UPDATE media_items
      SET dhash_bits = ${bitString}::bit(64)
      WHERE id = ${mediaItemId}::uuid
    `;

    // Step 4: Load similarity config from system settings
    const settings = await this.prisma.systemSettings.findUnique({
      where: { key: 'global' },
      select: { value: true },
    });
    const value = (settings?.value as Record<string, unknown> | null) ?? {};
    const simConfig = value['similarity'] as {
      hashDistance?: number;
      minGroupSize?: number;
      maxGroupSize?: number;
    } | undefined;
    const hashDistance = simConfig?.hashDistance ?? 6;
    const maxGroupSize = simConfig?.maxGroupSize ?? 50;

    // Step 5: NEIGHBOR QUERY — find circle items within Hamming distance using bit_count(xor)
    // dhash_bits uses Postgres native bit(64) type; # is the XOR operator, bit_count counts set bits.
    type NeighborRow = { id: string; similarity_group_id: string | null };
    const neighbors = await this.prisma.$queryRaw<NeighborRow[]>`
      SELECT id, similarity_group_id
      FROM media_items
      WHERE circle_id = ${item.circleId}::uuid
        AND deleted_at IS NULL
        AND id != ${mediaItemId}::uuid
        AND dhash_bits IS NOT NULL
        AND bit_count(dhash_bits # ${bitString}::bit(64)) <= ${hashDistance}
    `;

    if (neighbors.length === 0) {
      this.logger.debug(`No visual neighbors found for MediaItem ${mediaItemId}`);
      return;
    }

    // Step 6: Union-Find group resolution (mirrors burst module pattern)
    const existingGroupIds = [
      ...new Set(
        neighbors
          .map((n) => n.similarity_group_id)
          .filter((id): id is string => id !== null),
      ),
    ];

    let targetGroupId: string;

    if (existingGroupIds.length === 0) {
      // All neighbors are ungrouped — create a new group
      const newGroup = await this.prisma.similarityGroup.create({
        data: {
          circleId: item.circleId,
          status: SimilarityGroupStatus.pending,
          mediaCount: neighbors.length + 1,
        },
        select: { id: true },
      });
      targetGroupId = newGroup.id;

      const idsToAssign = [item.id, ...neighbors.map((n) => n.id)];

      // Cap group size to maxGroupSize
      const capped = idsToAssign.slice(0, maxGroupSize);
      await this.prisma.mediaItem.updateMany({
        where: { id: { in: capped } },
        data: { similarityGroupId: targetGroupId },
      });

      this.logger.log(
        `Created similarity group ${targetGroupId} with ${capped.length} members (circleId=${item.circleId})`,
      );
    } else if (existingGroupIds.length === 1) {
      // All neighbors belong to one existing group — join it
      targetGroupId = existingGroupIds[0];

      // Only join if the group hasn't exceeded maxGroupSize
      const currentCount = await this.prisma.mediaItem.count({
        where: { similarityGroupId: targetGroupId, deletedAt: null },
      });

      if (currentCount < maxGroupSize) {
        await this.prisma.mediaItem.update({
          where: { id: item.id },
          data: { similarityGroupId: targetGroupId },
        });
        this.logger.log(
          `Assigned MediaItem ${mediaItemId} to existing similarity group ${targetGroupId}`,
        );
      } else {
        this.logger.debug(
          `Similarity group ${targetGroupId} already at maxGroupSize=${maxGroupSize}; not joining`,
        );
        return;
      }
    } else {
      // Multiple distinct groups — merge into the oldest one (by createdAt)
      const groups = await this.prisma.similarityGroup.findMany({
        where: { id: { in: existingGroupIds } },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });

      targetGroupId = groups[0].id;
      const groupsToMerge = groups.slice(1).map((g) => g.id);

      // Reassign members from secondary groups to the target group
      await this.prisma.mediaItem.updateMany({
        where: { similarityGroupId: { in: groupsToMerge } },
        data: { similarityGroupId: targetGroupId },
      });

      // Also assign the current item
      await this.prisma.mediaItem.update({
        where: { id: item.id },
        data: { similarityGroupId: targetGroupId },
      });

      // Enforce maxGroupSize on the merged group
      const mergedMembers = await this.prisma.mediaItem.findMany({
        where: { similarityGroupId: targetGroupId, deletedAt: null },
        select: { id: true },
        orderBy: { importedAt: 'desc' },
        skip: maxGroupSize,
      });
      if (mergedMembers.length > 0) {
        await this.prisma.mediaItem.updateMany({
          where: { id: { in: mergedMembers.map((m) => m.id) } },
          data: { similarityGroupId: null, similarityScore: null },
        });
      }

      // Delete now-empty secondary groups
      await this.prisma.similarityGroup.deleteMany({
        where: { id: { in: groupsToMerge } },
      });

      this.logger.log(
        `Merged ${groupsToMerge.length} similarity group(s) into ${targetGroupId} for MediaItem ${mediaItemId}`,
      );
    }

    // Step 7: Recompute best-shot scores for all group members
    await this.recomputeGroupScores(targetGroupId);
  }

  private async recomputeGroupScores(groupId: string): Promise<void> {
    const members = await this.prisma.mediaItem.findMany({
      where: { similarityGroupId: groupId, deletedAt: null },
      select: { id: true, sharpnessScore: true, width: true, height: true },
    });

    if (members.length === 0) return;

    // Compute normalized composite of sharpnessScore + resolution
    const sharpValues = members.map((m) => m.sharpnessScore ?? 0);
    const resValues = members.map((m) => (m.width ?? 0) * (m.height ?? 0));

    const sharpScores = normalize(sharpValues);
    const resScores = normalize(resValues);

    // Weight: sharpness 90%, resolution 10%
    const similarityScores = members.map((_, i) => 0.9 * sharpScores[i] + 0.1 * resScores[i]);

    const bestIdx = similarityScores.indexOf(Math.max(...similarityScores));
    const suggestedBestItemId = members[bestIdx].id;

    await this.prisma.$transaction([
      ...members.map((m, i) =>
        this.prisma.mediaItem.update({
          where: { id: m.id },
          data: { similarityScore: similarityScores[i] },
        }),
      ),
      this.prisma.similarityGroup.update({
        where: { id: groupId },
        data: {
          suggestedBestItemId,
          mediaCount: members.length,
        },
      }),
    ]);

    this.logger.debug(
      `Recomputed scores for similarity group ${groupId}: ${members.length} members, best=${suggestedBestItemId}`,
    );
  }

  async processMediaItemRerun(mediaItemId: string): Promise<{ jobId: string; status: string }> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true },
    });
    if (!mediaItem) {
      throw new Error(`MediaItem ${mediaItemId} not found`);
    }

    const job = await this.enrichmentJobService.enqueue({
      type: 'similarity_detection',
      mediaItemId: mediaItem.id,
      circleId: mediaItem.circleId,
      reason: JobReason.rerun,
      priority: 0,
    });

    return { jobId: job.id, status: job.status };
  }
}
