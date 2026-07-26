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
import { ExecutionContext } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { MediaEnhancementController } from './media-enhancement.controller';
import { MediaEnhancementService } from './media-enhancement.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

const MEDIA_ID = randomUUID();
const ENH_ID = randomUUID();

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
    getLatestEnhancement: jest.fn().mockResolvedValue({ data: null }),
    getEnhancement: jest.fn().mockResolvedValue({
      data: { id: ENH_ID, status: 'ready' },
    }),
    applyEnhancement: jest.fn().mockResolvedValue({
      data: { id: 'new-media-1', status: 'applied', decision: 'keep_both' },
    }),
    discardEnhancement: jest.fn().mockResolvedValue(undefined),
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
