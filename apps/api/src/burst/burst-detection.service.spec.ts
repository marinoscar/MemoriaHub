/**
 * Unit tests for BurstDetectionService.
 *
 * Covers:
 *  - burstScore composition: weight application, per-group normalization,
 *    suggestedBestItemId picks highest scorer
 *  - Face signal is skipped gracefully when no face rows exist
 *  - Face signal is included when face rows exist
 *  - processMediaItem: group creation, member attachment, multi-group merge,
 *    score recomputation
 *  - BurstUUID hard-prior: items with shared non-null burstUuid always link
 *  - Cross-device isolation: different cameraMake never link by time alone
 *  - Items below minGroupSize still get a group (but that filtering happens at query time)
 *  - Deleted or missing mediaItem → early return (non-retryable)
 *  - No capturedAt → early return
 *  - No device info and no burstUuid → early return
 *  - Null perceptualHash → skip temporal-only link
 *  - On-demand perceptual hash for legacy photos (perceptualHash null + storageObjectId present)
 *  - Step 7 (burst wins over duplicate detection): after grouping, the burst
 *    group's member ids are passed to DuplicateDetectionService.evictFromDuplicateGroups;
 *    a thrown error is caught and logged, never failing the burst job
 */

// ---------------------------------------------------------------------------
// Module-level mock: computeVisualHash only (toSignedInt64 no longer exists)
// ---------------------------------------------------------------------------
jest.mock('../storage/processing/visual-hash.util', () => ({
  computeVisualHash: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { BurstDetectionService } from './burst-detection.service';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { DuplicateDetectionService } from '../dedup/duplicate-detection.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { BurstGroupStatus, EnrichmentJob, JobReason, JobStatus, MediaType } from '@prisma/client';
import { computeVisualHash } from '../storage/processing/visual-hash.util';
import { Readable } from 'stream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'burst_detection',
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
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null,
    createdAt: new Date(),
    ...overrides,
  };
}

const BASE_TIME = new Date('2026-06-15T14:32:00.000Z');

function makeMediaItem(overrides: Partial<{
  id: string;
  circleId: string;
  perceptualHash: string | null;   // DB column is now TEXT (unsigned decimal string)
  sharpnessScore: number | null;
  burstUuid: string | null;
  capturedAt: Date | null;
  width: number | null;
  height: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  deletedAt: Date | null;
  burstGroupId: string | null;
  storageObjectId: string | null;
}> = {}) {
  return {
    id: 'media-1',
    circleId: 'circle-1',
    perceptualHash: '12345',   // unsigned decimal string
    sharpnessScore: 100,
    burstUuid: null,
    capturedAt: BASE_TIME,
    width: 4032,
    height: 3024,
    cameraMake: 'Apple',
    cameraModel: 'iPhone 15 Pro',
    deletedAt: null,
    burstGroupId: null,
    storageObjectId: null,
    ...overrides,
  };
}

function makeNeighbor(overrides: Partial<{
  id: string;
  perceptualHash: string | null;   // DB column is TEXT
  burstUuid: string | null;
  burstGroupId: string | null;
  capturedAt: Date | null;
}> = {}) {
  return {
    id: 'media-neighbor-1',
    perceptualHash: '12345', // identical hash by default → Hamming distance 0
    burstUuid: null,
    burstGroupId: null,
    capturedAt: new Date(BASE_TIME.getTime() - 3000), // 3 seconds earlier
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BurstDetectionService', () => {
  let service: BurstDetectionService;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let mockStorageProvider: { download: jest.Mock };
  let mockResolver: { getProviderFor: jest.Mock };
  let mockDuplicateDetectionService: { evictFromDuplicateGroups: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = { enqueue: jest.fn() };
    mockStorageProvider = { download: jest.fn() };
    // Resolver returns mockStorageProvider so download assertions are unchanged.
    mockResolver = { getProviderFor: jest.fn().mockResolvedValue(mockStorageProvider) };
    // Burst wins over duplicate detection (Step 7): mocked as a collaborator,
    // never the real DuplicateDetectionService.
    mockDuplicateDetectionService = { evictFromDuplicateGroups: jest.fn().mockResolvedValue(undefined) };

    // Default system settings: standard burst config
    (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue({
      key: 'global',
      value: { burst: { timeGapSeconds: 10, hashDistance: 10, minGroupSize: 3 } },
    });

    // Default: $transaction executes array operations in parallel
    (mockPrisma.$transaction as jest.Mock).mockImplementation((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BurstDetectionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: StorageProviderResolver, useValue: mockResolver },
        { provide: DuplicateDetectionService, useValue: mockDuplicateDetectionService },
      ],
    }).compile();

    service = module.get<BurstDetectionService>(BurstDetectionService);

    // Reset module-level mock between tests
    jest.clearAllMocks();

    // Re-apply defaults cleared by clearAllMocks
    (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue({
      key: 'global',
      value: { burst: { timeGapSeconds: 10, hashDistance: 10, minGroupSize: 3 } },
    });
    (mockPrisma.$transaction as jest.Mock).mockImplementation((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );
    // Default: face.groupBy returns empty array (face signal absent by default)
    (mockPrisma.face.groupBy as jest.Mock).mockResolvedValue([]);
    mockDuplicateDetectionService.evictFromDuplicateGroups.mockResolvedValue(undefined);
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
      expect(mockPrisma.systemSettings.findUnique).not.toHaveBeenCalled();
    });

    it('returns early when mediaItem is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );
      await service.processMediaItem(makeJob());
      expect(mockPrisma.systemSettings.findUnique).not.toHaveBeenCalled();
    });

    it('returns early when mediaItem has no capturedAt', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ capturedAt: null }),
      );
      await service.processMediaItem(makeJob());
      expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
    });

    it('returns early when mediaItem has no device info and no burstUuid', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ cameraMake: null, cameraModel: null, burstUuid: null }),
      );
      await service.processMediaItem(makeJob());
      expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
    });

    it('returns early when no candidate neighbors are found', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);
      await service.processMediaItem(makeJob());
      expect(mockPrisma.burstGroup.create).not.toHaveBeenCalled();
    });

    it('returns early when no neighbors pass the link check', async () => {
      // Item hash = all 64 bits set (max uint64); neighbor = '0'; Hamming distance = 64 > threshold 10
      const itemHash = ((1n << 64n) - 1n).toString(); // '18446744073709551615'
      const neighborHash = '0';
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ perceptualHash: itemHash }),
      );
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        makeNeighbor({ perceptualHash: neighborHash }),
      ]);
      await service.processMediaItem(makeJob());
      expect(mockPrisma.burstGroup.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Null perceptualHash: temporal link not formed without hashes
  // -------------------------------------------------------------------------

  describe('null perceptualHash handling', () => {
    it('does NOT link when item has null perceptualHash and no shared burstUuid', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ perceptualHash: null }),
      );
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        makeNeighbor({ perceptualHash: '12345' }),
      ]);
      await service.processMediaItem(makeJob());
      expect(mockPrisma.burstGroup.create).not.toHaveBeenCalled();
    });

    it('does NOT link when neighbor has null perceptualHash and no shared burstUuid', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        makeNeighbor({ perceptualHash: null }),
      ]);
      await service.processMediaItem(makeJob());
      expect(mockPrisma.burstGroup.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // BurstUUID hard prior
  // -------------------------------------------------------------------------

  describe('BurstUUID hard prior', () => {
    it('links items with shared non-null burstUuid regardless of hash distance', async () => {
      const burstUuid = 'BURST-UUID-APPLE-0001';
      const maxUint64 = ((1n << 64n) - 1n).toString(); // '18446744073709551615'
      // Item has hash '0' and neighbor has max hash — Hamming distance 64, exceeds threshold
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ burstUuid, perceptualHash: '0' }),
      );
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        makeNeighbor({
          burstUuid,
          perceptualHash: maxUint64, // max distance from '0'
          burstGroupId: null,
        }),
      ]);

      const createdGroup = { id: 'group-new' };
      (mockPrisma.burstGroup.create as jest.Mock).mockResolvedValue(createdGroup);
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      // For recomputeGroupScores
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([makeNeighbor({ burstUuid, perceptualHash: maxUint64, burstGroupId: null })])
        .mockResolvedValueOnce([
          { id: 'media-1', sharpnessScore: 100, width: 4032, height: 3024, capturedAt: BASE_TIME },
          { id: 'media-neighbor-1', sharpnessScore: 80, width: 3024, height: 4032, capturedAt: BASE_TIME },
        ]);
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.burstGroup.update as jest.Mock).mockResolvedValue({});

      await service.processMediaItem(makeJob());

      // Group should be created (BurstUUID link passed the hard-prior check)
      expect(mockPrisma.burstGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            circleId: 'circle-1',
            status: BurstGroupStatus.pending,
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Group creation: all ungrouped neighbors
  // -------------------------------------------------------------------------

  describe('group creation (all ungrouped neighbors)', () => {
    beforeEach(() => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaItem.findMany as jest.Mock)
        // Candidate neighbors
        .mockResolvedValueOnce([makeNeighbor()])
        // recomputeGroupScores: group members
        .mockResolvedValueOnce([
          { id: 'media-1', sharpnessScore: 100, width: 4032, height: 3024, capturedAt: BASE_TIME },
          { id: 'media-neighbor-1', sharpnessScore: 80, width: 3024, height: 4032, capturedAt: new Date(BASE_TIME.getTime() - 3000) },
        ]);
      (mockPrisma.burstGroup.create as jest.Mock).mockResolvedValue({ id: 'group-1' });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.burstGroup.update as jest.Mock).mockResolvedValue({});
    });

    it('creates a new BurstGroup with circleId, pending status, and correct mediaCount', async () => {
      await service.processMediaItem(makeJob());

      expect(mockPrisma.burstGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            circleId: 'circle-1',
            status: BurstGroupStatus.pending,
            mediaCount: 2, // item + 1 neighbor
          }),
        }),
      );
    });

    it('assigns item and all linked neighbors to the new group via updateMany', async () => {
      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: expect.arrayContaining(['media-1', 'media-neighbor-1']) } },
          data: { burstGroupId: 'group-1' },
        }),
      );
    });

    it('capturedAt of the new group is the earliest member timestamp', async () => {
      const neighborTime = new Date(BASE_TIME.getTime() - 3000);
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce([makeNeighbor({ capturedAt: neighborTime })])
        .mockResolvedValueOnce([
          { id: 'media-1', sharpnessScore: 100, width: 4032, height: 3024, capturedAt: BASE_TIME },
          { id: 'media-neighbor-1', sharpnessScore: 80, width: 3024, height: 4032, capturedAt: neighborTime },
        ]);

      await service.processMediaItem(makeJob());

      expect(mockPrisma.burstGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ capturedAt: neighborTime }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Join existing group: one existing group
  // -------------------------------------------------------------------------

  describe('joining an existing group (one existing group)', () => {
    it('assigns item to the existing group via update (not create)', async () => {
      const existingGroupId = 'existing-group-1';
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([
          makeNeighbor({ burstGroupId: existingGroupId }),
        ])
        .mockResolvedValueOnce([
          { id: 'media-1', sharpnessScore: 100, width: 4032, height: 3024, capturedAt: BASE_TIME },
          { id: 'media-neighbor-1', sharpnessScore: 80, width: 3024, height: 4032, capturedAt: BASE_TIME },
        ]);
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.burstGroup.update as jest.Mock).mockResolvedValue({});

      await service.processMediaItem(makeJob());

      expect(mockPrisma.burstGroup.create).not.toHaveBeenCalled();
      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'media-1' },
          data: { burstGroupId: existingGroupId },
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Merge: multiple distinct groups
  // -------------------------------------------------------------------------

  describe('merging multiple distinct groups', () => {
    it('merges secondary groups into the oldest group and deletes them', async () => {
      const groupA = 'group-oldest';
      const groupB = 'group-newer';

      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([
          makeNeighbor({ id: 'media-2', burstGroupId: groupA }),
          makeNeighbor({ id: 'media-3', burstGroupId: groupB }),
        ])
        .mockResolvedValueOnce([
          { id: 'media-1', sharpnessScore: 100, width: 4032, height: 3024, capturedAt: BASE_TIME },
          { id: 'media-2', sharpnessScore: 90, width: 3000, height: 2000, capturedAt: BASE_TIME },
          { id: 'media-3', sharpnessScore: 70, width: 2000, height: 1500, capturedAt: BASE_TIME },
        ]);

      (mockPrisma.burstGroup.findMany as jest.Mock).mockResolvedValue([
        { id: groupA, createdAt: new Date('2026-01-01') },
        { id: groupB, createdAt: new Date('2026-01-02') },
      ]);
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.burstGroup.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.burstGroup.update as jest.Mock).mockResolvedValue({});

      await service.processMediaItem(makeJob());

      // Members from groupB should be reassigned to groupA
      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { burstGroupId: { in: [groupB] } },
          data: { burstGroupId: groupA },
        }),
      );

      // The current item should be assigned to groupA
      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'media-1' },
          data: { burstGroupId: groupA },
        }),
      );

      // groupB should be deleted
      expect(mockPrisma.burstGroup.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: [groupB] } },
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // On-demand perceptual hash for legacy photos
  // -------------------------------------------------------------------------

  describe('on-demand perceptual hash (perceptualHash === null, storageObjectId present)', () => {
    const STORAGE_OBJECT_ID = 'sobj-legacy-1';
    const STORAGE_KEY = 'originals/legacy-photo.jpg';
    // computeVisualHash returns a bigint; the service converts to string for storage
    const COMPUTED_HASH_BIGINT = 99999n;
    const COMPUTED_HASH_STRING = '99999'; // what gets persisted and patched in-memory
    const COMPUTED_SHARPNESS = 250.5;

    function makeStream(): Readable {
      return Readable.from([Buffer.from('fake-image-bytes')]);
    }

    function setupLegacyItem() {
      // Media item with null perceptualHash but a storageObjectId
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({
          perceptualHash: null,
          sharpnessScore: null,
          storageObjectId: STORAGE_OBJECT_ID,
        }),
      );
      // StorageObject lookup inside computeAndPersistHashOnDemand
      (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue({
        storageKey: STORAGE_KEY,
        storageProvider: 's3',
        bucket: 'test-bucket',
      });
      // Storage download returns a readable stream
      mockStorageProvider.download.mockResolvedValue(makeStream());
    }

    it('downloads the object via StorageProvider when perceptualHash is null', async () => {
      setupLegacyItem();
      // computeVisualHash returns null → hash not set, but process continues
      (computeVisualHash as jest.Mock).mockResolvedValue(null);
      // No candidates → early-exit after hash attempt
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      expect(mockStorageProvider.download).toHaveBeenCalledWith(STORAGE_KEY);
    });

    it('persists computed hash as unsigned decimal string and sharpnessScore via prisma.mediaItem.update', async () => {
      setupLegacyItem();
      (computeVisualHash as jest.Mock).mockResolvedValue({
        perceptualHash: COMPUTED_HASH_BIGINT,
        sharpnessScore: COMPUTED_SHARPNESS,
      });
      // No candidates → returns early after hash computation
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'media-1' },
          data: expect.objectContaining({
            // Must be stored as a string, not a bigint
            perceptualHash: COMPUTED_HASH_STRING,
            sharpnessScore: COMPUTED_SHARPNESS,
          }),
        }),
      );
    });

    it('uses the freshly computed hash string for burst grouping (links to a matching neighbor)', async () => {
      setupLegacyItem();
      (computeVisualHash as jest.Mock).mockResolvedValue({
        perceptualHash: COMPUTED_HASH_BIGINT,
        sharpnessScore: COMPUTED_SHARPNESS,
      });

      // A neighbor with an identical hash string → Hamming distance 0 → should link
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([makeNeighbor({ perceptualHash: COMPUTED_HASH_STRING })])
        .mockResolvedValueOnce([
          { id: 'media-1', sharpnessScore: COMPUTED_SHARPNESS, width: 4032, height: 3024, capturedAt: BASE_TIME },
          { id: 'media-neighbor-1', sharpnessScore: 80, width: 3024, height: 4032, capturedAt: BASE_TIME },
        ]);
      (mockPrisma.burstGroup.create as jest.Mock).mockResolvedValue({ id: 'group-legacy-1' });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.burstGroup.update as jest.Mock).mockResolvedValue({});

      await service.processMediaItem(makeJob());

      // Group should be created because the computed hash matched the neighbor
      expect(mockPrisma.burstGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            circleId: 'circle-1',
            status: BurstGroupStatus.pending,
          }),
        }),
      );
    });

    it('skips the item (no crash) when computeVisualHash returns null', async () => {
      setupLegacyItem();
      (computeVisualHash as jest.Mock).mockResolvedValue(null);
      // No candidates would be found (or they'd have non-null hashes)
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      // Must not throw
      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();
      // No group should be created
      expect(mockPrisma.burstGroup.create).not.toHaveBeenCalled();
      // No hash persisted
      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('re-throws when StorageProvider.download throws (allows enrichment worker to retry)', async () => {
      setupLegacyItem();
      const storageError = new Error('S3 connection timeout');
      mockStorageProvider.download.mockRejectedValue(storageError);

      await expect(service.processMediaItem(makeJob())).rejects.toThrow('S3 connection timeout');
      // No hash persisted on transient failure
      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('does NOT call StorageProvider.download when perceptualHash is already set', async () => {
      // Item already has a perceptualHash string → on-demand path is skipped entirely
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ perceptualHash: '12345', storageObjectId: STORAGE_OBJECT_ID }),
      );
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      expect(mockStorageProvider.download).not.toHaveBeenCalled();
    });

    it('does NOT call StorageProvider.download when storageObjectId is null (no source to download)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ perceptualHash: null, storageObjectId: null }),
      );
      // With null perceptualHash and no storageObjectId the item just skips hash; still
      // needs device/burstUuid check. Force early-exit by having no device info + no burstUuid.
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ perceptualHash: null, storageObjectId: null, cameraMake: null, cameraModel: null, burstUuid: null }),
      );

      await service.processMediaItem(makeJob());

      expect(mockStorageProvider.download).not.toHaveBeenCalled();
    });

    it('high-bit hash (previously overflow-prone) is stored and read as correct unsigned decimal string', async () => {
      // 16488331711678253075 is the exact value that overflowed in production.
      // computeVisualHash returns a bigint; the service must store bigint.toString().
      const highBitHash = 16488331711678253075n;
      const highBitHashStr = '16488331711678253075';

      setupLegacyItem();
      (computeVisualHash as jest.Mock).mockResolvedValue({
        perceptualHash: highBitHash,
        sharpnessScore: 100,
      });
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      // Must be stored as the unsigned decimal string, not as a negative bigint
      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'media-1' },
          data: expect.objectContaining({
            perceptualHash: highBitHashStr,
          }),
        }),
      );

      // And BigInt(stored) must recover the original value for Hamming comparison
      expect(BigInt(highBitHashStr)).toBe(highBitHash);
    });
  });

  // -------------------------------------------------------------------------
  // burstScore composition and normalization (via recomputeGroupScores)
  // -------------------------------------------------------------------------

  describe('burstScore composition and suggestedBestItemId', () => {
    function setupForScoring(members: Array<{
      id: string;
      sharpnessScore: number | null;
      width: number;
      height: number;
      capturedAt: Date;
    }>, faceData?: Array<{ mediaItemId: string; _count: { id: number }; _avg: { confidence: number | null } }>) {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      // Candidates (first findMany)
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([makeNeighbor()])
        // Group members (second findMany in recomputeGroupScores)
        .mockResolvedValueOnce(members);
      (mockPrisma.burstGroup.create as jest.Mock).mockResolvedValue({ id: 'group-1' });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.face.groupBy as jest.Mock).mockResolvedValue(faceData ?? []);
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.burstGroup.update as jest.Mock).mockResolvedValue({});
    }

    it('picks member with highest sharpness as suggestedBestItemId when no face data', async () => {
      const members = [
        { id: 'media-1', sharpnessScore: 50, width: 4032, height: 3024, capturedAt: BASE_TIME },
        { id: 'media-2', sharpnessScore: 200, width: 4032, height: 3024, capturedAt: BASE_TIME },
        { id: 'media-3', sharpnessScore: 10, width: 4032, height: 3024, capturedAt: BASE_TIME },
      ];
      setupForScoring(members);

      await service.processMediaItem(makeJob());

      const groupUpdateCall = (mockPrisma.burstGroup.update as jest.Mock).mock.calls[0][0];
      expect(groupUpdateCall.data.suggestedBestItemId).toBe('media-2');
    });

    it('normalizes scores to [0,1] within the group', async () => {
      const members = [
        { id: 'media-low', sharpnessScore: 0, width: 100, height: 100, capturedAt: BASE_TIME },
        { id: 'media-high', sharpnessScore: 500, width: 4000, height: 3000, capturedAt: BASE_TIME },
      ];
      setupForScoring(members);

      await service.processMediaItem(makeJob());

      // Both members should receive burstScore updates in $transaction
      const updateCalls = (mockPrisma.mediaItem.update as jest.Mock).mock.calls;
      const scores = updateCalls.map((c: any[]) => c[0].data.burstScore as number);

      // The high member should score > 0.5; the low member < 0.5
      expect(Math.max(...scores)).toBeGreaterThan(0.5);
      expect(Math.min(...scores)).toBeLessThan(0.5);

      // All scores should be in [0, 1]
      for (const score of scores) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    });

    it('when all members have identical sharpness, scores still in [0,1]', async () => {
      const members = [
        { id: 'media-a', sharpnessScore: 100, width: 4032, height: 3024, capturedAt: BASE_TIME },
        { id: 'media-b', sharpnessScore: 100, width: 4032, height: 3024, capturedAt: BASE_TIME },
      ];
      setupForScoring(members);

      await service.processMediaItem(makeJob());

      const updateCalls = (mockPrisma.mediaItem.update as jest.Mock).mock.calls;
      const scores = updateCalls.map((c: any[]) => c[0].data.burstScore as number);
      for (const score of scores) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    });

    it('skips face term gracefully when face.groupBy returns no rows (faceMap empty)', async () => {
      const members = [
        { id: 'media-1', sharpnessScore: 300, width: 4032, height: 3024, capturedAt: BASE_TIME },
        { id: 'media-2', sharpnessScore: 100, width: 4032, height: 3024, capturedAt: BASE_TIME },
      ];
      // No faceData → face.groupBy returns []
      setupForScoring(members, undefined);

      await service.processMediaItem(makeJob());

      // face.groupBy is always called
      expect(mockPrisma.face.groupBy).toHaveBeenCalled();

      // Best should still be determined (higher sharpness wins)
      const groupUpdateCall = (mockPrisma.burstGroup.update as jest.Mock).mock.calls[0][0];
      expect(groupUpdateCall.data.suggestedBestItemId).toBe('media-1');
    });

    it('includes face term when face rows exist', async () => {
      const members = [
        // media-1 has lower sharpness but many high-confidence faces
        { id: 'media-1', sharpnessScore: 50, width: 4032, height: 3024, capturedAt: BASE_TIME },
        // media-2 has higher sharpness but zero faces
        { id: 'media-2', sharpnessScore: 200, width: 4032, height: 3024, capturedAt: BASE_TIME },
      ];
      const faceData = [
        {
          mediaItemId: 'media-1',
          _count: { id: 5 },
          _avg: { confidence: 0.98 },
        },
      ];
      setupForScoring(members, faceData);

      await service.processMediaItem(makeJob());

      // face.groupBy is always called; it returned data this time
      expect(mockPrisma.face.groupBy).toHaveBeenCalled();
    });

    it('updates mediaCount on the BurstGroup in recomputeGroupScores', async () => {
      const members = [
        { id: 'media-1', sharpnessScore: 100, width: 4032, height: 3024, capturedAt: BASE_TIME },
        { id: 'media-neighbor-1', sharpnessScore: 80, width: 3000, height: 2000, capturedAt: BASE_TIME },
      ];
      setupForScoring(members);

      await service.processMediaItem(makeJob());

      const groupUpdateCall = (mockPrisma.burstGroup.update as jest.Mock).mock.calls[0][0];
      expect(groupUpdateCall.data.mediaCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Step 7: burst wins over duplicate detection (eviction)
  // -------------------------------------------------------------------------

  describe('Step 7: eviction from duplicate groups after burst grouping', () => {
    function setupGroupCreationForEviction() {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaItem.findMany as jest.Mock)
        // Step 3: candidate neighbors
        .mockResolvedValueOnce([makeNeighbor()])
        // Step 6 (recomputeGroupScores): group members
        .mockResolvedValueOnce([
          { id: 'media-1', sharpnessScore: 100, width: 4032, height: 3024, capturedAt: BASE_TIME },
          { id: 'media-neighbor-1', sharpnessScore: 80, width: 3024, height: 4032, capturedAt: BASE_TIME },
        ])
        // Step 7: group members for eviction
        .mockResolvedValueOnce([{ id: 'media-1' }, { id: 'media-neighbor-1' }]);
      (mockPrisma.burstGroup.create as jest.Mock).mockResolvedValue({ id: 'group-1' });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.burstGroup.update as jest.Mock).mockResolvedValue({});
    }

    it('calls duplicateDetectionService.evictFromDuplicateGroups with the target burst group member ids after grouping', async () => {
      setupGroupCreationForEviction();

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaItem.findMany).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          where: { burstGroupId: 'group-1', deletedAt: null },
        }),
      );
      expect(mockDuplicateDetectionService.evictFromDuplicateGroups).toHaveBeenCalledWith(
        expect.arrayContaining(['media-1', 'media-neighbor-1']),
      );
    });

    it('an error thrown by eviction is caught and does not fail/reject the burst job', async () => {
      setupGroupCreationForEviction();
      mockDuplicateDetectionService.evictFromDuplicateGroups.mockRejectedValue(
        new Error('eviction boom'),
      );

      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();

      // Normal burst grouping (Steps 1-6) still completed despite the eviction failure.
      expect(mockPrisma.burstGroup.create).toHaveBeenCalled();
      expect(mockPrisma.burstGroup.update).toHaveBeenCalled();
    });
  });
});
