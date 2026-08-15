import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'stream';
import { ThumbnailProcessor } from './thumbnail.processor';
import { PrismaService } from '../../../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../../providers/storage-provider.interface';
import { StorageProviderResolver } from '../../providers/storage-provider.resolver';
import { createMockPrismaService, MockPrismaService } from '../../../../test/mocks/prisma.mock';
import { createMockStorageProvider } from '../../../../test/mocks/storage-provider.mock';
import { buildThumbnailKey, thumbnailVersionFromBytes } from '../thumbnail-key.util';

// The mocked sharp below always renders these exact bytes, so the versioned,
// content-addressed thumbnail key (issue #434) is fully determined here.
const FAKE_THUMB_BYTES = Buffer.from('fake-jpeg-data');
const expectedThumbKey = (objectId: string) =>
  buildThumbnailKey(objectId, thumbnailVersionFromBytes(FAKE_THUMB_BYTES));

// ---------------------------------------------------------------------------
// Mock sharp so the image path can be exercised without real image data
// ---------------------------------------------------------------------------
jest.mock('sharp', () => {
  const mockSharpInstance = {
    rotate: jest.fn().mockReturnThis(),
    resize: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-jpeg-data')),
  };
  return jest.fn(() => mockSharpInstance);
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStorageObject(overrides: Partial<any> = {}) {
  return {
    id: 'obj-123',
    name: 'photo.jpg',
    size: BigInt(1024000),
    mimeType: 'image/jpeg',
    storageKey: 'uploads/photo.jpg',
    storageProvider: 's3',
    bucket: 'default-bucket',
    status: 'processing',
    s3UploadId: null,
    uploadedById: 'user-1',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThumbnailProcessor', () => {
  let processor: ThumbnailProcessor;
  let mockPrisma: MockPrismaService;
  let mockStaticProvider: ReturnType<typeof createMockStorageProvider>;
  let mockResolver: { getActiveProvider: jest.Mock; getProviderFor: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockStaticProvider = createMockStorageProvider();
    mockResolver = {
      getActiveProvider: jest.fn(),
      getProviderFor: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThumbnailProcessor,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStaticProvider },
        { provide: StorageProviderResolver, useValue: mockResolver },
      ],
    }).compile();

    processor = module.get<ThumbnailProcessor>(ThumbnailProcessor);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // canProcess()
  // -------------------------------------------------------------------------

  describe('canProcess()', () => {
    it('returns false for storageKeys starting with thumbnails/', () => {
      const obj = makeStorageObject({ storageKey: 'thumbnails/obj-123.jpg', mimeType: 'image/jpeg' });
      expect(processor.canProcess(obj as any)).toBe(false);
    });

    it('returns true for image/* mimeType with a non-thumbnail storageKey', () => {
      const obj = makeStorageObject({ storageKey: 'uploads/photo.jpg', mimeType: 'image/jpeg' });
      expect(processor.canProcess(obj as any)).toBe(true);
    });

    it('returns true for video/* mimeType with a non-thumbnail storageKey', () => {
      const obj = makeStorageObject({ storageKey: 'uploads/clip.mp4', mimeType: 'video/mp4' });
      expect(processor.canProcess(obj as any)).toBe(true);
    });

    it('returns false for unsupported mimeTypes', () => {
      const obj = makeStorageObject({ storageKey: 'uploads/doc.pdf', mimeType: 'application/pdf' });
      expect(processor.canProcess(obj as any)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // download() — must use static provider, NOT the resolver
  // -------------------------------------------------------------------------

  describe('download()', () => {
    it('calls the static storage provider download, not the resolver', async () => {
      const stream = Readable.from(['data']);
      mockStaticProvider.download.mockResolvedValue(stream);

      const result = await processor.download('some/key');

      expect(mockStaticProvider.download).toHaveBeenCalledWith('some/key');
      expect(mockResolver.getActiveProvider).not.toHaveBeenCalled();
      expect(result).toBe(stream);
    });
  });

  // -------------------------------------------------------------------------
  // uploadThumbnail (exercised via process())
  // -------------------------------------------------------------------------

  describe('uploadThumbnail()', () => {
    let mockActiveProvider: ReturnType<typeof createMockStorageProvider>;

    beforeEach(() => {
      // Build a second mock provider that will be returned as the "active" provider
      mockActiveProvider = createMockStorageProvider();
      mockActiveProvider.getBucket.mockReturnValue('r2-bucket');

      // Resolver returns the active provider with id 'r2'
      mockResolver.getActiveProvider.mockResolvedValue({ id: 'r2', provider: mockActiveProvider });

      // Prisma upsert returns a minimal thumb object
      mockPrisma.storageObject.upsert.mockResolvedValue({
        id: 'thumb-obj-1',
        storageKey: 'thumbnails/obj-123.jpg',
        storageProvider: 'r2',
        bucket: 'r2-bucket',
        name: 'thumb-photo.jpg',
        size: BigInt(100),
        mimeType: 'image/jpeg',
        status: 'ready',
        uploadedById: 'user-1',
        metadata: { thumbnailOf: 'obj-123' },
        s3UploadId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
    });

    it('uploads via the active provider, not the static one', async () => {
      const object = makeStorageObject({ mimeType: 'image/jpeg' });
      const getStream = async () => Readable.from([Buffer.from('fake')]);

      await processor.process(object as any, getStream);

      expect(mockActiveProvider.upload).toHaveBeenCalledWith(
        expectedThumbKey(object.id),
        expect.any(Readable),
        expect.objectContaining({ mimeType: 'image/jpeg' }),
      );
      expect(mockStaticProvider.upload).not.toHaveBeenCalled();
    });

    it('passes cacheControl: "public, max-age=31536000, immutable" to the active provider', async () => {
      const object = makeStorageObject({ mimeType: 'image/jpeg' });
      const getStream = async () => Readable.from([Buffer.from('fake')]);

      await processor.process(object as any, getStream);

      expect(mockActiveProvider.upload).toHaveBeenCalledWith(
        expectedThumbKey(object.id),
        expect.any(Readable),
        expect.objectContaining({
          cacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    });

    it('persists the active provider id (r2) in the upsert create branch, not s3', async () => {
      const object = makeStorageObject({ mimeType: 'image/jpeg' });
      const getStream = async () => Readable.from([Buffer.from('fake')]);

      await processor.process(object as any, getStream);

      expect(mockPrisma.storageObject.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            storageProvider: 'r2',
            bucket: 'r2-bucket',
          }),
        }),
      );
    });

    it('does NOT hardcode s3 in the upsert create branch', async () => {
      const object = makeStorageObject({ mimeType: 'image/jpeg' });
      const getStream = async () => Readable.from([Buffer.from('fake')]);

      await processor.process(object as any, getStream);

      const upsertCall = (mockPrisma.storageObject.upsert as jest.Mock).mock.calls[0][0];
      expect(upsertCall.create.storageProvider).not.toBe('s3');
    });

    it('refreshes provider/bucket in the upsert update branch (reprocess after provider switch)', async () => {
      const object = makeStorageObject({ mimeType: 'image/jpeg' });
      const getStream = async () => Readable.from([Buffer.from('fake')]);

      await processor.process(object as any, getStream);

      // The update branch must also carry the active provider id + bucket so a
      // reprocess after the active provider changed doesn't leave the row
      // pointing at the old (now-empty) provider.
      expect(mockPrisma.storageObject.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            storageProvider: 'r2',
            bucket: 'r2-bucket',
          }),
        }),
      );
    });

    it('returns success with thumbnailObjectId and thumbnailStorageKey', async () => {
      const object = makeStorageObject({ mimeType: 'image/jpeg' });
      const getStream = async () => Readable.from([Buffer.from('fake')]);

      const result = await processor.process(object as any, getStream);

      expect(result.success).toBe(true);
      expect(result.metadata).toMatchObject({
        thumbnailObjectId: 'thumb-obj-1',
        thumbnailStorageKey: expectedThumbKey(object.id),
      });
    });

    // -----------------------------------------------------------------------
    // Issue #434 — the key is VERSIONED and CONTENT-ADDRESSED
    // -----------------------------------------------------------------------

    it('writes to a versioned thumbnails/<objectId>-<hash>.jpg key, never the bare <objectId>.jpg', async () => {
      const object = makeStorageObject({ mimeType: 'image/jpeg' });
      const getStream = async () => Readable.from([Buffer.from('fake')]);

      await processor.process(object as any, getStream);

      const [key] = mockActiveProvider.upload.mock.calls[0];
      expect(key).toMatch(/^thumbnails\/obj-123-[0-9a-f]{16}\.jpg$/);
      expect(key).not.toBe('thumbnails/obj-123.jpg');
    });

    it('reuses the SAME key when the rendered bytes are unchanged (reprocess stays an idempotent upsert)', async () => {
      const object = makeStorageObject({ mimeType: 'image/jpeg' });
      const getStream = async () => Readable.from([Buffer.from('fake')]);

      await processor.process(object as any, getStream);
      await processor.process(object as any, getStream);

      const [firstKey] = mockActiveProvider.upload.mock.calls[0];
      const [secondKey] = mockActiveProvider.upload.mock.calls[1];
      expect(secondKey).toBe(firstKey);
      expect(mockPrisma.storageObject.upsert).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ where: { storageKey: firstKey } }),
      );
    });

    it('moves to a NEW key when the rendered bytes change — the destructive-overwrite case the stale grid tile came from', async () => {
      const object = makeStorageObject({ mimeType: 'image/jpeg' });
      const getStream = async () => Readable.from([Buffer.from('fake')]);

      await processor.process(object as any, getStream);
      const [firstKey] = mockActiveProvider.upload.mock.calls[0];

      // Simulate the original's bytes having been overwritten (AI enhance
      // replace / orientation edit): sharp now renders different thumbnail bytes.
      const sharpMock = jest.requireMock('sharp') as jest.Mock;
      sharpMock().toBuffer.mockResolvedValueOnce(Buffer.from('enhanced-jpeg-data'));

      await processor.process(object as any, getStream);
      const [secondKey] = mockActiveProvider.upload.mock.calls[1];

      expect(secondKey).not.toBe(firstKey);
      expect(secondKey).toBe(
        buildThumbnailKey(object.id, thumbnailVersionFromBytes(Buffer.from('enhanced-jpeg-data'))),
      );
    });
  });
});
