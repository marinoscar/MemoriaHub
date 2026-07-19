/**
 * Route-dispatch + RBAC tests for WorkflowsAdminController (issue #143).
 *
 * Unlike a pure delegation test, this exercises NestJS's ACTUAL compiled route
 * table plus the REAL RolesGuard/PermissionsGuard (backed by the real
 * Reflector reading the `@Auth()` metadata declared on each handler) via a
 * genuine HTTP round-trip (supertest). Only JwtAuthGuard is stubbed — it
 * stamps a fake `AuthenticatedUser`-shaped `request.user` the same way the
 * real JWT strategy does, so RolesGuard/PermissionsGuard evaluate against
 * caller-supplied roles/permissions exactly as they would in production. This
 * is what lets this file assert genuine 403s for a non-admin caller, not just
 * decorator-metadata presence.
 *
 * WorkflowsAdminService itself is mocked — no database required.
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
import { WorkflowsAdminController } from './workflows-admin.controller';
import { WorkflowsAdminService } from './workflows-admin.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

const WORKFLOW_ID = randomUUID();
const RUN_ID = randomUUID();

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

function makeMockAdminService() {
  return {
    getStats: jest.fn().mockResolvedValue({
      windowDays: 7,
      runsLast7Days: 5,
      itemsActioned: 42,
      failures: 1,
      currentlyRunning: 0,
    }),
    listWorkflows: jest.fn().mockResolvedValue({
      items: [{ id: WORKFLOW_ID }],
      meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
    }),
    listRuns: jest.fn().mockResolvedValue({
      items: [{ id: RUN_ID }],
      meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
    }),
    disableWorkflow: jest.fn().mockResolvedValue({ id: WORKFLOW_ID, enabled: false }),
    cancelRun: jest.fn().mockResolvedValue({ runId: RUN_ID, status: 'cancelled' }),
  };
}

describe('WorkflowsAdminController — route dispatch + RBAC (supertest)', () => {
  let app: NestFastifyApplication;
  let mockAdminService: ReturnType<typeof makeMockAdminService>;

  /** Rebuilds the app with the given caller identity, real RolesGuard/PermissionsGuard. */
  async function buildApp(user: Partial<AuthenticatedUser>): Promise<NestFastifyApplication> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [WorkflowsAdminController],
      providers: [
        { provide: WorkflowsAdminService, useValue: mockAdminService },
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

  const ADMIN = fakeAuthenticatedUser(['admin'], [
    'system_settings:read',
    'system_settings:write',
    'jobs:read',
    'jobs:write',
  ]);
  const VIEWER = fakeAuthenticatedUser(['viewer'], ['media:read']);
  // An "admin" role holder who is missing the specific permission a given
  // endpoint requires (tests permission enforcement independent of role).
  const ADMIN_NO_PERMS = fakeAuthenticatedUser(['admin'], []);

  beforeEach(() => {
    mockAdminService = makeMockAdminService();
  });

  afterEach(async () => {
    if (app) await app.close();
    jest.clearAllMocks();
  });

  // ===========================================================================
  // GET /admin/workflows/stats
  // ===========================================================================

  describe('GET /admin/workflows/stats', () => {
    it('200s for an Admin with system_settings:read and delegates to getStats()', async () => {
      app = await buildApp(ADMIN);

      const res = await request(app.getHttpServer()).get('/admin/workflows/stats').expect(200);

      expect(mockAdminService.getStats).toHaveBeenCalledTimes(1);
      expect(res.body).toMatchObject({ runsLast7Days: 5, itemsActioned: 42 });
    });

    it('403s for a non-admin role', async () => {
      app = await buildApp(VIEWER);

      await request(app.getHttpServer()).get('/admin/workflows/stats').expect(403);
      expect(mockAdminService.getStats).not.toHaveBeenCalled();
    });

    it('403s for an Admin missing system_settings:read', async () => {
      app = await buildApp(ADMIN_NO_PERMS);

      await request(app.getHttpServer()).get('/admin/workflows/stats').expect(403);
      expect(mockAdminService.getStats).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // GET /admin/workflows
  // ===========================================================================

  describe('GET /admin/workflows', () => {
    it('200s for an Admin with system_settings:read and delegates to listWorkflows()', async () => {
      app = await buildApp(ADMIN);

      const res = await request(app.getHttpServer())
        .get('/admin/workflows')
        .query({ page: 2, pageSize: 10 })
        .expect(200);

      expect(mockAdminService.listWorkflows).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, pageSize: 10 }),
      );
      expect(res.body.items).toEqual([{ id: WORKFLOW_ID }]);
    });

    it('403s for a non-admin role', async () => {
      app = await buildApp(VIEWER);

      await request(app.getHttpServer()).get('/admin/workflows').expect(403);
    });
  });

  // ===========================================================================
  // GET /admin/workflow-runs
  // ===========================================================================

  describe('GET /admin/workflow-runs', () => {
    it('200s for an Admin with jobs:read and delegates to listRuns()', async () => {
      app = await buildApp(ADMIN);

      const res = await request(app.getHttpServer()).get('/admin/workflow-runs').expect(200);

      expect(mockAdminService.listRuns).toHaveBeenCalledTimes(1);
      expect(res.body.items).toEqual([{ id: RUN_ID }]);
    });

    it('403s for a non-admin role', async () => {
      app = await buildApp(VIEWER);

      await request(app.getHttpServer()).get('/admin/workflow-runs').expect(403);
    });

    it('403s for an Admin missing jobs:read', async () => {
      app = await buildApp(ADMIN_NO_PERMS);

      await request(app.getHttpServer()).get('/admin/workflow-runs').expect(403);
      expect(mockAdminService.listRuns).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // POST /admin/workflows/:id/disable
  // ===========================================================================

  describe('POST /admin/workflows/:id/disable', () => {
    it('200s for an Admin with system_settings:write and delegates to disableWorkflow(id, actorId)', async () => {
      app = await buildApp(ADMIN);

      const res = await request(app.getHttpServer())
        .post(`/admin/workflows/${WORKFLOW_ID}/disable`)
        .expect(200);

      expect(mockAdminService.disableWorkflow).toHaveBeenCalledWith(WORKFLOW_ID, 'user-1');
      expect(res.body).toEqual({ id: WORKFLOW_ID, enabled: false });
    });

    it('403s for a non-admin role', async () => {
      app = await buildApp(VIEWER);

      await request(app.getHttpServer())
        .post(`/admin/workflows/${WORKFLOW_ID}/disable`)
        .expect(403);
      expect(mockAdminService.disableWorkflow).not.toHaveBeenCalled();
    });

    it('403s for an Admin with only system_settings:read (write required)', async () => {
      const adminReadOnly = fakeAuthenticatedUser(['admin'], ['system_settings:read']);
      app = await buildApp(adminReadOnly);

      await request(app.getHttpServer())
        .post(`/admin/workflows/${WORKFLOW_ID}/disable`)
        .expect(403);
      expect(mockAdminService.disableWorkflow).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // POST /admin/workflow-runs/:id/cancel
  // ===========================================================================

  describe('POST /admin/workflow-runs/:id/cancel', () => {
    it('200s for an Admin with jobs:write and delegates to cancelRun(id, user)', async () => {
      app = await buildApp(ADMIN);

      const res = await request(app.getHttpServer())
        .post(`/admin/workflow-runs/${RUN_ID}/cancel`)
        .expect(200);

      expect(mockAdminService.cancelRun).toHaveBeenCalledWith(
        RUN_ID,
        expect.objectContaining({ id: 'user-1' }),
      );
      expect(res.body).toEqual({ runId: RUN_ID, status: 'cancelled' });
    });

    it('403s for a non-admin role', async () => {
      app = await buildApp(VIEWER);

      await request(app.getHttpServer())
        .post(`/admin/workflow-runs/${RUN_ID}/cancel`)
        .expect(403);
      expect(mockAdminService.cancelRun).not.toHaveBeenCalled();
    });

    it('403s for an Admin with only jobs:read (write required)', async () => {
      const adminReadOnly = fakeAuthenticatedUser(['admin'], ['jobs:read']);
      app = await buildApp(adminReadOnly);

      await request(app.getHttpServer())
        .post(`/admin/workflow-runs/${RUN_ID}/cancel`)
        .expect(403);
      expect(mockAdminService.cancelRun).not.toHaveBeenCalled();
    });
  });
});
