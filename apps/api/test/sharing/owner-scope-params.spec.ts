/**
 * RETRO-I3 (#573): the owner-scope request parameters `ownerGroupId` and
 * `scope=me`, with `circleId` kept as a deprecated alias.
 *
 *   1. the rewrite rules (`rewriteOwnerScope`, `isUntouchedPath`);
 *   2. through the real app: a route that reads `circleId` takes either new
 *      form, unchanged routes still take `circleId`, conflicts are 400;
 *   3. the OpenAPI pass documents both forms and deprecates `circleId`.
 */
import request from 'supertest';
import { randomUUID } from 'crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import {
  isUntouchedPath,
  rewriteOwnerScope,
} from '../../src/platform/sharing/owner-scope-params';
import { applyOwnerScopeParams } from '../../src/openapi/owner-scope-params';
import { createTestApp, closeTestApp, TestContext } from '../helpers/test-app.helper';
import { createMockContributorUser, authHeader } from '../helpers/auth-mock.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';

const GROUP = '6f3a8a2e-1111-4a6b-9c1d-0000000000b1';
const PERSONAL = '6f3a8a2e-1111-4a6b-9c1d-0000000000b2';

describe('rewriteOwnerScope', () => {
  const personal = async () => PERSONAL;

  it('ownerGroupId becomes circleId', async () => {
    const p: Record<string, unknown> = { ownerGroupId: GROUP, page: '1' };
    await rewriteOwnerScope(p, personal);
    expect(p).toEqual({ circleId: GROUP, page: '1' });
  });

  it('scope=me becomes the personal library id', async () => {
    const p: Record<string, unknown> = { scope: 'me' };
    await rewriteOwnerScope(p, personal);
    expect(p).toEqual({ circleId: PERSONAL });
  });

  it('the same id twice is fine; two different ids are 400', async () => {
    const same: Record<string, unknown> = { ownerGroupId: GROUP, circleId: GROUP };
    await rewriteOwnerScope(same, personal);
    expect(same).toEqual({ circleId: GROUP });
    await expect(rewriteOwnerScope({ ownerGroupId: GROUP, circleId: PERSONAL }, personal)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(rewriteOwnerScope({ ownerGroupId: GROUP, scope: 'me' }, personal)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('scope=me with no personal library is 404', async () => {
    await expect(rewriteOwnerScope({ scope: 'me' }, async () => null)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('another scope value is left alone (a route of its own, e.g. scope=mine)', async () => {
    const p: Record<string, unknown> = { scope: 'mine' };
    await rewriteOwnerScope(p, personal);
    expect(p).toEqual({ scope: 'mine' });
  });

  it("never rewrites the platform's own routes", () => {
    expect(isUntouchedPath('/api/groups/abc/members?ownerGroupId=x')).toBe(true);
    expect(isUntouchedPath('/api/grants')).toBe(true);
    expect(isUntouchedPath('/api/media?ownerGroupId=x')).toBe(false);
    expect(isUntouchedPath('/api/groupsx')).toBe(false);
  });
});

describe('owner-scope parameters through the app (RETRO-I3)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
  });

  async function asMemberOf(scopeId: string, personal: boolean) {
    const user = await createMockContributorUser(context);
    const m = context.prismaMock;
    m.circle.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === scopeId ? { id: scopeId, isPersonal: personal, ownerId: personal ? user.id : randomUUID() } : null,
    );
    m.circle.findFirst.mockImplementation(async ({ where }: { where: { ownerId: string; isPersonal: boolean } }) =>
      where.ownerId === user.id && where.isPersonal ? { id: PERSONAL } : null,
    );
    m.circleMember.findUnique.mockResolvedValue({ circleId: scopeId, userId: user.id, role: 'viewer', joinedAt: new Date() });
    m.album.findMany.mockResolvedValue([]);
    m.album.count.mockResolvedValue(0);
    return user;
  }

  const albumsWhere = () => context.prismaMock.album.findMany.mock.calls.at(-1)?.[0]?.where;

  it.each([
    ['ownerGroupId', `ownerGroupId=${GROUP}`],
    ['circleId (deprecated alias)', `circleId=${GROUP}`],
  ])('GET /api/media/albums takes %s', async (_label, query) => {
    const user = await asMemberOf(GROUP, false);
    const res = await request(context.app.getHttpServer()).get(`/api/media/albums?${query}`).set(authHeader(user.accessToken));
    expect(res.status).toBe(200);
    expect(albumsWhere()).toEqual({ circleId: GROUP });
  });

  it('GET /api/media/albums?scope=me lists the personal library', async () => {
    const user = await asMemberOf(PERSONAL, true);
    const res = await request(context.app.getHttpServer()).get('/api/media/albums?scope=me').set(authHeader(user.accessToken));
    expect(res.status).toBe(200);
    expect(albumsWhere()).toEqual({ circleId: PERSONAL });
  });

  it('a JSON body takes ownerGroupId too (POST /api/media/albums)', async () => {
    const user = await asMemberOf(GROUP, false);
    context.prismaMock.circleMember.findUnique.mockResolvedValue({
      circleId: GROUP,
      userId: user.id,
      role: 'collaborator',
      joinedAt: new Date(),
    });
    context.prismaMock.album.create.mockResolvedValue({ id: randomUUID(), circleId: GROUP, name: 'Album A' });
    const res = await request(context.app.getHttpServer())
      .post('/api/media/albums')
      .set(authHeader(user.accessToken))
      .send({ ownerGroupId: GROUP, name: 'Album A' });
    expect(res.status).toBe(201);
    expect(context.prismaMock.album.create.mock.calls[0][0].data.circleId).toBe(GROUP);
  });

  it('conflicting ownerGroupId and circleId is 400', async () => {
    const user = await asMemberOf(GROUP, false);
    const res = await request(context.app.getHttpServer())
      .get(`/api/media/albums?ownerGroupId=${GROUP}&circleId=${PERSONAL}`)
      .set(authHeader(user.accessToken));
    expect(res.status).toBe(400);
  });

  it('a non-member naming the scope by ownerGroupId still gets 404', async () => {
    const user = await asMemberOf(GROUP, false);
    context.prismaMock.circleMember.findUnique.mockResolvedValue(null);
    const res = await request(context.app.getHttpServer()).get(`/api/media/albums?ownerGroupId=${GROUP}`).set(authHeader(user.accessToken));
    expect(res.status).toBe(404);
  });
});

describe('applyOwnerScopeParams (OpenAPI)', () => {
  function doc() {
    return {
      paths: {
        '/media': {
          get: {
            parameters: [{ name: 'circleId', in: 'query', required: true, schema: { type: 'string' } }],
          },
        },
        '/shares': { get: { parameters: [{ name: 'scope', in: 'query', schema: { type: 'string', enum: ['mine', 'all'] } }] } },
        '/media/albums': {
          post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateAlbumDto' } } } } },
        },
      },
      components: {
        schemas: {
          CreateAlbumDto: {
            type: 'object',
            properties: { circleId: { type: 'string' }, name: { type: 'string' } },
            required: ['circleId', 'name'],
          },
        },
      },
    };
  }

  it('deprecates circleId and adds ownerGroupId and scope=me, in query and body', () => {
    const d = doc();
    applyOwnerScopeParams(d as never);
    const params = d.paths['/media'].get.parameters as Array<Record<string, unknown>>;
    expect(params.find((p) => p.name === 'circleId')).toMatchObject({ deprecated: true, required: false });
    expect(params.map((p) => p.name)).toEqual(['circleId', 'ownerGroupId', 'scope']);
    const body = d.components.schemas.CreateAlbumDto as Record<string, any>;
    expect(body.required).toEqual(['name']);
    expect(body.properties.circleId.deprecated).toBe(true);
    expect(body.properties.ownerGroupId.format).toBe('uuid');
    expect(body.properties.scope.enum).toEqual(['me']);
  });

  it('leaves an operation without circleId alone and is idempotent', () => {
    const d = doc();
    applyOwnerScopeParams(d as never);
    const once = JSON.stringify(d);
    applyOwnerScopeParams(d as never);
    expect(JSON.stringify(d)).toBe(once);
    expect(d.paths['/shares'].get.parameters).toEqual([{ name: 'scope', in: 'query', schema: { type: 'string', enum: ['mine', 'all'] } }]);
  });
});
