import request from 'supertest';
import { randomUUID } from 'crypto';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockTestUser,
  createMockAdminUser,
  createMockContributorUser,
  authHeader,
} from '../helpers/auth-mock.helper';

// ---------------------------------------------------------------------------
// Test data factories (integration-level)
// ---------------------------------------------------------------------------

const BASE_MEDIA_ID = '550e8400-e29b-41d4-a716-446655440001';
const BASE_STORAGE_ID = '550e8400-e29b-41d4-a716-446655440000';
const BASE_ALBUM_ID = '550e8400-e29b-41d4-a716-446655440002';
const BASE_TAG_ID = '550e8400-e29b-41d4-a716-446655440003';

function makeStorageObject(ownerId: string, overrides: Record<string, any> = {}) {
  return {
    id: BASE_STORAGE_ID,
    name: 'photo.jpg',
    size: BigInt(1024000),
    mimeType: 'image/jpeg',
    storageKey: 'uploads/photo.jpg',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'ready',
    s3UploadId: null,
    uploadedById: ownerId,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMediaItem(ownerId: string, overrides: Record<string, any> = {}) {
  return {
    id: BASE_MEDIA_ID,
    storageObjectId: BASE_STORAGE_ID,
    ownerId,
    type: 'photo',
    source: 'web',
    originalFilename: 'photo.jpg',
    capturedAt: null,
    capturedAtOffset: null,
    importedAt: new Date(),
    classification: 'unreviewed',
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

function makeAlbum(ownerId: string, overrides: Record<string, any> = {}) {
  return {
    id: BASE_ALBUM_ID,
    ownerId,
    name: 'My Album',
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeTag(ownerId: string, overrides: Record<string, any> = {}) {
  return {
    id: BASE_TAG_ID,
    ownerId,
    name: 'nature',
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Media Integration', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();
  });

  // =========================================================================
  // Authentication
  // =========================================================================

  describe('Authentication — all media endpoints require auth', () => {
    it('POST /api/media returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .post('/api/media')
        .send({
          storageObjectId: BASE_STORAGE_ID,
          type: 'photo',
          source: 'web',
          originalFilename: 'photo.jpg',
        })
        .expect(401);
    });

    it('GET /api/media returns 401 without token', async () => {
      await request(context.app.getHttpServer()).get('/api/media').expect(401);
    });

    it('GET /api/media/:id returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .get(`/api/media/${BASE_MEDIA_ID}`)
        .expect(401);
    });

    it('PATCH /api/media/:id returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .patch(`/api/media/${BASE_MEDIA_ID}`)
        .send({ title: 'New Title' })
        .expect(401);
    });

    it('DELETE /api/media/:id returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .delete(`/api/media/${BASE_MEDIA_ID}`)
        .expect(401);
    });
  });

  // =========================================================================
  // POST /api/media — create
  // =========================================================================

  describe('POST /api/media', () => {
    it('should create a MediaItem from owned StorageObject', async () => {
      const contributor = await createMockContributorUser(context);
      const storageObject = makeStorageObject(contributor.id);
      const createdItem = makeMediaItem(contributor.id);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(storageObject);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(null);
      context.prismaMock.mediaItem.create.mockResolvedValue(createdItem);

      const response = await request(context.app.getHttpServer())
        .post('/api/media')
        .set(authHeader(contributor.accessToken))
        .send({
          storageObjectId: BASE_STORAGE_ID,
          type: 'photo',
          source: 'web',
          originalFilename: 'photo.jpg',
        })
        .expect(201);

      expect(response.body.data).toMatchObject({
        id: BASE_MEDIA_ID,
        ownerId: contributor.id,
        type: 'photo',
        source: 'web',
      });
    });

    it('should return 404 when StorageObject does not exist', async () => {
      const contributor = await createMockContributorUser(context);
      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post('/api/media')
        .set(authHeader(contributor.accessToken))
        .send({
          storageObjectId: BASE_STORAGE_ID,
          type: 'photo',
          source: 'web',
          originalFilename: 'photo.jpg',
        })
        .expect(404);
    });

    it('should return 403 when StorageObject belongs to another user', async () => {
      const contributor = await createMockContributorUser(context);
      const otherStorageObject = makeStorageObject('other-user-id');

      context.prismaMock.storageObject.findUnique.mockResolvedValue(otherStorageObject);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post('/api/media')
        .set(authHeader(contributor.accessToken))
        .send({
          storageObjectId: BASE_STORAGE_ID,
          type: 'photo',
          source: 'web',
          originalFilename: 'photo.jpg',
        })
        .expect(403);
    });

    it('should return 400 when StorageObject is already linked to a MediaItem', async () => {
      const contributor = await createMockContributorUser(context);
      const storageObject = makeStorageObject(contributor.id);
      const existingItem = makeMediaItem(contributor.id);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(storageObject);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(existingItem);

      await request(context.app.getHttpServer())
        .post('/api/media')
        .set(authHeader(contributor.accessToken))
        .send({
          storageObjectId: BASE_STORAGE_ID,
          type: 'photo',
          source: 'web',
          originalFilename: 'photo.jpg',
        })
        .expect(400);
    });

    it('should return 400 for missing required fields', async () => {
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .post('/api/media')
        .set(authHeader(contributor.accessToken))
        .send({ type: 'photo' }) // missing storageObjectId, source, originalFilename
        .expect(400);
    });
  });

  // =========================================================================
  // GET /api/media — list with filters
  // =========================================================================

  describe('GET /api/media', () => {
    it('should return paginated results for the authenticated user', async () => {
      const contributor = await createMockContributorUser(context);
      const items = [makeMediaItem(contributor.id)];

      context.prismaMock.mediaItem.findMany.mockResolvedValue(items);
      context.prismaMock.mediaItem.count.mockResolvedValue(1);

      const response = await request(context.app.getHttpServer())
        .get('/api/media')
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.meta).toMatchObject({
        page: 1,
        pageSize: 20,
        totalItems: 1,
        totalPages: 1,
      });
    });

    it('should support pagination query params', async () => {
      const contributor = await createMockContributorUser(context);

      context.prismaMock.mediaItem.findMany.mockResolvedValue([]);
      context.prismaMock.mediaItem.count.mockResolvedValue(50);

      const response = await request(context.app.getHttpServer())
        .get('/api/media?page=2&pageSize=10')
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body.data.meta).toMatchObject({
        page: 2,
        pageSize: 10,
        totalItems: 50,
        totalPages: 5,
      });
    });

    it('should pass location filter to service — ?location=California', async () => {
      const contributor = await createMockContributorUser(context);
      const californiaItem = makeMediaItem(contributor.id, {
        geoAdmin1: 'California',
      });

      context.prismaMock.mediaItem.findMany.mockResolvedValue([californiaItem]);
      context.prismaMock.mediaItem.count.mockResolvedValue(1);

      const response = await request(context.app.getHttpServer())
        .get('/api/media?location=California')
        .set(authHeader(contributor.accessToken))
        .expect(200);

      // Verify the filter was built correctly by examining the mock call
      const [findManyCall] =
        (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls;

      expect(findManyCall[0].where.OR).toEqual(
        expect.arrayContaining([
          { geoAdmin1: { contains: 'California', mode: 'insensitive' } },
          { geoCountry: { contains: 'California', mode: 'insensitive' } },
          { geoLocality: { contains: 'California', mode: 'insensitive' } },
          { geoPlaceName: { contains: 'California', mode: 'insensitive' } },
        ]),
      );

      expect(response.body.data.items).toHaveLength(1);
    });

    it('should pass country filter to service — ?country=CR', async () => {
      const contributor = await createMockContributorUser(context);
      const costaRicaItem = makeMediaItem(contributor.id, {
        geoCountryCode: 'CR',
        geoCountry: 'Costa Rica',
      });

      context.prismaMock.mediaItem.findMany.mockResolvedValue([costaRicaItem]);
      context.prismaMock.mediaItem.count.mockResolvedValue(1);

      const response = await request(context.app.getHttpServer())
        .get('/api/media?country=CR')
        .set(authHeader(contributor.accessToken))
        .expect(200);

      const [findManyCall] =
        (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls;

      expect(findManyCall[0].where.OR).toEqual(
        expect.arrayContaining([
          { geoCountry: { contains: 'CR', mode: 'insensitive' } },
          { geoCountryCode: { equals: 'CR', mode: 'insensitive' } },
        ]),
      );

      expect(response.body.data.items).toHaveLength(1);
    });

    it('should exclude soft-deleted items by default', async () => {
      const contributor = await createMockContributorUser(context);

      context.prismaMock.mediaItem.findMany.mockResolvedValue([]);
      context.prismaMock.mediaItem.count.mockResolvedValue(0);

      await request(context.app.getHttpServer())
        .get('/api/media')
        .set(authHeader(contributor.accessToken))
        .expect(200);

      const [findManyCall] =
        (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls;
      expect(findManyCall[0].where).toMatchObject({ deletedAt: null });
    });

    it('should filter by type', async () => {
      const contributor = await createMockContributorUser(context);

      context.prismaMock.mediaItem.findMany.mockResolvedValue([]);
      context.prismaMock.mediaItem.count.mockResolvedValue(0);

      await request(context.app.getHttpServer())
        .get('/api/media?type=photo')
        .set(authHeader(contributor.accessToken))
        .expect(200);

      const [call] = (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ type: 'photo' });
    });

    it('should filter by favorite=true', async () => {
      const contributor = await createMockContributorUser(context);

      context.prismaMock.mediaItem.findMany.mockResolvedValue([]);
      context.prismaMock.mediaItem.count.mockResolvedValue(0);

      await request(context.app.getHttpServer())
        .get('/api/media?favorite=true')
        .set(authHeader(contributor.accessToken))
        .expect(200);

      const [call] = (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ favorite: true });
    });
  });

  // =========================================================================
  // GET /api/media/:id — get single
  // =========================================================================

  describe('GET /api/media/:id', () => {
    it('should return a MediaItem for the owner', async () => {
      const contributor = await createMockContributorUser(context);
      const item = makeMediaItem(contributor.id);

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(item);

      const response = await request(context.app.getHttpServer())
        .get(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        id: BASE_MEDIA_ID,
        type: 'photo',
      });
    });

    it('should return 404 when MediaItem does not exist', async () => {
      const contributor = await createMockContributorUser(context);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(404);
    });

    it('should return 403 when Contributor accesses another user\'s item', async () => {
      const contributor = await createMockContributorUser(context);
      const otherUserItem = makeMediaItem('other-user');

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(otherUserItem);

      await request(context.app.getHttpServer())
        .get(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);
    });

    it('should allow Admin with media:read_any to access another user\'s item', async () => {
      const admin = await createMockAdminUser(context);
      const otherUserItem = makeMediaItem('other-user');

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(otherUserItem);

      const response = await request(context.app.getHttpServer())
        .get(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.id).toBe(BASE_MEDIA_ID);
    });
  });

  // =========================================================================
  // PATCH /api/media/:id — update
  // =========================================================================

  describe('PATCH /api/media/:id', () => {
    it('should update title, caption, description, and favorite', async () => {
      const contributor = await createMockContributorUser(context);
      const item = makeMediaItem(contributor.id);
      const updated = {
        ...item,
        title: 'Sunset',
        caption: 'Golden hour',
        description: 'Beautiful sunset at the beach',
        favorite: true,
      };

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(item);
      context.prismaMock.mediaItem.update.mockResolvedValue(updated);

      const response = await request(context.app.getHttpServer())
        .patch(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .send({
          title: 'Sunset',
          caption: 'Golden hour',
          description: 'Beautiful sunset at the beach',
          favorite: true,
        })
        .expect(200);

      expect(response.body.data).toMatchObject({
        title: 'Sunset',
        favorite: true,
      });
    });

    it('should return 403 when Contributor patches another user\'s item', async () => {
      const contributor = await createMockContributorUser(context);
      const otherUserItem = makeMediaItem('other-user');

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(otherUserItem);

      await request(context.app.getHttpServer())
        .patch(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .send({ title: 'hack' })
        .expect(403);
    });

    it('should return 404 when item does not exist', async () => {
      const contributor = await createMockContributorUser(context);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .patch(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .send({ title: 'New Title' })
        .expect(404);
    });
  });

  // =========================================================================
  // DELETE /api/media/:id — soft-delete
  // =========================================================================

  describe('DELETE /api/media/:id', () => {
    it('should soft-delete the MediaItem (sets deletedAt)', async () => {
      const contributor = await createMockContributorUser(context);
      const item = makeMediaItem(contributor.id);

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(item);
      context.prismaMock.mediaItem.update.mockResolvedValue({
        ...item,
        deletedAt: new Date(),
      });

      await request(context.app.getHttpServer())
        .delete(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(204);

      // Verify soft-delete — update with deletedAt, NOT delete
      expect(context.prismaMock.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BASE_MEDIA_ID },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      // StorageObject is NOT touched
      expect(context.prismaMock.storageObject.delete).not.toHaveBeenCalled();
      expect(context.prismaMock.storageObject.update).not.toHaveBeenCalled();
    });

    it('should return 403 when Contributor deletes another user\'s item', async () => {
      const contributor = await createMockContributorUser(context);
      const otherUserItem = makeMediaItem('other-user');

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(otherUserItem);

      await request(context.app.getHttpServer())
        .delete(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);
    });

    it('should return 404 when item does not exist', async () => {
      const contributor = await createMockContributorUser(context);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(404);
    });

    it('soft-deleted item no longer appears in normal list results', async () => {
      const contributor = await createMockContributorUser(context);
      // Soft-delete succeeds
      const item = makeMediaItem(contributor.id);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(item);
      context.prismaMock.mediaItem.update.mockResolvedValue({
        ...item,
        deletedAt: new Date(),
      });

      await request(context.app.getHttpServer())
        .delete(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(204);

      // List returns zero (simulated: soft-deleted not returned)
      context.prismaMock.mediaItem.findMany.mockResolvedValue([]);
      context.prismaMock.mediaItem.count.mockResolvedValue(0);

      const listResponse = await request(context.app.getHttpServer())
        .get('/api/media')
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(listResponse.body.data.items).toHaveLength(0);
    });
  });

  // =========================================================================
  // GET /api/media/tags — list tags
  // =========================================================================

  describe('GET /api/media/tags', () => {
    it('should return caller\'s tags with count', async () => {
      const contributor = await createMockContributorUser(context);
      const tags = [
        {
          id: BASE_TAG_ID,
          name: 'nature',
          createdAt: new Date(),
          ownerId: contributor.id,
          _count: { mediaTags: 3 },
        },
      ];

      context.prismaMock.tag.findMany.mockResolvedValue(tags);

      const response = await request(context.app.getHttpServer())
        .get('/api/media/tags')
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'nature', count: 3 }),
        ]),
      );
    });

    it('should return 401 without token', async () => {
      await request(context.app.getHttpServer())
        .get('/api/media/tags')
        .expect(401);
    });
  });

  // =========================================================================
  // POST /api/media/:id/tags — attach tags
  // =========================================================================

  describe('POST /api/media/:id/tags', () => {
    it('should attach tags idempotently', async () => {
      const contributor = await createMockContributorUser(context);
      const item = makeMediaItem(contributor.id);
      const tag = makeTag(contributor.id);

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(item);
      context.prismaMock.tag.upsert.mockResolvedValue(tag);
      context.prismaMock.mediaTag.upsert.mockResolvedValue({
        id: randomUUID(),
        tagId: tag.id,
        mediaItemId: item.id,
        addedAt: new Date(),
      });

      const response = await request(context.app.getHttpServer())
        .post(`/api/media/${BASE_MEDIA_ID}/tags`)
        .set(authHeader(contributor.accessToken))
        .send({ names: ['nature', 'travel'] })
        .expect(201);

      expect(response.body.data).toHaveLength(2);
      expect(context.prismaMock.tag.upsert).toHaveBeenCalledTimes(2);
      expect(context.prismaMock.mediaTag.upsert).toHaveBeenCalledTimes(2);
    });

    it('should return 403 when Contributor attaches tags to another user\'s item', async () => {
      const contributor = await createMockContributorUser(context);
      const otherUserItem = makeMediaItem('other-user');

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(otherUserItem);

      await request(context.app.getHttpServer())
        .post(`/api/media/${BASE_MEDIA_ID}/tags`)
        .set(authHeader(contributor.accessToken))
        .send({ names: ['nature'] })
        .expect(403);
    });

    it('should return 400 for empty names array', async () => {
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .post(`/api/media/${BASE_MEDIA_ID}/tags`)
        .set(authHeader(contributor.accessToken))
        .send({ names: [] })
        .expect(400);
    });
  });

  // =========================================================================
  // DELETE /api/media/:id/tags/:tagId — remove tag
  // =========================================================================

  describe('DELETE /api/media/:id/tags/:tagId', () => {
    it('should remove a tag from a MediaItem', async () => {
      const contributor = await createMockContributorUser(context);
      const item = makeMediaItem(contributor.id);
      const mediaTag = {
        id: randomUUID(),
        tagId: BASE_TAG_ID,
        mediaItemId: item.id,
        addedAt: new Date(),
      };

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(item);
      context.prismaMock.mediaTag.findUnique.mockResolvedValue(mediaTag);
      context.prismaMock.mediaTag.delete.mockResolvedValue(mediaTag);

      await request(context.app.getHttpServer())
        .delete(`/api/media/${BASE_MEDIA_ID}/tags/${BASE_TAG_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(204);

      expect(context.prismaMock.mediaTag.delete).toHaveBeenCalled();
    });

    it('should return 404 when tag is not attached', async () => {
      const contributor = await createMockContributorUser(context);
      const item = makeMediaItem(contributor.id);

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(item);
      context.prismaMock.mediaTag.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete(`/api/media/${BASE_MEDIA_ID}/tags/${BASE_TAG_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(404);
    });
  });

  // =========================================================================
  // RBAC / Ownership enforcement
  // =========================================================================

  describe('RBAC — Ownership enforcement', () => {
    it('Contributor cannot read another user\'s MediaItem (403)', async () => {
      const contributor = await createMockContributorUser(context);
      const otherUserItem = makeMediaItem('completely-other-user');

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(otherUserItem);

      await request(context.app.getHttpServer())
        .get(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);
    });

    it('Contributor cannot modify another user\'s MediaItem (403)', async () => {
      const contributor = await createMockContributorUser(context);
      const otherUserItem = makeMediaItem('completely-other-user');

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(otherUserItem);

      await request(context.app.getHttpServer())
        .patch(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .send({ title: 'hack' })
        .expect(403);
    });

    it('Admin with media:read_any can read any user\'s MediaItem (200)', async () => {
      const admin = await createMockAdminUser(context);
      const otherUserItem = makeMediaItem('some-other-user');

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(otherUserItem);

      await request(context.app.getHttpServer())
        .get(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(200);
    });

    it('Admin with media:write_any can patch any user\'s MediaItem (200)', async () => {
      const admin = await createMockAdminUser(context);
      const otherUserItem = makeMediaItem('some-other-user');
      const updated = { ...otherUserItem, title: 'Admin Updated' };

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(otherUserItem);
      context.prismaMock.mediaItem.update.mockResolvedValue(updated);

      await request(context.app.getHttpServer())
        .patch(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(admin.accessToken))
        .send({ title: 'Admin Updated' })
        .expect(200);
    });

    it('Admin with media:delete_any can soft-delete any user\'s MediaItem (204)', async () => {
      const admin = await createMockAdminUser(context);
      const otherUserItem = makeMediaItem('some-other-user');

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(otherUserItem);
      context.prismaMock.mediaItem.update.mockResolvedValue({
        ...otherUserItem,
        deletedAt: new Date(),
      });

      await request(context.app.getHttpServer())
        .delete(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(204);
    });
  });

  // =========================================================================
  // Album CRUD
  // =========================================================================

  describe('POST /api/media/albums', () => {
    it('should create an album for the authenticated user', async () => {
      const contributor = await createMockContributorUser(context);
      const album = makeAlbum(contributor.id);

      context.prismaMock.album.create.mockResolvedValue(album);

      const response = await request(context.app.getHttpServer())
        .post('/api/media/albums')
        .set(authHeader(contributor.accessToken))
        .send({ name: 'My Album' })
        .expect(201);

      expect(response.body.data).toMatchObject({
        id: BASE_ALBUM_ID,
        name: 'My Album',
        ownerId: contributor.id,
      });
    });

    it('should return 400 for missing name', async () => {
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .post('/api/media/albums')
        .set(authHeader(contributor.accessToken))
        .send({})
        .expect(400);
    });
  });

  describe('GET /api/media/albums', () => {
    it('should return paginated albums for the authenticated user', async () => {
      const contributor = await createMockContributorUser(context);
      const albums = [{ ...makeAlbum(contributor.id), _count: { items: 0 } }];

      context.prismaMock.album.findMany.mockResolvedValue(albums);
      context.prismaMock.album.count.mockResolvedValue(1);

      const response = await request(context.app.getHttpServer())
        .get('/api/media/albums')
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.meta).toMatchObject({
        page: 1,
        pageSize: 20,
        totalItems: 1,
        totalPages: 1,
      });
    });
  });

  describe('GET /api/media/albums/:id', () => {
    it('should return album with items for owner', async () => {
      const contributor = await createMockContributorUser(context);
      const album = { ...makeAlbum(contributor.id), items: [] };

      context.prismaMock.album.findUnique.mockResolvedValue(album);

      const response = await request(context.app.getHttpServer())
        .get(`/api/media/albums/${BASE_ALBUM_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({ id: BASE_ALBUM_ID, name: 'My Album' });
    });

    it('should return 403 when Contributor accesses another user\'s album', async () => {
      const contributor = await createMockContributorUser(context);
      const otherAlbum = { ...makeAlbum('other-user'), items: [] };

      context.prismaMock.album.findUnique.mockResolvedValue(otherAlbum);

      await request(context.app.getHttpServer())
        .get(`/api/media/albums/${BASE_ALBUM_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);
    });

    it('should return 404 when album does not exist', async () => {
      const contributor = await createMockContributorUser(context);
      context.prismaMock.album.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get(`/api/media/albums/${BASE_ALBUM_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(404);
    });
  });

  describe('PATCH /api/media/albums/:id', () => {
    it('should update album name for owner', async () => {
      const contributor = await createMockContributorUser(context);
      const album = makeAlbum(contributor.id);
      const updated = { ...album, name: 'Renamed Album' };

      context.prismaMock.album.findUnique.mockResolvedValue(album);
      context.prismaMock.album.update.mockResolvedValue(updated);

      const response = await request(context.app.getHttpServer())
        .patch(`/api/media/albums/${BASE_ALBUM_ID}`)
        .set(authHeader(contributor.accessToken))
        .send({ name: 'Renamed Album' })
        .expect(200);

      expect(response.body.data.name).toBe('Renamed Album');
    });

    it('should return 403 for non-owner without _any permission', async () => {
      const contributor = await createMockContributorUser(context);
      const otherAlbum = makeAlbum('other-user');

      context.prismaMock.album.findUnique.mockResolvedValue(otherAlbum);

      await request(context.app.getHttpServer())
        .patch(`/api/media/albums/${BASE_ALBUM_ID}`)
        .set(authHeader(contributor.accessToken))
        .send({ name: 'hack' })
        .expect(403);
    });
  });

  describe('DELETE /api/media/albums/:id', () => {
    it('should delete album (cascade AlbumItems) but NOT delete MediaItems', async () => {
      const contributor = await createMockContributorUser(context);
      const album = makeAlbum(contributor.id);

      context.prismaMock.album.findUnique.mockResolvedValue(album);
      context.prismaMock.album.delete.mockResolvedValue(album);

      await request(context.app.getHttpServer())
        .delete(`/api/media/albums/${BASE_ALBUM_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(204);

      expect(context.prismaMock.album.delete).toHaveBeenCalledWith({
        where: { id: BASE_ALBUM_ID },
      });
      expect(context.prismaMock.mediaItem.delete).not.toHaveBeenCalled();
      expect(context.prismaMock.mediaItem.deleteMany).not.toHaveBeenCalled();
    });

    it('should return 403 for non-owner', async () => {
      const contributor = await createMockContributorUser(context);
      const otherAlbum = makeAlbum('other-user');

      context.prismaMock.album.findUnique.mockResolvedValue(otherAlbum);

      await request(context.app.getHttpServer())
        .delete(`/api/media/albums/${BASE_ALBUM_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);
    });
  });

  // =========================================================================
  // Album items — add / remove
  // =========================================================================

  describe('POST /api/media/albums/:id/items', () => {
    it('should add MediaItems to an album', async () => {
      const contributor = await createMockContributorUser(context);
      const album = makeAlbum(contributor.id);
      const mediaItemId = randomUUID();
      const mediaItem = makeMediaItem(contributor.id, { id: mediaItemId });
      const albumItem = {
        id: randomUUID(),
        albumId: album.id,
        mediaItemId,
        addedAt: new Date(),
      };

      context.prismaMock.album.findUnique.mockResolvedValue(album);
      context.prismaMock.mediaItem.findMany.mockResolvedValue([mediaItem]);
      context.prismaMock.albumItem.upsert.mockResolvedValue(albumItem);

      const response = await request(context.app.getHttpServer())
        .post(`/api/media/albums/${BASE_ALBUM_ID}/items`)
        .set(authHeader(contributor.accessToken))
        .send({ mediaItemIds: [mediaItemId] })
        .expect(201);

      expect(response.body.data).toHaveLength(1);
      expect(context.prismaMock.albumItem.upsert).toHaveBeenCalledTimes(1);
    });

    it('should return 404 when a mediaItemId is not accessible', async () => {
      const contributor = await createMockContributorUser(context);
      const album = makeAlbum(contributor.id);

      context.prismaMock.album.findUnique.mockResolvedValue(album);
      context.prismaMock.mediaItem.findMany.mockResolvedValue([]); // none found

      await request(context.app.getHttpServer())
        .post(`/api/media/albums/${BASE_ALBUM_ID}/items`)
        .set(authHeader(contributor.accessToken))
        .send({ mediaItemIds: [randomUUID()] })
        .expect(404);
    });
  });

  describe('DELETE /api/media/albums/:id/items/:itemId', () => {
    it('should remove a MediaItem from an album without deleting the MediaItem', async () => {
      const contributor = await createMockContributorUser(context);
      const album = makeAlbum(contributor.id);
      const mediaItemId = randomUUID();
      const albumItem = {
        id: randomUUID(),
        albumId: album.id,
        mediaItemId,
        addedAt: new Date(),
      };

      context.prismaMock.album.findUnique.mockResolvedValue(album);
      context.prismaMock.albumItem.findUnique.mockResolvedValue(albumItem);
      context.prismaMock.albumItem.delete.mockResolvedValue(albumItem);

      await request(context.app.getHttpServer())
        .delete(`/api/media/albums/${BASE_ALBUM_ID}/items/${mediaItemId}`)
        .set(authHeader(contributor.accessToken))
        .expect(204);

      expect(context.prismaMock.albumItem.delete).toHaveBeenCalled();
      expect(context.prismaMock.mediaItem.delete).not.toHaveBeenCalled();
    });

    it('should return 404 when item is not in the album', async () => {
      const contributor = await createMockContributorUser(context);
      const album = makeAlbum(contributor.id);

      context.prismaMock.album.findUnique.mockResolvedValue(album);
      context.prismaMock.albumItem.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete(`/api/media/albums/${BASE_ALBUM_ID}/items/${randomUUID()}`)
        .set(authHeader(contributor.accessToken))
        .expect(404);
    });
  });
});
