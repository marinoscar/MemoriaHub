/**
 * Media Integration — circle-scoped rewrite (issue #221)
 *
 * This suite predated Family Circles: it had zero references to `circleId`, its
 * factories built items with an `ownerId` field against a schema that moved to
 * `added_by_id` + `circle_id`, and 35 of its 54 tests failed with 400 because
 * `/api/media*` requires `circleId` plus per-circle membership. It was excluded
 * from `test:ci` while every other integration spec was repaired in #220.
 *
 * Rewritten against the current API, using
 * `media-bulk-dashboard.integration.spec.ts` as the reference for:
 *   - `setupCircleMocks(context, userId, circleId, role)`, which mocks
 *     `circle.findUnique` + `circleMember.findUnique` so
 *     `CircleMembershipService.assertCircleAccess` passes at a chosen role
 *   - factories that build `circleId` / `addedById`
 *   - `flattenWhere`, for asserting AND-composed filter predicates without
 *     depending on descriptor order (see docs/audits/search-audit.md)
 *
 * The material new coverage is authorization the old spec could not express at
 * all: a non-member gets 403, and a `viewer` is refused every write. Those are
 * the invariants this suite exists to protect, and until now it protected
 * neither.
 *
 * Mocked Prisma throughout (`useMockDatabase: true`) — no live PostgreSQL.
 */

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
  createMockAdminUser,
  createMockContributorUser,
  authHeader,
} from '../helpers/auth-mock.helper';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CIRCLE_ID = '550e8400-e29b-41d4-a716-446655440099';
const BASE_MEDIA_ID = '550e8400-e29b-41d4-a716-446655440001';
const BASE_STORAGE_ID = '550e8400-e29b-41d4-a716-446655440000';
const BASE_ALBUM_ID = '550e8400-e29b-41d4-a716-446655440002';
const BASE_TAG_ID = '550e8400-e29b-41d4-a716-446655440003';

// ---------------------------------------------------------------------------
// Circle membership mocks
// ---------------------------------------------------------------------------

/**
 * Make `assertCircleAccess` resolve at `role` for `userId` in `circleId`.
 * Roles rank viewer < collaborator < circle_admin, so a test asserting a write
 * is refused for a viewer sets `'viewer'` here and expects 403.
 */
function setupCircleMocks(
  context: TestContext,
  userId: string,
  circleId: string,
  role: 'viewer' | 'collaborator' | 'circle_admin',
): void {
  context.prismaMock.circle.findUnique.mockResolvedValue({ id: circleId });
  context.prismaMock.circleMember.findUnique.mockResolvedValue({
    circleId,
    userId,
    role,
    joinedAt: new Date(),
  });
}

/**
 * The circle exists but the caller is not a member — `assertCircleAccess`
 * throws Forbidden at its membership step, on reads as well as writes.
 */
function setupNonMemberMocks(context: TestContext, circleId: string): void {
  context.prismaMock.circle.findUnique.mockResolvedValue({ id: circleId });
  context.prismaMock.circleMember.findUnique.mockResolvedValue(null);
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeStorageObject(uploaderId: string, overrides: Record<string, any> = {}) {
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
    uploadedById: uploaderId,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMediaItem(addedById: string, overrides: Record<string, any> = {}) {
  return {
    id: BASE_MEDIA_ID,
    storageObjectId: BASE_STORAGE_ID,
    addedById,
    circleId: CIRCLE_ID,
    type: 'photo',
    source: 'web',
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
    coordSource: null,
    metadata: null,
    mediaTags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAlbum(addedById: string, overrides: Record<string, any> = {}) {
  return {
    id: BASE_ALBUM_ID,
    addedById,
    circleId: CIRCLE_ID,
    name: 'My Album',
    description: null,
    coverMediaItemId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeTag(overrides: Record<string, any> = {}) {
  return {
    id: BASE_TAG_ID,
    circleId: CIRCLE_ID,
    addedById: 'user-1',
    name: 'nature',
    createdAt: new Date(),
    ...overrides,
  };
}

/** Valid POST /api/media body — every required field, circle included. */
function createMediaBody(overrides: Record<string, any> = {}) {
  return {
    circleId: CIRCLE_ID,
    storageObjectId: BASE_STORAGE_ID,
    type: 'photo',
    source: 'web',
    originalFilename: 'photo.jpg',
    ...overrides,
  };
}

/**
 * Media filters are AND-composed: each descriptor appends its own entry to
 * `where.AND` rather than merging into one flat object (docs/audits/
 * search-audit.md — the old flat merge silently dropped criteria when two
 * descriptors wrote the same key). Flattening lets a test assert "this
 * predicate was applied" without depending on descriptor count or order.
 */
function flattenWhere(where: Record<string, any>): Record<string, any> {
  const { AND, ...rest } = where ?? {};
  const clauses: Array<Record<string, any>> = Array.isArray(AND) ? AND : [];
  return clauses.reduce((acc, clause) => ({ ...acc, ...clause }), { ...rest });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Media Integration (circle-scoped)', () => {
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
        .send(createMediaBody())
        .expect(401);
    });

    it('GET /api/media returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .get(`/api/media?circleId=${CIRCLE_ID}`)
        .expect(401);
    });

    it('GET /api/media/:id returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .get(`/api/media/${BASE_MEDIA_ID}`)
        .expect(401);
    });

    it('PATCH /api/media/:id returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .patch(`/api/media/${BASE_MEDIA_ID}`)
        .send({ description: 'New Description' })
        .expect(401);
    });

    it('DELETE /api/media/:id returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .delete(`/api/media/${BASE_MEDIA_ID}`)
        .expect(401);
    });

    it('GET /api/media/tags returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .get(`/api/media/tags?circleId=${CIRCLE_ID}`)
        .expect(401);
    });
  });

  // =========================================================================
  // POST /api/media — create
  // =========================================================================

  describe('POST /api/media', () => {
    it('creates a MediaItem in the circle from an owned StorageObject', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      context.prismaMock.storageObject.findUnique.mockResolvedValue(
        makeStorageObject(contributor.id),
      );
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(null);
      context.prismaMock.mediaItem.create.mockResolvedValue(
        makeMediaItem(contributor.id),
      );

      const response = await request(context.app.getHttpServer())
        .post('/api/media')
        .set(authHeader(contributor.accessToken))
        .send(createMediaBody())
        .expect(201);

      expect(response.body.data).toMatchObject({
        id: BASE_MEDIA_ID,
        circleId: CIRCLE_ID,
        addedById: contributor.id,
        type: 'photo',
        source: 'web',
        deduplicated: false,
      });

      // The row is written with the circle and the caller as adder — the two
      // columns that replaced the old `ownerId`.
      expect(context.prismaMock.mediaItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            circleId: CIRCLE_ID,
            addedById: contributor.id,
          }),
        }),
      );
    });

    it('returns 404 when the StorageObject does not exist', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');
      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post('/api/media')
        .set(authHeader(contributor.accessToken))
        .send(createMediaBody())
        .expect(404);
    });

    it('returns 403 when the StorageObject belongs to another user', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      context.prismaMock.storageObject.findUnique.mockResolvedValue(
        makeStorageObject('other-user-id'),
      );
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post('/api/media')
        .set(authHeader(contributor.accessToken))
        .send(createMediaBody())
        .expect(403);
    });

    it('returns 400 when the StorageObject is already linked to a MediaItem', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      context.prismaMock.storageObject.findUnique.mockResolvedValue(
        makeStorageObject(contributor.id),
      );
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem(contributor.id),
      );

      await request(context.app.getHttpServer())
        .post('/api/media')
        .set(authHeader(contributor.accessToken))
        .send(createMediaBody())
        .expect(400);
    });

    it('returns 400 for missing required fields', async () => {
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .post('/api/media')
        .set(authHeader(contributor.accessToken))
        .send({ type: 'photo' }) // no circleId/storageObjectId/source/filename
        .expect(400);
    });

    it('returns 400 when circleId is omitted', async () => {
      const contributor = await createMockContributorUser(context);
      const { circleId: _omitted, ...body } = createMediaBody();

      await request(context.app.getHttpServer())
        .post('/api/media')
        .set(authHeader(contributor.accessToken))
        .send(body)
        .expect(400);
    });

    it('returns 403 when the caller is not a member of the circle', async () => {
      const contributor = await createMockContributorUser(context);
      setupNonMemberMocks(context, CIRCLE_ID);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(
        makeStorageObject(contributor.id),
      );
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post('/api/media')
        .set(authHeader(contributor.accessToken))
        .send(createMediaBody())
        .expect(403);

      expect(context.prismaMock.mediaItem.create).not.toHaveBeenCalled();
    });

    it('returns 403 for a circle VIEWER — creating requires collaborator', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');

      context.prismaMock.storageObject.findUnique.mockResolvedValue(
        makeStorageObject(contributor.id),
      );
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post('/api/media')
        .set(authHeader(contributor.accessToken))
        .send(createMediaBody())
        .expect(403);

      expect(context.prismaMock.mediaItem.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GET /api/media — list
  // =========================================================================

  describe('GET /api/media', () => {
    it('returns 400 when circleId is omitted', async () => {
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .get('/api/media')
        .set(authHeader(contributor.accessToken))
        .expect(400);
    });

    it('returns 403 when the caller is not a member of the circle', async () => {
      const contributor = await createMockContributorUser(context);
      setupNonMemberMocks(context, CIRCLE_ID);

      await request(context.app.getHttpServer())
        .get(`/api/media?circleId=${CIRCLE_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);

      expect(context.prismaMock.mediaItem.findMany).not.toHaveBeenCalled();
    });

    it('defaults to KEYSET mode (no page param): no COUNT, cursor meta', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');

      context.prismaMock.mediaItem.findMany.mockResolvedValue([
        makeMediaItem(contributor.id),
      ]);

      const response = await request(context.app.getHttpServer())
        .get(`/api/media?circleId=${CIRCLE_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.meta).toMatchObject({
        pageSize: 20,
        nextCursor: null,
        hasMore: false,
      });
      // Keyset mode deliberately skips the COUNT(*) (issue #104).
      expect(context.prismaMock.mediaItem.count).not.toHaveBeenCalled();
    });

    it('uses LEGACY OFFSET mode when page is supplied, with totalItems/totalPages', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');

      context.prismaMock.mediaItem.findMany.mockResolvedValue([]);
      context.prismaMock.mediaItem.count.mockResolvedValue(50);

      const response = await request(context.app.getHttpServer())
        .get(`/api/media?circleId=${CIRCLE_ID}&page=2&pageSize=10`)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body.data.meta).toMatchObject({
        page: 2,
        pageSize: 10,
        totalItems: 50,
        totalPages: 5,
      });
    });

    it('always scopes the query to the circle and excludes soft-deleted items', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');

      context.prismaMock.mediaItem.findMany.mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .get(`/api/media?circleId=${CIRCLE_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      const [call] = (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls;
      expect(flattenWhere(call[0].where)).toMatchObject({
        circleId: CIRCLE_ID,
        deletedAt: null,
      });
    });

    it('passes the location filter through as an OR across all geo tiers', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');

      context.prismaMock.mediaItem.findMany.mockResolvedValue([
        makeMediaItem(contributor.id, { geoAdmin1: 'California' }),
      ]);

      const response = await request(context.app.getHttpServer())
        .get(`/api/media?circleId=${CIRCLE_ID}&location=California`)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      const [call] = (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls;
      expect(flattenWhere(call[0].where).OR).toEqual(
        expect.arrayContaining([
          { geoAdmin1: { contains: 'California', mode: 'insensitive' } },
          { geoCountry: { contains: 'California', mode: 'insensitive' } },
          { geoLocality: { contains: 'California', mode: 'insensitive' } },
          { geoPlaceName: { contains: 'California', mode: 'insensitive' } },
        ]),
      );
      expect(response.body.data.items).toHaveLength(1);
    });

    it('passes the country filter through as name-contains OR code-equals', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');

      context.prismaMock.mediaItem.findMany.mockResolvedValue([
        makeMediaItem(contributor.id, {
          geoCountryCode: 'CR',
          geoCountry: 'Costa Rica',
        }),
      ]);

      await request(context.app.getHttpServer())
        .get(`/api/media?circleId=${CIRCLE_ID}&country=CR`)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      const [call] = (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls;
      expect(flattenWhere(call[0].where).OR).toEqual(
        expect.arrayContaining([
          { geoCountry: { contains: 'CR', mode: 'insensitive' } },
          { geoCountryCode: { equals: 'CR', mode: 'insensitive' } },
        ]),
      );
    });

    it('filters by type', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');
      context.prismaMock.mediaItem.findMany.mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .get(`/api/media?circleId=${CIRCLE_ID}&type=photo`)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      const [call] = (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls;
      expect(flattenWhere(call[0].where)).toMatchObject({ type: 'photo' });
    });

    it('filters by favorite=true', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');
      context.prismaMock.mediaItem.findMany.mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .get(`/api/media?circleId=${CIRCLE_ID}&favorite=true`)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      const [call] = (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls;
      expect(flattenWhere(call[0].where)).toMatchObject({ favorite: true });
    });
  });

  // =========================================================================
  // GET /api/media/:id
  // =========================================================================

  describe('GET /api/media/:id', () => {
    it('returns the item for a circle viewer', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem(contributor.id),
      );
      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      const response = await request(context.app.getHttpServer())
        .get(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        id: BASE_MEDIA_ID,
        circleId: CIRCLE_ID,
        type: 'photo',
      });
    });

    it('returns 404 when the item does not exist', async () => {
      const contributor = await createMockContributorUser(context);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(404);
    });

    it('returns 404 for a soft-deleted item', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem(contributor.id, { deletedAt: new Date() }),
      );

      await request(context.app.getHttpServer())
        .get(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(404);
    });

    it("returns 403 when the caller is not a member of the item's circle", async () => {
      const contributor = await createMockContributorUser(context);
      setupNonMemberMocks(context, CIRCLE_ID);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem('someone-else'),
      );

      await request(context.app.getHttpServer())
        .get(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);
    });

    it('lets an Admin holding media:read_any read an item in a circle they do not belong to', async () => {
      // Super-admin bypass: assertCircleAccess short-circuits before the
      // membership lookup, so no circle mocks are set up here on purpose.
      const admin = await createMockAdminUser(context);
      context.prismaMock.circleMember.findUnique.mockResolvedValue(null);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem('someone-else'),
      );
      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      const response = await request(context.app.getHttpServer())
        .get(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.id).toBe(BASE_MEDIA_ID);
    });
  });

  // =========================================================================
  // PATCH /api/media/:id
  // =========================================================================

  describe('PATCH /api/media/:id', () => {
    it('updates description and favorite for a circle collaborator', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      const item = makeMediaItem(contributor.id);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(item);
      context.prismaMock.mediaItem.update.mockResolvedValue({
        ...item,
        description: 'Beautiful sunset at the beach',
        favorite: true,
      });

      const response = await request(context.app.getHttpServer())
        .patch(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .send({ description: 'Beautiful sunset at the beach', favorite: true })
        .expect(200);

      expect(response.body.data).toMatchObject({
        description: 'Beautiful sunset at the beach',
        favorite: true,
      });
    });

    it('returns 403 for a circle VIEWER — updating requires collaborator', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem(contributor.id),
      );

      await request(context.app.getHttpServer())
        .patch(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .send({ description: 'nope' })
        .expect(403);

      expect(context.prismaMock.mediaItem.update).not.toHaveBeenCalled();
    });

    it('returns 403 when the caller is not a member of the circle', async () => {
      const contributor = await createMockContributorUser(context);
      setupNonMemberMocks(context, CIRCLE_ID);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem('someone-else'),
      );

      await request(context.app.getHttpServer())
        .patch(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .send({ description: 'hack' })
        .expect(403);

      expect(context.prismaMock.mediaItem.update).not.toHaveBeenCalled();
    });

    it('returns 404 when the item does not exist', async () => {
      const contributor = await createMockContributorUser(context);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .patch(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .send({ description: 'New Description' })
        .expect(404);
    });
  });

  // =========================================================================
  // DELETE /api/media/:id — soft-delete
  // =========================================================================

  describe('DELETE /api/media/:id', () => {
    it('soft-deletes the item and never touches the StorageObject', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

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

      expect(context.prismaMock.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BASE_MEDIA_ID },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      expect(context.prismaMock.storageObject.delete).not.toHaveBeenCalled();
      expect(context.prismaMock.storageObject.update).not.toHaveBeenCalled();
    });

    it('returns 403 for a circle VIEWER — deleting requires collaborator', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem(contributor.id),
      );

      await request(context.app.getHttpServer())
        .delete(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);

      expect(context.prismaMock.mediaItem.update).not.toHaveBeenCalled();
    });

    it('returns 403 when the caller is not a member of the circle', async () => {
      const contributor = await createMockContributorUser(context);
      setupNonMemberMocks(context, CIRCLE_ID);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem('someone-else'),
      );

      await request(context.app.getHttpServer())
        .delete(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);
    });

    it('returns 404 when the item does not exist', async () => {
      const contributor = await createMockContributorUser(context);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete(`/api/media/${BASE_MEDIA_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(404);
    });
  });

  // =========================================================================
  // GET /api/media/tags
  // =========================================================================

  describe('GET /api/media/tags', () => {
    it("returns the circle's tags with attach counts", async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');

      context.prismaMock.tag.findMany.mockResolvedValue([
        { ...makeTag(), _count: { mediaTags: 3 } },
      ]);

      const response = await request(context.app.getHttpServer())
        .get(`/api/media/tags?circleId=${CIRCLE_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'nature', count: 3 }),
        ]),
      );
      // Scoped to the circle, not to the caller.
      expect(context.prismaMock.tag.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { circleId: CIRCLE_ID } }),
      );
    });

    it('returns 403 when the caller is not a member of the circle', async () => {
      const contributor = await createMockContributorUser(context);
      setupNonMemberMocks(context, CIRCLE_ID);

      await request(context.app.getHttpServer())
        .get(`/api/media/tags?circleId=${CIRCLE_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);
    });
  });

  // =========================================================================
  // POST /api/media/:id/tags
  // =========================================================================

  describe('POST /api/media/:id/tags', () => {
    it('attaches tags idempotently, upserting into the item\'s circle', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem(contributor.id),
      );
      context.prismaMock.tag.upsert.mockResolvedValue(makeTag());
      context.prismaMock.mediaTag.upsert.mockResolvedValue({
        id: randomUUID(),
        tagId: BASE_TAG_ID,
        mediaItemId: BASE_MEDIA_ID,
        source: 'manual',
        addedAt: new Date(),
      });
      context.prismaMock.mediaTag.updateMany.mockResolvedValue({ count: 0 });

      const response = await request(context.app.getHttpServer())
        .post(`/api/media/${BASE_MEDIA_ID}/tags`)
        .set(authHeader(contributor.accessToken))
        .send({ names: ['nature', 'travel'] })
        .expect(201);

      expect(response.body.data).toHaveLength(2);
      expect(context.prismaMock.tag.upsert).toHaveBeenCalledTimes(2);
      expect(context.prismaMock.mediaTag.upsert).toHaveBeenCalledTimes(2);
      // Tag uniqueness is per (circleId, name), never per user.
      expect(context.prismaMock.tag.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { circleId_name: { circleId: CIRCLE_ID, name: 'nature' } },
        }),
      );
    });

    it('returns 403 for a circle VIEWER — tagging requires collaborator', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem(contributor.id),
      );

      await request(context.app.getHttpServer())
        .post(`/api/media/${BASE_MEDIA_ID}/tags`)
        .set(authHeader(contributor.accessToken))
        .send({ names: ['nature'] })
        .expect(403);

      expect(context.prismaMock.tag.upsert).not.toHaveBeenCalled();
    });

    it('returns 400 for an empty names array', async () => {
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .post(`/api/media/${BASE_MEDIA_ID}/tags`)
        .set(authHeader(contributor.accessToken))
        .send({ names: [] })
        .expect(400);
    });
  });

  // =========================================================================
  // DELETE /api/media/:id/tags/:tagId
  // =========================================================================

  describe('DELETE /api/media/:id/tags/:tagId', () => {
    it('removes the join row for a circle collaborator', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      const mediaTag = {
        id: randomUUID(),
        tagId: BASE_TAG_ID,
        mediaItemId: BASE_MEDIA_ID,
        source: 'manual',
        addedAt: new Date(),
      };
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem(contributor.id),
      );
      context.prismaMock.mediaTag.findUnique.mockResolvedValue(mediaTag);
      context.prismaMock.mediaTag.delete.mockResolvedValue(mediaTag);

      await request(context.app.getHttpServer())
        .delete(`/api/media/${BASE_MEDIA_ID}/tags/${BASE_TAG_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(204);

      expect(context.prismaMock.mediaTag.delete).toHaveBeenCalled();
    });

    it('returns 404 when the tag is not attached', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem(contributor.id),
      );
      context.prismaMock.mediaTag.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete(`/api/media/${BASE_MEDIA_ID}/tags/${BASE_TAG_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(404);
    });

    it('returns 403 for a circle VIEWER', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem(contributor.id),
      );

      await request(context.app.getHttpServer())
        .delete(`/api/media/${BASE_MEDIA_ID}/tags/${BASE_TAG_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);

      expect(context.prismaMock.mediaTag.delete).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Albums — CRUD
  // =========================================================================

  describe('POST /api/media/albums', () => {
    it('creates an album in the circle', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');
      context.prismaMock.album.create.mockResolvedValue(makeAlbum(contributor.id));

      const response = await request(context.app.getHttpServer())
        .post('/api/media/albums')
        .set(authHeader(contributor.accessToken))
        .send({ circleId: CIRCLE_ID, name: 'My Album' })
        .expect(201);

      expect(response.body.data).toMatchObject({
        id: BASE_ALBUM_ID,
        name: 'My Album',
        circleId: CIRCLE_ID,
        addedById: contributor.id,
      });
    });

    it('returns 400 for a missing name', async () => {
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .post('/api/media/albums')
        .set(authHeader(contributor.accessToken))
        .send({ circleId: CIRCLE_ID })
        .expect(400);
    });

    it('returns 400 when circleId is omitted', async () => {
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .post('/api/media/albums')
        .set(authHeader(contributor.accessToken))
        .send({ name: 'My Album' })
        .expect(400);
    });

    it('returns 403 for a circle VIEWER', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');

      await request(context.app.getHttpServer())
        .post('/api/media/albums')
        .set(authHeader(contributor.accessToken))
        .send({ circleId: CIRCLE_ID, name: 'My Album' })
        .expect(403);

      expect(context.prismaMock.album.create).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/media/albums', () => {
    it('returns a paginated album list for a circle viewer', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');

      context.prismaMock.album.findMany.mockResolvedValue([
        makeAlbum(contributor.id),
      ]);
      context.prismaMock.album.count.mockResolvedValue(1);
      (context.prismaMock.mediaItem.aggregate as jest.Mock).mockResolvedValue({
        _count: { _all: 0 },
        _min: { capturedAt: null },
        _max: { capturedAt: null },
      });
      context.prismaMock.mediaItem.findFirst.mockResolvedValue(null);

      const response = await request(context.app.getHttpServer())
        .get(`/api/media/albums?circleId=${CIRCLE_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.items[0]).toMatchObject({
        itemCount: 0,
        dateRange: null,
      });
      expect(response.body.data.meta).toMatchObject({
        page: 1,
        pageSize: 20,
        totalItems: 1,
        totalPages: 1,
      });
    });

    it('returns 403 when the caller is not a member of the circle', async () => {
      const contributor = await createMockContributorUser(context);
      setupNonMemberMocks(context, CIRCLE_ID);

      await request(context.app.getHttpServer())
        .get(`/api/media/albums?circleId=${CIRCLE_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);
    });
  });

  describe('GET /api/media/albums/:id', () => {
    it('returns the album with its items for a circle viewer', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');

      context.prismaMock.album.findUnique.mockResolvedValue({
        ...makeAlbum(contributor.id),
        items: [],
      });
      context.prismaMock.mediaItem.findFirst.mockResolvedValue(null);

      const response = await request(context.app.getHttpServer())
        .get(`/api/media/albums/${BASE_ALBUM_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        id: BASE_ALBUM_ID,
        name: 'My Album',
        circleId: CIRCLE_ID,
      });
    });

    it("returns 403 when the caller is not a member of the album's circle", async () => {
      const contributor = await createMockContributorUser(context);
      setupNonMemberMocks(context, CIRCLE_ID);
      context.prismaMock.album.findUnique.mockResolvedValue({
        ...makeAlbum('someone-else'),
        items: [],
      });

      await request(context.app.getHttpServer())
        .get(`/api/media/albums/${BASE_ALBUM_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);
    });

    it('returns 404 when the album does not exist', async () => {
      const contributor = await createMockContributorUser(context);
      context.prismaMock.album.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get(`/api/media/albums/${BASE_ALBUM_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(404);
    });
  });

  describe('PATCH /api/media/albums/:id', () => {
    it('renames the album for a circle collaborator', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      const album = makeAlbum(contributor.id);
      context.prismaMock.album.findUnique.mockResolvedValue(album);
      context.prismaMock.album.update.mockResolvedValue({
        ...album,
        name: 'Renamed Album',
      });

      const response = await request(context.app.getHttpServer())
        .patch(`/api/media/albums/${BASE_ALBUM_ID}`)
        .set(authHeader(contributor.accessToken))
        .send({ name: 'Renamed Album' })
        .expect(200);

      expect(response.body.data.name).toBe('Renamed Album');
    });

    it('returns 403 for a circle VIEWER', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');
      context.prismaMock.album.findUnique.mockResolvedValue(
        makeAlbum(contributor.id),
      );

      await request(context.app.getHttpServer())
        .patch(`/api/media/albums/${BASE_ALBUM_ID}`)
        .set(authHeader(contributor.accessToken))
        .send({ name: 'nope' })
        .expect(403);

      expect(context.prismaMock.album.update).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/media/albums/:id', () => {
    it('deletes the album (cascading joins) without deleting MediaItems', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

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

    it('returns 403 for a circle VIEWER', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');
      context.prismaMock.album.findUnique.mockResolvedValue(
        makeAlbum(contributor.id),
      );

      await request(context.app.getHttpServer())
        .delete(`/api/media/albums/${BASE_ALBUM_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);

      expect(context.prismaMock.album.delete).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Album items — add / remove
  // =========================================================================

  describe('POST /api/media/albums/:id/items', () => {
    it('adds MediaItems from the same circle to the album', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      const mediaItemId = randomUUID();
      context.prismaMock.album.findUnique.mockResolvedValue(
        makeAlbum(contributor.id),
      );
      context.prismaMock.mediaItem.findMany.mockResolvedValue([
        makeMediaItem(contributor.id, { id: mediaItemId }),
      ]);
      context.prismaMock.albumItem.upsert.mockResolvedValue({
        id: randomUUID(),
        albumId: BASE_ALBUM_ID,
        mediaItemId,
        addedAt: new Date(),
      });

      const response = await request(context.app.getHttpServer())
        .post(`/api/media/albums/${BASE_ALBUM_ID}/items`)
        .set(authHeader(contributor.accessToken))
        .send({ mediaItemIds: [mediaItemId] })
        .expect(201);

      expect(response.body.data).toHaveLength(1);
      expect(context.prismaMock.albumItem.upsert).toHaveBeenCalledTimes(1);
      // Membership is resolved against the ALBUM's circle, so an item from
      // another circle can never be added.
      expect(context.prismaMock.mediaItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ circleId: CIRCLE_ID }),
        }),
      );
    });

    it('returns 404 when a mediaItemId is not in the album\'s circle', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      context.prismaMock.album.findUnique.mockResolvedValue(
        makeAlbum(contributor.id),
      );
      context.prismaMock.mediaItem.findMany.mockResolvedValue([]); // none matched

      await request(context.app.getHttpServer())
        .post(`/api/media/albums/${BASE_ALBUM_ID}/items`)
        .set(authHeader(contributor.accessToken))
        .send({ mediaItemIds: [randomUUID()] })
        .expect(404);
    });

    it('returns 403 for a circle VIEWER', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');
      context.prismaMock.album.findUnique.mockResolvedValue(
        makeAlbum(contributor.id),
      );

      await request(context.app.getHttpServer())
        .post(`/api/media/albums/${BASE_ALBUM_ID}/items`)
        .set(authHeader(contributor.accessToken))
        .send({ mediaItemIds: [randomUUID()] })
        .expect(403);

      expect(context.prismaMock.albumItem.upsert).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/media/albums/:id/items/:itemId', () => {
    it('removes the join row without deleting the MediaItem', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      const mediaItemId = randomUUID();
      const albumItem = {
        id: randomUUID(),
        albumId: BASE_ALBUM_ID,
        mediaItemId,
        addedAt: new Date(),
      };
      context.prismaMock.album.findUnique.mockResolvedValue(
        makeAlbum(contributor.id),
      );
      context.prismaMock.albumItem.findUnique.mockResolvedValue(albumItem);
      context.prismaMock.albumItem.delete.mockResolvedValue(albumItem);

      await request(context.app.getHttpServer())
        .delete(`/api/media/albums/${BASE_ALBUM_ID}/items/${mediaItemId}`)
        .set(authHeader(contributor.accessToken))
        .expect(204);

      expect(context.prismaMock.albumItem.delete).toHaveBeenCalled();
      expect(context.prismaMock.mediaItem.delete).not.toHaveBeenCalled();
    });

    it('returns 404 when the item is not in the album', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      context.prismaMock.album.findUnique.mockResolvedValue(
        makeAlbum(contributor.id),
      );
      context.prismaMock.albumItem.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete(`/api/media/albums/${BASE_ALBUM_ID}/items/${randomUUID()}`)
        .set(authHeader(contributor.accessToken))
        .expect(404);
    });

    it('returns 403 for a circle VIEWER', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');
      context.prismaMock.album.findUnique.mockResolvedValue(
        makeAlbum(contributor.id),
      );

      await request(context.app.getHttpServer())
        .delete(`/api/media/albums/${BASE_ALBUM_ID}/items/${randomUUID()}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);

      expect(context.prismaMock.albumItem.delete).not.toHaveBeenCalled();
    });
  });
});
