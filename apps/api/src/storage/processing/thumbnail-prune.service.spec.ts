/**
 * Unit tests — ThumbnailPruneService (issue #434)
 *
 * The service deletes the thumbnail objects a source StorageObject no longer
 * points at, after its key moved. The behaviours worth pinning are the safety
 * rails, not the happy path:
 *   - it NEVER prunes when the source records no current thumbnail key
 *     ("prune everything else" would mean "prune everything");
 *   - it keeps exactly the key the source currently points at;
 *   - it resolves each superseded row's OWN provider/bucket, not the active one;
 *   - it is total — a provider or Prisma failure is logged, never thrown, so it
 *     can never fail a user edit that has already committed.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ThumbnailPruneService } from './thumbnail-prune.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageProviderResolver } from '../providers/storage-provider.resolver';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import { createMockStorageProvider } from '../../../test/mocks/storage-provider.mock';

const SOURCE_ID = 'obj-1';
const CURRENT_KEY = 'thumbnails/obj-1-1111111111111111.jpg';
const OLD_KEY = 'thumbnails/obj-1-0000000000000000.jpg';

function withThumbnail(key: string | null) {
  return {
    metadata: key ? { _processing: { thumbnail: { thumbnailStorageKey: key } } } : {},
  };
}

describe('ThumbnailPruneService', () => {
  let service: ThumbnailPruneService;
  let mockPrisma: MockPrismaService;
  let mockProvider: ReturnType<typeof createMockStorageProvider>;
  let mockResolver: { getProviderFor: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockProvider = createMockStorageProvider();
    mockProvider.delete.mockResolvedValue(undefined);
    mockResolver = { getProviderFor: jest.fn().mockResolvedValue(mockProvider) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThumbnailPruneService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageProviderResolver, useValue: mockResolver },
      ],
    }).compile();

    service = module.get(ThumbnailPruneService);
  });

  afterEach(() => jest.clearAllMocks());

  it('deletes the superseded thumbnail bytes and row, keeping the current key', async () => {
    (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue(
      withThumbnail(CURRENT_KEY),
    );
    (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
      { id: 'thumb-old', storageKey: OLD_KEY, storageProvider: 's3', bucket: 'b1' },
    ]);

    const pruned = await service.pruneSupersededThumbnails(SOURCE_ID);

    expect(pruned).toBe(1);
    expect(mockPrisma.storageObject.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storageKey: { startsWith: 'thumbnails/obj-1' },
          NOT: { storageKey: { equals: CURRENT_KEY } },
        },
      }),
    );
    expect(mockProvider.delete).toHaveBeenCalledWith(OLD_KEY);
    expect(mockPrisma.storageObject.delete).toHaveBeenCalledWith({
      where: { id: 'thumb-old' },
    });
  });

  it('also reaps the LEGACY unversioned thumbnails/<objectId>.jpg key', async () => {
    (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue(
      withThumbnail(CURRENT_KEY),
    );
    (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'thumb-legacy',
        storageKey: 'thumbnails/obj-1.jpg',
        storageProvider: 's3',
        bucket: 'b1',
      },
    ]);

    await service.pruneSupersededThumbnails(SOURCE_ID);

    expect(mockProvider.delete).toHaveBeenCalledWith('thumbnails/obj-1.jpg');
  });

  it('resolves each superseded row through its OWN provider/bucket, not the active one', async () => {
    (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue(
      withThumbnail(CURRENT_KEY),
    );
    (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
      { id: 'thumb-old', storageKey: OLD_KEY, storageProvider: 'r2', bucket: 'r2-bucket' },
    ]);

    await service.pruneSupersededThumbnails(SOURCE_ID);

    expect(mockResolver.getProviderFor).toHaveBeenCalledWith('r2', 'r2-bucket');
  });

  it('is a NO-OP when the source object records no thumbnail key', async () => {
    (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue(
      withThumbnail(null),
    );

    const pruned = await service.pruneSupersededThumbnails(SOURCE_ID);

    expect(pruned).toBe(0);
    expect(mockPrisma.storageObject.findMany).not.toHaveBeenCalled();
    expect(mockProvider.delete).not.toHaveBeenCalled();
  });

  it('is a NO-OP when the recorded key is not one of this object’s thumbnails', async () => {
    (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue(
      withThumbnail('thumbnails/some-other-object-abc.jpg'),
    );

    const pruned = await service.pruneSupersededThumbnails(SOURCE_ID);

    expect(pruned).toBe(0);
    expect(mockPrisma.storageObject.findMany).not.toHaveBeenCalled();
  });

  it('is a NO-OP when the source object no longer exists', async () => {
    (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(service.pruneSupersededThumbnails(SOURCE_ID)).resolves.toBe(0);
  });

  it('still deletes the row when the byte delete fails, and never throws', async () => {
    (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue(
      withThumbnail(CURRENT_KEY),
    );
    (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
      { id: 'thumb-old', storageKey: OLD_KEY, storageProvider: 's3', bucket: 'b1' },
    ]);
    mockProvider.delete.mockRejectedValue(new Error('storage exploded'));

    await expect(service.pruneSupersededThumbnails(SOURCE_ID)).resolves.toBe(1);
    expect(mockPrisma.storageObject.delete).toHaveBeenCalled();
  });

  it('never throws when the whole lookup fails — pruning must not fail a committed edit', async () => {
    (mockPrisma.storageObject.findUnique as jest.Mock).mockRejectedValue(
      new Error('db down'),
    );

    await expect(service.pruneSupersededThumbnails(SOURCE_ID)).resolves.toBe(0);
  });
});
