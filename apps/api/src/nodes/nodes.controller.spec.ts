/**
 * Route-dispatch tests for NodesController.
 *
 * Unlike a pure delegation test (calling controller methods directly), this
 * exercises NestJS's ACTUAL compiled route table via a real HTTP round-trip
 * (supertest), so we empirically verify — not just reason about — that:
 *
 *  - GET /nodes and GET /nodes/:id are wired to NodesService.listNodes /
 *    getNode and are owner-scoped (the caller's user.id is passed through).
 *  - GET /nodes/models/manifest (a literal route declared AFTER the new
 *    GET /nodes and GET /nodes/:id routes in the controller) still resolves
 *    to the manifest handler and is NOT swallowed by `@Get(':id')` treating
 *    "models" as an :id param with "manifest" left over unmatched.
 *
 * Auth is stubbed by overriding JwtAuthGuard / RolesGuard / PermissionsGuard
 * to always activate and stamp a fake user onto the request the same way the
 * real guards do (via `request.user`, which `@CurrentUser()` reads through
 * `request.requestUser || request.user`). RBAC enforcement itself is out of
 * scope here — it is covered by the guards' own unit tests and by
 * integration tests elsewhere; the point of this file is route matching.
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { NodesController } from './nodes.controller';
import { NodesService } from './nodes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';

const FAKE_USER = { id: 'user-1', email: 'user-1@example.com', roles: [], permissions: [] };

/** Guard override: always activates and stamps a fake user onto the request,
 * mirroring what JwtAuthGuard/RolesGuard/PermissionsGuard do when auth succeeds. */
const allowAndStampUser = {
  canActivate: (ctx: import('@nestjs/common').ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    req.user = FAKE_USER;
    return true;
  },
};

function makeMockNodesService() {
  return {
    register: jest.fn().mockResolvedValue({ nodeId: 'node-1' }),
    deregister: jest.fn().mockResolvedValue({ status: 'offline' }),
    heartbeat: jest.fn().mockResolvedValue({ ok: true }),
    claim: jest.fn().mockResolvedValue({ jobs: [] }),
    renewLease: jest.fn().mockResolvedValue({ leaseExpiresAt: new Date() }),
    getJobUploadUrl: jest.fn().mockResolvedValue({ url: 'x', storageKey: 'y', expiresSeconds: 60 }),
    getJobCredentials: jest.fn().mockResolvedValue({ type: 'geocode', provider: 'offline' }),
    submitJobResult: jest.fn().mockResolvedValue({ ok: true }),
    reportJobFailure: jest.fn().mockResolvedValue({ ok: true }),
    listNodes: jest.fn().mockResolvedValue([{ id: 'node-1', health: 'healthy' }]),
    getNode: jest.fn().mockResolvedValue({ id: 'node-abc', health: 'healthy' }),
    getModelManifest: jest.fn().mockReturnValue([{ name: 'foo.bin' }]),
  };
}

describe('NodesController — route dispatch (supertest)', () => {
  let app: NestFastifyApplication;
  let mockNodesService: ReturnType<typeof makeMockNodesService>;

  beforeEach(async () => {
    mockNodesService = makeMockNodesService();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [NodesController],
      providers: [{ provide: NodesService, useValue: mockNodesService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(allowAndStampUser)
      .overrideGuard(RolesGuard)
      .useValue(allowAndStampUser)
      .overrideGuard(PermissionsGuard)
      .useValue(allowAndStampUser)
      .compile();

    // The app runs on Fastify (no @nestjs/platform-express installed), so the
    // test app must use the same adapter — mirrors test/helpers/test-app.helper.ts.
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    jest.clearAllMocks();
  });

  describe('GET /nodes', () => {
    it('resolves to listNodes and passes the caller user id', async () => {
      const res = await request(app.getHttpServer()).get('/nodes').expect(200);

      expect(mockNodesService.listNodes).toHaveBeenCalledWith('user-1');
      expect(mockNodesService.getNode).not.toHaveBeenCalled();
      expect(mockNodesService.getModelManifest).not.toHaveBeenCalled();
      expect(res.body).toEqual([{ id: 'node-1', health: 'healthy' }]);
    });
  });

  describe('GET /nodes/:id', () => {
    it('resolves to getNode with (userId, id)', async () => {
      const res = await request(app.getHttpServer()).get('/nodes/abc-123').expect(200);

      expect(mockNodesService.getNode).toHaveBeenCalledWith('user-1', 'abc-123');
      expect(mockNodesService.listNodes).not.toHaveBeenCalled();
      expect(res.body).toEqual({ id: 'node-abc', health: 'healthy' });
    });
  });

  describe('GET /nodes/models/manifest', () => {
    it('resolves to getModelManifest and is NOT swallowed by GET /nodes/:id', async () => {
      const res = await request(app.getHttpServer())
        .get('/nodes/models/manifest')
        .expect(200);

      expect(mockNodesService.getModelManifest).toHaveBeenCalledTimes(1);
      // Proves the literal two-segment route won, not `:id` matching "models"
      // with "manifest" spilling over into some other handler.
      expect(mockNodesService.getNode).not.toHaveBeenCalled();
      expect(res.body).toEqual([{ name: 'foo.bin' }]);
    });
  });
});
