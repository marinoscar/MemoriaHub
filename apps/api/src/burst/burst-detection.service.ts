import { Inject, Injectable, Logger } from '@nestjs/common';
import { EnrichmentJob, MediaType, BurstGroupStatus, JobReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { computeAndPersistVisualHash } from '../storage/processing/hash-backfill.util';

/**
 * Computes the Hamming distance between two 64-bit perceptual hashes.
 *
 * Inputs are unsigned BigInts parsed from the TEXT column (unsigned decimal
 * strings), so they are always non-negative. The XOR of two non-negative
 * BigInts is also non-negative and the popcount loop terminates correctly
 * without any masking.
 */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
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
export class BurstDetectionService {
  private readonly logger = new Logger(BurstDetectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
    private readonly resolver: StorageProviderResolver,
  ) {}

  async processMediaItem(job: EnrichmentJob): Promise<void> {
    const mediaItemId = job.mediaItemId;
    if (!mediaItemId) {
      this.logger.warn(`burst_detection job ${job.id} has no mediaItemId; skipping`);
      return;
    }

    // Step 1: Load the MediaItem
    const rawItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        perceptualHash: true,
        sharpnessScore: true,
        burstUuid: true,
        capturedAt: true,
        width: true,
        height: true,
        cameraMake: true,
        cameraModel: true,
        circleId: true,
        deletedAt: true,
        burstGroupId: true,
        storageObjectId: true,
      },
    });

    if (!rawItem) {
      this.logger.warn(`MediaItem ${mediaItemId} not found; skipping burst detection`);
      return;
    }

    if (rawItem.deletedAt) {
      this.logger.debug(`MediaItem ${mediaItemId} is deleted; skipping burst detection`);
      return;
    }

    if (!rawItem.capturedAt) {
      this.logger.debug(`MediaItem ${mediaItemId} has no capturedAt; cannot do temporal proximity grouping`);
      return;
    }

    // After the guard above capturedAt is narrowed to Date; store it explicitly
    // so TypeScript knows it is non-null in subsequent accesses on `item`.
    const capturedAt: Date = rawItem.capturedAt;

    // Build a mutable copy so we can patch perceptualHash/sharpnessScore below
    // without mutating the raw Prisma result.
    let item = { ...rawItem, capturedAt };

    // Step 1b: On-demand hash computation for legacy photos.
    // Only attempt when perceptualHash is null AND we have a storageObjectId to
    // download from. If computation fails non-transiently, we continue without
    // a hash (BurstUUID grouping still works; temporal-only linking is skipped
    // by the existing null-hash guard in Step 4).
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
          // Convert bigint → unsigned decimal string to match the DB column type.
          item = {
            ...item,
            perceptualHash: computed.perceptualHash.toString(),
            sharpnessScore: computed.sharpnessScore,
          };
        }
      } catch (err) {
        // Re-throw to let the enrichment worker retry on transient errors
        // (e.g. storage unavailable). Permanently unreadable files should
        // return null from computeAndPersistHashOnDemand, not throw.
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `MediaItem ${mediaItemId}: on-demand hash computation failed with error (will retry): ${msg}`,
        );
        throw err;
      }
    }

    // Step 2: Load system settings for burst config
    const settings = await this.prisma.systemSettings.findUnique({
      where: { key: 'global' },
      select: { value: true },
    });
    const value = (settings?.value as Record<string, unknown> | null) ?? {};
    const burstConfig = value['burst'] as { timeGapSeconds?: number; hashDistance?: number; minGroupSize?: number } | undefined;
    const timeGapSeconds = burstConfig?.timeGapSeconds ?? 10;
    const hashDistance = burstConfig?.hashDistance ?? 10;

    // Step 3: Build candidate neighbor query conditions
    const deviceCondition =
      item.cameraMake && item.cameraModel
        ? [{ cameraMake: item.cameraMake, cameraModel: item.cameraModel }]
        : [];
    const burstUuidCondition =
      item.burstUuid
        ? [{ burstUuid: item.burstUuid }]
        : [];

    // If we have no device info and no burstUuid, we cannot link to anything
    if (deviceCondition.length === 0 && burstUuidCondition.length === 0) {
      this.logger.debug(
        `MediaItem ${mediaItemId} has no cameraMake/cameraModel and no burstUuid; cannot link`,
      );
      return;
    }

    const windowStart = new Date(item.capturedAt.getTime() - timeGapSeconds * 1000);

    const candidates = await this.prisma.mediaItem.findMany({
      where: {
        circleId: item.circleId,
        type: MediaType.photo,
        deletedAt: null,
        id: { not: item.id },
        capturedAt: { gte: windowStart, lte: item.capturedAt },
        OR: [...deviceCondition, ...burstUuidCondition],
      },
      select: {
        id: true,
        perceptualHash: true,
        burstUuid: true,
        burstGroupId: true,
        capturedAt: true,
      },
      orderBy: { capturedAt: 'desc' },
    });

    if (candidates.length === 0) {
      this.logger.debug(`No candidate neighbors found for MediaItem ${mediaItemId}`);
      return;
    }

    // Step 4: For each candidate, determine whether to link
    const linkedCandidates: typeof candidates = [];

    for (const candidate of candidates) {
      // BurstUUID hard prior: if both share a non-null burstUuid, always link
      if (item.burstUuid && candidate.burstUuid && item.burstUuid === candidate.burstUuid) {
        linkedCandidates.push(candidate);
        continue;
      }

      // Cannot compute visual similarity without both hashes
      if (!item.perceptualHash || !candidate.perceptualHash) {
        continue;
      }

      // Parse unsigned decimal strings from the TEXT column into BigInts for
      // the popcount loop. Both values are guaranteed non-null here.
      const dist = hammingDistance(BigInt(item.perceptualHash), BigInt(candidate.perceptualHash));
      if (dist <= hashDistance) {
        linkedCandidates.push(candidate);
      }
    }

    if (linkedCandidates.length === 0) {
      this.logger.debug(`No linked neighbors found for MediaItem ${mediaItemId}`);
      return;
    }

    // Step 5: Group resolution
    const existingGroupIds = [
      ...new Set(
        linkedCandidates
          .map((c) => c.burstGroupId)
          .filter((id): id is string => id !== null),
      ),
    ];

    let targetGroupId: string;

    if (existingGroupIds.length === 0) {
      // All linked neighbors are ungrouped — create a new group
      const earliestCapturedAt = [item.capturedAt, ...linkedCandidates.map((c) => c.capturedAt)]
        .filter((d): d is Date => d !== null)
        .reduce((min, d) => (d < min ? d : min), item.capturedAt);

      const newGroup = await this.prisma.burstGroup.create({
        data: {
          circleId: item.circleId,
          status: BurstGroupStatus.pending,
          capturedAt: earliestCapturedAt,
          mediaCount: linkedCandidates.length + 1,
        },
        select: { id: true },
      });
      targetGroupId = newGroup.id;

      // Assign item and all linked neighbors to the new group
      const idsToAssign = [item.id, ...linkedCandidates.map((c) => c.id)];
      await this.prisma.mediaItem.updateMany({
        where: { id: { in: idsToAssign } },
        data: { burstGroupId: targetGroupId },
      });

      this.logger.log(
        `Created burst group ${targetGroupId} with ${idsToAssign.length} members (circleId=${item.circleId})`,
      );
    } else if (existingGroupIds.length === 1) {
      // All linked neighbors belong to one existing group — join it
      targetGroupId = existingGroupIds[0];

      await this.prisma.mediaItem.update({
        where: { id: item.id },
        data: { burstGroupId: targetGroupId },
      });

      this.logger.log(`Assigned MediaItem ${mediaItemId} to existing burst group ${targetGroupId}`);
    } else {
      // Multiple distinct groups — merge into the oldest one (by createdAt)
      const groups = await this.prisma.burstGroup.findMany({
        where: { id: { in: existingGroupIds } },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });

      targetGroupId = groups[0].id;
      const groupsToMerge = groups.slice(1).map((g) => g.id);

      // Reassign members from all secondary groups to the target group
      await this.prisma.mediaItem.updateMany({
        where: { burstGroupId: { in: groupsToMerge } },
        data: { burstGroupId: targetGroupId },
      });

      // Also assign the current item
      await this.prisma.mediaItem.update({
        where: { id: item.id },
        data: { burstGroupId: targetGroupId },
      });

      // Delete now-empty secondary groups
      await this.prisma.burstGroup.deleteMany({
        where: { id: { in: groupsToMerge } },
      });

      this.logger.log(
        `Merged ${groupsToMerge.length} burst group(s) into ${targetGroupId} for MediaItem ${mediaItemId}`,
      );
    }

    // Step 6: Recompute scores for all group members
    await this.recomputeGroupScores(targetGroupId, item.circleId);
  }

  private async recomputeGroupScores(groupId: string, circleId: string): Promise<void> {
    // Load all current group members
    const members = await this.prisma.mediaItem.findMany({
      where: { burstGroupId: groupId, deletedAt: null },
      select: { id: true, sharpnessScore: true, width: true, height: true, capturedAt: true },
    });

    if (members.length === 0) return;

    // Load face data for best-shot scoring
    interface FaceGroupResult {
      mediaItemId: string;
      _count: { id: number };
      _avg: { confidence: number | null };
    }

    const faceData = await this.prisma.face.groupBy({
      by: ['mediaItemId'],
      where: { mediaItemId: { in: members.map((m) => m.id) } },
      _count: { id: true },
      _avg: { confidence: true },
    }) as unknown as FaceGroupResult[];

    const faceMap = new Map(
      faceData.map((f) => [
        f.mediaItemId,
        { count: f._count.id, avgConf: f._avg.confidence ?? 0 },
      ]),
    );

    // Compute sub-signals
    const sharpValues = members.map((m) => m.sharpnessScore ?? 0);
    const resValues = members.map((m) => (m.width ?? 0) * (m.height ?? 0));
    const faceSignals = members.map((m) => {
      const fd = faceMap.get(m.id);
      if (!fd) return 0;
      return fd.count * fd.avgConf;
    });

    const sharpScores = normalize(sharpValues);
    const resScores = normalize(resValues);
    const faceScores = normalize(faceSignals);

    const hasFaceData = faceMap.size > 0;
    const wSharp = hasFaceData ? 0.6 : 0.9;
    const wFace = hasFaceData ? 0.3 : 0.0;
    const wRes = 0.1;

    const burstScores = members.map((_, i) => {
      return wSharp * sharpScores[i] + wFace * faceScores[i] + wRes * resScores[i];
    });

    const bestIdx = burstScores.indexOf(Math.max(...burstScores));
    const suggestedBestItemId = members[bestIdx].id;

    const earliestCapturedAt = members
      .map((m) => m.capturedAt)
      .filter((d): d is Date => d !== null)
      .reduce<Date | null>((min, d) => (!min || d < min ? d : min), null);

    // Write burst scores to all members and update the group
    await this.prisma.$transaction([
      ...members.map((m, i) =>
        this.prisma.mediaItem.update({
          where: { id: m.id },
          data: { burstScore: burstScores[i] },
        }),
      ),
      this.prisma.burstGroup.update({
        where: { id: groupId },
        data: {
          suggestedBestItemId,
          mediaCount: members.length,
          ...(earliestCapturedAt ? { capturedAt: earliestCapturedAt } : {}),
        },
      }),
    ]);

    this.logger.debug(
      `Recomputed scores for burst group ${groupId}: ${members.length} members, best=${suggestedBestItemId}`,
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
      type: 'burst_detection',
      mediaItemId: mediaItem.id,
      circleId: mediaItem.circleId,
      reason: JobReason.rerun,
      priority: 0,
    });

    return { jobId: job.id, status: job.status };
  }
}
