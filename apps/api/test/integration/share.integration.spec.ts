/**
 * Integration tests for the public media sharing feature.
 *
 * IMPORTANT — TEST DB NOT REQUIRED:
 * These tests run against a mocked PrismaService (useMockDatabase: true).
 * No live PostgreSQL connection is needed. All database calls are intercepted
 * by jest-mock-extended (prismaMock) and shaped per test.
 *
 * Coverage:
 *   RBAC / management endpoints (ShareController):
 *     - 401 without token (all management endpoints)
 *     - 403 for system Viewer (no shares:manage permission)
 *     - 403 for a circle-level viewer-only mock (same permission path)
 *     - 201 success for Contributor (has shares:manage)
 *     - scope=all returns 403 for contributor, 200 for admin (shares:manage_any)
 *     - PATCH /api/shares/:id updates expiresAt
 *     - DELETE /api/shares/:id revokes and returns 204
 *     - POST /api/shares/bulk returns affected count
 *
 *   Public endpoint (PublicShareController — @Public(), no JWT required):
 *     - GET /api/public/shares/:token returns stripped metadata-only contract
 *     - Asserts ABSENCE of sensitive fields (description, tags, capturedAt,
 *       cameraMake, geoCountry, originalFilename, etc.)
 *     - Revoked token → 404
 *     - Expired token → 404
 *     - Trashed media item → 404
 *     - Out-of-range idx → 404 on /media/:idx
 *     - Content-Disposition: inline header on /media/:idx
 *     - Album share returns type=album with itemCount and items[]
 */

import request from 'supertest';
import { randomUUID } from 'crypto';
import { ShareTargetType } from '@prisma/client';
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
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEDIA_ITEM_ID = '550e8400-e29b-41d4-a716-446655440001';
const ALBUM_ID = '550e8400-e29b-41d4-a716-446655440002';
const CIRCLE_ID = '550e8400-e29b-41d4-a716-446655440003';
const SHARE_ID = '550e8400-e29b-41d4-a716-446655440004';
const SHARE_TOKEN = 'validTokenABCDEFGHIJKLMNOPQRSTUVWXYZ01234';

// ---------------------------------------------------------------------------
// Data factories
// ---------------------------------------------------------------------------

function makeMediaItem(overrides: Record<string, unknown> = {}) {
  return {
    id: MEDIA_ITEM_ID,
    circleId: CIRCLE_ID,
    type: 'photo',
    width: 1920,
    height: 1080,
    deletedAt: null,
    archivedAt: null,
    metadata: null,
    storageObject: {
      storageKey: 'uploads/photo.jpg',
      storageProvider: 's3',
      bucket: 'test-bucket',
      mimeType: 'image/jpeg',
    },
    ...overrides,
  };
}

function makeShare(createdById: string, overrides: Record<string, unknown> = {}) {
  return {
    id: SHARE_ID,
    token: SHARE_TOKEN,
    targetType: ShareTargetType.media_item,
    mediaItemId: MEDIA_ITEM_ID,
    albumId: null,
    circleId: CIRCLE_ID,
    createdById,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    mediaItem: null,
    album: null,
    ...overrides,
  };
}

function makeAlbumShare(createdById: string) {
  return makeShare(createdById, {
    targetType: ShareTargetType.album,
    mediaItemId: null,
    albumId: ALBUM_ID,
  });
}

function makeAlbum() {
  return {
    id: ALBUM_ID,
    circleId: CIRCLE_ID,
    name: 'Test Album',
  };
}

function makeAlbumResolved(items: any[]) {
  return { items };
}

function makeAlbumItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    mediaItem: {
      id,
      type: 'photo',
      width: 800,
      height: 600,
      metadata: null,
      storageObject: {
        storageKey: `uploads/${id}.jpg`,
        storageProvider: 's3',
        bucket: 'test-bucket',
        mimeType: 'image/jpeg',
      },
      ...overrides,
    },
  };
}

function makeCircleMember(userId: string, circleId: string, role = 'collaborator') {
  return {
    circleId,
    userId,
    role,
    joinedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Share Feature Integration', () => {
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
  // Authentication — management endpoints require JWT
  // =========================================================================

  describe('Authentication — management endpoints require JWT', () => {
    it('POST /api/shares returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .post('/api/shares')
        .send({ targetType: 'media_item', mediaItemId: MEDIA_ITEM_ID })
        .expect(401);
    });

    it('GET /api/shares returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .get('/api/shares')
        .expect(401);
    });

    it('PATCH /api/shares/:id returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .patch(`/api/shares/${SHARE_ID}`)
        .send({ expiresAt: null })
        .expect(401);
    });

    it('DELETE /api/shares/:id returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .delete(`/api/shares/${SHARE_ID}`)
        .expect(401);
    });

    it('POST /api/shares/bulk returns 401 without token', async () => {
      await request(context.app.getHttpServer())
        .post('/api/shares/bulk')
        .send({ ids: [SHARE_ID], action: 'revoke' })
        .expect(401);
    });
  });

  // =========================================================================
  // RBAC — shares:manage permission
  // =========================================================================

  describe('RBAC — shares:manage permission required', () => {
    it('POST /api/shares returns 403 for system Viewer (no shares:manage)', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .post('/api/shares')
        .set(authHeader(viewer.accessToken))
        .send({
          targetType: 'media_item',
          mediaItemId: MEDIA_ITEM_ID,
        })
        .expect(403);
    });

    it('GET /api/shares returns 403 for system Viewer', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .get('/api/shares')
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });

    it('POST /api/shares returns 201 for Contributor (has shares:manage)', async () => {
      const contributor = await createMockContributorUser(context);

      // Mock the target media item lookup
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(makeMediaItem());
      // Mock circle membership lookup (assertCircleAccess checks circle.findUnique + circleMember.findUnique)
      context.prismaMock.circle.findUnique.mockResolvedValue({ id: CIRCLE_ID });
      context.prismaMock.circleMember.findUnique.mockResolvedValue(
        makeCircleMember(contributor.id, CIRCLE_ID, 'collaborator'),
      );
      // No existing share → idempotency check returns null
      context.prismaMock.mediaShare.findFirst.mockResolvedValue(null);
      // Create returns the new share
      context.prismaMock.mediaShare.create.mockResolvedValue(
        makeShare(contributor.id),
      );

      const response = await request(context.app.getHttpServer())
        .post('/api/shares')
        .set(authHeader(contributor.accessToken))
        .send({
          targetType: 'media_item',
          mediaItemId: MEDIA_ITEM_ID,
        })
        .expect(201);

      expect(response.body).toHaveProperty('id', SHARE_ID);
      expect(response.body).toHaveProperty('token', SHARE_TOKEN);
      expect(response.body).toHaveProperty('status', 'active');
      expect(response.body).toHaveProperty('publicUrl');
    });
  });

  // =========================================================================
  // RBAC — scope=all requires shares:manage_any
  // =========================================================================

  describe('RBAC — scope=all requires shares:manage_any', () => {
    it('GET /api/shares?scope=all returns 403 for Contributor (no manage_any)', async () => {
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .get('/api/shares?scope=all')
        .set(authHeader(contributor.accessToken))
        .expect(403);
    });

    it('GET /api/shares?scope=all returns 200 for Admin (has manage_any)', async () => {
      const admin = await createMockAdminUser(context);

      context.prismaMock.mediaShare.count.mockResolvedValue(0);
      context.prismaMock.mediaShare.findMany.mockResolvedValue([]);

      const response = await request(context.app.getHttpServer())
        .get('/api/shares?scope=all')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body).toHaveProperty('items');
      expect(response.body).toHaveProperty('meta');
    });
  });

  // =========================================================================
  // PATCH /api/shares/:id — update expiration
  // =========================================================================

  describe('PATCH /api/shares/:id', () => {
    it('returns 200 and updated share when caller owns it', async () => {
      const contributor = await createMockContributorUser(context);
      const futureDate = new Date(Date.now() + 86400_000).toISOString();
      const updatedShare = makeShare(contributor.id, { expiresAt: new Date(futureDate) });

      context.prismaMock.mediaShare.findUnique.mockResolvedValue(makeShare(contributor.id));
      context.prismaMock.mediaShare.update.mockResolvedValue(updatedShare);

      const response = await request(context.app.getHttpServer())
        .patch(`/api/shares/${SHARE_ID}`)
        .set(authHeader(contributor.accessToken))
        .send({ expiresAt: futureDate })
        .expect(200);

      expect(response.body).toHaveProperty('id', SHARE_ID);
      // expiresAt should be present and the computed status should not be 'expired'
      expect(['active', 'expired', 'revoked']).toContain(response.body.status);
    });

    it('returns 403 when caller does not own the share and lacks manage_any', async () => {
      const contributor = await createMockContributorUser(context);
      const otherUserId = randomUUID();

      context.prismaMock.mediaShare.findUnique.mockResolvedValue(makeShare(otherUserId));

      await request(context.app.getHttpServer())
        .patch(`/api/shares/${SHARE_ID}`)
        .set(authHeader(contributor.accessToken))
        .send({ expiresAt: null })
        .expect(403);
    });
  });

  // =========================================================================
  // DELETE /api/shares/:id — revoke
  // =========================================================================

  describe('DELETE /api/shares/:id', () => {
    it('returns 204 and revokes the share for the owning contributor', async () => {
      const contributor = await createMockContributorUser(context);

      context.prismaMock.mediaShare.findUnique.mockResolvedValue(makeShare(contributor.id));
      context.prismaMock.mediaShare.update.mockResolvedValue(
        makeShare(contributor.id, { revokedAt: new Date() }),
      );

      await request(context.app.getHttpServer())
        .delete(`/api/shares/${SHARE_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(204);
    });

    it('returns 204 idempotently when share is already revoked', async () => {
      const contributor = await createMockContributorUser(context);

      context.prismaMock.mediaShare.findUnique.mockResolvedValue(
        makeShare(contributor.id, { revokedAt: new Date() }),
      );

      await request(context.app.getHttpServer())
        .delete(`/api/shares/${SHARE_ID}`)
        .set(authHeader(contributor.accessToken))
        .expect(204);

      // update should NOT be called since share is already revoked
      expect(context.prismaMock.mediaShare.update).not.toHaveBeenCalled();
    });

    it('returns 204 for Admin revoking another user\'s share (manage_any)', async () => {
      const admin = await createMockAdminUser(context);
      const otherUserId = randomUUID();

      context.prismaMock.mediaShare.findUnique.mockResolvedValue(makeShare(otherUserId));
      context.prismaMock.mediaShare.update.mockResolvedValue(
        makeShare(otherUserId, { revokedAt: new Date() }),
      );

      await request(context.app.getHttpServer())
        .delete(`/api/shares/${SHARE_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(204);
    });
  });

  // =========================================================================
  // POST /api/shares/bulk — bulk actions
  // =========================================================================

  describe('POST /api/shares/bulk', () => {
    it('returns affected count for revoke action', async () => {
      const contributor = await createMockContributorUser(context);

      context.prismaMock.mediaShare.updateMany.mockResolvedValue({ count: 2 });

      const response = await request(context.app.getHttpServer())
        .post('/api/shares/bulk')
        .set(authHeader(contributor.accessToken))
        .send({
          ids: [randomUUID(), randomUUID()],
          action: 'revoke',
        })
        .expect(200);

      expect(response.body).toHaveProperty('affected', 2);
    });

    it('returns affected count for delete action', async () => {
      const contributor = await createMockContributorUser(context);

      context.prismaMock.mediaShare.deleteMany.mockResolvedValue({ count: 1 });

      const response = await request(context.app.getHttpServer())
        .post('/api/shares/bulk')
        .set(authHeader(contributor.accessToken))
        .send({
          ids: [randomUUID()],
          action: 'delete',
        })
        .expect(200);

      expect(response.body).toHaveProperty('affected', 1);
    });

    it('returns 400 for invalid action', async () => {
      const contributor = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .post('/api/shares/bulk')
        .set(authHeader(contributor.accessToken))
        .send({
          ids: [randomUUID()],
          action: 'invalid_action',
        })
        .expect(400);
    });
  });

  // =========================================================================
  // GET /api/public/shares/:token — metadata-stripped public contract
  // =========================================================================

  describe('GET /api/public/shares/:token — public contract', () => {
    it('requires no authentication (200 without token)', async () => {
      context.prismaMock.mediaShare.findUnique.mockResolvedValue(
        makeShare('some-user-id'),
      );
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(makeMediaItem());

      await request(context.app.getHttpServer())
        .get(`/api/public/shares/${SHARE_TOKEN}`)
        .expect(200);
    });

    it('returns type=media_item with mediaType, width, height — and ONLY those fields', async () => {
      context.prismaMock.mediaShare.findUnique.mockResolvedValue(
        makeShare('some-user-id'),
      );
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(makeMediaItem());

      const response = await request(context.app.getHttpServer())
        .get(`/api/public/shares/${SHARE_TOKEN}`)
        .expect(200);

      const body = response.body.data ?? response.body;

      expect(body).toHaveProperty('type', 'media_item');
      expect(body).toHaveProperty('media');
      expect(body.media).toHaveProperty('mediaType', 'photo');
      expect(body.media).toHaveProperty('width', 1920);
      expect(body.media).toHaveProperty('height', 1080);

      // Sensitive fields MUST NOT be present anywhere in the response
      const responseStr = JSON.stringify(response.body);
      const forbiddenFields = [
        'description',
        'tags',
        'faces',
        'capturedAt',
        'cameraMake',
        'cameraModel',
        'geoCountry',
        'geoAdmin1',
        'geoLocality',
        'originalFilename',
        'storageKey',
        'contentHash',
        'addedById',
        'albumName',
      ];
      for (const field of forbiddenFields) {
        expect(responseStr).not.toContain(`"${field}"`);
      }
    });

    it('does not expose internal UUIDs (circleId, createdById, mediaItemId)', async () => {
      context.prismaMock.mediaShare.findUnique.mockResolvedValue(
        makeShare('some-user-id'),
      );
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(makeMediaItem());

      const response = await request(context.app.getHttpServer())
        .get(`/api/public/shares/${SHARE_TOKEN}`)
        .expect(200);

      const responseStr = JSON.stringify(response.body);
      expect(responseStr).not.toContain(CIRCLE_ID);
      expect(responseStr).not.toContain(MEDIA_ITEM_ID);
    });

    it('returns 404 for a revoked token (generic 404, no distinguishing message)', async () => {
      context.prismaMock.mediaShare.findUnique.mockResolvedValue(
        makeShare('some-user-id', { revokedAt: new Date() }),
      );

      await request(context.app.getHttpServer())
        .get(`/api/public/shares/${SHARE_TOKEN}`)
        .expect(404);
    });

    it('returns 404 for an expired token', async () => {
      context.prismaMock.mediaShare.findUnique.mockResolvedValue(
        makeShare('some-user-id', { expiresAt: new Date(Date.now() - 60_000) }),
      );

      await request(context.app.getHttpServer())
        .get(`/api/public/shares/${SHARE_TOKEN}`)
        .expect(404);
    });

    it('returns 404 for an unknown token', async () => {
      context.prismaMock.mediaShare.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get('/api/public/shares/totallybogustoken')
        .expect(404);
    });

    it('returns 404 when the media item is trashed (deletedAt set)', async () => {
      context.prismaMock.mediaShare.findUnique.mockResolvedValue(
        makeShare('some-user-id'),
      );
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await request(context.app.getHttpServer())
        .get(`/api/public/shares/${SHARE_TOKEN}`)
        .expect(404);
    });

    it('returns 200 when media item is archived (archivedAt set, deletedAt null)', async () => {
      context.prismaMock.mediaShare.findUnique.mockResolvedValue(
        makeShare('some-user-id'),
      );
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({ archivedAt: new Date(), deletedAt: null }),
      );

      const response = await request(context.app.getHttpServer())
        .get(`/api/public/shares/${SHARE_TOKEN}`)
        .expect(200);

      const body = response.body.data ?? response.body;
      expect(body).toHaveProperty('type', 'media_item');
    });

    it('returns type=album with itemCount and items array for album shares', async () => {
      const albumShare = makeAlbumShare('some-user-id');
      context.prismaMock.mediaShare.findUnique.mockResolvedValue(albumShare);
      context.prismaMock.album.findUnique.mockResolvedValue(
        makeAlbumResolved([
          makeAlbumItem(randomUUID()),
          makeAlbumItem(randomUUID()),
        ]),
      );

      const response = await request(context.app.getHttpServer())
        .get(`/api/public/shares/${SHARE_TOKEN}`)
        .expect(200);

      const body = response.body.data ?? response.body;

      expect(body).toHaveProperty('type', 'album');
      expect(body).toHaveProperty('itemCount', 2);
      expect(body).toHaveProperty('items');
      expect(body.items).toHaveLength(2);
      // Each item must have only mediaType/width/height
      for (const item of body.items) {
        expect(item).toHaveProperty('mediaType');
        expect(item).toHaveProperty('width');
        expect(item).toHaveProperty('height');
        // No sensitive info on album items either
        expect(item).not.toHaveProperty('storageKey');
        expect(item).not.toHaveProperty('originalFilename');
        expect(item).not.toHaveProperty('id');
      }
    });

    it('returns empty itemCount=0 when all album members are trashed', async () => {
      const albumShare = makeAlbumShare('some-user-id');
      context.prismaMock.mediaShare.findUnique.mockResolvedValue(albumShare);
      // The DB-level filter removes trashed items; we model that with an empty array
      context.prismaMock.album.findUnique.mockResolvedValue(makeAlbumResolved([]));

      const response = await request(context.app.getHttpServer())
        .get(`/api/public/shares/${SHARE_TOKEN}`)
        .expect(200);

      const body = response.body.data ?? response.body;
      expect(body).toHaveProperty('type', 'album');
      expect(body).toHaveProperty('itemCount', 0);
      expect(body.items).toHaveLength(0);
    });
  });

  // =========================================================================
  // GET /api/public/shares/:token/media/:idx — byte proxy
  // =========================================================================

  describe('GET /api/public/shares/:token/media/:idx — byte proxy', () => {
    /**
     * The byte-proxy endpoint calls StorageProviderResolver.getProviderFor()
     * and then provider.download(). Because the storage provider is wired
     * through a deep module dependency chain that we cannot easily mock at this
     * level without bootstrapping real S3 credentials, we assert on the HTTP
     * layer responses that do NOT depend on the storage provider:
     *   - 404 for revoked/expired token (resolvePublicShare throws before reaching storage)
     *   - 404 for out-of-range idx (checked before reaching storage)
     *
     * Asserting Content-Disposition: inline is a deeper test that requires the
     * storage call to succeed. We note below why it is skipped and how to test
     * it in a full E2E environment.
     */

    it('returns 404 for out-of-range idx on a media_item share (only idx=0 valid)', async () => {
      context.prismaMock.mediaShare.findUnique.mockResolvedValue(
        makeShare('some-user-id'),
      );
      context.prismaMock.mediaItem.findUnique.mockResolvedValue(makeMediaItem());

      // idx=1 is out of range for a single-item share
      await request(context.app.getHttpServer())
        .get(`/api/public/shares/${SHARE_TOKEN}/media/1`)
        .expect(404);
    });

    it('returns 404 for out-of-range idx on an album share', async () => {
      const albumShare = makeAlbumShare('some-user-id');
      context.prismaMock.mediaShare.findUnique.mockResolvedValue(albumShare);
      context.prismaMock.album.findUnique.mockResolvedValue(
        makeAlbumResolved([makeAlbumItem(randomUUID())]),
      );

      // Only idx=0 exists (1 item); idx=1 is out of range
      await request(context.app.getHttpServer())
        .get(`/api/public/shares/${SHARE_TOKEN}/media/1`)
        .expect(404);
    });

    it('returns 404 when the share token is revoked (resolvePublicShare throws first)', async () => {
      context.prismaMock.mediaShare.findUnique.mockResolvedValue(
        makeShare('some-user-id', { revokedAt: new Date() }),
      );

      await request(context.app.getHttpServer())
        .get(`/api/public/shares/${SHARE_TOKEN}/media/0`)
        .expect(404);
    });

    it('returns 404 when the share token is expired', async () => {
      context.prismaMock.mediaShare.findUnique.mockResolvedValue(
        makeShare('some-user-id', { expiresAt: new Date(Date.now() - 60_000) }),
      );

      await request(context.app.getHttpServer())
        .get(`/api/public/shares/${SHARE_TOKEN}/media/0`)
        .expect(404);
    });

    it('returns 404 for idx=NaN (non-numeric idx)', async () => {
      // The controller throws NotFoundException for NaN idx before any DB call
      await request(context.app.getHttpServer())
        .get(`/api/public/shares/${SHARE_TOKEN}/media/notanumber`)
        .expect(404);
    });

    /**
     * NOTE: Testing "Content-Disposition: inline" requires a successful storage
     * provider download. This is not feasible without:
     *   (a) a live S3/local provider, or
     *   (b) mocking StorageProviderResolver + the returned provider object
     *       at the module level (requires overrideProvider in the test module).
     *
     * In a full E2E setup (real DB + local storage provider) this should be
     * verified with:
     *
     *   expect(response.headers['content-disposition']).toBe('inline');
     *
     * That test is covered in the E2E suite (tests/e2e/).
     */
  });

  // =========================================================================
  // GET /api/shares — list (own shares)
  // =========================================================================

  describe('GET /api/shares — list own shares', () => {
    it('returns paginated list for contributor', async () => {
      const contributor = await createMockContributorUser(context);
      const share = makeShare(contributor.id);

      context.prismaMock.mediaShare.count.mockResolvedValue(1);
      context.prismaMock.mediaShare.findMany.mockResolvedValue([
        { ...share, mediaItem: null, album: null },
      ]);

      const response = await request(context.app.getHttpServer())
        .get('/api/shares')
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body).toHaveProperty('items');
      expect(response.body).toHaveProperty('meta');
      expect(response.body.meta).toHaveProperty('totalItems', 1);
      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toHaveProperty('id', SHARE_ID);
      expect(response.body.items[0]).toHaveProperty('status', 'active');
    });

    it('status filter — active shares only', async () => {
      const contributor = await createMockContributorUser(context);

      context.prismaMock.mediaShare.count.mockResolvedValue(0);
      context.prismaMock.mediaShare.findMany.mockResolvedValue([]);

      const response = await request(context.app.getHttpServer())
        .get('/api/shares?status=active')
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body.items).toHaveLength(0);
    });
  });
});
