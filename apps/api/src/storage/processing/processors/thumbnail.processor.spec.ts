import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'stream';
import { ThumbnailProcessor } from './thumbnail.processor';
import { PrismaService } from '../../../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../../providers/storage-provider.interface';
import { StorageProviderResolver } from '../../providers/storage-provider.resolver';
import { createMockPrismaService, MockPrismaService } from '../../../../test/mocks/prisma.mock';
import { createMockStorageProvider } from '../../../../test/mocks/storage-provider.mock';

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
        `thumbnails/${object.id}.jpg`,
        expect.any(Readable),
        expect.objectContaining({ mimeType: 'image/jpeg' }),
      );
      expect(mockStaticProvider.upload).not.toHaveBeenCalled();
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
        thumbnailStorageKey: `thumbnails/${object.id}.jpg`,
      });
    });
  });
});
