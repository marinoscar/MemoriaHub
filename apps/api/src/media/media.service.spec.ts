import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { MediaService } from './media.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

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

function makeMediaItem(overrides: Partial<any> = {}) {
  return {
    id: randomUUID(),
    storageObjectId: randomUUID(),
    ownerId: 'user-1',
    type: 'photo' as const,
    source: 'web' as const,
    originalFilename: 'photo.jpg',
    capturedAt: null,
    capturedAtOffset: null,
    importedAt: new Date(),
    classification: 'unreviewed' as const,
    width: null,
    height: null,
    durationMs: null,
    orientation: null,
    cameraMake: null,
    cameraModel: null,
    contentHash: null,
    title: null,
    caption: null,
    description: null,
    favorite: false,
    deletedAt: null,
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

function makeAlbum(overrides: Partial<any> = {}) {
  return {
    id: randomUUID(),
    ownerId: 'user-1',
    name: 'My Album',
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeTag(overrides: Partial<any> = {}) {
  return {
    id: randomUUID(),
    ownerId: 'user-1',
    name: 'nature',
    createdAt: new Date(),
    ...overrides,
  };
}

// Default paginated query params
// Cast to any to avoid strict DTO type checking in unit tests
// (the DTO has a `favorite` field with transform that TypeScript marks as required)
const defaultMediaQuery = {
  page: 1,
  pageSize: 20,
  sortBy: 'capturedAt' as const,
  sortOrder: 'desc' as const,
} as any;

const defaultAlbumQuery = {
  page: 1,
  pageSize: 20,
  sortBy: 'createdAt' as const,
  sortOrder: 'desc' as const,
} as any;

// Permissions helpers
const ownPerms = [
  PERMISSIONS.MEDIA_READ,
  PERMISSIONS.MEDIA_WRITE,
  PERMISSIONS.MEDIA_DELETE,
];
const anyPerms = [
  ...ownPerms,
  PERMISSIONS.MEDIA_READ_ANY,
  PERMISSIONS.MEDIA_WRITE_ANY,
  PERMISSIONS.MEDIA_DELETE_ANY,
];
const noPerms: string[] = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaService', () => {
  let service: MediaService;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<MediaService>(MediaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // createMedia
  // -------------------------------------------------------------------------

  describe('createMedia', () => {
    it('should create a MediaItem when the StorageObject is owned by the caller', async () => {
      const storageObject = makeStorageObject({ uploadedById: 'user-1' });
      const createdItem = makeMediaItem({ storageObjectId: storageObject.id });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);
      mockPrisma.mediaItem.create.mockResolvedValue(createdItem as any);

      const dto = {
        storageObjectId: storageObject.id,
        type: 'photo' as const,
        source: 'web' as const,
        originalFilename: 'photo.jpg',
      };

      const result = await service.createMedia(dto, 'user-1');

      expect(result).toEqual(createdItem);
      expect(mockPrisma.storageObject.findUnique).toHaveBeenCalledWith({
        where: { id: dto.storageObjectId },
      });
      expect(mockPrisma.mediaItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            storageObjectId: dto.storageObjectId,
            ownerId: 'user-1',
            type: 'photo',
            source: 'web',
            originalFilename: 'photo.jpg',
          }),
        }),
      );
    });

    it('should throw NotFoundException when StorageObject does not exist', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(
        service.createMedia(
          {
            storageObjectId: randomUUID(),
            type: 'photo',
            source: 'web',
            originalFilename: 'photo.jpg',
          },
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when StorageObject is not owned by caller', async () => {
      const storageObject = makeStorageObject({ uploadedById: 'other-user' });
      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(
        service.createMedia(
          {
            storageObjectId: storageObject.id,
            type: 'photo',
            source: 'web',
            originalFilename: 'photo.jpg',
          },
          'user-1',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException when StorageObject is already linked to a MediaItem', async () => {
      const storageObject = makeStorageObject({ uploadedById: 'user-1' });
      const existingItem = makeMediaItem({ storageObjectId: storageObject.id });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(existingItem as any);

      await expect(
        service.createMedia(
          {
            storageObjectId: storageObject.id,
            type: 'photo',
            source: 'web',
            originalFilename: 'photo.jpg',
          },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  // listMedia — where-clause assertions
  // -------------------------------------------------------------------------

  describe('listMedia', () => {
    beforeEach(() => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      mockPrisma.mediaItem.count.mockResolvedValue(0);
    });

    it('always includes deletedAt: null in the where clause', async () => {
      await service.listMedia({ ...defaultMediaQuery }, 'user-1', ownPerms);

      const [findManyCall] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(findManyCall[0].where).toMatchObject({ deletedAt: null });
    });

    it('filters by ownerId for non-admin callers', async () => {
      await service.listMedia({ ...defaultMediaQuery }, 'user-1', ownPerms);

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ ownerId: 'user-1' });
    });

    it('does NOT filter by ownerId when caller holds media:read_any', async () => {
      await service.listMedia({ ...defaultMediaQuery }, 'user-1', anyPerms);

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).not.toHaveProperty('ownerId');
    });

    it('filters by type when provided', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, type: 'photo' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ type: 'photo' });
    });

    it('filters by capturedAt date range', async () => {
      const from = new Date('2024-01-01');
      const to = new Date('2024-12-31');

      await service.listMedia(
        { ...defaultMediaQuery, capturedAtFrom: from, capturedAtTo: to },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.capturedAt).toMatchObject({ gte: from, lte: to });
    });

    it('filters by classification', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, classification: 'memory' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ classification: 'memory' });
    });

    it('filters by albumId via AlbumItem join', async () => {
      const albumId = randomUUID();

      await service.listMedia(
        { ...defaultMediaQuery, albumId },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.albumItems).toMatchObject({ some: { albumId } });
    });

    it('filters by favorite', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, favorite: true },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ favorite: true });
    });

    it('filters by tag name via MediaTag join (case-insensitive)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, tag: 'nature' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.mediaTags).toMatchObject({
        some: {
          tag: { name: { equals: 'nature', mode: 'insensitive' } },
        },
      });
    });

    it('filters by country — OR across geoCountry (contains) and geoCountryCode (exact)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, country: 'CR' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.OR).toEqual(
        expect.arrayContaining([
          { geoCountry: { contains: 'CR', mode: 'insensitive' } },
          { geoCountryCode: { equals: 'CR', mode: 'insensitive' } },
        ]),
      );
    });

    it('filters by region (geoAdmin1 contains, case-insensitive)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, region: 'California' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        geoAdmin1: { contains: 'California', mode: 'insensitive' },
      });
    });

    it('filters by locality (geoLocality contains, case-insensitive)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, locality: 'San Jose' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        geoLocality: { contains: 'San Jose', mode: 'insensitive' },
      });
    });

    it('filters by place (geoPlaceName contains, case-insensitive)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, place: 'Yosemite' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        geoPlaceName: { contains: 'Yosemite', mode: 'insensitive' },
      });
    });

    it('free-text location filter spans all geo tiers via OR', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, location: 'California' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.OR).toEqual(
        expect.arrayContaining([
          { geoCountry: { contains: 'California', mode: 'insensitive' } },
          { geoCountryCode: { contains: 'California', mode: 'insensitive' } },
          { geoAdmin1: { contains: 'California', mode: 'insensitive' } },
          { geoLocality: { contains: 'California', mode: 'insensitive' } },
          { geoPlaceName: { contains: 'California', mode: 'insensitive' } },
        ]),
      );
    });

    it('returns correct pagination meta', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([] as any);
      mockPrisma.mediaItem.count.mockResolvedValue(45);

      const result = await service.listMedia(
        { ...defaultMediaQuery, page: 2, pageSize: 10 },
        'user-1',
        ownPerms,
      );

      expect(result.meta).toEqual({
        page: 2,
        pageSize: 10,
        totalItems: 45,
        totalPages: 5,
      });
    });
  });

  // -------------------------------------------------------------------------
  // getMedia
  // -------------------------------------------------------------------------

  describe('getMedia', () => {
    it('should return a MediaItem for the owner', async () => {
      const item = makeMediaItem({ ownerId: 'user-1' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);

      const result = await service.getMedia(item.id, 'user-1', ownPerms);

      expect(result).toEqual(item);
    });

    it('should throw NotFoundException if item does not exist', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(
        service.getMedia(randomUUID(), 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for soft-deleted items', async () => {
      const item = makeMediaItem({ deletedAt: new Date() });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);

      await expect(
        service.getMedia(item.id, 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when non-owner without _any permission accesses', async () => {
      const item = makeMediaItem({ ownerId: 'other-user' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);

      await expect(
        service.getMedia(item.id, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow Admin with media:read_any to access another user\'s item', async () => {
      const item = makeMediaItem({ ownerId: 'other-user' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);

      const result = await service.getMedia(item.id, 'user-1', anyPerms);

      expect(result).toEqual(item);
    });
  });

  // -------------------------------------------------------------------------
  // updateMedia
  // -------------------------------------------------------------------------

  describe('updateMedia', () => {
    it('should update mutable fields for the owner', async () => {
      const item = makeMediaItem({ ownerId: 'user-1' });
      const updated = { ...item, title: 'New Title', favorite: true };

      // findUnique called by getMediaWithOwnershipCheck
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue(updated as any);

      const result = await service.updateMedia(
        item.id,
        { title: 'New Title', favorite: true },
        'user-1',
        ownPerms,
      );

      expect(result).toEqual(updated);
      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: item.id },
          data: expect.objectContaining({ title: 'New Title', favorite: true }),
        }),
      );
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const item = makeMediaItem({ ownerId: 'other-user' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);

      await expect(
        service.updateMedia(item.id, { title: 'hack' }, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);

      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('should allow Admin with media:write_any to update another user\'s item', async () => {
      const item = makeMediaItem({ ownerId: 'other-user' });
      const updated = { ...item, title: 'Admin Updated' };

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue(updated as any);

      const result = await service.updateMedia(
        item.id,
        { title: 'Admin Updated' },
        'user-1',
        anyPerms,
      );

      expect(result.title).toBe('Admin Updated');
    });

    it('should throw NotFoundException when item does not exist', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(
        service.updateMedia(randomUUID(), { favorite: true }, 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // deleteMedia — soft-delete
  // -------------------------------------------------------------------------

  describe('deleteMedia', () => {
    it('should set deletedAt on the MediaItem (soft-delete)', async () => {
      const item = makeMediaItem({ ownerId: 'user-1' });

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue({
        ...item,
        deletedAt: new Date(),
      } as any);

      await service.deleteMedia(item.id, 'user-1', ownPerms);

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: item.id },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it('should NOT call storageObject.delete (blob stays intact)', async () => {
      const item = makeMediaItem({ ownerId: 'user-1' });

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue({
        ...item,
        deletedAt: new Date(),
      } as any);

      await service.deleteMedia(item.id, 'user-1', ownPerms);

      expect(mockPrisma.storageObject.delete).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const item = makeMediaItem({ ownerId: 'other-user' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);

      await expect(
        service.deleteMedia(item.id, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow Admin with media:delete_any to soft-delete another user\'s item', async () => {
      const item = makeMediaItem({ ownerId: 'other-user' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue({
        ...item,
        deletedAt: new Date(),
      } as any);

      await expect(
        service.deleteMedia(item.id, 'user-1', anyPerms),
      ).resolves.not.toThrow();

      expect(mockPrisma.mediaItem.update).toHaveBeenCalled();
    });

    it('should throw NotFoundException when item does not exist', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(
        service.deleteMedia(randomUUID(), 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // listTags
  // -------------------------------------------------------------------------

  describe('listTags', () => {
    it('should return caller\'s tags with count', async () => {
      const tags = [
        { id: randomUUID(), name: 'nature', createdAt: new Date(), ownerId: 'user-1', _count: { mediaTags: 3 } },
        { id: randomUUID(), name: 'travel', createdAt: new Date(), ownerId: 'user-1', _count: { mediaTags: 1 } },
      ];

      mockPrisma.tag.findMany.mockResolvedValue(tags as any);

      const result = await service.listTags('user-1');

      expect(result).toEqual([
        { id: tags[0].id, name: 'nature', createdAt: tags[0].createdAt, count: 3 },
        { id: tags[1].id, name: 'travel', createdAt: tags[1].createdAt, count: 1 },
      ]);
      expect(mockPrisma.tag.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ownerId: 'user-1' },
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // attachTags
  // -------------------------------------------------------------------------

  describe('attachTags', () => {
    it('should upsert Tag and MediaTag for each name (idempotent)', async () => {
      const item = makeMediaItem({ ownerId: 'user-1' });
      const tag = makeTag({ name: 'nature' });

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.tag.upsert.mockResolvedValue(tag as any);
      mockPrisma.mediaTag.upsert.mockResolvedValue({} as any);

      const result = await service.attachTags(
        item.id,
        { names: ['nature', 'travel'] },
        'user-1',
        ownPerms,
      );

      // Two tag upserts, two mediaTag upserts
      expect(mockPrisma.tag.upsert).toHaveBeenCalledTimes(2);
      expect(mockPrisma.mediaTag.upsert).toHaveBeenCalledTimes(2);

      // Verify tag upsert args for first name
      expect(mockPrisma.tag.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ownerId_name: { ownerId: 'user-1', name: 'nature' } },
          create: { ownerId: 'user-1', name: 'nature' },
          update: {},
        }),
      );

      expect(result).toHaveLength(2);
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const item = makeMediaItem({ ownerId: 'other-user' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);

      await expect(
        service.attachTags(item.id, { names: ['nature'] }, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow Admin with media:write_any to attach tags to another user\'s item', async () => {
      const item = makeMediaItem({ ownerId: 'other-user' });
      const tag = makeTag({ ownerId: 'user-1', name: 'nature' });

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.tag.upsert.mockResolvedValue(tag as any);
      mockPrisma.mediaTag.upsert.mockResolvedValue({} as any);

      await expect(
        service.attachTags(item.id, { names: ['nature'] }, 'user-1', anyPerms),
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // removeTag
  // -------------------------------------------------------------------------

  describe('removeTag', () => {
    it('should delete the MediaTag join record', async () => {
      const item = makeMediaItem({ ownerId: 'user-1' });
      const tag = makeTag();
      const mediaTag = { id: randomUUID(), tagId: tag.id, mediaItemId: item.id, addedAt: new Date() };

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaTag.findUnique.mockResolvedValue(mediaTag as any);
      mockPrisma.mediaTag.delete.mockResolvedValue(mediaTag as any);

      await service.removeTag(item.id, tag.id, 'user-1', ownPerms);

      expect(mockPrisma.mediaTag.delete).toHaveBeenCalledWith({
        where: { tagId_mediaItemId: { tagId: tag.id, mediaItemId: item.id } },
      });
    });

    it('should throw NotFoundException when the tag is not attached', async () => {
      const item = makeMediaItem({ ownerId: 'user-1' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaTag.findUnique.mockResolvedValue(null);

      await expect(
        service.removeTag(item.id, randomUUID(), 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const item = makeMediaItem({ ownerId: 'other-user' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);

      await expect(
        service.removeTag(item.id, randomUUID(), 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // -------------------------------------------------------------------------
  // createAlbum
  // -------------------------------------------------------------------------

  describe('createAlbum', () => {
    it('should create an album owned by the caller', async () => {
      const album = makeAlbum({ name: 'Vacation' });
      mockPrisma.album.create.mockResolvedValue(album as any);

      const result = await service.createAlbum({ name: 'Vacation' }, 'user-1');

      expect(result).toEqual(album);
      expect(mockPrisma.album.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ownerId: 'user-1', name: 'Vacation' }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // listAlbums
  // -------------------------------------------------------------------------

  describe('listAlbums', () => {
    beforeEach(() => {
      mockPrisma.album.findMany.mockResolvedValue([]);
      mockPrisma.album.count.mockResolvedValue(0);
    });

    it('should filter by ownerId for non-admin callers', async () => {
      await service.listAlbums(defaultAlbumQuery, 'user-1', ownPerms);

      const [call] = (mockPrisma.album.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ ownerId: 'user-1' });
    });

    it('should NOT filter by ownerId for admin with media:read_any', async () => {
      await service.listAlbums(defaultAlbumQuery, 'user-1', anyPerms);

      const [call] = (mockPrisma.album.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toEqual({});
    });

    it('should return correct pagination meta', async () => {
      mockPrisma.album.count.mockResolvedValue(30);

      const result = await service.listAlbums(
        { ...defaultAlbumQuery, page: 2, pageSize: 10 },
        'user-1',
        ownPerms,
      );

      expect(result.meta).toEqual({
        page: 2,
        pageSize: 10,
        totalItems: 30,
        totalPages: 3,
      });
    });
  });

  // -------------------------------------------------------------------------
  // getAlbum
  // -------------------------------------------------------------------------

  describe('getAlbum', () => {
    it('should return album with items for the owner', async () => {
      const album = { ...makeAlbum(), items: [] };
      mockPrisma.album.findUnique.mockResolvedValue(album as any);

      const result = await service.getAlbum(album.id, 'user-1', ownPerms);

      expect(result).toEqual(album);
    });

    it('should throw NotFoundException when album does not exist', async () => {
      mockPrisma.album.findUnique.mockResolvedValue(null);

      await expect(
        service.getAlbum(randomUUID(), 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const album = { ...makeAlbum({ ownerId: 'other-user' }), items: [] };
      mockPrisma.album.findUnique.mockResolvedValue(album as any);

      await expect(
        service.getAlbum(album.id, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow Admin with media:read_any to access another user\'s album', async () => {
      const album = { ...makeAlbum({ ownerId: 'other-user' }), items: [] };
      mockPrisma.album.findUnique.mockResolvedValue(album as any);

      const result = await service.getAlbum(album.id, 'user-1', anyPerms);

      expect(result).toEqual(album);
    });
  });

  // -------------------------------------------------------------------------
  // updateAlbum
  // -------------------------------------------------------------------------

  describe('updateAlbum', () => {
    it('should update album name and description for owner', async () => {
      const album = makeAlbum({ ownerId: 'user-1' });
      const updated = { ...album, name: 'New Name' };

      // getAlbumWithOwnershipCheck uses album.findUnique
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.album.update.mockResolvedValue(updated as any);

      const result = await service.updateAlbum(
        album.id,
        { name: 'New Name' },
        'user-1',
        ownPerms,
      );

      expect(result.name).toBe('New Name');
      expect(mockPrisma.album.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: album.id },
          data: expect.objectContaining({ name: 'New Name' }),
        }),
      );
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const album = makeAlbum({ ownerId: 'other-user' });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);

      await expect(
        service.updateAlbum(album.id, { name: 'hack' }, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // -------------------------------------------------------------------------
  // deleteAlbum
  // -------------------------------------------------------------------------

  describe('deleteAlbum', () => {
    it('should delete the album (and cascade AlbumItems) for the owner', async () => {
      const album = makeAlbum({ ownerId: 'user-1' });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.album.delete.mockResolvedValue(album as any);

      await service.deleteAlbum(album.id, 'user-1', ownPerms);

      expect(mockPrisma.album.delete).toHaveBeenCalledWith({
        where: { id: album.id },
      });
    });

    it('should NOT call mediaItem.delete (MediaItems are not deleted)', async () => {
      const album = makeAlbum({ ownerId: 'user-1' });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.album.delete.mockResolvedValue(album as any);

      await service.deleteAlbum(album.id, 'user-1', ownPerms);

      expect(mockPrisma.mediaItem.delete).not.toHaveBeenCalled();
      expect(mockPrisma.mediaItem.deleteMany).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const album = makeAlbum({ ownerId: 'other-user' });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);

      await expect(
        service.deleteAlbum(album.id, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // -------------------------------------------------------------------------
  // addAlbumItems
  // -------------------------------------------------------------------------

  describe('addAlbumItems', () => {
    it('should upsert AlbumItem joins (idempotent)', async () => {
      const album = makeAlbum({ ownerId: 'user-1' });
      const item1 = makeMediaItem({ ownerId: 'user-1' });
      const item2 = makeMediaItem({ ownerId: 'user-1' });

      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.mediaItem.findMany.mockResolvedValue([item1, item2] as any);
      (mockPrisma.albumItem.upsert as jest.Mock).mockImplementation(async ({ create }: any) => ({
        id: randomUUID(),
        albumId: create.albumId,
        mediaItemId: create.mediaItemId,
        addedAt: new Date(),
      }));

      const result = await service.addAlbumItems(
        album.id,
        { mediaItemIds: [item1.id, item2.id] },
        'user-1',
        ownPerms,
      );

      expect(mockPrisma.albumItem.upsert).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
    });

    it('should throw NotFoundException when a mediaItemId is not found', async () => {
      const album = makeAlbum({ ownerId: 'user-1' });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      // Return only 1 item when 2 were requested
      mockPrisma.mediaItem.findMany.mockResolvedValue([makeMediaItem()] as any);

      await expect(
        service.addAlbumItems(
          album.id,
          { mediaItemIds: [randomUUID(), randomUUID()] },
          'user-1',
          ownPerms,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // removeAlbumItem
  // -------------------------------------------------------------------------

  describe('removeAlbumItem', () => {
    it('should delete the AlbumItem join record', async () => {
      const album = makeAlbum({ ownerId: 'user-1' });
      const item = makeMediaItem({ ownerId: 'user-1' });
      const albumItem = {
        id: randomUUID(),
        albumId: album.id,
        mediaItemId: item.id,
        addedAt: new Date(),
      };

      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.albumItem.findUnique.mockResolvedValue(albumItem as any);
      mockPrisma.albumItem.delete.mockResolvedValue(albumItem as any);

      await service.removeAlbumItem(album.id, item.id, 'user-1', ownPerms);

      expect(mockPrisma.albumItem.delete).toHaveBeenCalledWith({
        where: { albumId_mediaItemId: { albumId: album.id, mediaItemId: item.id } },
      });
    });

    it('should NOT delete the underlying MediaItem', async () => {
      const album = makeAlbum({ ownerId: 'user-1' });
      const item = makeMediaItem({ ownerId: 'user-1' });
      const albumItem = {
        id: randomUUID(),
        albumId: album.id,
        mediaItemId: item.id,
        addedAt: new Date(),
      };

      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.albumItem.findUnique.mockResolvedValue(albumItem as any);
      mockPrisma.albumItem.delete.mockResolvedValue(albumItem as any);

      await service.removeAlbumItem(album.id, item.id, 'user-1', ownPerms);

      expect(mockPrisma.mediaItem.delete).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when the item is not in the album', async () => {
      const album = makeAlbum({ ownerId: 'user-1' });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.albumItem.findUnique.mockResolvedValue(null);

      await expect(
        service.removeAlbumItem(album.id, randomUUID(), 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const album = makeAlbum({ ownerId: 'other-user' });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);

      await expect(
        service.removeAlbumItem(album.id, randomUUID(), 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
