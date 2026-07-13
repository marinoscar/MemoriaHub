import { Injectable, Logger } from '@nestjs/common';
import { BurstGroupStatus, DuplicateGroupStatus, EnrichmentJob, MediaType, Prisma } from '@prisma/client';
import { computeVisualHash, hammingDistance } from '@memoriahub/enrichment-compute/dhash';
import { VISUAL_EMBEDDING_MODEL_TAG } from '@memoriahub/enrichment-compute/clip';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { streamToBuffer } from '../storage/processing/processors/stream-utils';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { VisualEmbeddingService } from './visual-embedding.service';

const DEFAULT_DEDUP_CONFIG = {
  similarityThreshold: 0.96,
  hashMaxDistance: 6,
  knnCandidates: 20,
};

/**
 * Output of the pure COMPUTE half of duplicate detection. This is a superset
 * of the node result contract (`duplicateDetectionResult` in
 * `@memoriahub/enrichment-compute/dto` — model/embedding/dHash): the
 * sharpness score falls out of the same dHash pipeline pass and is persisted
 * onto the MediaItem alongside the hash, so it rides along here rather than
 * being recomputed in a second decode.
 */
export interface DuplicateComputeResult {
  /** Model tag for the visual embedding (VISUAL_EMBEDDING_MODEL_TAG). */
  model: string;
  /** L2-normalized 512-d CLIP embedding, or null in degraded mode / undecodable image. */
  embedding: number[] | null;
  /** Unsigned 64-bit dHash as a decimal string, or null when undecodable. */
  dHash: string | null;
  /** Variance-of-Laplacian sharpness, or null when undecodable. */
  sharpnessScore: number | null;
}

/** The subject row shape shared by the guard/persist/grouping steps. */
interface EligibleItem {
  id: string;
  circleId: string;
  capturedAt: Date | null;
  perceptualHash: string | null;
  storageObjectId: string | null;
  burstGroupId: string | null;
}

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
 *
 * COMPUTE / PERSIST split (distributed-nodes spec §6): `computeDuplicate` is
 * the pure compute half (CLIP embed + dHash, no Prisma) that a worker node
 * runs against downloaded bytes; `persistDuplicate` is the server-only
 * persist half (embedding row, perceptualHash column, KNN/hash matching and
 * union-find grouping). The server's own `processMediaItem` composes the two
 * around a single byte download.
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

  // ---------------------------------------------------------------------
  // Server-side orchestration: load → download → compute → persist
  // ---------------------------------------------------------------------

  async processMediaItem(mediaItemId: string): Promise<void> {
    const item = await this.loadEligibleItem(mediaItemId);
    if (!item) {
      return;
    }

    // Only touch the original bytes when something is actually missing —
    // an item that already has both a perceptualHash and an embedding row
    // goes straight to matching without a download.
    const needsHash = item.perceptualHash === null;
    const needsEmbedding =
      this.visualEmbeddingService.isAvailable() &&
      !(await this.visualEmbeddingService.hasEmbedding(item.id));

    let result: DuplicateComputeResult | null = null;

    if ((needsHash || needsEmbedding) && item.storageObjectId) {
      const buffer = await this.downloadOriginalBytes(item, needsHash);
      if (buffer) {
        result = await this.computeDuplicate(buffer);
      }
    }

    await this.persistForItem(item, result);
  }

  // ---------------------------------------------------------------------
  // COMPUTE half — pure, no Prisma. This is exactly what a worker node runs.
  // ---------------------------------------------------------------------

  /**
   * Compute the duplicate-detection artifacts for one image's bytes: CLIP
   * visual embedding (best-effort; null in degraded mode or when the image
   * cannot be decoded) and dHash + sharpness (null when undecodable).
   */
  async computeDuplicate(buffer: Buffer): Promise<DuplicateComputeResult> {
    const embedding = await this.visualEmbeddingService.embedImage(buffer);
    const visualHash = await computeVisualHash(buffer);

    return {
      model: VISUAL_EMBEDDING_MODEL_TAG,
      embedding,
      dHash: visualHash?.perceptualHash ?? null,
      sharpnessScore: visualHash?.sharpnessScore ?? null,
    };
  }

  // ---------------------------------------------------------------------
  // PERSIST half — server-only Prisma writes + matching + grouping.
  // ---------------------------------------------------------------------

  /**
   * Persist a compute result for the job's media item, then run matching and
   * union-find grouping. Entry point for the (follow-up) node result-ingestion
   * path; the in-process path composes the same internals via processMediaItem.
   */
  async persistDuplicate(job: EnrichmentJob, result: DuplicateComputeResult): Promise<void> {
    if (!job.mediaItemId) {
      this.logger.warn(`persistDuplicate: job ${job.id} has no mediaItemId; skipping`);
      return;
    }

    const item = await this.loadEligibleItem(job.mediaItemId);
    if (!item) {
      return;
    }

    await this.persistForItem(item, result);
  }

  private async persistForItem(
    item: EligibleItem,
    result: DuplicateComputeResult | null,
  ): Promise<void> {
    let current = item;

    if (result?.embedding) {
      await this.visualEmbeddingService.persistEmbedding(
        item.id,
        item.circleId,
        result.embedding,
        result.model,
      );
    }

    if (current.perceptualHash === null && result?.dHash) {
      // Persist so subsequent runs (burst grouping, dedup matching, score
      // recompute) benefit without re-downloading the image.
      await this.prisma.mediaItem.update({
        where: { id: item.id },
        data: {
          perceptualHash: result.dHash,
          ...(result.sharpnessScore !== null ? { sharpnessScore: result.sharpnessScore } : {}),
        },
      });
      this.logger.log(
        `MediaItem ${item.id}: on-demand hash computed and persisted (dHash=${result.dHash})`,
      );
      current = { ...current, perceptualHash: result.dHash };
    }

    await this.linkAndGroup(current);
  }

  // ---------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------

  /**
   * Load the media item and apply the eligibility guards (exists, not
   * deleted/archived, is a photo, not in a PENDING burst group). Returns
   * null when the item should be skipped entirely.
   */
  private async loadEligibleItem(mediaItemId: string): Promise<EligibleItem | null> {
    const item = await this.prisma.mediaItem.findUnique({
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

    if (!item) {
      this.logger.warn(`MediaItem ${mediaItemId} not found; skipping duplicate detection`);
      return null;
    }

    if (item.deletedAt || item.archivedAt) {
      this.logger.debug(`MediaItem ${mediaItemId} is deleted/archived; skipping duplicate detection`);
      return null;
    }

    if (item.type !== MediaType.photo) {
      this.logger.debug(`MediaItem ${mediaItemId} is not a photo; skipping duplicate detection`);
      return null;
    }

    // Skip entirely while the item is still in an unreviewed (pending) burst
    // group — burst review may soft-delete or reshuffle members, so running
    // dedup concurrently would race against that review.
    if (item.burstGroupId) {
      const burstGroup = await this.prisma.burstGroup.findUnique({
        where: { id: item.burstGroupId },
        select: { status: true },
      });
      if (burstGroup?.status === BurstGroupStatus.pending) {
        this.logger.debug(
          `MediaItem ${mediaItemId} is in a pending burst group; skipping duplicate detection`,
        );
        return null;
      }
    }

    return item;
  }

  // ---------------------------------------------------------------------
  // Byte download (server path only — a node receives a presigned URL instead)
  // ---------------------------------------------------------------------

  /**
   * Download the item's original bytes from its own provider+bucket.
   *
   * Error semantics preserve the two pre-split code paths:
   *  - When the hash is missing (`rethrowOnDownloadError`), a transient
   *    storage error propagates so the enrichment worker's retry logic kicks
   *    in (previous on-demand hash-backfill behavior).
   *  - Otherwise the embedding is best-effort: failures are logged and the
   *    item proceeds with hash-only matching (previous ensureEmbedding
   *    behavior).
   */
  private async downloadOriginalBytes(
    item: EligibleItem,
    rethrowOnDownloadError: boolean,
  ): Promise<Buffer | null> {
    if (!item.storageObjectId) {
      return null;
    }

    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: item.storageObjectId },
      select: { storageKey: true, storageProvider: true, bucket: true },
    });

    if (!storageObject?.storageKey) {
      this.logger.warn(
        `MediaItem ${item.id}: storageObject ${item.storageObjectId} not found or has no storageKey; cannot compute`,
      );
      return null;
    }

    try {
      const provider = await this.resolver.getProviderFor(
        storageObject.storageProvider,
        storageObject.bucket,
      );
      const stream = await provider.download(storageObject.storageKey);
      return await streamToBuffer(stream);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (rethrowOnDownloadError) {
        this.logger.error(
          `MediaItem ${item.id}: byte download for duplicate detection failed (will retry): ${msg}`,
        );
        throw err;
      }
      this.logger.warn(
        `MediaItem ${item.id}: byte download failed; continuing with hash-only matching: ${msg}`,
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Matching + union-find grouping
  // ---------------------------------------------------------------------

  private async linkAndGroup(item: EligibleItem): Promise<void> {
    const settings = await this.systemSettings.getSettings();
    const dedupConfig = settings.dedup ?? DEFAULT_DEDUP_CONFIG;

    const subjectBurstGroupId = item.burstGroupId;
    const circleId = item.circleId;
    const mediaItemId = item.id;

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
      for (const candidate of hashCandidates) {
        if (!candidate.perceptualHash) continue;
        const dist = hammingDistance(item.perceptualHash, candidate.perceptualHash);
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

    // -----------------------------------------------------------------
    // Write-time burst precedence re-check (TOCTOU guard).
    //
    // The eligibility guard in loadEligibleItem ran at the START of this
    // job. Burst detection may have assigned this same item to a (pending)
    // burst group AFTER that guard but BEFORE we reach this write. To close
    // that race we take a row lock on the subject inside a transaction and
    // re-read its live burst state immediately before writing membership:
    //   - burst committed its pending burstGroupId first → we see it here
    //     and abort the dedup write (item stays out of the dup queue);
    //   - dedup commits the dup-group write first → burst's own Step-7
    //     evictFromDuplicateGroups now finds the item genuinely in a dup
    //     group and evicts it.
    // Either interleaving leaves the item in at most one queue. Only the
    // re-check + membership write live inside the transaction — the heavy
    // compute (download/CLIP/KNN/hash scan) stayed outside to keep the lock
    // hold-time minimal.
    // -----------------------------------------------------------------
    await this.prisma.$transaction(async (tx) => {
      const lockRows = await tx.$queryRaw<
        { burst_group_id: string | null; burst_status: string | null }[]
      >`
        SELECT m.burst_group_id AS burst_group_id, bg.status AS burst_status
        FROM media_items m
        LEFT JOIN burst_groups bg ON bg.id = m.burst_group_id
        WHERE m.id = ${mediaItemId}::uuid
        FOR UPDATE OF m
      `;

      const lock = lockRows[0];
      if (lock?.burst_group_id && lock.burst_status === BurstGroupStatus.pending) {
        this.logger.debug(
          `skipping dedup write for ${mediaItemId}: became burst member during job`,
        );
        // Mirror the "no duplicates / processed" early-return path: write
        // nothing that links the subject and commit an empty transaction.
        return;
      }

      let targetGroupId: string;

      if (existingGroupIds.length === 0) {
        const earliestCapturedAt = [item.capturedAt, ...linkedCandidates.map((c) => c.capturedAt)]
          .filter((d): d is Date => d !== null)
          .reduce<Date | null>((min, d) => (!min || d < min ? d : min), null);

        const newGroup = await tx.duplicateGroup.create({
          data: {
            circleId,
            status: DuplicateGroupStatus.pending,
            capturedAt: earliestCapturedAt,
            mediaCount: linkedCandidates.length + 1,
          },
          select: { id: true },
        });
        targetGroupId = newGroup.id;

        await tx.mediaItem.updateMany({
          where: { id: { in: [item.id, ...linkedCandidates.map((c) => c.id)] } },
          data: { duplicateGroupId: targetGroupId },
        });

        this.logger.log(
          `Created duplicate group ${targetGroupId} with ${linkedCandidates.length + 1} members (circleId=${circleId})`,
        );
      } else if (existingGroupIds.length === 1) {
        targetGroupId = existingGroupIds[0];

        await tx.mediaItem.update({
          where: { id: item.id },
          data: { duplicateGroupId: targetGroupId },
        });

        this.logger.log(`Assigned MediaItem ${mediaItemId} to existing duplicate group ${targetGroupId}`);
      } else {
        const groups = await tx.duplicateGroup.findMany({
          where: { id: { in: existingGroupIds } },
          select: { id: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        });

        targetGroupId = groups[0].id;
        const groupsToMerge = groups.slice(1).map((g) => g.id);

        await tx.mediaItem.updateMany({
          where: { duplicateGroupId: { in: groupsToMerge } },
          data: { duplicateGroupId: targetGroupId },
        });

        await tx.mediaItem.update({
          where: { id: item.id },
          data: { duplicateGroupId: targetGroupId },
        });

        await tx.duplicateGroup.deleteMany({
          where: { id: { in: groupsToMerge } },
        });

        this.logger.log(
          `Merged ${groupsToMerge.length} duplicate group(s) into ${targetGroupId} for MediaItem ${mediaItemId}`,
        );
      }

      await this.recomputeGroupMeta(targetGroupId, tx);
    });
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
  private async recomputeGroupMeta(
    groupId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const members = await db.mediaItem.findMany({
      where: { duplicateGroupId: groupId, deletedAt: null, archivedAt: null },
      select: { id: true, capturedAt: true },
    });

    if (members.length === 0) {
      await db.duplicateGroup.delete({ where: { id: groupId } }).catch(() => undefined);
      return;
    }

    if (members.length === 1) {
      // A duplicate group is invariant `mediaCount >= 2`; a lone survivor is
      // no longer a duplicate — clear its membership and delete the group.
      await db.mediaItem.updateMany({
        where: { id: members[0].id },
        data: { duplicateGroupId: null },
      });
      await db.duplicateGroup.delete({ where: { id: groupId } }).catch(() => undefined);
      return;
    }

    const earliestCapturedAt = members
      .map((m) => m.capturedAt)
      .filter((d): d is Date => d !== null)
      .reduce<Date | null>((min, d) => (!min || d < min ? d : min), null);

    await db.duplicateGroup.update({
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
