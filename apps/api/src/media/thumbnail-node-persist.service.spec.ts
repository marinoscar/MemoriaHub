/**
 * Unit tests for ThumbnailNodePersistService.
 *
 * Covers the node-result persist half shared by ThumbnailRegenHandler and
 * ThumbnailRepairHandler: existence + byte-length validation against the
 * active storage provider, the thumbnail StorageObject upsert, the merge
 * into the original object's _processing.thumbnail entry, and the
 * MediaMetadataSyncService.syncFromStorageObject call — mirroring
 * ThumbnailProcessor.uploadThumbnail's writes exactly (see the acceptance
 * note in thumbnail-node-persist.service.ts: both paths must converge on
 * identical columns).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ThumbnailNodePersistService } from './thumbnail-node-persist.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { MediaMetadataSyncService } from './sync/media-metadata-sync.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import type { EnrichmentJob } from '@prisma/client';
import type { ThumbnailResult } from '@memoriahub/enrichment-compute/dto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'thumbnail_regen',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: 'running' as any,
    reason: 'rerun' as any,
    priority: 0,
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
  } as EnrichmentJob;
}

function makeResult(overrides: Partial<ThumbnailResult> = {}): ThumbnailResult {
  return {
    storageKey: 'thumbnails/so-original.jpg',
    width: 400,
    height: 300,
    bytes: 12345,
    ...overrides,
  };
}

function makeMediaItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'media-1',
    deletedAt: null,
    storageObject: {
      id: 'so-original',
      name: 'photo.jpg',
      uploadedById: 'user-1',
      metadata: null,
    },
    ...overrides,
  };
}

describe('ThumbnailNodePersistService', () => {
  let service: ThumbnailNodePersistService;
  let mockPrisma: MockPrismaService;
  let mockResolver: { getActiveProvider: jest.Mock };
  let mockActiveProvider: {
    exists: jest.Mock;
    getObjectSize: jest.Mock;
    getBucket: jest.Mock;
  };
  let mockSync: jest.Mocked<Pick<MediaMetadataSyncService, 'syncFromStorageObject'>>;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    mockActiveProvider = {
      exists: jest.fn().mockResolvedValue(true),
      getObjectSize: jest.fn().mockResolvedValue(12345),
      getBucket: jest.fn().mockReturnValue('test-bucket'),
    };
    mockResolver = {
      getActiveProvider: jest.fn().mockResolvedValue({ id: 's3', provider: mockActiveProvider }),
    };
    mockSync = { syncFromStorageObject: jest.fn().mockResolvedValue(undefined) };

    (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
    (mockPrisma.storageObject.upsert as jest.Mock).mockResolvedValue({ id: 'thumb-obj-1' });
    (mockPrisma.storageObject.update as jest.Mock).mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThumbnailNodePersistService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageProviderResolver, useValue: mockResolver },
        { provide: MediaMetadataSyncService, useValue: mockSync },
      ],
    }).compile();

    service = module.get(ThumbnailNodePersistService);
  });

  // =========================================================================
  // Happy path
  // =========================================================================

  describe('happy path', () => {
    it('validates existence + size, upserts the thumbnail StorageObject, merges _processing, and syncs', async () => {
      await service.persistThumbnail(makeJob(), makeResult());

      expect(mockActiveProvider.exists).toHaveBeenCalledWith('thumbnails/so-original.jpg');
      expect(mockActiveProvider.getObjectSize).toHaveBeenCalledWith('thumbnails/so-original.jpg');

      const upsertCall = (mockPrisma.storageObject.upsert as jest.Mock).mock.calls[0][0];
      expect(upsertCall.where).toEqual({ storageKey: 'thumbnails/so-original.jpg' });
      expect(upsertCall.create).toMatchObject({
        name: 'thumb-photo.jpg',
        mimeType: 'image/jpeg',
        storageKey: 'thumbnails/so-original.jpg',
        status: 'ready',
        metadata: { thumbnailOf: 'so-original' },
      });

      const updateCall = (mockPrisma.storageObject.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 'so-original' });
      const processing = (updateCall.data.metadata as Record<string, unknown>)['_processing'] as Record<
        string,
        unknown
      >;
      expect(processing['thumbnail']).toEqual({
        thumbnailObjectId: 'thumb-obj-1',
        thumbnailStorageKey: 'thumbnails/so-original.jpg',
      });

      expect(mockSync.syncFromStorageObject).toHaveBeenCalledWith('so-original');
    });

    it('preserves existing _processing keys on the original object when merging', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({
          storageObject: {
            id: 'so-original',
            name: 'photo.jpg',
            uploadedById: 'user-1',
            metadata: { _processing: { exif: { cameraMake: 'Apple' } }, otherKey: 'kept' },
          },
        }),
      );

      await service.persistThumbnail(makeJob(), makeResult());

      const updateCall = (mockPrisma.storageObject.update as jest.Mock).mock.calls[0][0];
      const merged = updateCall.data.metadata as Record<string, unknown>;
      expect(merged['otherKey']).toBe('kept');
      const processing = merged['_processing'] as Record<string, unknown>;
      expect(processing['exif']).toEqual({ cameraMake: 'Apple' });
      expect(processing['thumbnail']).toBeDefined();
    });

    it('skips the size check (but still persists) when getObjectSize returns null', async () => {
      mockActiveProvider.getObjectSize.mockResolvedValue(null);

      await expect(service.persistThumbnail(makeJob(), makeResult())).resolves.toBeUndefined();
      expect(mockPrisma.storageObject.upsert).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Validation failures
  // =========================================================================

  describe('validation failures', () => {
    it('throws when the object does not exist at storageKey on the active provider', async () => {
      mockActiveProvider.exists.mockResolvedValue(false);

      await expect(service.persistThumbnail(makeJob(), makeResult())).rejects.toThrow(
        /no object found at storageKey/i,
      );

      expect(mockPrisma.storageObject.upsert).not.toHaveBeenCalled();
      expect(mockSync.syncFromStorageObject).not.toHaveBeenCalled();
    });

    it('throws on a byte-length mismatch between the reported and actual size', async () => {
      mockActiveProvider.getObjectSize.mockResolvedValue(999);

      await expect(
        service.persistThumbnail(makeJob(), makeResult({ bytes: 12345 })),
      ).rejects.toThrow(/byte-length mismatch/i);

      expect(mockPrisma.storageObject.upsert).not.toHaveBeenCalled();
      expect(mockSync.syncFromStorageObject).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Graceful skip paths
  // =========================================================================

  describe('graceful skip paths', () => {
    it('skips without throwing when job.mediaItemId is null', async () => {
      await expect(
        service.persistThumbnail(makeJob({ mediaItemId: null }), makeResult()),
      ).resolves.toBeUndefined();
      expect(mockResolver.getActiveProvider).not.toHaveBeenCalled();
    });

    it('skips without throwing when the MediaItem is missing', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.persistThumbnail(makeJob(), makeResult())).resolves.toBeUndefined();
      expect(mockResolver.getActiveProvider).not.toHaveBeenCalled();
    });

    it('skips without throwing when the MediaItem is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await expect(service.persistThumbnail(makeJob(), makeResult())).resolves.toBeUndefined();
      expect(mockResolver.getActiveProvider).not.toHaveBeenCalled();
    });

    it('skips without throwing when the MediaItem has no storageObject', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ storageObject: null }),
      );

      await expect(service.persistThumbnail(makeJob(), makeResult())).resolves.toBeUndefined();
      expect(mockResolver.getActiveProvider).not.toHaveBeenCalled();
    });
  });
});
