/**
 * Unit tests for MediaThumbnailService.
 *
 * Covers three behaviors added by the gallery-perf work (issue #104):
 *   1. Batched signing (`signThumbsBatched`) — one storageObject.findMany call
 *      for N keys, one provider resolution per distinct (provider|bucket)
 *      pair, static-provider fallback for keys with no matching row, and
 *      per-key error isolation (a failing sign never throws, it maps to null).
 *   2. The in-memory signed-URL cache — same key signed twice returns the
 *      SAME url string and only calls the provider once; different keys sign
 *      independently; `clearUrlCache()` forces a fresh signing round-trip.
 *   3. `extractThumbKey` / `attachThumbnailUrls` convenience helpers.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MediaThumbnailService } from './media-thumbnail.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';

describe('MediaThumbnailService', () => {
  let service: MediaThumbnailService;
  let mockPrisma: MockPrismaService;
  let mockStorageProvider: { getSignedDownloadUrl: jest.Mock; getBucket: jest.Mock };
  let mockResolver: { getProviderFor: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockStorageProvider = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://cdn.example.com/static-signed'),
      getBucket: jest.fn().mockReturnValue('legacy-static-bucket'),
    };
    mockResolver = {
      getProviderFor: jest.fn().mockResolvedValue({
        getSignedDownloadUrl: jest.fn().mockResolvedValue('https://cdn.example.com/resolved-signed'),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaThumbnailService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: StorageProviderResolver, useValue: mockResolver },
      ],
    }).compile();

    service = module.get<MediaThumbnailService>(MediaThumbnailService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // signThumbsBatched
  // -------------------------------------------------------------------------

  describe('signThumbsBatched', () => {
    it('issues exactly one storageObject.findMany call for N keys', async () => {
      const keys = ['thumbs/a.jpg', 'thumbs/b.jpg', 'thumbs/c.jpg'];
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
        { storageKey: 'thumbs/a.jpg', storageProvider: 's3', bucket: 'bucket-a' },
        { storageKey: 'thumbs/b.jpg', storageProvider: 's3', bucket: 'bucket-a' },
        { storageKey: 'thumbs/c.jpg', storageProvider: 'r2', bucket: 'bucket-b' },
      ]);

      await service.signThumbsBatched(keys);

      expect(mockPrisma.storageObject.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.storageObject.findMany).toHaveBeenCalledWith({
        where: { storageKey: { in: keys } },
        select: { storageKey: true, storageProvider: true, bucket: true },
      });
    });

    it('resolves each distinct (provider|bucket) pair only once', async () => {
      const keys = ['thumbs/a.jpg', 'thumbs/b.jpg', 'thumbs/c.jpg'];
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
        // a and b share the same provider+bucket; c differs.
        { storageKey: 'thumbs/a.jpg', storageProvider: 's3', bucket: 'bucket-a' },
        { storageKey: 'thumbs/b.jpg', storageProvider: 's3', bucket: 'bucket-a' },
        { storageKey: 'thumbs/c.jpg', storageProvider: 'r2', bucket: 'bucket-b' },
      ]);

      await service.signThumbsBatched(keys);

      expect(mockResolver.getProviderFor).toHaveBeenCalledTimes(2);
      expect(mockResolver.getProviderFor).toHaveBeenCalledWith('s3', 'bucket-a');
      expect(mockResolver.getProviderFor).toHaveBeenCalledWith('r2', 'bucket-b');
    });

    it('falls back to the static provider for keys with no matching StorageObject row', async () => {
      const keys = ['thumbs/orphan.jpg'];
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([]);
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue(
        'https://cdn.example.com/orphan-signed',
      );

      const result = await service.signThumbsBatched(keys);

      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith(
        'thumbs/orphan.jpg',
        { expiresIn: 86400 },
      );
      expect(result.get('thumbs/orphan.jpg')).toBe('https://cdn.example.com/orphan-signed');
    });

    it('maps a failing sign for one key to null without throwing, and still signs the rest', async () => {
      const keys = ['thumbs/broken.jpg', 'thumbs/ok.jpg'];
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
        { storageKey: 'thumbs/broken.jpg', storageProvider: 's3', bucket: 'bucket-a' },
        { storageKey: 'thumbs/ok.jpg', storageProvider: 's3', bucket: 'bucket-a' },
      ]);
      const signedUrl = jest
        .fn()
        .mockRejectedValueOnce(new Error('S3 error'))
        .mockResolvedValueOnce('https://cdn.example.com/ok-signed');
      mockResolver.getProviderFor.mockResolvedValue({ getSignedDownloadUrl: signedUrl });

      const result = await service.signThumbsBatched(keys);

      expect(result.get('thumbs/broken.jpg')).toBeNull();
      expect(result.get('thumbs/ok.jpg')).toBe('https://cdn.example.com/ok-signed');
    });

    it('returns an empty map for an empty key list without querying the database', async () => {
      const result = await service.signThumbsBatched([]);

      expect(result.size).toBe(0);
      expect(mockPrisma.storageObject.findMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Signed-URL cache
  // -------------------------------------------------------------------------

  describe('signed-URL cache', () => {
    it('signing the same key twice returns the same URL and calls the provider only once', async () => {
      const key = 'thumbs/cached.jpg';
      const signedUrl = jest.fn().mockResolvedValue('https://cdn.example.com/cached-signed');
      mockResolver.getProviderFor.mockResolvedValue({ getSignedDownloadUrl: signedUrl });
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
        { storageKey: key, storageProvider: 's3', bucket: 'bucket-a' },
      ]);

      const first = await service.signThumbsBatched([key]);
      const second = await service.signThumbsBatched([key]);

      expect(first.get(key)).toBe(second.get(key));
      expect(signedUrl).toHaveBeenCalledTimes(1);
    });

    it('different keys sign independently (each calls the provider)', async () => {
      const keyA = 'thumbs/x.jpg';
      const keyB = 'thumbs/y.jpg';
      const signA = jest.fn().mockResolvedValue('https://cdn.example.com/x-signed');
      const signB = jest.fn().mockResolvedValue('https://cdn.example.com/y-signed');
      mockResolver.getProviderFor.mockImplementation(async () => ({
        getSignedDownloadUrl: mockResolver.getProviderFor.mock.calls.length === 1 ? signA : signB,
      }));
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
        { storageKey: keyA, storageProvider: 's3', bucket: 'bucket-a' },
        { storageKey: keyB, storageProvider: 's3', bucket: 'bucket-b' },
      ]);

      const result = await service.signThumbsBatched([keyA, keyB]);

      expect(result.get(keyA)).toBe('https://cdn.example.com/x-signed');
      expect(result.get(keyB)).toBe('https://cdn.example.com/y-signed');
      expect(signA).toHaveBeenCalledTimes(1);
      expect(signB).toHaveBeenCalledTimes(1);
    });

    it('re-signs after clearUrlCache() is called', async () => {
      const key = 'thumbs/cached.jpg';
      const signedUrl = jest.fn().mockResolvedValue('https://cdn.example.com/cached-signed');
      mockResolver.getProviderFor.mockResolvedValue({ getSignedDownloadUrl: signedUrl });
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
        { storageKey: key, storageProvider: 's3', bucket: 'bucket-a' },
      ]);

      await service.signThumbsBatched([key]);
      service.clearUrlCache();
      await service.signThumbsBatched([key]);

      expect(signedUrl).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // extractThumbKey
  // -------------------------------------------------------------------------

  describe('extractThumbKey', () => {
    it('returns the key when metadata has a non-empty thumbnailStorageKey string', () => {
      expect(
        service.extractThumbKey({ thumbnailStorageKey: 'thumbs/a.jpg' }),
      ).toBe('thumbs/a.jpg');
    });

    it('returns null for null metadata', () => {
      expect(service.extractThumbKey(null)).toBeNull();
    });

    it('returns null when metadata is not a plain object (e.g. an array)', () => {
      expect(service.extractThumbKey(['not', 'an', 'object'] as any)).toBeNull();
    });

    it('returns null when thumbnailStorageKey is missing', () => {
      expect(service.extractThumbKey({ someOtherField: 'x' })).toBeNull();
    });

    it('returns null when thumbnailStorageKey is an empty string', () => {
      expect(service.extractThumbKey({ thumbnailStorageKey: '' })).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // attachThumbnailUrls
  // -------------------------------------------------------------------------

  describe('attachThumbnailUrls', () => {
    it('enriches each item with a signed thumbnailUrl, batching the underlying query', async () => {
      const items = [
        { id: 'item-1', metadata: { thumbnailStorageKey: 'thumbs/a.jpg' } },
        { id: 'item-2', metadata: { thumbnailStorageKey: 'thumbs/b.jpg' } },
        { id: 'item-3', metadata: null },
      ];
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
        { storageKey: 'thumbs/a.jpg', storageProvider: 's3', bucket: 'bucket-a' },
        { storageKey: 'thumbs/b.jpg', storageProvider: 's3', bucket: 'bucket-a' },
      ]);

      const result = await service.attachThumbnailUrls(items);

      expect(mockPrisma.storageObject.findMany).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        { id: 'item-1', metadata: items[0].metadata, thumbnailUrl: 'https://cdn.example.com/resolved-signed' },
        { id: 'item-2', metadata: items[1].metadata, thumbnailUrl: 'https://cdn.example.com/resolved-signed' },
        { id: 'item-3', metadata: null, thumbnailUrl: null },
      ]);
    });
  });
});
