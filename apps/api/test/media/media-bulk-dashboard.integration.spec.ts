/**
 * Media Bulk Dashboard Integration (DB-gated)
 *
 * NOTE: These tests use useMockDatabase: true (mocked Prisma).
 * The CircleMembershipService uses prismaMock.circle.findUnique and
 * prismaMock.circleMember.findUnique — these must be set up per test
 * so the circle access gate passes for contributor/viewer users.
 *
 * Tests are designed to run in CI. No live PostgreSQL connection is required.
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
  createMockContributorUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CIRCLE_ID = '550e8400-e29b-41d4-a716-446655440099';
const BASE_MEDIA_ID_1 = '550e8400-e29b-41d4-a716-446655440001';
const BASE_MEDIA_ID_2 = '550e8400-e29b-41d4-a716-446655440002';
const BASE_TAG_ID = '550e8400-e29b-41d4-a716-446655440003';

// ---------------------------------------------------------------------------
// Helper: set up circle membership mocks so assertCircleAccess passes
// ---------------------------------------------------------------------------

function setupCircleMocks(
  context: TestContext,
  userId: string,
  circleId: string,
  role: string,
): void {
  context.prismaMock.circle.findUnique.mockResolvedValue({ id: circleId });
  context.prismaMock.circleMember.findUnique.mockResolvedValue({
    circleId,
    userId,
    role,
    joinedAt: new Date(),
  });
}

// ---------------------------------------------------------------------------
// Media item factory (integration-level)
// ---------------------------------------------------------------------------

function makeMediaItem(overrides: Record<string, any> = {}) {
  return {
    id: BASE_MEDIA_ID_1,
    storageObjectId: randomUUID(),
    addedById: 'user-1',
    circleId: CIRCLE_ID,
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Media Bulk Dashboard Integration (DB-gated)', () => {
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
  // PATCH /api/media/bulk — auth and RBAC
  // =========================================================================

  describe('PATCH /api/media/bulk — auth and RBAC', () => {
    const validBulkUpdateBody = {
      circleId: CIRCLE_ID,
      ids: [BASE_MEDIA_ID_1, BASE_MEDIA_ID_2],
      set: { classification: 'memory' },
    };

    it('returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .patch('/api/media/bulk')
        .send(validBulkUpdateBody)
        .expect(401);
    });

    it('returns 403 without MEDIA_WRITE permission (viewer)', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/media/bulk')
        .set(authHeader(viewer.accessToken))
        .send(validBulkUpdateBody)
        .expect(403);
    });

    it('returns 200 for contributor with matching ids in circle', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      context.prismaMock.mediaItem.findMany.mockResolvedValue([
        { id: BASE_MEDIA_ID_1 },
        { id: BASE_MEDIA_ID_2 },
      ]);
      context.prismaMock.mediaItem.updateMany.mockResolvedValue({ count: 2 });

      const response = await request(context.app.getHttpServer())
        .patch('/api/media/bulk')
        .set(authHeader(contributor.accessToken))
        .send(validBulkUpdateBody)
        .expect(200);

      expect(response.body.data).toMatchObject({ updated: 2 });
    });

    it('returns 404 when ids contain items not in circle', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      // Only one of the two ids returned — the other is missing
      context.prismaMock.mediaItem.findMany.mockResolvedValue([
        { id: BASE_MEDIA_ID_1 },
      ]);

      await request(context.app.getHttpServer())
        .patch('/api/media/bulk')
        .set(authHeader(contributor.accessToken))
        .send(validBulkUpdateBody)
        .expect(404);
    });
  });

  // =========================================================================
  // POST /api/media/bulk/tags — auth and RBAC
  // =========================================================================

  describe('POST /api/media/bulk/tags — auth and RBAC', () => {
    const validBulkTagsAddBody = {
      circleId: CIRCLE_ID,
      ids: [BASE_MEDIA_ID_1, BASE_MEDIA_ID_2],
      add: ['nature'],
    };

    const validBulkTagsRemoveBody = {
      circleId: CIRCLE_ID,
      ids: [BASE_MEDIA_ID_1, BASE_MEDIA_ID_2],
      remove: ['old-tag'],
    };

    it('returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .post('/api/media/bulk/tags')
        .send(validBulkTagsAddBody)
        .expect(401);
    });

    it('returns 200 for add operation with correct shape { added: N, removed: 0 }', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      context.prismaMock.mediaItem.findMany.mockResolvedValue([
        { id: BASE_MEDIA_ID_1 },
        { id: BASE_MEDIA_ID_2 },
      ]);
      context.prismaMock.tag.upsert.mockResolvedValue({
        id: BASE_TAG_ID,
        name: 'nature',
        circleId: CIRCLE_ID,
        addedById: contributor.id,
        createdAt: new Date(),
      });
      context.prismaMock.mediaTag.createMany.mockResolvedValue({ count: 2 });

      const response = await request(context.app.getHttpServer())
        .post('/api/media/bulk/tags')
        .set(authHeader(contributor.accessToken))
        .send(validBulkTagsAddBody)
        .expect(200);

      expect(response.body.data).toMatchObject({ added: 2, removed: 0 });
    });

    it('returns 200 for remove operation with correct shape { added: 0, removed: N }', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      context.prismaMock.mediaItem.findMany.mockResolvedValue([
        { id: BASE_MEDIA_ID_1 },
        { id: BASE_MEDIA_ID_2 },
      ]);
      context.prismaMock.tag.findMany.mockResolvedValue([{ id: BASE_TAG_ID }]);
      context.prismaMock.mediaTag.deleteMany.mockResolvedValue({ count: 2 });

      const response = await request(context.app.getHttpServer())
        .post('/api/media/bulk/tags')
        .set(authHeader(contributor.accessToken))
        .send(validBulkTagsRemoveBody)
        .expect(200);

      expect(response.body.data).toMatchObject({ added: 0, removed: 2 });
    });
  });

  // =========================================================================
  // POST /api/media/bulk/delete — auth and RBAC
  // =========================================================================

  describe('POST /api/media/bulk/delete — auth and RBAC', () => {
    const validBulkDeleteBody = {
      circleId: CIRCLE_ID,
      ids: [BASE_MEDIA_ID_1, BASE_MEDIA_ID_2],
    };

    it('returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .post('/api/media/bulk/delete')
        .send(validBulkDeleteBody)
        .expect(401);
    });

    it('returns 200 for contributor — soft-deletes items { deleted: N }', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      context.prismaMock.mediaItem.findMany.mockResolvedValue([
        { id: BASE_MEDIA_ID_1 },
        { id: BASE_MEDIA_ID_2 },
      ]);
      context.prismaMock.mediaItem.updateMany.mockResolvedValue({ count: 2 });

      const response = await request(context.app.getHttpServer())
        .post('/api/media/bulk/delete')
        .set(authHeader(contributor.accessToken))
        .send(validBulkDeleteBody)
        .expect(200);

      expect(response.body.data).toMatchObject({ deleted: 2 });
    });
  });

  // =========================================================================
  // GET /api/media/dashboard
  // =========================================================================

  describe('GET /api/media/dashboard', () => {
    it('returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .get(`/api/media/dashboard?circleId=${CIRCLE_ID}`)
        .expect(401);
    });

    it('returns 200 for viewer with correct shape', async () => {
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');

      // $queryRaw → no On This Day items
      (context.prismaMock.$queryRaw as jest.Mock).mockResolvedValue([]);
      // findMany: recent, favorites
      context.prismaMock.mediaItem.findMany
        .mockResolvedValueOnce([makeMediaItem()]) // recent
        .mockResolvedValueOnce([]);               // favorites
      // count: total, unreviewed, low_value, missingGeo
      context.prismaMock.mediaItem.count
        .mockResolvedValueOnce(50)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(7);

      const response = await request(context.app.getHttpServer())
        .get(`/api/media/dashboard?circleId=${CIRCLE_ID}`)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      const data = response.body.data;
      expect(data).toHaveProperty('onThisDay');
      expect(data).toHaveProperty('recent');
      expect(data).toHaveProperty('favorites');
      expect(data).toHaveProperty('counts');
    });

    it('returns counts shape { total, unreviewed, lowValue, missingGeo } as numbers', async () => {
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');

      (context.prismaMock.$queryRaw as jest.Mock).mockResolvedValue([]);
      context.prismaMock.mediaItem.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      context.prismaMock.mediaItem.count
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(25)
        .mockResolvedValueOnce(8)
        .mockResolvedValueOnce(15);

      const response = await request(context.app.getHttpServer())
        .get(`/api/media/dashboard?circleId=${CIRCLE_ID}`)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      const counts = response.body.data.counts;
      expect(typeof counts.total).toBe('number');
      expect(typeof counts.unreviewed).toBe('number');
      expect(typeof counts.lowValue).toBe('number');
      expect(typeof counts.missingGeo).toBe('number');
      expect(counts.total).toBe(100);
      expect(counts.unreviewed).toBe(25);
      expect(counts.lowValue).toBe(8);
      expect(counts.missingGeo).toBe(15);
    });
  });

  // =========================================================================
  // GET /api/media — new filters
  // =========================================================================

  describe('GET /api/media — new filters', () => {
    it('cameraMake filter: where includes cameraMake: { contains, mode: insensitive }', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');

      context.prismaMock.mediaItem.findMany.mockResolvedValue([]);
      context.prismaMock.mediaItem.count.mockResolvedValue(0);

      await request(context.app.getHttpServer())
        .get(`/api/media?circleId=${CIRCLE_ID}&cameraMake=Canon`)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      const [findManyCall] = (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls;
      expect(findManyCall[0].where).toMatchObject({
        cameraMake: { contains: 'Canon', mode: 'insensitive' },
      });
    });

    it('missingGeo=true filter: where includes { takenLat: null, takenLng: null }', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');

      context.prismaMock.mediaItem.findMany.mockResolvedValue([]);
      context.prismaMock.mediaItem.count.mockResolvedValue(0);

      await request(context.app.getHttpServer())
        .get(`/api/media?circleId=${CIRCLE_ID}&missingGeo=true`)
        .set(authHeader(contributor.accessToken))
        .expect(200);

      const [findManyCall] = (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls;
      expect(findManyCall[0].where).toMatchObject({
        takenLat: null,
        takenLng: null,
      });
    });
  });
});
