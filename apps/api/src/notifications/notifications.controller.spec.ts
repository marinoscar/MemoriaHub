/**
 * Route-dispatch + auth + request-validation tests for NotificationsController
 * (epic #240, issue #245).
 *
 * Mirrors media-enhancement.controller.spec.ts / workflows-admin.controller.spec.ts:
 * a genuine HTTP round-trip (supertest) against NestJS's REAL compiled route
 * table, with the REAL RolesGuard/PermissionsGuard (backed by the real
 * Reflector reading `@Auth()` metadata) and the REAL global `ZodValidationPipe`
 * (nestjs-zod) wired in via APP_PIPE — this is what lets this file assert
 * genuine 400s for a malformed query/body, not just decorator presence. Only
 * JwtAuthGuard is stubbed, stamping a fake AuthenticatedUser-shaped
 * `request.user` the same way the real JWT strategy does.
 * NotificationsService itself is mocked — no database required.
 *
 * Every handler here carries a BARE `@Auth()` (no @Roles()/@Permissions()) —
 * per the controller's own header comment, ANY authenticated user, any role,
 * passes RolesGuard/PermissionsGuard (both short-circuit `true` when no
 * metadata is present). So there is no 403 case to exercise here; the only
 * gate is JwtAuthGuard (always stubbed authenticated in this file).
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { APP_PIPE } from '@nestjs/core';
import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { randomUUID } from 'crypto';

import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

const USER_ID = 'user-1';
const NOTIF_ID = randomUUID();
const CIRCLE_ID = randomUUID();

/** Builds a minimal AuthenticatedUser-shaped fixture (no roles/permissions needed — bare @Auth()). */
function fakeAuthenticatedUser(): Partial<AuthenticatedUser> {
  return {
    id: USER_ID,
    email: 'user-1@example.com',
    isActive: true,
    userRoles: [],
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
    list: jest.fn().mockResolvedValue({
      items: [],
      meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 1 },
    }),
    getUnreadCount: jest.fn().mockResolvedValue({ count: 0 }),
    markAllRead: jest.fn().mockResolvedValue({ updated: 0 }),
    dismissAll: jest.fn().mockResolvedValue({ updated: 0 }),
    markRead: jest.fn().mockResolvedValue(undefined),
    dismiss: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  };
}

describe('NotificationsController — route dispatch + auth + validation (supertest)', () => {
  let app: NestFastifyApplication;
  let mockService: ReturnType<typeof makeMockService>;

  async function buildApp(): Promise<NestFastifyApplication> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        { provide: NotificationsService, useValue: mockService },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(stubJwtAuthGuard(fakeAuthenticatedUser()))
      .compile();
    // NOTE: RolesGuard/PermissionsGuard are NOT overridden — they run for
    // real. Every route here is bare @Auth(), so both trivially pass.

    const nestApp = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
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
  // GET /notifications
  // ===========================================================================

  describe('GET /notifications', () => {
    it('200s with no query params and delegates with the Zod-applied defaults', async () => {
      const res = await request(app.getHttpServer()).get('/notifications').expect(200);

      expect(mockService.list).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ status: 'all', page: 1, pageSize: 20 }),
      );
      expect(res.body).toEqual({
        items: [],
        meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 1 },
      });
    });

    it.each(['unread', 'read', 'dismissed', 'all'] as const)(
      'accepts status=%s and forwards it verbatim',
      async (status) => {
        await request(app.getHttpServer()).get('/notifications').query({ status }).expect(200);

        expect(mockService.list).toHaveBeenCalledWith(
          USER_ID,
          expect.objectContaining({ status }),
        );
      },
    );

    it('400s for an unknown status value', async () => {
      await request(app.getHttpServer())
        .get('/notifications')
        .query({ status: 'archived' })
        .expect(400);

      expect(mockService.list).not.toHaveBeenCalled();
    });

    it('forwards a valid circleId', async () => {
      await request(app.getHttpServer())
        .get('/notifications')
        .query({ circleId: CIRCLE_ID })
        .expect(200);

      expect(mockService.list).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ circleId: CIRCLE_ID }),
      );
    });

    it('400s when circleId is not a valid UUID', async () => {
      await request(app.getHttpServer())
        .get('/notifications')
        .query({ circleId: 'not-a-uuid' })
        .expect(400);

      expect(mockService.list).not.toHaveBeenCalled();
    });

    it('400s when pageSize exceeds 100', async () => {
      await request(app.getHttpServer())
        .get('/notifications')
        .query({ pageSize: 101 })
        .expect(400);

      expect(mockService.list).not.toHaveBeenCalled();
    });

    it('400s when page is less than 1', async () => {
      await request(app.getHttpServer()).get('/notifications').query({ page: 0 }).expect(400);

      expect(mockService.list).not.toHaveBeenCalled();
    });

    it('coerces numeric string query params (page/pageSize)', async () => {
      await request(app.getHttpServer())
        .get('/notifications')
        .query({ page: '2', pageSize: '50' })
        .expect(200);

      expect(mockService.list).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ page: 2, pageSize: 50 }),
      );
    });
  });

  // ===========================================================================
  // GET /notifications/unread-count
  // ===========================================================================

  describe('GET /notifications/unread-count', () => {
    it('200s and delegates to getUnreadCount(userId)', async () => {
      mockService.getUnreadCount.mockResolvedValueOnce({ count: 4 });

      const res = await request(app.getHttpServer()).get('/notifications/unread-count').expect(200);

      expect(mockService.getUnreadCount).toHaveBeenCalledWith(USER_ID);
      expect(res.body).toEqual({ count: 4 });
    });

    it('is NOT swallowed by any :id-shaped route (resolves to the literal segment)', async () => {
      await request(app.getHttpServer()).get('/notifications/unread-count').expect(200);

      expect(mockService.getUnreadCount).toHaveBeenCalledTimes(1);
      expect(mockService.list).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // POST /notifications/read-all
  // ===========================================================================

  describe('POST /notifications/read-all', () => {
    it('200s with an explicit empty object body and passes circleId=undefined', async () => {
      mockService.markAllRead.mockResolvedValueOnce({ updated: 3 });

      const res = await request(app.getHttpServer())
        .post('/notifications/read-all')
        .send({})
        .expect(200);

      expect(mockService.markAllRead).toHaveBeenCalledWith(USER_ID, undefined);
      expect(res.body).toEqual({ updated: 3 });
    });

    it('forwards circleId when given', async () => {
      await request(app.getHttpServer())
        .post('/notifications/read-all')
        .send({ circleId: CIRCLE_ID })
        .expect(200);

      expect(mockService.markAllRead).toHaveBeenCalledWith(USER_ID, CIRCLE_ID);
    });

    it('400s when circleId is not a valid UUID', async () => {
      await request(app.getHttpServer())
        .post('/notifications/read-all')
        .send({ circleId: 'not-a-uuid' })
        .expect(400);

      expect(mockService.markAllRead).not.toHaveBeenCalled();
    });

    it('200s for a genuinely bodyless POST (no .send() at all) and treats it as unscoped', async () => {
      // Regression guard for the `.default({})` on notificationScopeSchema:
      // Fastify leaves request.body undefined when no body is sent, and a bare
      // z.object().parse(undefined) throws — which used to 400 here. This is
      // the exact shape `fetch(url, { method: 'POST' })` produces, i.e. how the
      // web "Mark all as read" button (#249/#250) will call this route.
      mockService.markAllRead.mockResolvedValueOnce({ updated: 7 });

      const res = await request(app.getHttpServer()).post('/notifications/read-all').expect(200);

      expect(mockService.markAllRead).toHaveBeenCalledWith(USER_ID, undefined);
      expect(res.body).toEqual({ updated: 7 });
    });
  });

  // ===========================================================================
  // POST /notifications/dismiss-all
  // ===========================================================================

  describe('POST /notifications/dismiss-all', () => {
    it('200s with an explicit empty object body and passes circleId=undefined', async () => {
      mockService.dismissAll.mockResolvedValueOnce({ updated: 5 });

      const res = await request(app.getHttpServer())
        .post('/notifications/dismiss-all')
        .send({})
        .expect(200);

      expect(mockService.dismissAll).toHaveBeenCalledWith(USER_ID, undefined);
      expect(res.body).toEqual({ updated: 5 });
    });

    it('forwards circleId when given', async () => {
      await request(app.getHttpServer())
        .post('/notifications/dismiss-all')
        .send({ circleId: CIRCLE_ID })
        .expect(200);

      expect(mockService.dismissAll).toHaveBeenCalledWith(USER_ID, CIRCLE_ID);
    });

    it('400s when circleId is not a valid UUID', async () => {
      await request(app.getHttpServer())
        .post('/notifications/dismiss-all')
        .send({ circleId: 'not-a-uuid' })
        .expect(400);

      expect(mockService.dismissAll).not.toHaveBeenCalled();
    });

    it('200s for a genuinely bodyless POST (no .send() at all) and treats it as unscoped', async () => {
      // Same regression guard as read-all above: bodyless POST must be an
      // all-circles dismiss, not a 400.
      mockService.dismissAll.mockResolvedValueOnce({ updated: 9 });

      const res = await request(app.getHttpServer()).post('/notifications/dismiss-all').expect(200);

      expect(mockService.dismissAll).toHaveBeenCalledWith(USER_ID, undefined);
      expect(res.body).toEqual({ updated: 9 });
    });
  });

  // ===========================================================================
  // POST /notifications/:id/read
  // ===========================================================================

  describe('POST /notifications/:id/read', () => {
    it('204s and delegates to markRead(userId, id)', async () => {
      await request(app.getHttpServer()).post(`/notifications/${NOTIF_ID}/read`).expect(204);

      expect(mockService.markRead).toHaveBeenCalledWith(USER_ID, NOTIF_ID);
    });

    it('400s when the id path param is not a UUID', async () => {
      await request(app.getHttpServer()).post('/notifications/not-a-uuid/read').expect(400);

      expect(mockService.markRead).not.toHaveBeenCalled();
    });

    it('maps a service NotFoundException (e.g. a cross-user id) to HTTP 404', async () => {
      mockService.markRead.mockRejectedValueOnce(new NotFoundException('Notification not found'));

      await request(app.getHttpServer()).post(`/notifications/${NOTIF_ID}/read`).expect(404);
    });
  });

  // ===========================================================================
  // POST /notifications/:id/dismiss
  // ===========================================================================

  describe('POST /notifications/:id/dismiss', () => {
    it('204s and delegates to dismiss(userId, id)', async () => {
      await request(app.getHttpServer()).post(`/notifications/${NOTIF_ID}/dismiss`).expect(204);

      expect(mockService.dismiss).toHaveBeenCalledWith(USER_ID, NOTIF_ID);
    });

    it('400s when the id path param is not a UUID', async () => {
      await request(app.getHttpServer()).post('/notifications/not-a-uuid/dismiss').expect(400);

      expect(mockService.dismiss).not.toHaveBeenCalled();
    });

    it('maps a service NotFoundException (e.g. a cross-user id) to HTTP 404', async () => {
      mockService.dismiss.mockRejectedValueOnce(new NotFoundException('Notification not found'));

      await request(app.getHttpServer()).post(`/notifications/${NOTIF_ID}/dismiss`).expect(404);
    });
  });

  // ===========================================================================
  // DELETE /notifications/:id
  // ===========================================================================

  describe('DELETE /notifications/:id', () => {
    it('204s and delegates to remove(userId, id)', async () => {
      await request(app.getHttpServer()).delete(`/notifications/${NOTIF_ID}`).expect(204);

      expect(mockService.remove).toHaveBeenCalledWith(USER_ID, NOTIF_ID);
    });

    it('400s when the id path param is not a UUID', async () => {
      await request(app.getHttpServer()).delete('/notifications/not-a-uuid').expect(400);

      expect(mockService.remove).not.toHaveBeenCalled();
    });

    it('maps a service NotFoundException (e.g. a cross-user id) to HTTP 404', async () => {
      mockService.remove.mockRejectedValueOnce(new NotFoundException('Notification not found'));

      await request(app.getHttpServer()).delete(`/notifications/${NOTIF_ID}`).expect(404);
    });
  });
});
