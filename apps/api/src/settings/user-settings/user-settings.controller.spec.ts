/**
 * HTTP round-trip tests for UserSettingsController's `navigation` namespace
 * (issue #392, epic #388).
 *
 * WHY THIS FILE EXISTS, AND WHY A SERVICE-LEVEL TEST CANNOT REPLACE IT.
 * Settings namespaces in this repo are hand-maintained in THREE places:
 * `userSettingsSchema` and its patch twin in
 * `apps/api/src/common/schemas/settings.schema.ts`, and — the trap — the WIRE
 * DTO in `apps/api/src/settings/dto/update-user-settings.dto.ts`. `nestjs-zod`
 * strips keys the body DTO does not declare, so a namespace added only to the
 * first two validates and merges perfectly in every service unit test while
 * every real PATCH silently no-ops: the client's payload never reaches the
 * service at all. See the "three hand-maintained copies" pitfall in CLAUDE.md.
 *
 * The only assertion that can catch that is one made on the far side of the
 * real pipe. So this file mounts the REAL UserSettingsController on a REAL
 * NestFastifyApplication with the REAL global `ZodValidationPipe` wired in via
 * APP_PIPE, and drives real HTTP requests through it (supertest), asserting
 * what the SERVICE was handed. Only JwtAuthGuard is stubbed (stamping a fake
 * authenticated user); RolesGuard/PermissionsGuard run for real against the
 * routes' `@Auth({ permissions: [...] })` metadata, and UserSettingsService is
 * mocked so no database is required. Same harness shape as
 * notifications.controller.spec.ts and issue-289-bodyless-post.spec.ts.
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { APP_PIPE } from '@nestjs/core';
import { BadRequestException, ExecutionContext } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';

import { UserSettingsController } from './user-settings.controller';
import { UserSettingsService } from './user-settings.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS, ROLES } from '../../common/constants/roles.constants';
import {
  NAVIGATION_MAX_PINNED,
  NAVIGATION_PINNABLE_KEYS,
} from '../../common/schemas/settings.schema';

const USER_ID = 'user-1';

/** Minimal AuthenticatedUser-shaped fixture carrying the user-settings permissions. */
function fakeAuthenticatedUser(): Partial<AuthenticatedUser> {
  return {
    id: USER_ID,
    email: 'user-1@example.com',
    isActive: true,
    userRoles: [
      {
        role: {
          id: 'role-viewer',
          name: ROLES.VIEWER,
          description: 'viewer',
          rolePermissions: [
            PERMISSIONS.USER_SETTINGS_READ,
            PERMISSIONS.USER_SETTINGS_WRITE,
          ].map((p) => ({
            permission: { id: `perm-${p}`, name: p, description: p },
          })),
        } as any,
      },
    ],
  };
}

/** JwtAuthGuard stub: always "authenticates", stamping the user onto the request. */
function stubJwtAuthGuard(user: Partial<AuthenticatedUser>) {
  return {
    canActivate: (ctx: ExecutionContext) => {
      const req = ctx.switchToHttp().getRequest();
      req.user = user;
      return true;
    },
  };
}

/** Echoes what the controller passed through, so assertions can read it back. */
function makeMockService() {
  return {
    getSettings: jest.fn().mockResolvedValue({
      theme: 'system',
      profile: { useProviderImage: true },
      updatedAt: new Date().toISOString(),
      version: 1,
    }),
    replaceSettings: jest.fn().mockImplementation(async (_userId, dto) => ({
      ...dto,
      updatedAt: new Date().toISOString(),
      version: 2,
    })),
    patchSettings: jest.fn().mockImplementation(async (_userId, dto) => ({
      theme: 'system',
      profile: { useProviderImage: true },
      navigation: dto.navigation ?? undefined,
      updatedAt: new Date().toISOString(),
      version: 2,
    })),
  };
}

describe('UserSettingsController — `navigation` survives the real ZodValidationPipe (issue #392)', () => {
  let app: NestFastifyApplication;
  let mockService: ReturnType<typeof makeMockService>;

  async function buildApp(): Promise<NestFastifyApplication> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [UserSettingsController],
      providers: [
        { provide: UserSettingsService, useValue: mockService },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(stubJwtAuthGuard(fakeAuthenticatedUser()))
      .compile();
    // RolesGuard/PermissionsGuard are NOT overridden — they run for real
    // against the routes' @Auth({ permissions }) metadata. The fake user above
    // holds both user-settings permissions, so 403 is never why a call fails.

    const nestApp = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await nestApp.init();
    await nestApp.getHttpAdapter().getInstance().ready();
    return nestApp;
  }

  beforeEach(async () => {
    mockService = makeMockService();
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    jest.clearAllMocks();
  });

  // ===========================================================================
  // PATCH /user-settings — THE three-copies assertion.
  // ===========================================================================

  describe('PATCH /user-settings', () => {
    it('carries `navigation` THROUGH the pipe to the service — the assertion that fails if the wire DTO forgets the namespace', async () => {
      const res = await request(app.getHttpServer())
        .patch('/user-settings')
        .send({ navigation: { pinned: ['albums', 'people'], railCollapsed: true } })
        .expect(200);

      // If `navigation` were missing from patchUserSettingsSchema, nestjs-zod
      // would strip it and this would be called with `{}` — a silent no-op that
      // every service-level test would still pass.
      expect(mockService.patchSettings).toHaveBeenCalledWith(
        USER_ID,
        { navigation: { pinned: ['albums', 'people'], railCollapsed: true } },
        undefined,
      );
      expect(res.body.navigation).toEqual({
        pinned: ['albums', 'people'],
        railCollapsed: true,
      });
    });

    it('carries a single field through without inventing the other', async () => {
      await request(app.getHttpServer())
        .patch('/user-settings')
        .send({ navigation: { railCollapsed: true } })
        .expect(200);

      expect(mockService.patchSettings).toHaveBeenCalledWith(
        USER_ID,
        { navigation: { railCollapsed: true } },
        undefined,
      );
    });

    it('carries a `null` field through as the JSON Merge Patch delete marker', async () => {
      await request(app.getHttpServer())
        .patch('/user-settings')
        .send({ navigation: { pinned: null } })
        .expect(200);

      expect(mockService.patchSettings).toHaveBeenCalledWith(
        USER_ID,
        { navigation: { pinned: null } },
        undefined,
      );
    });

    it('carries `navigation: null` through as the clear-the-namespace marker', async () => {
      await request(app.getHttpServer())
        .patch('/user-settings')
        .send({ navigation: null })
        .expect(200);

      expect(mockService.patchSettings).toHaveBeenCalledWith(
        USER_ID,
        { navigation: null },
        undefined,
      );
    });

    it('does not materialize the namespace when the body omits it', async () => {
      await request(app.getHttpServer())
        .patch('/user-settings')
        .send({ theme: 'dark' })
        .expect(200);

      expect(mockService.patchSettings).toHaveBeenCalledWith(
        USER_ID,
        { theme: 'dark' },
        undefined,
      );
    });

    it('400s on an unknown pin key — the service is never reached', async () => {
      await request(app.getHttpServer())
        .patch('/user-settings')
        .send({ navigation: { pinned: ['holodeck'] } })
        .expect(400);

      expect(mockService.patchSettings).not.toHaveBeenCalled();
    });

    it('400s on more than NAVIGATION_MAX_PINNED pins — the service is never reached', async () => {
      await request(app.getHttpServer())
        .patch('/user-settings')
        .send({
          navigation: {
            pinned: NAVIGATION_PINNABLE_KEYS.slice(0, NAVIGATION_MAX_PINNED + 1),
          },
        })
        .expect(400);

      expect(mockService.patchSettings).not.toHaveBeenCalled();
    });

    it('400s on an unknown key inside the namespace (strict)', async () => {
      await request(app.getHttpServer())
        .patch('/user-settings')
        .send({ navigation: { railHidden: true } })
        .expect(400);

      expect(mockService.patchSettings).not.toHaveBeenCalled();
    });

    it('surfaces the service\'s post-merge over-cap guard as a 400, not a 500', async () => {
      // The stored blob is over-cap and the patch never mentions `pinned`, so
      // the schema cannot catch it — UserSettingsService's post-merge re-check
      // is what makes this a 400 instead of a raw ZodError escaping as a 500.
      mockService.patchSettings.mockRejectedValueOnce(
        new BadRequestException(
          `navigation.pinned may hold at most ${NAVIGATION_MAX_PINNED} destinations (patch would produce ${NAVIGATION_MAX_PINNED + 1})`,
        ),
      );

      const res = await request(app.getHttpServer())
        .patch('/user-settings')
        .send({ theme: 'dark' })
        .expect(400);

      expect(res.body.message).toContain('navigation.pinned may hold at most');
    });
  });

  // ===========================================================================
  // PUT /user-settings — same wire-DTO question, full-replacement schema.
  // ===========================================================================

  describe('PUT /user-settings', () => {
    it('carries `navigation` THROUGH the pipe to the service', async () => {
      const res = await request(app.getHttpServer())
        .put('/user-settings')
        .send({
          theme: 'system',
          profile: { useProviderImage: true },
          navigation: { pinned: ['bursts'], railCollapsed: false },
        })
        .expect(200);

      expect(mockService.replaceSettings).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          navigation: { pinned: ['bursts'], railCollapsed: false },
        }),
      );
      expect(res.body.navigation).toEqual({
        pinned: ['bursts'],
        railCollapsed: false,
      });
    });

    it('leaves the namespace absent when the body omits it — PUT never materializes defaults', async () => {
      await request(app.getHttpServer())
        .put('/user-settings')
        .send({ theme: 'system', profile: { useProviderImage: true } })
        .expect(200);

      const [, dto] = mockService.replaceSettings.mock.calls[0];
      expect('navigation' in dto).toBe(false);
    });

    it('400s on an unknown pin key', async () => {
      await request(app.getHttpServer())
        .put('/user-settings')
        .send({
          theme: 'system',
          profile: { useProviderImage: true },
          navigation: { pinned: ['warp-core'] },
        })
        .expect(400);

      expect(mockService.replaceSettings).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // GET /user-settings — the read path returns whatever the service resolved
  // (including the unknown-key drop, which lives in the service).
  // ===========================================================================

  describe('GET /user-settings', () => {
    it('returns the namespace the service resolved, absences included', async () => {
      mockService.getSettings.mockResolvedValueOnce({
        theme: 'system',
        profile: { useProviderImage: true },
        navigation: { pinned: ['albums'] },
        updatedAt: new Date().toISOString(),
        version: 3,
      });

      const res = await request(app.getHttpServer())
        .get('/user-settings')
        .expect(200);

      expect(res.body.navigation).toEqual({ pinned: ['albums'] });
    });

    it('omits the namespace entirely when the user has never persisted one', async () => {
      const res = await request(app.getHttpServer())
        .get('/user-settings')
        .expect(200);

      expect(res.body.navigation).toBeUndefined();
    });
  });
});
