/**
 * Route-dispatch tests for NodeCredentialsController (/node-credentials) and
 * the credential routes on NodesAdminController (/admin/nodes/credentials).
 *
 * Mirrors nodes.controller.spec.ts: exercises NestJS's ACTUAL compiled route
 * table via supertest on the Fastify adapter, so we empirically verify:
 *
 *  - POST/GET/DELETE on /node-credentials delegate owner-scoped to
 *    NodeCredentialService (createCredential/listForUser/revoke).
 *  - GET /admin/nodes/credentials and DELETE /admin/nodes/credentials/:id are
 *    NOT swallowed by the earlier-registered DELETE /admin/nodes/:id param
 *    route (the literal 'credentials' routes are declared before it).
 *  - Neither response ever contains the raw token hash.
 *
 * Auth is stubbed by overriding the guards (RBAC enforcement is covered by
 * the guards' own unit tests); the point of this file is route matching.
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { NodeCredentialsController } from './node-credentials.controller';
import { NodesAdminController } from './nodes-admin.controller';
import { NodeCredentialService } from './node-credential.service';
import { NodesService } from './nodes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';

const FAKE_USER = { id: 'user-1', email: 'user-1@example.com', roles: [], permissions: [] };

/** Guard override: always activates and stamps a fake user onto the request. */
const allowAndStampUser = {
  canActivate: (ctx: import('@nestjs/common').ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    req.user = FAKE_USER;
    return true;
  },
};

const CRED_UUID = '4c2f7a52-1111-4f7d-9c58-2f4a9e2f0abc';
const NODE_UUID = '9d8e6b41-2222-4a3c-8d17-5e6f7a8b9c0d';

function makeMockCredentialService() {
  return {
    createCredential: jest.fn().mockResolvedValue({
      token: 'nod_rawtoken',
      id: CRED_UUID,
      name: 'My node',
      tokenPrefix: 'nod_ab12',
      expiresAt: null,
      createdAt: '2026-07-16T00:00:00.000Z',
    }),
    listForUser: jest.fn().mockResolvedValue([
      {
        id: CRED_UUID,
        name: 'My node',
        tokenPrefix: 'nod_ab12',
        expiresAt: null,
        lastUsedAt: null,
        createdAt: new Date('2026-07-16T00:00:00.000Z'),
        revokedAt: null,
      },
    ]),
    revoke: jest.fn().mockResolvedValue(undefined),
    listAll: jest.fn().mockResolvedValue([
      {
        id: CRED_UUID,
        userId: 'user-1',
        name: 'My node',
        tokenPrefix: 'nod_ab12',
        expiresAt: null,
        lastUsedAt: null,
        createdAt: new Date('2026-07-16T00:00:00.000Z'),
        revokedAt: null,
        ownerEmail: 'owner@example.com',
        ownerDisplayName: 'Owner',
      },
    ]),
    revokeAny: jest.fn().mockResolvedValue(undefined),
  };
}

function makeMockNodesService() {
  return {
    listNodes: jest.fn().mockResolvedValue([]),
    deleteNode: jest.fn().mockResolvedValue({ deleted: true }),
  };
}

describe('Node credential controllers — route dispatch (supertest)', () => {
  let app: NestFastifyApplication;
  let mockCredentialService: ReturnType<typeof makeMockCredentialService>;
  let mockNodesService: ReturnType<typeof makeMockNodesService>;

  beforeEach(async () => {
    mockCredentialService = makeMockCredentialService();
    mockNodesService = makeMockNodesService();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [NodeCredentialsController, NodesAdminController],
      providers: [
        { provide: NodeCredentialService, useValue: mockCredentialService },
        { provide: NodesService, useValue: mockNodesService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(allowAndStampUser)
      .overrideGuard(RolesGuard)
      .useValue(allowAndStampUser)
      .overrideGuard(PermissionsGuard)
      .useValue(allowAndStampUser)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // User-facing /node-credentials
  // ---------------------------------------------------------------------------

  describe('POST /node-credentials', () => {
    it('creates a credential for the caller and returns the raw token once', async () => {
      const res = await request(app.getHttpServer())
        .post('/node-credentials')
        .send({ name: 'My node' })
        .expect(201);

      expect(mockCredentialService.createCredential).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ name: 'My node' }),
      );
      expect(res.body).toMatchObject({
        token: 'nod_rawtoken',
        id: CRED_UUID,
        tokenPrefix: 'nod_ab12',
        expiresAt: null,
      });
    });

    it('passes an optional expiresAt through to the service', async () => {
      await request(app.getHttpServer())
        .post('/node-credentials')
        .send({ name: 'Expiring node', expiresAt: '2027-01-01T00:00:00.000Z' })
        .expect(201);

      expect(mockCredentialService.createCredential).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ expiresAt: '2027-01-01T00:00:00.000Z' }),
      );
    });
  });

  describe('GET /node-credentials', () => {
    it('lists the caller\'s credentials without hash or raw token', async () => {
      const res = await request(app.getHttpServer()).get('/node-credentials').expect(200);

      expect(mockCredentialService.listForUser).toHaveBeenCalledWith('user-1');
      expect(res.body).toEqual([
        {
          id: CRED_UUID,
          name: 'My node',
          tokenPrefix: 'nod_ab12',
          expiresAt: null,
          lastUsedAt: null,
          createdAt: '2026-07-16T00:00:00.000Z',
          revokedAt: null,
        },
      ]);
      expect(JSON.stringify(res.body)).not.toContain('tokenHash');
    });
  });

  describe('DELETE /node-credentials/:id', () => {
    it('revokes owner-scoped and returns 204', async () => {
      await request(app.getHttpServer())
        .delete(`/node-credentials/${CRED_UUID}`)
        .expect(204);

      expect(mockCredentialService.revoke).toHaveBeenCalledWith('user-1', CRED_UUID);
    });
  });

  // ---------------------------------------------------------------------------
  // Admin /admin/nodes/credentials — must not be captured by /admin/nodes/:id
  // ---------------------------------------------------------------------------

  describe('GET /admin/nodes/credentials', () => {
    it('resolves to listAll with owner annotations (not the fleet list)', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/nodes/credentials')
        .expect(200);

      expect(mockCredentialService.listAll).toHaveBeenCalledTimes(1);
      expect(mockNodesService.listNodes).not.toHaveBeenCalled();
      expect(res.body).toEqual([
        expect.objectContaining({
          id: CRED_UUID,
          ownerEmail: 'owner@example.com',
          ownerDisplayName: 'Owner',
        }),
      ]);
    });
  });

  describe('DELETE /admin/nodes/credentials/:id', () => {
    it('resolves to revokeAny and is NOT swallowed by DELETE /admin/nodes/:id', async () => {
      await request(app.getHttpServer())
        .delete(`/admin/nodes/credentials/${CRED_UUID}`)
        .expect(204);

      expect(mockCredentialService.revokeAny).toHaveBeenCalledWith(CRED_UUID);
      // Proves the literal 'credentials/:id' route won, not ':id' matching
      // "credentials" and deleting a node.
      expect(mockNodesService.deleteNode).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /admin/nodes/:id (regression)', () => {
    it('still resolves to deleteNode for plain node ids', async () => {
      await request(app.getHttpServer())
        .delete(`/admin/nodes/${NODE_UUID}`)
        .expect(200);

      expect(mockNodesService.deleteNode).toHaveBeenCalledWith(NODE_UUID);
      expect(mockCredentialService.revokeAny).not.toHaveBeenCalled();
    });
  });
});
