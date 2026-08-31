/**
 * Route-dispatch + RBAC + request-validation tests for MediaEnhancementController.
 *
 * Mirrors workflows-admin.controller.spec.ts: a genuine HTTP round-trip
 * (supertest) against NestJS's REAL compiled route table, with the REAL
 * RolesGuard/PermissionsGuard (backed by the real Reflector reading the
 * `@Auth()` metadata declared on each handler) and the REAL global
 * `ZodValidationPipe` (nestjs-zod) wired in via APP_PIPE — this is what lets
 * this file assert genuine 400s for a malformed body, not just decorator
 * presence. Only JwtAuthGuard is stubbed, stamping a fake
 * AuthenticatedUser-shaped `request.user` the same way the real JWT strategy
 * does. MediaEnhancementService itself is mocked — no database required.
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { APP_PIPE } from '@nestjs/core';
import { ExecutionContext, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { MediaEnhancementController } from './media-enhancement.controller';
import { MediaEnhancementService } from './media-enhancement.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

const MEDIA_ID = randomUUID();
const ENH_ID = randomUUID();
const CIRCLE_ID = randomUUID();

/** Builds a minimal AuthenticatedUser-shaped fixture with the given roles/permissions. */
function fakeAuthenticatedUser(
  roleNames: string[],
  permissionNames: string[],
): Partial<AuthenticatedUser> {
  return {
    id: 'user-1',
    email: 'user-1@example.com',
    isActive: true,
    userRoles: roleNames.map((name) => ({
      role: {
        id: `role-${name}`,
        name,
        description: `${name} role`,
        rolePermissions: permissionNames.map((p) => ({
          permission: { id: `perm-${p}`, name: p, description: p },
        })),
      } as any,
    })),
  };
}

/** JwtAuthGuard stub: always "authenticates", stamping the given user onto the request. */
function stubJwtAuthGuard(user: Partial<AuthenticatedUser>) {
  return {
    canActivate: (ctx: ExecutionContext) => {
      const req = ctx.switchToHttp().getRequest();
      req.user = user;
      return true;
    },
  };
}

function makeMockService() {
  return {
    startEnhance: jest.fn().mockResolvedValue({
      data: { enhancementId: ENH_ID, jobId: 'job-1', status: 'pending' },
    }),
    startBatch: jest.fn().mockResolvedValue({
      data: { batchId: 'batch-1', requested: 1, queued: 1, skipped: { notPhoto: 0, tooLarge: 0, alreadyLive: 0 } },
    }),
    startBatchByFilter: jest.fn().mockResolvedValue({
      data: { batchId: 'batch-1', requested: 1, queued: 1, skipped: { notPhoto: 0, tooLarge: 0, alreadyLive: 0 } },
    }),
    getLatestEnhancement: jest.fn().mockResolvedValue({ data: null }),
    getEnhancement: jest.fn().mockResolvedValue({
      data: { id: ENH_ID, status: 'ready' },
    }),
    applyEnhancement: jest.fn().mockResolvedValue({
      data: { id: 'new-media-1', status: 'applied', decision: 'keep_both' },
    }),
    discardEnhancement: jest.fn().mockResolvedValue(undefined),
    listEnhancements: jest.fn().mockResolvedValue({
      items: [],
      meta: { page: 1, pageSize: 24, totalItems: 0, totalPages: 0 },
    }),
  };
}

describe('MediaEnhancementController — route dispatch + RBAC + validation (supertest)', () => {
  let app: NestFastifyApplication;
  let mockService: ReturnType<typeof makeMockService>;

  /** Rebuilds the app with the given caller identity, real RolesGuard/PermissionsGuard/ZodValidationPipe. */
  async function buildApp(user: Partial<AuthenticatedUser>): Promise<NestFastifyApplication> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [MediaEnhancementController],
      providers: [
        { provide: MediaEnhancementService, useValue: mockService },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(stubJwtAuthGuard(user))
      .compile();
    // NOTE: RolesGuard and PermissionsGuard are intentionally NOT overridden —
    // they run for real, resolving @Auth() metadata via the real Reflector.

    const nestApp = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await nestApp.init();
    await nestApp.getHttpAdapter().getInstance().ready();
    return nestApp;
  }

  const WRITER = fakeAuthenticatedUser(['contributor'], ['media:read', 'media:write']);
  // Holds media:read but NOT media:write — used both to exercise the
  // read-only endpoints and to prove write endpoints are gated independently
  // of read access.
  const READER = fakeAuthenticatedUser(['viewer'], ['media:read']);

  beforeEach(() => {
    mockService = makeMockService();
  });

  afterEach(async () => {
    if (app) await app.close();
    jest.clearAllMocks();
  });

  // ===========================================================================
  // GET /media/enhancements — cross-item listing hub (issue #201)
  // ===========================================================================

  describe('GET /media/enhancements', () => {
    it('200s for a caller with media:read and delegates to listEnhancements()', async () => {
      app = await buildApp(READER);

      const res = await request(app.getHttpServer())
        .get('/media/enhancements')
        .query({ circleId: CIRCLE_ID })
        .expect(200);

      expect(mockService.listEnhancements).toHaveBeenCalledTimes(1);
      expect(mockService.listEnhancements.mock.calls[0][0]).toMatchObject({ circleId: CIRCLE_ID });
      expect(res.body).toEqual({
        items: [],
        meta: { page: 1, pageSize: 24, totalItems: 0, totalPages: 0 },
      });
    });

    it('403s for a caller missing media:read', async () => {
      const NO_PERMS = fakeAuthenticatedUser(['viewer'], []);
      app = await buildApp(NO_PERMS);

      await request(app.getHttpServer())
        .get('/media/enhancements')
        .query({ circleId: CIRCLE_ID })
        .expect(403);

      expect(mockService.listEnhancements).not.toHaveBeenCalled();
    });

    it('400s when circleId is missing', async () => {
      app = await buildApp(READER);

      await request(app.getHttpServer()).get('/media/enhancements').expect(400);

      expect(mockService.listEnhancements).not.toHaveBeenCalled();
    });

    it('400s when circleId is not a valid UUID', async () => {
      app = await buildApp(READER);

      await request(app.getHttpServer())
        .get('/media/enhancements')
        .query({ circleId: 'not-a-uuid' })
        .expect(400);

      expect(mockService.listEnhancements).not.toHaveBeenCalled();
    });

    it('400s when pageSize exceeds the max of 50', async () => {
      app = await buildApp(READER);

      await request(app.getHttpServer())
        .get('/media/enhancements')
        .query({ circleId: CIRCLE_ID, pageSize: 51 })
        .expect(400);

      expect(mockService.listEnhancements).not.toHaveBeenCalled();
    });

    it('400s for an unknown status value (not a concrete status or an alias)', async () => {
      app = await buildApp(READER);

      await request(app.getHttpServer())
        .get('/media/enhancements')
        .query({ circleId: CIRCLE_ID, status: 'not_a_real_status' })
        .expect(400);

      expect(mockService.listEnhancements).not.toHaveBeenCalled();
    });

    it('applies defaults (page=1, pageSize=24, sortBy=createdAt, sortOrder=desc) when only circleId is provided', async () => {
      app = await buildApp(READER);

      await request(app.getHttpServer())
        .get('/media/enhancements')
        .query({ circleId: CIRCLE_ID })
        .expect(200);

      expect(mockService.listEnhancements.mock.calls[0][0]).toEqual({
        circleId: CIRCLE_ID,
        page: 1,
        pageSize: 24,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });
    });
  });

  // ===========================================================================
  // POST /media/:id/enhance — start
  // ===========================================================================

  describe('POST /media/:id/enhance', () => {
    it('202s for a caller with media:write and delegates to startEnhance()', async () => {
      app = await buildApp(WRITER);

      const res = await request(app.getHttpServer())
        .post(`/media/${MEDIA_ID}/enhance`)
        .send({})
        .expect(202);

      expect(mockService.startEnhance).toHaveBeenCalledTimes(1);
      expect(mockService.startEnhance.mock.calls[0][0]).toBe(MEDIA_ID);
      expect(res.body).toMatchObject({ data: { status: 'pending' } });
    });

    it('403s for a caller missing media:write', async () => {
      app = await buildApp(READER);

      await request(app.getHttpServer()).post(`/media/${MEDIA_ID}/enhance`).send({}).expect(403);
      expect(mockService.startEnhance).not.toHaveBeenCalled();
    });

    it('accepts a fully-specified valid body (intent, preset, adjustments, strength, quality, preserveFaces, instructions, model)', async () => {
      app = await buildApp(WRITER);

      await request(app.getHttpServer())
        .post(`/media/${MEDIA_ID}/enhance`)
        .send({
          intent: 'custom',
          preset: 'restore_old_photo',
          adjustments: { color: true, dehaze: true },
          strength: 'strong',
          quality: 'medium',
          preserveFaces: false,
          instructions: 'brighten the sky',
          model: 'gpt-image-1',
        })
        .expect(202);

      expect(mockService.startEnhance).toHaveBeenCalledTimes(1);
      const [, dto] = mockService.startEnhance.mock.calls[0];
      expect(dto).toMatchObject({ preset: 'restore_old_photo', quality: 'medium' });
    });

    it('400s on an unknown preset value', async () => {
      app = await buildApp(WRITER);

      await request(app.getHttpServer())
        .post(`/media/${MEDIA_ID}/enhance`)
        .send({ preset: 'not_a_real_preset' })
        .expect(400);

      expect(mockService.startEnhance).not.toHaveBeenCalled();
    });

    it('400s on an unknown quality value', async () => {
      app = await buildApp(WRITER);

      await request(app.getHttpServer())
        .post(`/media/${MEDIA_ID}/enhance`)
        .send({ quality: 'ultra' })
        .expect(400);

      expect(mockService.startEnhance).not.toHaveBeenCalled();
    });

    it('400s on an unknown intent value', async () => {
      app = await buildApp(WRITER);

      await request(app.getHttpServer())
        .post(`/media/${MEDIA_ID}/enhance`)
        .send({ intent: 'bogus' })
        .expect(400);

      expect(mockService.startEnhance).not.toHaveBeenCalled();
    });

    it('400s on an unknown strength value', async () => {
      app = await buildApp(WRITER);

      await request(app.getHttpServer())
        .post(`/media/${MEDIA_ID}/enhance`)
        .send({ strength: 'extreme' })
        .expect(400);

      expect(mockService.startEnhance).not.toHaveBeenCalled();
    });

    it('400s when the media id path param is not a UUID', async () => {
      app = await buildApp(WRITER);

      await request(app.getHttpServer()).post('/media/not-a-uuid/enhance').send({}).expect(400);

      expect(mockService.startEnhance).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // POST /media/bulk/enhance — route-collision regression (issue #421)
  //
  // MediaEnhancementController declares `bulk/enhance` in its static-routes
  // block, BEFORE the parameterised `:id/enhance` route below it — the same
  // convention (and the same reason) as `GET /media/enhancements` above it.
  // Without that ordering, a POST to /media/bulk/enhance is the exact same
  // shape (<segment>/enhance) as POST /media/:id/enhance, so 'bulk' would be
  // silently parsed as the :id param and routed to startEnhance() instead of
  // startBatch().
  // ===========================================================================

  describe('POST /media/bulk/enhance — route-collision regression', () => {
    it('202s and dispatches to startBatch() — "bulk" is never parsed as the :id param of POST :id/enhance', async () => {
      app = await buildApp(WRITER);

      const res = await request(app.getHttpServer())
        .post('/media/bulk/enhance')
        .send({ circleId: CIRCLE_ID, ids: [MEDIA_ID] })
        .expect(202);

      expect(mockService.startBatch).toHaveBeenCalledTimes(1);
      expect(mockService.startBatch.mock.calls[0][0]).toMatchObject({
        circleId: CIRCLE_ID,
        ids: [MEDIA_ID],
      });
      // The strongest proof of no collision: the :id/enhance handler
      // (startEnhance, which would have been called with id:'bulk' had the
      // param route won) was never invoked at all.
      expect(mockService.startEnhance).not.toHaveBeenCalled();
      expect(res.body).toMatchObject({ data: { batchId: 'batch-1' } });
    });

    it('403s for a caller missing media:write, and never reaches startEnhance either', async () => {
      app = await buildApp(READER);

      await request(app.getHttpServer())
        .post('/media/bulk/enhance')
        .send({ circleId: CIRCLE_ID, ids: [MEDIA_ID] })
        .expect(403);

      expect(mockService.startBatch).not.toHaveBeenCalled();
      expect(mockService.startEnhance).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // Decorator-metadata-level check (mirrors media.controller.spec.ts's
    // "route ordering — review-counts precedes @Get(:id)" pattern): reads the
    // REAL compiled declaration order off the controller prototype, which is
    // what NestJS's RouterExplorer walks to register routes. A future edit
    // that moves `bulk/enhance` below `:id/enhance` in the source would flip
    // this ordering and fail here even before a live-dispatch test could catch it.
    // -------------------------------------------------------------------------

    it('declares POST bulk/enhance at a lower prototype index than POST :id/enhance', () => {
      const prototype = MediaEnhancementController.prototype;
      const routes = Object.getOwnPropertyNames(prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => ({
          name,
          path: Reflect.getMetadata(PATH_METADATA, (prototype as any)[name]),
          method: Reflect.getMetadata(METHOD_METADATA, (prototype as any)[name]),
        }))
        .filter((entry) => entry.path !== undefined);

      const bulkIdx = routes.findIndex(
        (r) => r.path === 'bulk/enhance' && r.method === RequestMethod.POST,
      );
      const paramIdx = routes.findIndex(
        (r) => r.path === ':id/enhance' && r.method === RequestMethod.POST,
      );

      expect(bulkIdx).toBeGreaterThanOrEqual(0);
      expect(paramIdx).toBeGreaterThanOrEqual(0);
      expect(bulkIdx).toBeLessThan(paramIdx);
    });
  });

  // ===========================================================================
  // POST /media/bulk/enhance/by-filter — route-collision regression (issue #424)
  //
  // Same static-routes-block rule as `bulk/enhance` above: this controller
  // shares the `media` prefix with MediaController, so any literal-prefixed
  // route declared after a parameterised one risks having `bulk` captured as
  // the :id param. It must also not be shadowed by its own shorter sibling
  // `bulk/enhance`, which would route a by-filter body to startBatch() — where
  // the missing `ids` array would surface as a confusing 400 rather than the
  // batch the caller asked for.
  // ===========================================================================

  describe('POST /media/bulk/enhance/by-filter — route-collision regression', () => {
    it('202s and dispatches to startBatchByFilter() — never to startBatch() or startEnhance()', async () => {
      app = await buildApp(WRITER);

      const res = await request(app.getHttpServer())
        .post('/media/bulk/enhance/by-filter')
        .send({ circleId: CIRCLE_ID, tag: 'birthday' })
        .expect(202);

      expect(mockService.startBatchByFilter).toHaveBeenCalledTimes(1);
      expect(mockService.startBatchByFilter.mock.calls[0][0]).toMatchObject({
        circleId: CIRCLE_ID,
        tag: 'birthday',
      });
      // Neither neighbouring route won: not the shorter static sibling, and not
      // the parameterised :id/enhance route.
      expect(mockService.startBatch).not.toHaveBeenCalled();
      expect(mockService.startEnhance).not.toHaveBeenCalled();
      expect(res.body).toMatchObject({ data: { batchId: 'batch-1' } });
    });

    it('403s for a caller missing media:write, and reaches no other handler either', async () => {
      app = await buildApp(READER);

      await request(app.getHttpServer())
        .post('/media/bulk/enhance/by-filter')
        .send({ circleId: CIRCLE_ID })
        .expect(403);

      expect(mockService.startBatchByFilter).not.toHaveBeenCalled();
      expect(mockService.startBatch).not.toHaveBeenCalled();
      expect(mockService.startEnhance).not.toHaveBeenCalled();
    });

    it('400s on a body with no circleId (the one required filter field)', async () => {
      app = await buildApp(WRITER);

      await request(app.getHttpServer())
        .post('/media/bulk/enhance/by-filter')
        .send({ tag: 'birthday' })
        .expect(400);

      expect(mockService.startBatchByFilter).not.toHaveBeenCalled();
    });

    it('declares POST bulk/enhance/by-filter at a lower prototype index than POST :id/enhance', () => {
      const prototype = MediaEnhancementController.prototype;
      const routes = Object.getOwnPropertyNames(prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => ({
          name,
          path: Reflect.getMetadata(PATH_METADATA, (prototype as any)[name]),
          method: Reflect.getMetadata(METHOD_METADATA, (prototype as any)[name]),
        }))
        .filter((entry) => entry.path !== undefined);

      const byFilterIdx = routes.findIndex(
        (r) => r.path === 'bulk/enhance/by-filter' && r.method === RequestMethod.POST,
      );
      const paramIdx = routes.findIndex(
        (r) => r.path === ':id/enhance' && r.method === RequestMethod.POST,
      );

      expect(byFilterIdx).toBeGreaterThanOrEqual(0);
      expect(paramIdx).toBeGreaterThanOrEqual(0);
      expect(byFilterIdx).toBeLessThan(paramIdx);
    });
  });

  // ===========================================================================
  // GET /media/:id/enhance — latest
  // ===========================================================================

  describe('GET /media/:id/enhance', () => {
    it('200s for a caller with media:read and delegates to getLatestEnhancement()', async () => {
      app = await buildApp(READER);

      const res = await request(app.getHttpServer()).get(`/media/${MEDIA_ID}/enhance`).expect(200);

      expect(mockService.getLatestEnhancement).toHaveBeenCalledWith(MEDIA_ID, expect.anything());
      expect(res.body).toEqual({ data: null });
    });

    it('403s for a caller missing media:read', async () => {
      const NO_PERMS = fakeAuthenticatedUser(['viewer'], []);
      app = await buildApp(NO_PERMS);

      await request(app.getHttpServer()).get(`/media/${MEDIA_ID}/enhance`).expect(403);
      expect(mockService.getLatestEnhancement).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // GET /media/:id/enhance/:enhancementId — poll
  // ===========================================================================

  describe('GET /media/:id/enhance/:enhancementId', () => {
    it('200s and delegates to getEnhancement()', async () => {
      app = await buildApp(READER);

      const res = await request(app.getHttpServer())
        .get(`/media/${MEDIA_ID}/enhance/${ENH_ID}`)
        .expect(200);

      expect(mockService.getEnhancement).toHaveBeenCalledWith(MEDIA_ID, ENH_ID, expect.anything());
      expect(res.body).toMatchObject({ data: { status: 'ready' } });
    });

    it('400s when the enhancementId path param is not a UUID', async () => {
      app = await buildApp(READER);

      await request(app.getHttpServer()).get(`/media/${MEDIA_ID}/enhance/not-a-uuid`).expect(400);

      expect(mockService.getEnhancement).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // POST /media/:id/enhance/:enhancementId/apply
  // ===========================================================================

  describe('POST /media/:id/enhance/:enhancementId/apply', () => {
    it('201s for decision:keep_both and delegates to applyEnhancement()', async () => {
      app = await buildApp(WRITER);

      const res = await request(app.getHttpServer())
        .post(`/media/${MEDIA_ID}/enhance/${ENH_ID}/apply`)
        .send({ decision: 'keep_both' })
        .expect(201);

      expect(mockService.applyEnhancement).toHaveBeenCalledWith(
        MEDIA_ID,
        ENH_ID,
        'keep_both',
        expect.anything(),
        { acknowledgeDownscale: false },
      );
      expect(res.body).toMatchObject({ data: { decision: 'keep_both' } });
    });

    it('200s for decision:replace', async () => {
      mockService.applyEnhancement.mockResolvedValueOnce({
        data: { status: 'ready', width: 1536, height: 1024 },
      });
      app = await buildApp(WRITER);

      await request(app.getHttpServer())
        .post(`/media/${MEDIA_ID}/enhance/${ENH_ID}/apply`)
        .send({ decision: 'replace' })
        .expect(200);
    });

    // Issue #426: the downscale guard is a confirm-through speed bump, so the
    // client's explicit acknowledgement has to reach the service.
    it('forwards acknowledgeDownscale:true to the service', async () => {
      mockService.applyEnhancement.mockResolvedValueOnce({
        data: { status: 'ready', width: 1536, height: 1024 },
      });
      app = await buildApp(WRITER);

      await request(app.getHttpServer())
        .post(`/media/${MEDIA_ID}/enhance/${ENH_ID}/apply`)
        .send({ decision: 'replace', acknowledgeDownscale: true })
        .expect(200);

      expect(mockService.applyEnhancement).toHaveBeenCalledWith(
        MEDIA_ID,
        ENH_ID,
        'replace',
        expect.anything(),
        { acknowledgeDownscale: true },
      );
    });

    it('defaults acknowledgeDownscale to false when the body omits it', async () => {
      mockService.applyEnhancement.mockResolvedValueOnce({
        data: { status: 'ready', width: 1536, height: 1024 },
      });
      app = await buildApp(WRITER);

      await request(app.getHttpServer())
        .post(`/media/${MEDIA_ID}/enhance/${ENH_ID}/apply`)
        .send({ decision: 'replace' })
        .expect(200);

      expect(mockService.applyEnhancement).toHaveBeenCalledWith(
        MEDIA_ID,
        ENH_ID,
        'replace',
        expect.anything(),
        { acknowledgeDownscale: false },
      );
    });

    it('400s on a non-boolean acknowledgeDownscale', async () => {
      app = await buildApp(WRITER);

      await request(app.getHttpServer())
        .post(`/media/${MEDIA_ID}/enhance/${ENH_ID}/apply`)
        .send({ decision: 'replace', acknowledgeDownscale: 'yes' })
        .expect(400);

      expect(mockService.applyEnhancement).not.toHaveBeenCalled();
    });

    it('403s for a caller missing media:write', async () => {
      app = await buildApp(READER);

      await request(app.getHttpServer())
        .post(`/media/${MEDIA_ID}/enhance/${ENH_ID}/apply`)
        .send({ decision: 'keep_both' })
        .expect(403);

      expect(mockService.applyEnhancement).not.toHaveBeenCalled();
    });

    it('400s on an unknown decision value', async () => {
      app = await buildApp(WRITER);

      await request(app.getHttpServer())
        .post(`/media/${MEDIA_ID}/enhance/${ENH_ID}/apply`)
        .send({ decision: 'discard_and_burn' })
        .expect(400);

      expect(mockService.applyEnhancement).not.toHaveBeenCalled();
    });

    it('400s when decision is missing entirely', async () => {
      app = await buildApp(WRITER);

      await request(app.getHttpServer())
        .post(`/media/${MEDIA_ID}/enhance/${ENH_ID}/apply`)
        .send({})
        .expect(400);

      expect(mockService.applyEnhancement).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // POST /media/:id/enhance/:enhancementId/discard
  // ===========================================================================

  describe('POST /media/:id/enhance/:enhancementId/discard', () => {
    it('204s and delegates to discardEnhancement()', async () => {
      app = await buildApp(WRITER);

      await request(app.getHttpServer())
        .post(`/media/${MEDIA_ID}/enhance/${ENH_ID}/discard`)
        .expect(204);

      expect(mockService.discardEnhancement).toHaveBeenCalledWith(MEDIA_ID, ENH_ID, expect.anything());
    });

    it('403s for a caller missing media:write', async () => {
      app = await buildApp(READER);

      await request(app.getHttpServer()).post(`/media/${MEDIA_ID}/enhance/${ENH_ID}/discard`).expect(403);

      expect(mockService.discardEnhancement).not.toHaveBeenCalled();
    });
  });
});
