/**
 * Unit tests — MediaReprocessService
 *
 * Mock strategy: all dependencies are replaced with jest.fn() mocks.
 * - PrismaService (storageObject.findUnique, storageObject.update,
 *                  mediaItem.findMany)
 * - EventEmitter2 (emit)
 * - ThumbnailProcessor (canProcess, process, download)
 * - ImageDimensionsProcessor (canProcess, process)
 *
 * No I/O, no DB, no storage. Tests cover:
 *   - Skip rules (non-image, thumbnail key, non-ready, missing object)
 *   - Happy path: processors called in order, metadata merged, event emitted
 *   - reprocessCircle: correct counts, circleId filter forwarded to prisma
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MediaReprocessService } from './media-reprocess.service';
import { PrismaService } from '../prisma/prisma.service';
import { ThumbnailProcessor } from '../storage/processing/processors/thumbnail.processor';
import { ImageDimensionsProcessor } from '../storage/processing/processors/image-dimensions.processor';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { OBJECT_PROCESSED_EVENT } from '../storage/processing/events/object-processed.event';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeStorageObject(overrides: Partial<{
  id: string;
  mimeType: string;
  storageKey: string;
  status: string;
  metadata: Record<string, unknown> | null;
}> = {}) {
  return {
    id: overrides.id ?? 'obj-001',
    mimeType: overrides.mimeType ?? 'image/jpeg',
    storageKey: overrides.storageKey ?? 'originals/photo.jpg',
    status: overrides.status ?? 'ready',
    name: 'photo.jpg',
    size: BigInt(1000),
    bucket: 'test-bucket',
    storageProvider: 's3',
    s3UploadId: null,
    uploadedById: 'user-1',
    metadata: overrides.metadata ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaReprocessService', () => {
  let service: MediaReprocessService;

  // Prisma mocks
  let mockFindUnique: jest.Mock;
  let mockUpdate: jest.Mock;
  let mockFindManyMedia: jest.Mock;

  // EventEmitter mock
  let mockEmit: jest.Mock;

  // Processor mocks
  let mockThumbnailCanProcess: jest.Mock;
  let mockThumbnailProcess: jest.Mock;
  let mockThumbnailDownload: jest.Mock;
  let mockDimensionsCanProcess: jest.Mock;
  let mockDimensionsProcess: jest.Mock;

  // StorageProviderResolver mock
  let mockResolverDownload: jest.Mock;
  let mockGetProviderFor: jest.Mock;

  beforeEach(async () => {
    mockFindUnique = jest.fn();
    mockUpdate = jest.fn().mockResolvedValue({});
    mockFindManyMedia = jest.fn();

    mockEmit = jest.fn();

    mockThumbnailDownload = jest.fn().mockResolvedValue({ pipe: jest.fn() });
    mockThumbnailCanProcess = jest.fn().mockReturnValue(true);
    mockThumbnailProcess = jest.fn().mockResolvedValue({
      success: true,
      metadata: { thumbnailObjectId: 'new-thumb-id', thumbnailStorageKey: 'thumbnails/new.jpg' },
    });

    mockDimensionsCanProcess = jest.fn().mockReturnValue(true);
    mockDimensionsProcess = jest.fn().mockResolvedValue({
      success: true,
      metadata: { width: 100, height: 200 },
    });

    // Resolver returns a stub storage provider whose download resolves to a stream.
    mockResolverDownload = jest.fn().mockResolvedValue({ pipe: jest.fn() });
    mockGetProviderFor = jest.fn().mockResolvedValue({ download: mockResolverDownload });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaReprocessService,
        {
          provide: PrismaService,
          useValue: {
            storageObject: {
              findUnique: mockFindUnique,
              update: mockUpdate,
            },
            mediaItem: {
              findMany: mockFindManyMedia,
            },
          },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: mockEmit,
          },
        },
        {
          provide: ThumbnailProcessor,
          useValue: {
            name: 'thumbnail',
            priority: 40,
            canProcess: mockThumbnailCanProcess,
            process: mockThumbnailProcess,
            download: mockThumbnailDownload,
          },
        },
        {
          provide: ImageDimensionsProcessor,
          useValue: {
            name: 'dimensions',
            priority: 25,
            canProcess: mockDimensionsCanProcess,
            process: mockDimensionsProcess,
          },
        },
        {
          provide: StorageProviderResolver,
          useValue: { getProviderFor: mockGetProviderFor },
        },
      ],
    }).compile();

    service = module.get<MediaReprocessService>(MediaReprocessService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // reprocessImageObject — skip rules
  // -------------------------------------------------------------------------

  describe('reprocessImageObject — skip rules', () => {
    it('should skip objects the thumbnail processor cannot handle (e.g. application/pdf)', async () => {
      // The top-level gate now delegates entirely to thumbnailProcessor.canProcess
      // (no more mimeType.startsWith('image/') check), so the skip path must be
      // exercised by making canProcess itself return false — a PDF mimeType alone
      // no longer skips anything since canProcess is stubbed to return true by default.
      mockThumbnailCanProcess.mockReturnValue(false);
      mockFindUnique.mockResolvedValue(makeStorageObject({ mimeType: 'application/pdf' }));

      await service.reprocessImageObject('obj-001');

      expect(mockThumbnailProcess).not.toHaveBeenCalled();
      expect(mockDimensionsProcess).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('should skip objects whose storageKey starts with "thumbnails/"', async () => {
      mockFindUnique.mockResolvedValue(
        makeStorageObject({ mimeType: 'image/jpeg', storageKey: 'thumbnails/foo.jpg', status: 'ready' }),
      );

      await service.reprocessImageObject('obj-001');

      expect(mockThumbnailProcess).not.toHaveBeenCalled();
      expect(mockDimensionsProcess).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('should skip objects whose status is not ready/failed/processing (e.g. pending)', async () => {
      mockFindUnique.mockResolvedValue(
        makeStorageObject({ mimeType: 'image/jpeg', status: 'pending' }),
      );

      await service.reprocessImageObject('obj-001');

      expect(mockThumbnailProcess).not.toHaveBeenCalled();
      expect(mockDimensionsProcess).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('should skip objects whose status is "uploading"', async () => {
      mockFindUnique.mockResolvedValue(
        makeStorageObject({ mimeType: 'image/jpeg', status: 'uploading' }),
      );

      await service.reprocessImageObject('obj-001');

      expect(mockThumbnailProcess).not.toHaveBeenCalled();
      expect(mockDimensionsProcess).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('should NOT skip objects whose status is "failed" (recovery path)', async () => {
      mockFindUnique.mockResolvedValue(
        makeStorageObject({ mimeType: 'image/jpeg', status: 'failed' }),
      );

      await service.reprocessImageObject('obj-001');

      // Processors should run so the object can be recovered
      expect(mockDimensionsProcess).toHaveBeenCalledTimes(1);
      expect(mockThumbnailProcess).toHaveBeenCalledTimes(1);
    });

    it('should return without error when the object does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(service.reprocessImageObject('nonexistent')).resolves.toBeUndefined();
      expect(mockThumbnailProcess).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // reprocessImageObject — happy path (processors called in order)
  // -------------------------------------------------------------------------

  describe('reprocessImageObject — happy path', () => {
    it('should call both ImageDimensionsProcessor and ThumbnailProcessor', async () => {
      mockFindUnique.mockResolvedValue(makeStorageObject());

      await service.reprocessImageObject('obj-001');

      expect(mockDimensionsProcess).toHaveBeenCalledTimes(1);
      expect(mockThumbnailProcess).toHaveBeenCalledTimes(1);
    });

    it('should call storageObject.update exactly once with merged metadata and status ready', async () => {
      mockFindUnique.mockResolvedValue(makeStorageObject());

      await service.reprocessImageObject('obj-001');

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      const updateArg = mockUpdate.mock.calls[0][0];
      expect(updateArg.where).toEqual({ id: 'obj-001' });
      expect(updateArg.data.status).toBe('ready');
      expect(updateArg.data.metadata).toMatchObject({
        _processing: expect.objectContaining({
          thumbnail: { thumbnailObjectId: 'new-thumb-id', thumbnailStorageKey: 'thumbnails/new.jpg' },
          dimensions: { width: 100, height: 200 },
        }),
      });
    });

    it('should set status to ready even when recovering a previously failed object', async () => {
      mockFindUnique.mockResolvedValue(makeStorageObject({ status: 'failed' }));

      await service.reprocessImageObject('obj-001');

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      const updateArg = mockUpdate.mock.calls[0][0];
      expect(updateArg.data.status).toBe('ready');
    });

    it('should emit OBJECT_PROCESSED_EVENT after update', async () => {
      mockFindUnique.mockResolvedValue(makeStorageObject());

      await service.reprocessImageObject('obj-001');

      expect(mockEmit).toHaveBeenCalledWith(
        OBJECT_PROCESSED_EVENT,
        expect.objectContaining({ storageObjectId: 'obj-001' }),
      );
    });

    it('should process (not skip) objects whose status is "processing" — OOM-orphan recovery', async () => {
      // 'processing' was previously a skip case; it is now a processable status
      // covering objects orphaned by an OOM-killed API container mid-thumbnail-generation.
      mockFindUnique.mockResolvedValue(
        makeStorageObject({ mimeType: 'image/jpeg', status: 'processing' }),
      );

      await service.reprocessImageObject('obj-001');

      expect(mockDimensionsProcess).toHaveBeenCalledTimes(1);
      expect(mockThumbnailProcess).toHaveBeenCalledTimes(1);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockUpdate.mock.calls[0][0].data.status).toBe('ready');
      expect(mockEmit).toHaveBeenCalledWith(
        OBJECT_PROCESSED_EVENT,
        expect.objectContaining({ storageObjectId: 'obj-001' }),
      );
    });

    it('should reprocess video objects — thumbnail runs, dimensions self-guards and skips', async () => {
      // ImageDimensionsProcessor self-guards to image/* via its own canProcess,
      // so video objects should still get a first-frame thumbnail while
      // dimensions extraction is correctly skipped.
      mockThumbnailCanProcess.mockReturnValue(true);
      mockDimensionsCanProcess.mockReturnValue(false);
      mockFindUnique.mockResolvedValue(makeStorageObject({ mimeType: 'video/mp4' }));

      await expect(service.reprocessImageObject('obj-001')).resolves.toBeUndefined();

      expect(mockThumbnailProcess).toHaveBeenCalledTimes(1);
      expect(mockDimensionsProcess).not.toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockEmit).toHaveBeenCalledWith(
        OBJECT_PROCESSED_EVENT,
        expect.objectContaining({ storageObjectId: 'obj-001' }),
      );
    });

    it('should use resolver.getProviderFor to download originals via the per-object provider', async () => {
      const obj = makeStorageObject();
      mockFindUnique.mockResolvedValue(obj);

      // Override the dimensions processor to actually invoke the getStream callback
      // so the resolver.getProviderFor call inside it is exercised.
      mockDimensionsProcess.mockImplementationOnce(async (_obj: unknown, getStream: () => Promise<unknown>) => {
        await getStream();
        return { success: true, metadata: { width: 100, height: 200 } };
      });

      await service.reprocessImageObject('obj-001');

      // Both processors received a getStream callback
      expect(mockDimensionsProcess).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
      );
      expect(mockThumbnailProcess).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
      );

      // resolver.getProviderFor was called with the object's own provider/bucket,
      // not the legacy static STORAGE_PROVIDER token.
      expect(mockGetProviderFor).toHaveBeenCalledWith(
        obj.storageProvider,
        obj.bucket,
      );
    });
  });

  // -------------------------------------------------------------------------
  // reprocessCircle
  // -------------------------------------------------------------------------

  describe('reprocessCircle', () => {
    it('should return { reprocessed, failed } counts', async () => {
      // Two media items, two distinct storageObjectIds
      mockFindManyMedia.mockResolvedValue([
        { storageObjectId: 'obj-success' },
        { storageObjectId: 'obj-fail' },
      ]);

      // First object: valid image — succeeds (findUnique returns object, update resolves)
      // Second object: findUnique throws so reprocessImageObject propagates the error
      // to the reprocessCircle loop which catches it and increments failed.
      mockFindUnique
        .mockResolvedValueOnce(makeStorageObject({ id: 'obj-success' }))
        .mockRejectedValueOnce(new Error('DB timeout'));

      const result = await service.reprocessCircle();

      expect(result.reprocessed).toBe(1);
      expect(result.failed).toBe(1);
    });

    it('should query mediaItem.findMany with circleId filter when circleId is provided', async () => {
      mockFindManyMedia.mockResolvedValue([]);

      await service.reprocessCircle('circle-1');

      expect(mockFindManyMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ circleId: 'circle-1', deletedAt: null }),
        }),
      );
    });

    it('should query mediaItem.findMany without circleId filter when no circleId provided', async () => {
      mockFindManyMedia.mockResolvedValue([]);

      await service.reprocessCircle();

      const callArg = mockFindManyMedia.mock.calls[0][0];
      expect(callArg.where).not.toHaveProperty('circleId');
      expect(callArg.where).toMatchObject({ deletedAt: null });
    });

    it('should deduplicate storageObjectIds before processing', async () => {
      // Same storageObjectId referenced by two mediaItems
      mockFindManyMedia.mockResolvedValue([
        { storageObjectId: 'obj-001' },
        { storageObjectId: 'obj-001' },
      ]);
      mockFindUnique.mockResolvedValue(makeStorageObject({ id: 'obj-001' }));

      const result = await service.reprocessCircle();

      // Should only process once despite two mediaItems referencing it
      expect(mockFindUnique).toHaveBeenCalledTimes(1);
      expect(result.reprocessed).toBe(1);
      expect(result.failed).toBe(0);
    });
  });
});
