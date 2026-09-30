/**
 * GET /api/notifications/stream (epic #481, issue #485) — a real HTTP round
 * trip through Fastify with the app's REAL global TransformInterceptor and
 * LoggingInterceptor, proving:
 *   - the route resolves (not swallowed by an `:id`-shaped route),
 *   - it answers `text/event-stream`,
 *   - frames are NOT wrapped in the `{ data, meta }` envelope (every frame
 *     stays a named SSE event),
 *   - the stream is keyed on the authenticated caller.
 */
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ExecutionContext, Logger } from '@nestjs/common';
import request from 'supertest';
import { of } from 'rxjs';

import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationPolicyService } from './notification-policy.service';
import { NotificationStreamService } from './notification-stream.service';
import { PushConfigService } from './push/push-config.service';
import { PushSubscriptionService } from './push/push-subscription.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';
import { LoggingInterceptor } from '../common/interceptors/logging.interceptor';

const USER_ID = 'user-stream-1';

describe('GET /notifications/stream (SSE)', () => {
  let app: NestFastifyApplication;
  const streams = { subscribe: jest.fn(), publishSync: jest.fn() };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        { provide: NotificationsService, useValue: {} },
        { provide: PushConfigService, useValue: {} },
        { provide: PushSubscriptionService, useValue: {} },
        { provide: NotificationPolicyService, useValue: {} },
        { provide: NotificationStreamService, useValue: streams },
        { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = { id: USER_ID, userRoles: [] };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  it('streams unwrapped SSE frames for the authenticated caller', async () => {
    // A finite stream so the response ends and supertest can read it.
    streams.subscribe.mockReturnValue(
      of(
        { type: 'ping', data: { type: 'ping' } },
        { type: 'notification', data: { type: 'notification', notification: { id: 'n-1' }, toast: true } },
        { type: 'sync', data: { type: 'sync' } },
      ),
    );

    const res = await request(app.getHttpServer())
      .get('/notifications/stream')
      .buffer(true)
      .parse((r, cb) => {
        let body = '';
        r.on('data', (c: Buffer) => (body += c.toString()));
        r.on('end', () => cb(null, body));
      })
      .expect(200);

    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(streams.subscribe).toHaveBeenCalledWith(USER_ID);

    const body = res.body as string;
    expect(body).toContain('event: ping');
    expect(body).toContain('event: notification');
    expect(body).toContain('event: sync');
    expect(body).toContain('"notification":{"id":"n-1"}');
    // No REST envelope leaked into the stream.
    expect(body).not.toContain('"meta"');
  });
});
