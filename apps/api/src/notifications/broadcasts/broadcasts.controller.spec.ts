/**
 * BroadcastsController (issue #488) — real HTTP round trip through Fastify with
 * the REAL RolesGuard/PermissionsGuard (reading @Auth() metadata) and the REAL
 * ZodValidationPipe. Only JwtAuthGuard is stubbed. The service is mocked.
 */
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { APP_PIPE } from '@nestjs/core';
import { ConflictException, ExecutionContext } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PERMISSIONS, ROLES } from '../../common/constants/roles.constants';
import { BroadcastsController } from './broadcasts.controller';
import { BroadcastsService } from './broadcasts.service';

const BID = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';

let currentUser: Record<string, unknown>;

function user(roles: string[], permissions: string[]) {
  return {
    id: ADMIN,
    email: 'a@x.test',
    isActive: true,
    userRoles: roles.map((name) => ({
      role: { name, rolePermissions: permissions.map((p) => ({ permission: { name: p } })) },
    })),
  };
}

const FULL = () => user([ROLES.ADMIN], [PERMISSIONS.BROADCASTS_READ, PERMISSIONS.BROADCASTS_WRITE]);

describe('BroadcastsController (supertest)', () => {
  let app: NestFastifyApplication;
  const service = {
    audience: jest.fn().mockResolvedValue({ activeUsers: 3 }),
    sendTest: jest.fn().mockResolvedValue({ notificationType: 'admin_broadcast', channels: ['inbox'], sentToUserId: ADMIN, email: null }),
    list: jest.fn().mockResolvedValue({ items: [], meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } }),
    create: jest.fn().mockResolvedValue({ id: BID }),
    get: jest.fn().mockResolvedValue({ id: BID }),
    cancel: jest.fn().mockResolvedValue({ id: BID, status: 'canceled' }),
    resume: jest.fn().mockResolvedValue({ id: BID, status: 'sending' }),
    remove: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BroadcastsController],
      providers: [
        { provide: BroadcastsService, useValue: service },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = currentUser;
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => app?.close());

  beforeEach(() => {
    currentUser = FULL();
    jest.clearAllMocks();
  });

  const valid = { title: 'Hello', body: 'World', channels: ['inbox', 'push'] };

  it('GET /admin/broadcasts/audience resolves before :id', async () => {
    const res = await request(app.getHttpServer()).get('/admin/broadcasts/audience').expect(200);
    expect(res.body).toEqual({ activeUsers: 3 });
    expect(service.get).not.toHaveBeenCalled();
  });

  it('POST /admin/broadcasts/test is 200 and passes the caller id', async () => {
    await request(app.getHttpServer()).post('/admin/broadcasts/test').send(valid).expect(200);
    expect(service.sendTest).toHaveBeenCalledWith(expect.objectContaining({ title: 'Hello', critical: false }), ADMIN);
  });

  it('POST /admin/broadcasts creates (201) and 400s on invalid bodies', async () => {
    await request(app.getHttpServer()).post('/admin/broadcasts').send(valid).expect(201);
    expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ channels: ['inbox', 'push'] }), ADMIN);

    await request(app.getHttpServer()).post('/admin/broadcasts').send({ ...valid, link: 'https://evil.test' }).expect(400);
    await request(app.getHttpServer()).post('/admin/broadcasts').send({ ...valid, channels: ['email'], critical: true }).expect(400);
    await request(app.getHttpServer()).post('/admin/broadcasts').send({ ...valid, title: 'x'.repeat(121) }).expect(400);
    expect(service.create).toHaveBeenCalledTimes(1);
  });

  it('GET list forwards the parsed query', async () => {
    await request(app.getHttpServer()).get('/admin/broadcasts?page=2&status=sent').expect(200);
    expect(service.list).toHaveBeenCalledWith({ page: 2, pageSize: 20, status: 'sent' });
    await request(app.getHttpServer()).get('/admin/broadcasts?status=bogus').expect(400);
  });

  it('GET/cancel/resume/delete :id route with a UUID and 400 otherwise', async () => {
    await request(app.getHttpServer()).get(`/admin/broadcasts/${BID}`).expect(200);
    await request(app.getHttpServer()).post(`/admin/broadcasts/${BID}/cancel`).expect(200);
    await request(app.getHttpServer()).post(`/admin/broadcasts/${BID}/resume`).expect(200);
    await request(app.getHttpServer()).delete(`/admin/broadcasts/${BID}`).expect(204);
    expect(service.cancel).toHaveBeenCalledWith(BID, ADMIN);
    expect(service.resume).toHaveBeenCalledWith(BID, ADMIN);
    expect(service.remove).toHaveBeenCalledWith(BID, ADMIN);
    await request(app.getHttpServer()).get('/admin/broadcasts/not-a-uuid').expect(400);
  });

  it('maps a service 409 through', async () => {
    service.remove.mockRejectedValueOnce(new ConflictException('sending'));
    await request(app.getHttpServer()).delete(`/admin/broadcasts/${BID}`).expect(409);
  });

  it('403s a non-admin, and a broadcasts:read-only admin on every write', async () => {
    currentUser = user([ROLES.CONTRIBUTOR], [PERMISSIONS.BROADCASTS_READ, PERMISSIONS.BROADCASTS_WRITE]);
    await request(app.getHttpServer()).get('/admin/broadcasts').expect(403);

    currentUser = user([ROLES.ADMIN], [PERMISSIONS.BROADCASTS_READ]);
    await request(app.getHttpServer()).get('/admin/broadcasts').expect(200);
    await request(app.getHttpServer()).post('/admin/broadcasts').send(valid).expect(403);
    await request(app.getHttpServer()).post('/admin/broadcasts/test').send(valid).expect(403);
    await request(app.getHttpServer()).post(`/admin/broadcasts/${BID}/cancel`).expect(403);
    await request(app.getHttpServer()).post(`/admin/broadcasts/${BID}/resume`).expect(403);
    await request(app.getHttpServer()).delete(`/admin/broadcasts/${BID}`).expect(403);

    currentUser = user([ROLES.ADMIN], [PERMISSIONS.BROADCASTS_WRITE]);
    await request(app.getHttpServer()).get('/admin/broadcasts/audience').expect(403);
  });
});
