/**
 * Unit tests for MediaService — archive / trash methods.
 *
 * Tests: bulkArchive, bulkUnarchive, listArchived, listTrash,
 *        restoreFromTrash (happy path + P2002 conflict), purgeMediaItems,
 *        purgeMediaItemsBatched, deleteForever, emptyTrash (legacy/unrouted).
 *
 * NOTE (issue #165 — Empty Trash at scale): `POST /api/media/trash/empty` no
 * longer calls the legacy synchronous `emptyTrash` below — the controller now
 * routes through `TrashEmptyRunService.createRun`, which starts an async run
 * via the enrichment queue (see trash-empty-run.service.spec.ts,
 * trash-empty-evaluate.handler.spec.ts, and
 * trash-empty-execute-batch.handler.spec.ts for that real, routed coverage).
 * `emptyTrash` is retained on MediaService only for backward compatibility /
 * as a fallback and is exercised here purely so its behavior doesn't silently
 * rot; `deleteForever` now shares the batched `purgeMediaItemsBatched` path
 * with the new trash-empty execute-batch handler, which is why that method
 * gets its own dedicated describe block below.
 *
 * No database required — PrismaService and the storage provider are fully mocked.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { MediaService } from './media.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import { MediaMetadataSyncService } from './sync/media-metadata-sync.service';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { GEO_LOCATION_PROVIDER } from './geo/geo-location-provider.interface';
import { ForwardGeocodeService } from './geo/forward-geocode.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { MediaEnrichmentService } from './enrichment/media-enrichment.service';
import { MediaThumbnailService } from './media-thumbnail.service';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeP2002Error(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed',
    { code: 'P2002', clientVersion: '0.0.0', meta: { target: ['circle_id', 'content_hash'] } },
  );
}

function makeMediaItem(overrides: Partial<any> = {}) {
  return {
    id: randomUUID(),
    storageObjectId: randomUUID(),
    addedById: 'user-1',
    circleId: CIRCLE_ID,
    type: 'photo' as const,
    source: 'web' as const,
    originalFilename: 'photo.jpg',
    capturedAt: null,
    capturedAtOffset: null,
    importedAt: new Date(),
    width: null,
    height: null,
    durationMs: null,
    orientation: null,
    cameraMake: null,
    cameraModel: null,
    contentHash: null,
    description: null,
    favorite: false,
    deletedAt: null,
    archivedAt: null,
    originalCreatedAt: null,
    sourcePath: null,
    sourceDeviceId: null,
    sourceDeviceName: null,
    takenLat: null,
    takenLng: null,
    takenAltitude: null,
    geoCountry: null,
    geoCountryCode: null,
    geoAdmin1: null,
    geoAdmin2: null,
    geoLocality: null,
    geoPlaceName: null,
    geoSource: null,
    geocodedAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeStorageObject(overrides: Partial<any> = {}) {
  return {
    id: randomUUID(),
    name: 'photo.jpg',
    size: BigInt(1024000),
    mimeType: 'image/jpeg',
    storageKey: 'uploads/photo.jpg',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'ready',
    s3UploadId: null,
    uploadedById: 'user-1',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const CIRCLE_ID = 'circle-archive-test-0001';

const collabPerms = [
  PERMISSIONS.MEDIA_READ,
  PERMISSIONS.MEDIA_WRITE,
  PERMISSIONS.MEDIA_DELETE,
];

const archiveDto = { circleId: CIRCLE_ID, ids: ['item-1', 'item-2'] };

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('MediaService — archive & trash methods', () => {
  let service: MediaService;
  let mockPrisma: MockPrismaService;
  let mockStorageProvider: {
    getSignedDownloadUrl: jest.Mock;
    delete: jest.Mock;
    getBucket: jest.Mock;
  };
  let mockSyncService: jest.Mocked<Pick<MediaMetadataSyncService, 'syncFromStorageObject'>>;
  let mockCircleMembershipService: { assertCircleAccess: jest.Mock };
  let mockGeoProvider: { reverseGeocode: jest.Mock };
  let mockForwardGeocodeService: { searchPlaces: jest.Mock };
  let mockResolver: { getProviderFor: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') return arg(mockPrisma);
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg;
    });

    mockStorageProvider = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://cdn.example.com/signed'),
      delete: jest.fn().mockResolvedValue(undefined),
      // MediaThumbnailService's legacy-fallback signing path calls
      // storageProvider.getBucket() to build its URL-cache key.
      getBucket: jest.fn().mockReturnValue('legacy-static-bucket'),
    };
    // Batched thumbnail signing (MediaThumbnailService.signThumbsBatched) issues
    // one storageObject.findMany call for list surfaces (listArchived/listTrash).
    // Default to no matching rows -> falls back to the legacy static provider.
    (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([]);
    mockSyncService = {
      syncFromStorageObject: jest.fn().mockResolvedValue(undefined),
    };
    mockCircleMembershipService = {
      assertCircleAccess: jest.fn().mockResolvedValue({ role: 'collaborator', isSuperAdmin: false }),
    };
    mockGeoProvider = { reverseGeocode: jest.fn().mockResolvedValue(null) };
    mockForwardGeocodeService = { searchPlaces: jest.fn().mockResolvedValue([]) };
    mockResolver = { getProviderFor: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        // Real MediaThumbnailService, reusing the same PrismaService/
        // STORAGE_PROVIDER/StorageProviderResolver mocks registered below.
        MediaThumbnailService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: MediaMetadataSyncService, useValue: mockSyncService },
        { provide: CircleMembershipService, useValue: mockCircleMembershipService },
        { provide: GEO_LOCATION_PROVIDER, useValue: mockGeoProvider },
        { provide: ForwardGeocodeService, useValue: mockForwardGeocodeService },
        { provide: StorageProviderResolver, useValue: mockResolver },
        {
          provide: MediaEnrichmentService,
          useValue: { enqueueUploadEnrichment: jest.fn().mockResolvedValue(undefined), enqueueForStorageObject: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<MediaService>(MediaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // bulkArchive
  // -------------------------------------------------------------------------

  describe('bulkArchive', () => {
    it('calls updateMany with the correct where and data shape', async () => {
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 2 } as any);
      // Prisma findMany for assertAllInCircle
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        makeMediaItem({ id: 'item-1' }),
        makeMediaItem({ id: 'item-2' }),
      ] as any);

      await service.bulkArchive(archiveDto, 'user-1', collabPerms);

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { in: archiveDto.ids },
            circleId: CIRCLE_ID,
            deletedAt: null,
            archivedAt: null,
          }),
          data: expect.objectContaining({ archivedAt: expect.any(Date) }),
        }),
      );
    });

    it('returns the archived count', async () => {
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 2 } as any);
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        makeMediaItem({ id: 'item-1' }),
        makeMediaItem({ id: 'item-2' }),
      ] as any);

      const result = await service.bulkArchive(archiveDto, 'user-1', collabPerms);

      expect(result).toEqual({ archived: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // bulkUnarchive
  // -------------------------------------------------------------------------

  describe('bulkUnarchive', () => {
    it('calls updateMany with archivedAt: null in where and data: { archivedAt: null }', async () => {
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 1 } as any);

      await service.bulkUnarchive(archiveDto, 'user-1', collabPerms);

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { in: archiveDto.ids },
            circleId: CIRCLE_ID,
            deletedAt: null,
            archivedAt: { not: null },
          }),
          data: expect.objectContaining({ archivedAt: null }),
        }),
      );
    });

    it('returns the unarchived count', async () => {
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 2 } as any);

      const result = await service.bulkUnarchive(archiveDto, 'user-1', collabPerms);

      expect(result).toEqual({ unarchived: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // listArchived
  // -------------------------------------------------------------------------

  describe('listArchived', () => {
    const listArchivedQuery = {
      circleId: CIRCLE_ID,
      page: 1,
      pageSize: 20,
    } as any;

    it('uses where { circleId, deletedAt: null, archivedAt: { not: null } }', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      mockPrisma.mediaItem.count.mockResolvedValue(0);

      await service.listArchived(listArchivedQuery, 'user-1', collabPerms);

      const [findManyCall] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(findManyCall[0].where).toMatchObject({
        circleId: CIRCLE_ID,
        deletedAt: null,
        archivedAt: { not: null },
      });
    });

    it('orders by archivedAt descending', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      mockPrisma.mediaItem.count.mockResolvedValue(0);

      await service.listArchived(listArchivedQuery, 'user-1', collabPerms);

      const [findManyCall] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(findManyCall[0].orderBy).toMatchObject({ archivedAt: 'desc' });
    });

    it('returns paginated results with meta', async () => {
      const items = [makeMediaItem({ archivedAt: new Date() })];
      mockPrisma.mediaItem.findMany.mockResolvedValue(items as any);
      mockPrisma.mediaItem.count.mockResolvedValue(1);

      const result = await service.listArchived(listArchivedQuery, 'user-1', collabPerms);

      expect(result.meta).toMatchObject({ page: 1, pageSize: 20, totalItems: 1, totalPages: 1 });
      expect(result.items).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // listTrash
  // -------------------------------------------------------------------------

  describe('listTrash', () => {
    const listTrashQuery = {
      circleId: CIRCLE_ID,
      page: 1,
      pageSize: 20,
    } as any;

    it('uses where { circleId, deletedAt: { not: null } }', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      mockPrisma.mediaItem.count.mockResolvedValue(0);

      await service.listTrash(listTrashQuery, 'user-1', collabPerms);

      const [findManyCall] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(findManyCall[0].where).toMatchObject({
        circleId: CIRCLE_ID,
        deletedAt: { not: null },
      });
    });

    it('does NOT include archivedAt filter (trash shows all deleted items)', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      mockPrisma.mediaItem.count.mockResolvedValue(0);

      await service.listTrash(listTrashQuery, 'user-1', collabPerms);

      const [findManyCall] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      // The where should NOT have archivedAt key
      expect(findManyCall[0].where.archivedAt).toBeUndefined();
    });

    it('orders by deletedAt descending', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      mockPrisma.mediaItem.count.mockResolvedValue(0);

      await service.listTrash(listTrashQuery, 'user-1', collabPerms);

      const [findManyCall] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(findManyCall[0].orderBy).toMatchObject({ deletedAt: 'desc' });
    });

    it('returns paginated results with meta', async () => {
      const items = [makeMediaItem({ deletedAt: new Date() })];
      mockPrisma.mediaItem.findMany.mockResolvedValue(items as any);
      mockPrisma.mediaItem.count.mockResolvedValue(1);

      const result = await service.listTrash(listTrashQuery, 'user-1', collabPerms);

      expect(result.meta).toMatchObject({ page: 1, pageSize: 20, totalItems: 1, totalPages: 1 });
      expect(result.items).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // restoreFromTrash
  // -------------------------------------------------------------------------

  describe('restoreFromTrash', () => {
    const restoreDto = { circleId: CIRCLE_ID, ids: ['item-1'] };

    it('clears deletedAt on the found item', async () => {
      const item = makeMediaItem({ id: 'item-1', deletedAt: new Date() });
      mockPrisma.mediaItem.findFirst.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue({ ...item, deletedAt: null } as any);

      await service.restoreFromTrash(restoreDto, 'user-1', collabPerms);

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'item-1' },
          data: { deletedAt: null },
        }),
      );
    });

    it('returns { restored: 1, conflicts: [] } on success', async () => {
      const item = makeMediaItem({ id: 'item-1', deletedAt: new Date() });
      mockPrisma.mediaItem.findFirst.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue({ ...item, deletedAt: null } as any);

      const result = await service.restoreFromTrash(restoreDto, 'user-1', collabPerms);

      expect(result.restored).toBe(1);
      expect(result.conflicts).toHaveLength(0);
    });

    it('skips items not found in trash (findFirst returns null)', async () => {
      mockPrisma.mediaItem.findFirst.mockResolvedValue(null);

      const result = await service.restoreFromTrash(restoreDto, 'user-1', collabPerms);

      expect(result.restored).toBe(0);
      expect(result.conflicts).toHaveLength(0);
      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('returns the item id in conflicts when update throws P2002', async () => {
      const item = makeMediaItem({ id: 'item-1', deletedAt: new Date() });
      mockPrisma.mediaItem.findFirst.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockRejectedValue(makeP2002Error());

      const result = await service.restoreFromTrash(restoreDto, 'user-1', collabPerms);

      expect(result.restored).toBe(0);
      expect(result.conflicts).toEqual(['item-1']);
    });

    it('re-throws non-P2002 errors', async () => {
      const item = makeMediaItem({ id: 'item-1', deletedAt: new Date() });
      mockPrisma.mediaItem.findFirst.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockRejectedValue(new Error('DB connection lost'));

      await expect(
        service.restoreFromTrash(restoreDto, 'user-1', collabPerms),
      ).rejects.toThrow('DB connection lost');
    });

    it('handles mixed results: some restored, some conflicting', async () => {
      const restoreMixedDto = { circleId: CIRCLE_ID, ids: ['item-ok', 'item-conflict'] };
      const okItem = makeMediaItem({ id: 'item-ok', deletedAt: new Date() });
      const conflictItem = makeMediaItem({ id: 'item-conflict', deletedAt: new Date() });

      mockPrisma.mediaItem.findFirst
        .mockResolvedValueOnce(okItem as any)
        .mockResolvedValueOnce(conflictItem as any);

      mockPrisma.mediaItem.update
        .mockResolvedValueOnce({ ...okItem, deletedAt: null } as any)
        .mockRejectedValueOnce(makeP2002Error());

      const result = await service.restoreFromTrash(restoreMixedDto, 'user-1', collabPerms);

      expect(result.restored).toBe(1);
      expect(result.conflicts).toEqual(['item-conflict']);
    });
  });

  // -------------------------------------------------------------------------
  // purgeMediaItems
  // -------------------------------------------------------------------------

  describe('purgeMediaItems', () => {
    it('returns 0 when ids array is empty', async () => {
      const result = await service.purgeMediaItems([]);
      expect(result).toBe(0);
      expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
    });

    it('deletes the MediaItem row, calls storage delete, then deletes StorageObject row', async () => {
      const storageObj = makeStorageObject({ storageKey: 'uploads/test.jpg' });
      const item = makeMediaItem({ id: 'item-1', storageObjectId: storageObj.id, storageObject: storageObj });

      mockPrisma.mediaItem.findMany.mockResolvedValue([item as any]);
      mockPrisma.mediaItem.delete.mockResolvedValue(item as any);
      mockPrisma.storageObject.delete.mockResolvedValue(storageObj as any);

      const result = await service.purgeMediaItems(['item-1']);

      expect(mockPrisma.mediaItem.delete).toHaveBeenCalledWith({ where: { id: 'item-1' } });
      expect(mockStorageProvider.delete).toHaveBeenCalledWith(storageObj.storageKey);
      expect(mockPrisma.storageObject.delete).toHaveBeenCalledWith({ where: { id: storageObj.id } });
      expect(result).toBe(1);
    });

    it('still counts item as purged when blob delete fails (logs warning, continues)', async () => {
      const storageObj = makeStorageObject({ storageKey: 'uploads/blob-fail.jpg' });
      const item = makeMediaItem({ id: 'item-1', storageObjectId: storageObj.id, storageObject: storageObj });

      mockPrisma.mediaItem.findMany.mockResolvedValue([item as any]);
      mockPrisma.mediaItem.delete.mockResolvedValue(item as any);
      mockStorageProvider.delete.mockRejectedValue(new Error('S3 error'));
      mockPrisma.storageObject.delete.mockResolvedValue(storageObj as any);

      const result = await service.purgeMediaItems(['item-1']);

      expect(result).toBe(1);
    });

    it('skips an item (not counted) when the MediaItem delete itself fails', async () => {
      const storageObj = makeStorageObject();
      const item = makeMediaItem({ id: 'item-bad', storageObjectId: storageObj.id, storageObject: storageObj });

      mockPrisma.mediaItem.findMany.mockResolvedValue([item as any]);
      mockPrisma.mediaItem.delete.mockRejectedValue(new Error('FK constraint'));

      const result = await service.purgeMediaItems(['item-bad']);

      expect(result).toBe(0);
    });

    it('purges multiple items and returns the count of successful purges', async () => {
      const so1 = makeStorageObject({ storageKey: 'uploads/a.jpg' });
      const so2 = makeStorageObject({ storageKey: 'uploads/b.jpg' });
      const item1 = makeMediaItem({ id: 'item-1', storageObjectId: so1.id, storageObject: so1 });
      const item2 = makeMediaItem({ id: 'item-2', storageObjectId: so2.id, storageObject: so2 });

      mockPrisma.mediaItem.findMany.mockResolvedValue([item1 as any, item2 as any]);
      mockPrisma.mediaItem.delete.mockResolvedValue({} as any);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);

      const result = await service.purgeMediaItems(['item-1', 'item-2']);

      expect(result).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // purgeMediaItemsBatched (issue #165 — Empty Trash at scale)
  // -------------------------------------------------------------------------

  describe('purgeMediaItemsBatched', () => {
    it('returns { deleted: 0, failedIds: [] } for an empty ids array without any DB round-trip', async () => {
      const result = await service.purgeMediaItemsBatched([]);

      expect(result).toEqual({ deleted: 0, failedIds: [] });
      expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
    });

    it('returns { deleted: 0, failedIds: [] } when none of the ids resolve to a MediaItem row', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      const result = await service.purgeMediaItemsBatched(['ghost-1']);

      expect(result).toEqual({ deleted: 0, failedIds: [] });
      expect(mockPrisma.mediaItem.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes all MediaItem rows in ONE deleteMany call and reports deleted = count', async () => {
      const so = makeStorageObject({ storageKey: 'uploads/a.jpg', storageProvider: 's3', bucket: 'bucket-a' });
      const item = makeMediaItem({ id: 'item-1', storageObjectId: so.id, storageObject: so });
      mockPrisma.mediaItem.findMany.mockResolvedValue([item] as any);
      mockPrisma.mediaItem.deleteMany.mockResolvedValue({ count: 1 } as any);
      mockResolver.getProviderFor.mockResolvedValue({
        deleteMany: jest.fn().mockResolvedValue({ deleted: 1, errors: [] }),
      });

      const result = await service.purgeMediaItemsBatched(['item-1']);

      expect(mockPrisma.mediaItem.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['item-1'] } } });
      expect(result).toEqual({ deleted: 1, failedIds: [] });
    });

    it('groups blob deletes by (storageProvider, bucket) and calls each resolved provider\'s deleteMany once per group', async () => {
      const soA1 = makeStorageObject({ storageKey: 'a1.jpg', storageProvider: 's3', bucket: 'bucket-a' });
      const soA2 = makeStorageObject({ storageKey: 'a2.jpg', storageProvider: 's3', bucket: 'bucket-a' });
      const soB1 = makeStorageObject({ storageKey: 'b1.jpg', storageProvider: 'r2', bucket: 'bucket-b' });
      const item1 = makeMediaItem({ id: 'item-1', storageObjectId: soA1.id, storageObject: soA1 });
      const item2 = makeMediaItem({ id: 'item-2', storageObjectId: soA2.id, storageObject: soA2 });
      const item3 = makeMediaItem({ id: 'item-3', storageObjectId: soB1.id, storageObject: soB1 });
      mockPrisma.mediaItem.findMany.mockResolvedValue([item1, item2, item3] as any);
      mockPrisma.mediaItem.deleteMany.mockResolvedValue({ count: 3 } as any);

      const providerA = { deleteMany: jest.fn().mockResolvedValue({ deleted: 2, errors: [] }) };
      const providerB = { deleteMany: jest.fn().mockResolvedValue({ deleted: 1, errors: [] }) };
      mockResolver.getProviderFor.mockImplementation(async (provider: string) =>
        provider === 's3' ? providerA : providerB,
      );

      const result = await service.purgeMediaItemsBatched(['item-1', 'item-2', 'item-3']);

      expect(mockResolver.getProviderFor).toHaveBeenCalledWith('s3', 'bucket-a');
      expect(mockResolver.getProviderFor).toHaveBeenCalledWith('r2', 'bucket-b');
      expect(mockResolver.getProviderFor).toHaveBeenCalledTimes(2);
      expect(providerA.deleteMany).toHaveBeenCalledWith(['a1.jpg', 'a2.jpg']);
      expect(providerB.deleteMany).toHaveBeenCalledWith(['b1.jpg']);
      expect(result).toEqual({ deleted: 3, failedIds: [] });
    });

    it('deletes the StorageObject rows for the successfully-deleted items in one deleteMany call', async () => {
      const so = makeStorageObject({ storageKey: 'a.jpg', storageProvider: 's3', bucket: 'bucket-a' });
      const item = makeMediaItem({ id: 'item-1', storageObjectId: so.id, storageObject: so });
      mockPrisma.mediaItem.findMany.mockResolvedValue([item] as any);
      mockPrisma.mediaItem.deleteMany.mockResolvedValue({ count: 1 } as any);
      mockResolver.getProviderFor.mockResolvedValue({
        deleteMany: jest.fn().mockResolvedValue({ deleted: 1, errors: [] }),
      });

      await service.purgeMediaItemsBatched(['item-1']);

      expect(mockPrisma.storageObject.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [so.id] } },
      });
    });

    it('a blob-delete failure is non-fatal — the item is still counted deleted', async () => {
      const so = makeStorageObject({ storageKey: 'a.jpg', storageProvider: 's3', bucket: 'bucket-a' });
      const item = makeMediaItem({ id: 'item-1', storageObjectId: so.id, storageObject: so });
      mockPrisma.mediaItem.findMany.mockResolvedValue([item] as any);
      mockPrisma.mediaItem.deleteMany.mockResolvedValue({ count: 1 } as any);
      mockResolver.getProviderFor.mockRejectedValue(new Error('provider unreachable'));

      const result = await service.purgeMediaItemsBatched(['item-1']);

      expect(result).toEqual({ deleted: 1, failedIds: [] });
      // The StorageObject row is still cleaned up even though the blob delete failed.
      expect(mockPrisma.storageObject.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [so.id] } },
      });
    });

    it('falls back to per-item deletes and reports precisely which ids failed when the batch deleteMany throws', async () => {
      const so1 = makeStorageObject({ storageKey: 'a.jpg', storageProvider: 's3', bucket: 'bucket-a' });
      const so2 = makeStorageObject({ storageKey: 'b.jpg', storageProvider: 's3', bucket: 'bucket-a' });
      const item1 = makeMediaItem({ id: 'item-1', storageObjectId: so1.id, storageObject: so1 });
      const item2 = makeMediaItem({ id: 'item-2', storageObjectId: so2.id, storageObject: so2 });
      mockPrisma.mediaItem.findMany.mockResolvedValue([item1, item2] as any);
      mockPrisma.mediaItem.deleteMany.mockRejectedValue(new Error('FK constraint on the whole batch'));
      mockPrisma.mediaItem.delete
        .mockResolvedValueOnce(item1 as any) // item-1 succeeds per-item
        .mockRejectedValueOnce(new Error('item-2 still referenced')); // item-2 fails
      mockResolver.getProviderFor.mockResolvedValue({
        deleteMany: jest.fn().mockResolvedValue({ deleted: 1, errors: [] }),
      });

      const result = await service.purgeMediaItemsBatched(['item-1', 'item-2']);

      expect(result).toEqual({ deleted: 1, failedIds: ['item-2'] });
      // The failed item's StorageObject must survive — its blob key is
      // excluded from the blob-delete groups and its StorageObject id is
      // excluded from the final storageObject.deleteMany call.
      expect(mockPrisma.storageObject.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [so1.id] } },
      });
    });

    it('returns correct deleted/failedIds and does not throw when the storageObject.deleteMany call itself fails', async () => {
      const so = makeStorageObject({ storageKey: 'a.jpg', storageProvider: 's3', bucket: 'bucket-a' });
      const item = makeMediaItem({ id: 'item-1', storageObjectId: so.id, storageObject: so });
      mockPrisma.mediaItem.findMany.mockResolvedValue([item] as any);
      mockPrisma.mediaItem.deleteMany.mockResolvedValue({ count: 1 } as any);
      mockResolver.getProviderFor.mockResolvedValue({
        deleteMany: jest.fn().mockResolvedValue({ deleted: 1, errors: [] }),
      });
      mockPrisma.storageObject.deleteMany.mockRejectedValue(new Error('DB unavailable'));

      await expect(service.purgeMediaItemsBatched(['item-1'])).resolves.toEqual({
        deleted: 1,
        failedIds: [],
      });
    });
  });

  // -------------------------------------------------------------------------
  // deleteForever
  // -------------------------------------------------------------------------

  describe('deleteForever', () => {
    it('only purges items that are already in trash (deletedAt IS NOT NULL)', async () => {
      const deleteForeverDto = { circleId: CIRCLE_ID, ids: ['item-trash'] };
      const trashedItem = makeMediaItem({ id: 'item-trash', deletedAt: new Date() });
      const storageObj = makeStorageObject({ id: trashedItem.storageObjectId });

      // First findMany: the pre-check for deleted items
      mockPrisma.mediaItem.findMany
        .mockResolvedValueOnce([{ id: 'item-trash' }] as any) // deleteForever pre-check
        .mockResolvedValueOnce([{ ...trashedItem, storageObject: storageObj }] as any); // purgeMediaItems

      mockPrisma.mediaItem.delete.mockResolvedValue(trashedItem as any);
      mockPrisma.storageObject.delete.mockResolvedValue(storageObj as any);

      await service.deleteForever(deleteForeverDto, 'user-1', collabPerms);

      // The pre-check must only look at deletedAt: { not: null }
      const [preCheckCall] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(preCheckCall[0].where).toMatchObject({
        id: { in: deleteForeverDto.ids },
        circleId: CIRCLE_ID,
        deletedAt: { not: null },
      });
    });

    it('returns { deleted: N } with the purge count', async () => {
      const deleteForeverDto = { circleId: CIRCLE_ID, ids: ['item-1'] };
      const storageObj = makeStorageObject();
      const item = makeMediaItem({ id: 'item-1', deletedAt: new Date(), storageObjectId: storageObj.id });

      mockPrisma.mediaItem.findMany
        .mockResolvedValueOnce([{ id: 'item-1' }] as any)
        .mockResolvedValueOnce([{ ...item, storageObject: storageObj }] as any);

      mockPrisma.mediaItem.delete.mockResolvedValue(item as any);
      mockPrisma.storageObject.delete.mockResolvedValue(storageObj as any);

      const result = await service.deleteForever(deleteForeverDto, 'user-1', collabPerms);

      expect(result).toEqual({ deleted: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // emptyTrash
  // -------------------------------------------------------------------------

  describe('emptyTrash', () => {
    it('fetches ALL trashed items in the circle and purges them', async () => {
      const emptyTrashDto = { circleId: CIRCLE_ID };
      const storageObj = makeStorageObject();
      const trashedItem = makeMediaItem({ id: 'item-x', deletedAt: new Date(), storageObjectId: storageObj.id });

      mockPrisma.mediaItem.findMany
        .mockResolvedValueOnce([{ id: 'item-x' }] as any)
        .mockResolvedValueOnce([{ ...trashedItem, storageObject: storageObj }] as any);

      mockPrisma.mediaItem.delete.mockResolvedValue(trashedItem as any);
      mockPrisma.storageObject.delete.mockResolvedValue(storageObj as any);

      await service.emptyTrash(emptyTrashDto, 'user-1', collabPerms);

      // The pre-check must scan ALL deleted items (no id filter)
      const [preCheckCall] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(preCheckCall[0].where).toMatchObject({
        circleId: CIRCLE_ID,
        deletedAt: { not: null },
      });
      expect(preCheckCall[0].where.id).toBeUndefined();
    });

    it('returns { deleted: 0 } when trash is already empty', async () => {
      const emptyTrashDto = { circleId: CIRCLE_ID };

      mockPrisma.mediaItem.findMany.mockResolvedValue([] as any);

      const result = await service.emptyTrash(emptyTrashDto, 'user-1', collabPerms);

      expect(result).toEqual({ deleted: 0 });
    });
  });
});
