/**
 * Unit tests for ThumbnailRepairHandler.
 *
 * Verifies: handler type constant; onModuleInit registers with the registry;
 * empty candidate set is a no-op; the cheap resync path is chosen when the
 * StorageObject already carries _processing.thumbnail (no attempts bump); the
 * reprocess path persists the attempts counter BEFORE calling
 * reprocessObjectNow (crash-safety); a per-object error does not abort the
 * sweep loop.
 *
 * Mirrors trash-purge.handler.spec.ts. No database required — all
 * dependencies are fully mocked.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ThumbnailRepairHandler } from './thumbnail-repair.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProcessingRecoveryService } from '../storage/tasks/storage-processing-recovery.service';
import { MediaMetadataSyncService } from './sync/media-metadata-sync.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import type { EnrichmentJob } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-thumb-repair-1',
    type: 'thumbnail_repair',
    mediaItemId: null,
    circleId: null,
    status: 'running' as any,
    reason: 'backfill' as any,
    priority: 100,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 1,
    lastError: null,
    startedAt: new Date(),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null,
    createdAt: new Date(),
    ...overrides,
  } as EnrichmentJob;
}

function makeCandidateRow(objectId: string, mediaItemId = `media-for-${objectId}`) {
  return { media_item_id: mediaItemId, storage_object_id: objectId };
}

function makeStorageObject(id: string, metadata: Record<string, unknown> | null = null) {
  return {
    id,
    name: 'photo.jpg',
    size: BigInt(1024),
    mimeType: 'image/jpeg',
    storageKey: `uploads/${id}.jpg`,
    storageProvider: 's3',
    bucket: null,
    status: 'failed',
    s3UploadId: null,
    metadata,
    uploadedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThumbnailRepairHandler', () => {
  let handler: ThumbnailRepairHandler;
  let mockRegistry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
  let mockSync: jest.Mocked<Pick<MediaMetadataSyncService, 'syncFromStorageObject'>>;
  let mockRecovery: jest.Mocked<Pick<StorageProcessingRecoveryService, 'reprocessObjectNow'>>;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockRegistry = {
      register: jest.fn(),
    };

    mockSync = {
      syncFromStorageObject: jest.fn().mockResolvedValue(undefined),
    };

    mockRecovery = {
      reprocessObjectNow: jest.fn().mockResolvedValue(undefined),
    };

    mockPrisma = createMockPrismaService();
    mockPrisma.$queryRaw.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThumbnailRepairHandler,
        { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
        { provide: MediaMetadataSyncService, useValue: mockSync },
        { provide: StorageProcessingRecoveryService, useValue: mockRecovery },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    handler = module.get<ThumbnailRepairHandler>(ThumbnailRepairHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // type constant + registration
  // =========================================================================

  describe('type', () => {
    it('has type === "thumbnail_repair"', () => {
      expect(handler.type).toBe('thumbnail_repair');
    });
  });

  describe('onModuleInit', () => {
    it('registers itself in the EnrichmentHandlerRegistry on init', () => {
      handler.onModuleInit();
      expect(mockRegistry.register).toHaveBeenCalledWith(handler);
    });
  });

  // =========================================================================
  // process — empty candidate set
  // =========================================================================

  describe('process with no candidates', () => {
    it('is a no-op: no object loads, no sync, no reprocess', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      await expect(handler.process(makeJob())).resolves.toBeUndefined();

      expect(mockPrisma.storageObject.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.storageObject.update).not.toHaveBeenCalled();
      expect(mockSync.syncFromStorageObject).not.toHaveBeenCalled();
      expect(mockRecovery.reprocessObjectNow).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // process — cheap resync path
  // =========================================================================

  describe('cheap resync path', () => {
    it('calls syncFromStorageObject when _processing.thumbnail is fully present, without bumping attempts or reprocessing', async () => {
      const object = makeStorageObject('obj-1', {
        _processing: {
          thumbnail: {
            thumbnailObjectId: 'thumb-obj-1',
            thumbnailStorageKey: 'thumbnails/obj-1.jpg',
          },
        },
      });
      mockPrisma.$queryRaw.mockResolvedValue([makeCandidateRow('obj-1')]);
      mockPrisma.storageObject.findUnique.mockResolvedValue(object as any);

      await handler.process(makeJob());

      expect(mockSync.syncFromStorageObject).toHaveBeenCalledWith('obj-1');
      // No attempts-counter bump and no pipeline rerun on the cheap path
      expect(mockPrisma.storageObject.update).not.toHaveBeenCalled();
      expect(mockRecovery.reprocessObjectNow).not.toHaveBeenCalled();
    });

    it('takes the reprocess path when _processing.thumbnail is only partially present', async () => {
      const object = makeStorageObject('obj-2', {
        _processing: {
          thumbnail: { thumbnailObjectId: 'thumb-obj-2' }, // no thumbnailStorageKey
        },
      });
      mockPrisma.$queryRaw.mockResolvedValue([makeCandidateRow('obj-2')]);
      mockPrisma.storageObject.findUnique.mockResolvedValue(object as any);
      mockPrisma.storageObject.update.mockResolvedValue(object as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue({ metadata: {} } as any);

      await handler.process(makeJob());

      expect(mockSync.syncFromStorageObject).not.toHaveBeenCalled();
      expect(mockRecovery.reprocessObjectNow).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // process — reprocess path
  // =========================================================================

  describe('reprocess path', () => {
    it('persists the incremented attempts counter BEFORE calling reprocessObjectNow', async () => {
      const object = makeStorageObject('obj-3', { someKey: 'preserved' });
      const claimed = makeStorageObject('obj-3', {
        someKey: 'preserved',
        _thumbnailRepairAttempts: 1,
      });
      mockPrisma.$queryRaw.mockResolvedValue([makeCandidateRow('obj-3')]);
      mockPrisma.storageObject.findUnique.mockResolvedValue(object as any);
      mockPrisma.storageObject.update.mockResolvedValue(claimed as any);
      // Reprocess does not yield a thumbnail in this test
      mockPrisma.mediaItem.findUnique.mockResolvedValue({ metadata: {} } as any);

      await handler.process(makeJob());

      // Counter write happened, merged over existing metadata
      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'obj-3' },
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              someKey: 'preserved',
              _thumbnailRepairAttempts: 1,
            }),
          }),
        }),
      );

      // Crash-safety: the counter write must precede the pipeline invocation
      const updateOrder = (mockPrisma.storageObject.update as jest.Mock).mock
        .invocationCallOrder[0];
      const reprocessOrder = (mockRecovery.reprocessObjectNow as jest.Mock).mock
        .invocationCallOrder[0];
      expect(updateOrder).toBeLessThan(reprocessOrder);

      // The pipeline receives the claimed (counter-bearing) row
      expect(mockRecovery.reprocessObjectNow).toHaveBeenCalledWith(claimed);
    });

    it('sets _thumbnailRepairExhausted when the bump reaches maxAttempts', async () => {
      const object = makeStorageObject('obj-4', { _thumbnailRepairAttempts: 2 }); // default max = 3
      mockPrisma.$queryRaw.mockResolvedValue([makeCandidateRow('obj-4')]);
      mockPrisma.storageObject.findUnique.mockResolvedValue(object as any);
      mockPrisma.storageObject.update.mockResolvedValue(object as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue({ metadata: {} } as any);

      await handler.process(makeJob());

      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              _thumbnailRepairAttempts: 3,
              _thumbnailRepairExhausted: true,
            }),
          }),
        }),
      );
    });

    it('clears the repair counters after a successful reprocess', async () => {
      const object = makeStorageObject('obj-5', null);
      const freshAfterPipeline = makeStorageObject('obj-5', {
        _thumbnailRepairAttempts: 1,
        _processing: { thumbnail: { thumbnailObjectId: 't', thumbnailStorageKey: 'k' } },
      });
      mockPrisma.$queryRaw.mockResolvedValue([makeCandidateRow('obj-5')]);
      // First findUnique: initial load; second: fresh re-read for counter clear
      mockPrisma.storageObject.findUnique
        .mockResolvedValueOnce(object as any)
        .mockResolvedValueOnce({ metadata: freshAfterPipeline.metadata } as any);
      mockPrisma.storageObject.update.mockResolvedValue(object as any);
      // The pipeline emitted OBJECT_PROCESSED_EVENT → sync wrote the thumbnail key
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        metadata: { thumbnailStorageKey: 'thumbnails/obj-5.jpg' },
      } as any);

      await handler.process(makeJob());

      // Two updates: counter bump, then counter clear
      expect(mockPrisma.storageObject.update).toHaveBeenCalledTimes(2);
      const clearCall = (mockPrisma.storageObject.update as jest.Mock).mock.calls[1][0];
      expect(clearCall.data.metadata).not.toHaveProperty('_thumbnailRepairAttempts');
      expect(clearCall.data.metadata).not.toHaveProperty('_thumbnailRepairExhausted');
      // Pipeline results merged into metadata by processing are preserved
      expect(clearCall.data.metadata).toHaveProperty('_processing');
    });
  });

  // =========================================================================
  // process — per-object error isolation
  // =========================================================================

  describe('error isolation', () => {
    it('continues the sweep when one object throws', async () => {
      const goodObject = makeStorageObject('obj-good', {
        _processing: {
          thumbnail: {
            thumbnailObjectId: 'thumb-good',
            thumbnailStorageKey: 'thumbnails/obj-good.jpg',
          },
        },
      });
      mockPrisma.$queryRaw.mockResolvedValue([
        makeCandidateRow('obj-broken'),
        makeCandidateRow('obj-good'),
      ]);
      mockPrisma.storageObject.findUnique
        .mockRejectedValueOnce(new Error('DB hiccup'))
        .mockResolvedValueOnce(goodObject as any);

      await expect(handler.process(makeJob())).resolves.toBeUndefined();

      // The second (good) candidate was still processed via the resync path
      expect(mockSync.syncFromStorageObject).toHaveBeenCalledWith('obj-good');
    });

    it('does not throw when a candidate StorageObject has vanished', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([makeCandidateRow('obj-gone')]);
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(handler.process(makeJob())).resolves.toBeUndefined();

      expect(mockSync.syncFromStorageObject).not.toHaveBeenCalled();
      expect(mockRecovery.reprocessObjectNow).not.toHaveBeenCalled();
    });
  });
});
