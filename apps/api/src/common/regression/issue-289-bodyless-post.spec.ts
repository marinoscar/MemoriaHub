/**
 * End-to-end (pipe-level) regression test for GitHub issue #289.
 *
 * WHICH FORM THIS IS, AND WHY: the task asked for the "highest-value form" —
 * driving the request through Fastify + supertest so `request.body` is
 * genuinely `undefined`, exactly as a real `fetch(url, { method: 'POST' })`
 * produces it — rather than only calling the pipe directly with a hand-built
 * `undefined` + metatype. This file does the real-HTTP-round-trip form: it
 * mounts the REAL production controllers (`EnrichmentAdminController`,
 * `AdminMetadataController`) on a REAL `NestFastifyApplication`, with the
 * REAL global `ZodValidationPipe` wired in via `APP_PIPE` (nestjs-zod) and
 * the REAL `RolesGuard`/`PermissionsGuard` — only `JwtAuthGuard` is stubbed,
 * stamping a fake authenticated Admin user, mirroring
 * `notifications.controller.spec.ts` / `media-enhancement.controller.spec.ts`.
 * The underlying services (`EnrichmentAdminService`, `MetadataBackfillService`)
 * are mocked — no database required. This was practical here because both
 * controllers' dependency graphs are cheap to construct fully-mocked (see the
 * companion schema-level spec's header comment for why other candidate
 * controllers were avoided as being import-heavy in this environment).
 *
 * Calling `POST /some/route` via supertest with NO `.send(...)` call at all —
 * not even `.send({})` — never sets a request body or a Content-Type header,
 * which is exactly the shape Fastify leaves `request.body` as `undefined` for.
 * That is the precise mechanism issue #289 describes.
 *
 * This file additionally proves the `.prefault({})` half of the fix
 * end-to-end: `AdminMetadataController`'s body DTO (`AdminMetadataBackfillDto`
 * / `adminMetadataBackfillSchema`) is declared WITHOUT `export` in
 * `apps/api/src/metadata/admin-metadata.controller.ts`, so it cannot be
 * imported by name from a test file — but routing an actual bodyless HTTP
 * request through the actual mounted route exercises that exact schema via
 * Nest's own DTO-metatype resolution, without ever needing to name it. This
 * is what lets this file assert the inner `force: z.boolean().default(false)`
 * default actually reaches the service call, which is the one part of the
 * fix `.default({})` alone cannot provide (see `app.module.ts` Caveat 1 and
 * the "Contrast" describe block below).
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { APP_PIPE } from '@nestjs/core';
import { Body, Controller, ExecutionContext, Post } from '@nestjs/common';
import { ZodValidationPipe, createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import request from 'supertest';

import { EnrichmentAdminController } from '../../enrichment/enrichment-admin.controller';
import { EnrichmentAdminService } from '../../enrichment/enrichment-admin.service';
import { AdminMetadataController } from '../../metadata/admin-metadata.controller';
import { MetadataBackfillService } from '../../metadata/metadata-backfill.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS, ROLES } from '../constants/roles.constants';

/** Builds a minimal AuthenticatedUser-shaped fixture with the given roles/permissions. */
function fakeAuthenticatedUser(
  roleNames: string[],
  permissionNames: string[],
): Partial<AuthenticatedUser> {
  return {
    id: 'admin-1',
    email: 'admin-1@example.com',
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

const ADMIN = fakeAuthenticatedUser(
  [ROLES.ADMIN],
  [PERMISSIONS.JOBS_READ, PERMISSIONS.JOBS_WRITE, PERMISSIONS.SYSTEM_SETTINGS_WRITE],
);

// ---------------------------------------------------------------------------
// Contrast fixture: an UNFIXED body schema (no top-level .default({})),
// mounted through the SAME real pipe, to prove this harness genuinely
// reproduces the pre-#289 bug rather than the pipe being lenient by
// construction. See the "Contrast" describe block below.
// ---------------------------------------------------------------------------
const unfixedAllOptionalSchema = z.object({
  note: z.string().optional(),
});
class UnfixedAllOptionalDto extends createZodDto(unfixedAllOptionalSchema) {}

@Controller('__test-only/unfixed')
class UnfixedController {
  @Post()
  async handle(@Body() dto: UnfixedAllOptionalDto) {
    return { received: dto };
  }
}

function makeMockEnrichmentAdminService() {
  return {
    getStats: jest.fn(),
    listJobs: jest.fn(),
    retryJob: jest.fn(),
    retryAllFailed: jest.fn().mockResolvedValue({ retried: 5 }),
    resetStuck: jest.fn().mockResolvedValue({ reset: 2, failed: 0 }),
    deleteJob: jest.fn(),
  };
}

function makeMockMetadataBackfillService() {
  return {
    backfillAllCircles: jest.fn().mockResolvedValue({ enqueued: 42 }),
  };
}

describe('issue #289 — bodyless POST reaches the handler via the REAL ZodValidationPipe + Fastify', () => {
  let app: NestFastifyApplication;
  let mockEnrichmentAdminService: ReturnType<typeof makeMockEnrichmentAdminService>;
  let mockMetadataBackfillService: ReturnType<typeof makeMockMetadataBackfillService>;

  async function buildApp(): Promise<NestFastifyApplication> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [EnrichmentAdminController, AdminMetadataController, UnfixedController],
      providers: [
        { provide: EnrichmentAdminService, useValue: mockEnrichmentAdminService },
        { provide: MetadataBackfillService, useValue: mockMetadataBackfillService },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(stubJwtAuthGuard(ADMIN))
      .compile();
    // NOTE: RolesGuard/PermissionsGuard are NOT overridden — they run for
    // real, resolving the real @Auth() metadata via the real Reflector. The
    // fake ADMIN user above carries every permission these three controllers'
    // routes require, so 403 is never the reason a request fails here.

    const nestApp = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await nestApp.init();
    await nestApp.getHttpAdapter().getInstance().ready();
    return nestApp;
  }

  beforeEach(async () => {
    mockEnrichmentAdminService = makeMockEnrichmentAdminService();
    mockMetadataBackfillService = makeMockMetadataBackfillService();
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    jest.clearAllMocks();
  });

  // ===========================================================================
  // POST /admin/jobs/reset-stuck — ResetStuckDto, the DTO named in the issue.
  // ===========================================================================
  describe('POST /admin/jobs/reset-stuck (ResetStuckDto)', () => {
    it('201s for a genuinely bodyless request (no .send() at all) and calls the service with undefined', async () => {
      // No .send(...) call whatsoever: supertest issues the request with no
      // body and no Content-Type header, so Fastify leaves request.body
      // undefined — the exact shape of `fetch(url, { method: 'POST' })`.
      const res = await request(app.getHttpServer()).post('/admin/jobs/reset-stuck').expect(201);

      expect(mockEnrichmentAdminService.resetStuck).toHaveBeenCalledWith(undefined);
      expect(res.body).toEqual({ reset: 2, failed: 0 });
    });

    it('still 400s for a malformed body — the fix did not loosen validation', async () => {
      await request(app.getHttpServer())
        .post('/admin/jobs/reset-stuck')
        .send({ olderThanMinutes: -1 })
        .expect(400);

      expect(mockEnrichmentAdminService.resetStuck).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // POST /admin/jobs/retry-failed — RetryAllFailedDto.
  // ===========================================================================
  describe('POST /admin/jobs/retry-failed (RetryAllFailedDto)', () => {
    it('201s for a genuinely bodyless request and calls the service with undefined', async () => {
      const res = await request(app.getHttpServer()).post('/admin/jobs/retry-failed').expect(201);

      expect(mockEnrichmentAdminService.retryAllFailed).toHaveBeenCalledWith(undefined);
      expect(res.body).toEqual({ retried: 5 });
    });
  });

  // ===========================================================================
  // POST /admin/metadata/backfill — AdminMetadataBackfillDto, the .prefault({})
  // case. Its schema/class are both unexported production code, so this is
  // the ONLY way to assert its contract without modifying production code:
  // route a real bodyless request through the real mounted route.
  // ===========================================================================
  describe('POST /admin/metadata/backfill (AdminMetadataBackfillDto — unexported, .prefault({}) case)', () => {
    it('201s for a genuinely bodyless request and the inner `force` default reaches the service', async () => {
      const res = await request(app.getHttpServer()).post('/admin/metadata/backfill').expect(201);

      // This is the assertion .default({}) alone could not satisfy: a bare
      // .default({}) would short-circuit and return a literal {} WITHOUT
      // running force's own `.optional().default(false)` — force would come
      // out `undefined`, not `false`. .prefault({}) feeds {} THROUGH the
      // schema, so force really is `false` here, exactly like an explicit {}
      // body would produce.
      expect(mockMetadataBackfillService.backfillAllCircles).toHaveBeenCalledWith({
        from: undefined,
        to: undefined,
        force: false,
      });
      expect(res.body).toEqual({ data: { enqueued: 42 } });
    });

    it('an explicit {} body produces the identical service call (proves bodyless === {})', async () => {
      await request(app.getHttpServer()).post('/admin/metadata/backfill').send({}).expect(201);

      expect(mockMetadataBackfillService.backfillAllCircles).toHaveBeenCalledWith({
        from: undefined,
        to: undefined,
        force: false,
      });
    });

    it('an explicit force:true still overrides the default correctly', async () => {
      await request(app.getHttpServer())
        .post('/admin/metadata/backfill')
        .send({ force: true })
        .expect(201);

      expect(mockMetadataBackfillService.backfillAllCircles).toHaveBeenCalledWith({
        from: undefined,
        to: undefined,
        force: true,
      });
    });

    it('still 400s for a malformed body — the fix did not loosen validation', async () => {
      await request(app.getHttpServer())
        .post('/admin/metadata/backfill')
        .send({ from: 'not-a-date' })
        .expect(400);

      expect(mockMetadataBackfillService.backfillAllCircles).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Contrast: an all-optional body schema WITHOUT the #289 fix still 400s on
  // a genuinely bodyless request through this exact same harness. This proves
  // the 201s above are because of the fix, not because this test setup's pipe
  // is somehow more lenient than production's.
  // ===========================================================================
  describe('Contrast — an unfixed all-optional schema (no .default({})) still reproduces the #289 bug', () => {
    it('400s for a genuinely bodyless request against a schema with NO top-level default', async () => {
      const res = await request(app.getHttpServer()).post('/__test-only/unfixed').expect(400);

      expect(res.body).toMatchObject({ statusCode: 400 });
    });

    it('the same schema accepts an explicit {} body just fine (confirms the bug is specifically about undefined)', async () => {
      await request(app.getHttpServer()).post('/__test-only/unfixed').send({}).expect(201);
    });
  });
});
