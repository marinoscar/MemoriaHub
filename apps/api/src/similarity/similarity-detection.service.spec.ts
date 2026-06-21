/**
 * Unit tests for SimilarityDetectionService.
 *
 * Covers:
 *  - dhashDecimalToBitString: zero, single-bit, max uint64, high-bit value, round-trip
 *  - processMediaItem early-exit guards: no mediaItemId, item not found, soft-deleted,
 *    non-photo type, null perceptualHash + null storageObjectId, no neighbors
 *  - On-demand hash computation for legacy photos (perceptualHash null + storageObjectId set)
 *  - Group creation with all ungrouped neighbors (caps at maxGroupSize)
 *  - Join existing group (one existing group, size < maxGroupSize; size >= maxGroupSize returns early)
 *  - Merge multiple distinct groups (reassigns, deletes secondaries, enforces maxGroupSize overflow)
 *  - Score recomputation (recomputeGroupScores): best picker, [0,1] range, equal-sharpness → 0.5,
 *    mediaCount update on group
 */

// ---------------------------------------------------------------------------
// Module-level mock: computeVisualHash
// ---------------------------------------------------------------------------
jest.mock('../storage/processing/visual-hash.util', () => ({
  computeVisualHash: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import {
  SimilarityDetectionService,
  dhashDecimalToBitString,
} from './similarity-detection.service';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { EnrichmentJob, JobReason, JobStatus, MediaType, SimilarityGroupStatus } from '@prisma/client';
import { computeVisualHash } from '../storage/processing/visual-hash.util';
import { Readable } from 'stream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'similarity_detection',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.upload,
    priority: 10,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 0,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeMediaItem(overrides: Partial<{
  id: string;
  type: MediaType;
  mimeType: string;
  circleId: string;
  perceptualHash: string | null;
  sharpnessScore: number | null;
  width: number | null;
  height: number | null;
  deletedAt: Date | null;
  similarityGroupId: string | null;
  storageObjectId: string | null;
}> = {}) {
  return {
    id: 'media-1',
    type: MediaType.photo,
    mimeType: 'image/jpeg',
    circleId: 'circle-1',
    perceptualHash: '12345',
    sharpnessScore: 100,
    width: 4032,
    height: 3024,
    deletedAt: null,
    similarityGroupId: null,
    storageObjectId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dhashDecimalToBitString', () => {
  it('zero → 64-character string of all zeros', () => {
    const result = dhashDecimalToBitString('0');
    expect(result).toBe('0'.repeat(64));
    expect(result).toHaveLength(64);
  });

  it('"1" → 63 zeros followed by a single "1" (LSB set)', () => {
    const result = dhashDecimalToBitString('1');
    expect(result).toBe('0'.repeat(63) + '1');
    expect(result).toHaveLength(64);
  });

  it('max unsigned 64-bit (2^64 - 1) → 64 ones without overflow', () => {
    const maxUint64 = '18446744073709551615'; // (2^64) - 1
    const result = dhashDecimalToBitString(maxUint64);
    expect(result).toBe('1'.repeat(64));
    expect(result).toHaveLength(64);
  });

  it('high-bit value (16488331711678253075) converts correctly without signed-overflow', () => {
    const highBitDecimal = '16488331711678253075';
    const result = dhashDecimalToBitString(highBitDecimal);
    expect(result).toHaveLength(64);
    // Verify round-trip: parse the bit string back as binary BigInt → equals original
    expect(BigInt('0b' + result)).toBe(BigInt(highBitDecimal));
  });

  it('output is always exactly 64 characters', () => {
    const samples = ['0', '1', '255', '65536', '18446744073709551615', '9223372036854775808'];
    for (const s of samples) {
      expect(dhashDecimalToBitString(s)).toHaveLength(64);
    }
  });

  it('round-trip: any decimal string parses back to the same BigInt', () => {
    const values = ['42', '999999999999', '16488331711678253075', '18446744073709551615'];
    for (const decimal of values) {
      const bits = dhashDecimalToBitString(decimal);
      expect(BigInt('0b' + bits)).toBe(BigInt(decimal));
    }
  });
});

describe('SimilarityDetectionService', () => {
  let service: SimilarityDetectionService;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let mockStorageProvider: { download: jest.Mock; getSignedDownloadUrl: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = { enqueue: jest.fn() };
    mockStorageProvider = {
      download: jest.fn(),
      getSignedDownloadUrl: jest.fn(),
    };

    // Default system settings: standard similarity config
    (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue({
      key: 'global',
      value: { similarity: { hashDistance: 6, minGroupSize: 2, maxGroupSize: 50 } },
    });

    // Default: $transaction executes array operations in parallel
    (mockPrisma.$transaction as jest.Mock).mockImplementation((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SimilarityDetectionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
      ],
    }).compile();

    service = module.get<SimilarityDetectionService>(SimilarityDetectionService);

    // Reset mocks between tests
    jest.clearAllMocks();

    // Re-apply defaults cleared by clearAllMocks
    (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue({
      key: 'global',
      value: { similarity: { hashDistance: 6, minGroupSize: 2, maxGroupSize: 50 } },
    });
    (mockPrisma.$transaction as jest.Mock).mockImplementation((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );
    // $executeRaw is used for the dhash_bits UPDATE
    (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Early-exit guards
  // -------------------------------------------------------------------------

  describe('early-exit guards', () => {
    it('returns early when job has no mediaItemId', async () => {
      await service.processMediaItem(makeJob({ mediaItemId: null }));
      expect(mockPrisma.mediaItem.findUnique).not.toHaveBeenCalled();
    });

    it('returns early when mediaItem is not found', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);
      await service.processMediaItem(makeJob());
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns early when mediaItem is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );
      await service.processMediaItem(makeJob());
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns early when mediaItem is type video (not photo)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ type: MediaType.video }),
      );
      await service.processMediaItem(makeJob());
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns early when perceptualHash is null and storageObjectId is null', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ perceptualHash: null, storageObjectId: null }),
      );
      await service.processMediaItem(makeJob());
      // Without a hash and no way to compute one, neighbor query should not run
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns early when $queryRaw returns zero neighbors', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      await service.processMediaItem(makeJob());
      expect(mockPrisma.similarityGroup.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // On-demand hash for legacy photos
  // -------------------------------------------------------------------------

  describe('on-demand hash computation (perceptualHash === null, storageObjectId present)', () => {
    const STORAGE_OBJECT_ID = 'sobj-legacy-1';
    const STORAGE_KEY = 'originals/legacy-photo.jpg';
    const COMPUTED_HASH_BIGINT = 99999n;
    const COMPUTED_HASH_STRING = '99999';
    const COMPUTED_SHARPNESS = 250.5;

    function makeStream(): Readable {
      return Readable.from([Buffer.from('fake-image-bytes')]);
    }

    function setupLegacyItem() {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({
          perceptualHash: null,
          sharpnessScore: null,
          storageObjectId: STORAGE_OBJECT_ID,
        }),
      );
      (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue({
        storageKey: STORAGE_KEY,
      });
      mockStorageProvider.download.mockResolvedValue(makeStream());
    }

    it('downloads from StorageProvider when perceptualHash is null', async () => {
      setupLegacyItem();
      (computeVisualHash as jest.Mock).mockResolvedValue(null);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      expect(mockStorageProvider.download).toHaveBeenCalledWith(STORAGE_KEY);
    });

    it('persists computed hash as unsigned decimal string and sharpnessScore', async () => {
      setupLegacyItem();
      (computeVisualHash as jest.Mock).mockResolvedValue({
        perceptualHash: COMPUTED_HASH_BIGINT,
        sharpnessScore: COMPUTED_SHARPNESS,
      });
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'media-1' },
          data: expect.objectContaining({
            perceptualHash: COMPUTED_HASH_STRING,
            sharpnessScore: COMPUTED_SHARPNESS,
          }),
        }),
      );
    });

    it('high-bit hash is stored as unsigned decimal string (not negative)', async () => {
      const highBitHash = 16488331711678253075n;
      const highBitHashStr = '16488331711678253075';

      setupLegacyItem();
      (computeVisualHash as jest.Mock).mockResolvedValue({
        perceptualHash: highBitHash,
        sharpnessScore: 100,
      });
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'media-1' },
          data: expect.objectContaining({
            perceptualHash: highBitHashStr,
          }),
        }),
      );
      // Confirm the stored string parses back to original value
      expect(BigInt(highBitHashStr)).toBe(highBitHash);
    });

    it('skips without crash when computeVisualHash returns null', async () => {
      setupLegacyItem();
      (computeVisualHash as jest.Mock).mockResolvedValue(null);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();
      expect(mockPrisma.similarityGroup.create).not.toHaveBeenCalled();
      // No mediaItem.update for hash persistence
      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('re-throws when StorageProvider.download throws (allows enrichment worker retry)', async () => {
      setupLegacyItem();
      const storageError = new Error('S3 connection timeout');
      mockStorageProvider.download.mockRejectedValue(storageError);

      await expect(service.processMediaItem(makeJob())).rejects.toThrow('S3 connection timeout');
      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('does NOT call StorageProvider.download when perceptualHash is already set', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ perceptualHash: '12345', storageObjectId: STORAGE_OBJECT_ID }),
      );
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      expect(mockStorageProvider.download).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Group creation: all ungrouped neighbors
  // -------------------------------------------------------------------------

  describe('group creation (all ungrouped neighbors from $queryRaw)', () => {
    const GROUP_ID = 'group-new-1';

    function setupUngrouped(neighborIds: string[] = ['neighbor-1']) {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue(
        neighborIds.map((id) => ({ id, similarity_group_id: null })),
      );
      (mockPrisma.similarityGroup.create as jest.Mock).mockResolvedValue({ id: GROUP_ID });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: neighborIds.length + 1 });
      // For recomputeGroupScores
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(
        ['media-1', ...neighborIds].map((id) => ({
          id,
          sharpnessScore: 100,
          width: 4032,
          height: 3024,
        })),
      );
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.similarityGroup.update as jest.Mock).mockResolvedValue({});
    }

    it('creates SimilarityGroup with circleId, pending status, and mediaCount = neighbors + 1', async () => {
      setupUngrouped(['neighbor-1']);

      await service.processMediaItem(makeJob());

      expect(mockPrisma.similarityGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            circleId: 'circle-1',
            status: SimilarityGroupStatus.pending,
            mediaCount: 2, // 1 neighbor + 1 item
          }),
        }),
      );
    });

    it('assigns item and all neighbors via mediaItem.updateMany', async () => {
      setupUngrouped(['neighbor-1']);

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: expect.arrayContaining(['media-1', 'neighbor-1']) } },
          data: { similarityGroupId: GROUP_ID },
        }),
      );
    });

    it('caps assignment at maxGroupSize when neighbors + 1 exceed it', async () => {
      // maxGroupSize=50 from system settings default; create 60 neighbors
      const manyNeighborIds = Array.from({ length: 60 }, (_, i) => `neighbor-${i}`);
      setupUngrouped(manyNeighborIds);

      await service.processMediaItem(makeJob());

      const updateManyCall = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.calls[0][0];
      // Should be capped at 50 (maxGroupSize)
      expect(updateManyCall.where.id.in).toHaveLength(50);
    });
  });

  // -------------------------------------------------------------------------
  // Join existing group: one existing group
  // -------------------------------------------------------------------------

  describe('joining an existing group (one existing group from $queryRaw)', () => {
    const EXISTING_GROUP_ID = 'existing-group-1';

    function setupOneExistingGroup(currentGroupSize: number) {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([
        { id: 'neighbor-1', similarity_group_id: EXISTING_GROUP_ID },
      ]);
      (mockPrisma.mediaItem.count as jest.Mock).mockResolvedValue(currentGroupSize);
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        { id: 'media-1', sharpnessScore: 100, width: 4032, height: 3024 },
        { id: 'neighbor-1', sharpnessScore: 80, width: 3024, height: 4032 },
      ]);
      (mockPrisma.similarityGroup.update as jest.Mock).mockResolvedValue({});
    }

    it('does NOT call similarityGroup.create when joining an existing group', async () => {
      setupOneExistingGroup(5);

      await service.processMediaItem(makeJob());

      expect(mockPrisma.similarityGroup.create).not.toHaveBeenCalled();
    });

    it('calls mediaItem.count to check current group size', async () => {
      setupOneExistingGroup(5);

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaItem.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ similarityGroupId: EXISTING_GROUP_ID }),
        }),
      );
    });

    it('assigns item via mediaItem.update when count < maxGroupSize', async () => {
      setupOneExistingGroup(5); // 5 < 50

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'media-1' },
          data: { similarityGroupId: EXISTING_GROUP_ID },
        }),
      );
    });

    it('returns early without assigning when count >= maxGroupSize', async () => {
      setupOneExistingGroup(50); // 50 >= 50

      await service.processMediaItem(makeJob());

      // mediaItem.update for assignment should NOT have been called
      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
      // Group create should also not have been called
      expect(mockPrisma.similarityGroup.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Merge multiple groups
  // -------------------------------------------------------------------------

  describe('merging multiple distinct groups', () => {
    const GROUP_A = 'group-oldest';
    const GROUP_B = 'group-newer';

    beforeEach(() => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([
        { id: 'neighbor-a', similarity_group_id: GROUP_A },
        { id: 'neighbor-b', similarity_group_id: GROUP_B },
      ]);
      (mockPrisma.similarityGroup.findMany as jest.Mock).mockResolvedValue([
        { id: GROUP_A, createdAt: new Date('2026-01-01') },
        { id: GROUP_B, createdAt: new Date('2026-01-02') },
      ]);
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      // For overflow check (findMany with skip)
      (mockPrisma.mediaItem.findMany as jest.Mock)
        // Overflow check returns empty (no overflow)
        .mockResolvedValueOnce([])
        // recomputeGroupScores members
        .mockResolvedValueOnce([
          { id: 'media-1', sharpnessScore: 100, width: 4032, height: 3024 },
          { id: 'neighbor-a', sharpnessScore: 90, width: 3000, height: 2000 },
          { id: 'neighbor-b', sharpnessScore: 70, width: 2000, height: 1500 },
        ]);
      (mockPrisma.similarityGroup.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.similarityGroup.update as jest.Mock).mockResolvedValue({});
    });

    it('reassigns secondary group members to oldest group via updateMany', async () => {
      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { similarityGroupId: { in: [GROUP_B] } },
          data: { similarityGroupId: GROUP_A },
        }),
      );
    });

    it('assigns current item to the target (oldest) group via mediaItem.update', async () => {
      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'media-1' },
          data: { similarityGroupId: GROUP_A },
        }),
      );
    });

    it('deletes secondary groups via similarityGroup.deleteMany', async () => {
      await service.processMediaItem(makeJob());

      expect(mockPrisma.similarityGroup.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: [GROUP_B] } },
        }),
      );
    });

    it('nulls out similarityGroupId and similarityScore on overflow members', async () => {
      const overflowMember = { id: 'overflow-member-1' };
      // Reset and configure overflow scenario
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockReset()
        // Overflow findMany returns one excess member
        .mockResolvedValueOnce([overflowMember])
        // recomputeGroupScores members
        .mockResolvedValueOnce([
          { id: 'media-1', sharpnessScore: 100, width: 4032, height: 3024 },
        ]);
      (mockPrisma.similarityGroup.update as jest.Mock).mockResolvedValue({});

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: [overflowMember.id] } },
          data: { similarityGroupId: null, similarityScore: null },
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Score recomputation (recomputeGroupScores)
  // -------------------------------------------------------------------------

  describe('score recomputation (recomputeGroupScores)', () => {
    function setupForScoring(members: Array<{
      id: string;
      sharpnessScore: number | null;
      width: number;
      height: number;
    }>) {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([
        { id: 'neighbor-1', similarity_group_id: null },
      ]);
      (mockPrisma.similarityGroup.create as jest.Mock).mockResolvedValue({ id: 'group-score-1' });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(members);
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.similarityGroup.update as jest.Mock).mockResolvedValue({});
    }

    it('picks member with highest sharpness as suggestedBestItemId', async () => {
      const members = [
        { id: 'media-low', sharpnessScore: 10, width: 4032, height: 3024 },
        { id: 'media-high', sharpnessScore: 500, width: 4032, height: 3024 },
        { id: 'media-mid', sharpnessScore: 200, width: 4032, height: 3024 },
      ];
      setupForScoring(members);

      await service.processMediaItem(makeJob());

      const groupUpdateCall = (mockPrisma.similarityGroup.update as jest.Mock).mock.calls[0][0];
      expect(groupUpdateCall.data.suggestedBestItemId).toBe('media-high');
    });

    it('all similarityScore values are in [0, 1]', async () => {
      const members = [
        { id: 'media-1', sharpnessScore: 0, width: 100, height: 100 },
        { id: 'media-2', sharpnessScore: 500, width: 4000, height: 3000 },
      ];
      setupForScoring(members);

      await service.processMediaItem(makeJob());

      const updateCalls = (mockPrisma.mediaItem.update as jest.Mock).mock.calls;
      const scores = updateCalls.map((c: any[]) => c[0].data.similarityScore as number);

      for (const score of scores) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    });

    it('when all sharpness values are equal, scores are 0.5 for each member', async () => {
      const members = [
        { id: 'media-a', sharpnessScore: 100, width: 4032, height: 3024 },
        { id: 'media-b', sharpnessScore: 100, width: 4032, height: 3024 },
      ];
      setupForScoring(members);

      await service.processMediaItem(makeJob());

      const updateCalls = (mockPrisma.mediaItem.update as jest.Mock).mock.calls;
      const scores = updateCalls.map((c: any[]) => c[0].data.similarityScore as number);

      // When all inputs equal, normalize() returns 0.5 for each
      for (const score of scores) {
        expect(score).toBe(0.5);
      }
    });

    it('updates mediaCount on the SimilarityGroup', async () => {
      const members = [
        { id: 'media-1', sharpnessScore: 100, width: 4032, height: 3024 },
        { id: 'media-2', sharpnessScore: 80, width: 3000, height: 2000 },
      ];
      setupForScoring(members);

      await service.processMediaItem(makeJob());

      const groupUpdateCall = (mockPrisma.similarityGroup.update as jest.Mock).mock.calls[0][0];
      expect(groupUpdateCall.data.mediaCount).toBe(2);
    });

    it('sharpness 90% + resolution 10% weighting: higher-res member wins over lower-sharpness', async () => {
      // member-a has higher sharpness (dominant weight 90%)
      const members = [
        { id: 'member-a', sharpnessScore: 300, width: 1000, height: 1000 },
        { id: 'member-b', sharpnessScore: 50, width: 4000, height: 3000 },
      ];
      setupForScoring(members);

      await service.processMediaItem(makeJob());

      // member-a should be picked as best (sharpness wins at 90% weight)
      const groupUpdateCall = (mockPrisma.similarityGroup.update as jest.Mock).mock.calls[0][0];
      expect(groupUpdateCall.data.suggestedBestItemId).toBe('member-a');
    });
  });
});
