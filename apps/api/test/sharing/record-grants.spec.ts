/**
 * RETRO-I3 (#573), part 2: grants on `media_item` and `album` through the
 * sharing slice's `AccessPolicy`, over the real app (mocked Prisma).
 *
 * The rule under test: the owner-scope check (`OwnerAccessService`) runs
 * first and decides EVERY member exactly as before; only when it refused does
 * `RecordAccessService` ask `AccessPolicy` whether a GRANT allows the action.
 * So:
 *   - a non-member with a grant reads the record (single id, album, list);
 *   - a non-member without one keeps the 404;
 *   - a grant never lets a non-owner trash a record (`delete` needs the owner);
 *   - a bulk route asks ONE `decideMany` for the whole batch;
 *   - a member never reaches the policy (spied), so members keep today's access.
 */
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AccessPolicy } from '@marinoscar/platform-api/sharing';

import { createTestApp, closeTestApp, TestContext } from '../helpers/test-app.helper';
import { createMockContributorUser, authHeader, TestUser } from '../helpers/auth-mock.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';

const ORG = '00000000-0000-4000-8000-0000000000d0';
const CIRCLE_ID = '6f3a8a2e-1111-4a6b-9c1d-0000000000a1';
const ITEM_ID = '6f3a8a2e-2222-4a6b-9c1d-0000000000a2';
const ITEM_2 = '6f3a8a2e-2222-4a6b-9c1d-0000000000a3';
const ALBUM_ID = '6f3a8a2e-3333-4a6b-9c1d-0000000000a4';

type GrantRow = { resourceType: string; resourceId: string; role: string };

describe('Grants on media items and albums (RETRO-I3)', () => {
  let context: TestContext;
  let user: TestUser;
  let grants: GrantRow[];
  let member: 'viewer' | 'collaborator' | null;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    jest.restoreAllMocks();
    grants = [];
    member = null;
    user = await createMockContributorUser(context);
    const m = context.prismaMock;

    m.circle.findUnique.mockResolvedValue({ id: CIRCLE_ID, isPersonal: false, ownerId: randomUUID(), name: 'Circle A' });
    m.circleMember.findUnique.mockImplementation(async () =>
      member ? { circleId: CIRCLE_ID, userId: user.id, role: member, joinedAt: new Date() } : null,
    );
    const item = (id: string) => ({
      id,
      circleId: CIRCLE_ID,
      orgId: ORG,
      ownerGroupId: CIRCLE_ID,
      ownerUserId: null,
      deletedAt: null,
      archivedAt: null,
      type: 'photo',
      storageObjectId: randomUUID(),
      metadata: {},
      mediaTags: [],
    });
    m.mediaItem.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      [ITEM_ID, ITEM_2].includes(where.id) ? item(where.id) : null,
    );
    // loadOwners (owner columns) and the bulk "all in the circle" check share the delegate.
    m.mediaItem.findMany.mockImplementation(async ({ where }: { where: { id?: { in?: string[] } } }) =>
      (where?.id?.in ?? []).filter((id) => [ITEM_ID, ITEM_2].includes(id)).map(item),
    );
    m.mediaItem.updateMany.mockResolvedValue({ count: 1 });
    m.album.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === ALBUM_ID ? { id: ALBUM_ID, circleId: CIRCLE_ID, name: 'Album A', coverMediaItemId: null, items: [] } : null,
    );
    m.album.findMany.mockImplementation(async ({ where }: { where?: { id?: { in?: string[] } } }) =>
      (where?.id?.in ?? []).includes(ALBUM_ID)
        ? [{ id: ALBUM_ID, orgId: ORG, ownerGroupId: CIRCLE_ID, ownerUserId: null }]
        : [],
    );
    const named = () =>
      grants.map((g) => ({ ...g, granteeKind: 'user', granteeUserId: user.id, granteeGroupId: null, granteeRef: null }));
    m.grant.findMany.mockImplementation(async () => named());
    m.grant.groupBy.mockImplementation(async () =>
      named()
        .filter((g) => g.resourceType === 'media_item')
        .map((g) => ({ resourceId: g.resourceId })),
    );
    m.storageObject.findUnique.mockResolvedValue(null);
    m.storageObject.findMany.mockResolvedValue([]);
  });

  const get = (path: string) => request(context.app.getHttpServer()).get(path).set(authHeader(user.accessToken));

  describe('single record', () => {
    it('a non-member with no grant gets 404 on GET /api/media/:id (unchanged)', async () => {
      const res = await get(`/api/media/${ITEM_ID}`);
      expect(res.status).toBe(404);
    });

    it('a non-member with a viewer grant reads the item', async () => {
      grants.push({ resourceType: 'media_item', resourceId: ITEM_ID, role: 'viewer' });
      const res = await get(`/api/media/${ITEM_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(ITEM_ID);
    });

    it('a viewer grant does not allow a write (404, the record stays hidden for writes)', async () => {
      grants.push({ resourceType: 'media_item', resourceId: ITEM_ID, role: 'viewer' });
      const res = await request(context.app.getHttpServer())
        .patch(`/api/media/${ITEM_ID}`)
        .set(authHeader(user.accessToken))
        .send({ favorite: true });
      expect(res.status).toBe(404);
    });

    it('an editor grant allows a write', async () => {
      grants.push({ resourceType: 'media_item', resourceId: ITEM_ID, role: 'editor' });
      context.prismaMock.mediaItem.update.mockResolvedValue({ id: ITEM_ID });
      const res = await request(context.app.getHttpServer())
        .patch(`/api/media/${ITEM_ID}`)
        .set(authHeader(user.accessToken))
        .send({ favorite: true });
      expect(res.status).toBe(200);
    });

    it('no grant lets a non-owner trash the item (delete needs the owner)', async () => {
      grants.push({ resourceType: 'media_item', resourceId: ITEM_ID, role: 'editor' });
      const res = await request(context.app.getHttpServer()).delete(`/api/media/${ITEM_ID}`).set(authHeader(user.accessToken));
      expect(res.status).toBe(404);
    });

    it('an album grant opens the album, an item grant does not', async () => {
      grants.push({ resourceType: 'media_item', resourceId: ITEM_ID, role: 'viewer' });
      expect((await get(`/api/media/albums/${ALBUM_ID}`)).status).toBe(404);
      grants.push({ resourceType: 'album', resourceId: ALBUM_ID, role: 'viewer' });
      expect((await get(`/api/media/albums/${ALBUM_ID}`)).status).toBe(200);
    });
  });

  describe('members never reach the policy', () => {
    it.each(['viewer', 'collaborator'] as const)('a %s member reads without an AccessPolicy call', async (role) => {
      member = role;
      const decide = jest.spyOn(AccessPolicy.prototype, 'decide');
      const res = await get(`/api/media/${ITEM_ID}`);
      expect(res.status).toBe(200);
      expect(decide).not.toHaveBeenCalled();
    });

    it('a viewer member below editor still gets 403 without a grant', async () => {
      member = 'viewer';
      const res = await request(context.app.getHttpServer())
        .patch(`/api/media/${ITEM_ID}`)
        .set(authHeader(user.accessToken))
        .send({ favorite: true });
      expect(res.status).toBe(403);
    });

    it('a viewer member with an editor grant on the item may write it (a grant only adds)', async () => {
      member = 'viewer';
      grants.push({ resourceType: 'media_item', resourceId: ITEM_ID, role: 'editor' });
      context.prismaMock.mediaItem.update.mockResolvedValue({ id: ITEM_ID });
      const res = await request(context.app.getHttpServer())
        .patch(`/api/media/${ITEM_ID}`)
        .set(authHeader(user.accessToken))
        .send({ favorite: true });
      expect(res.status).toBe(200);
    });
  });

  describe('bulk', () => {
    const archive = () =>
      request(context.app.getHttpServer())
        .patch('/api/media/bulk/archive')
        .set(authHeader(user.accessToken))
        .send({ circleId: CIRCLE_ID, ids: [ITEM_ID, ITEM_2] });

    it('asks ONE decideMany for the whole batch and allows when every id is granted', async () => {
      grants.push({ resourceType: 'media_item', resourceId: ITEM_ID, role: 'editor' });
      grants.push({ resourceType: 'media_item', resourceId: ITEM_2, role: 'editor' });
      const decideMany = jest.spyOn(AccessPolicy.prototype, 'decideMany');
      const decide = jest.spyOn(AccessPolicy.prototype, 'decide');
      const res = await archive();
      expect(res.status).toBe(200);
      expect(decideMany).toHaveBeenCalledTimes(1);
      expect(decideMany.mock.calls[0][2]).toHaveLength(2);
      expect(decide).not.toHaveBeenCalled();
    });

    it('refuses the whole batch (404) when one id is not granted', async () => {
      grants.push({ resourceType: 'media_item', resourceId: ITEM_ID, role: 'editor' });
      expect((await archive()).status).toBe(404);
    });

    it('a member never reaches decideMany', async () => {
      member = 'collaborator';
      const decideMany = jest.spyOn(AccessPolicy.prototype, 'decideMany');
      expect((await archive()).status).toBe(200);
      expect(decideMany).not.toHaveBeenCalled();
    });
  });

  describe('lists', () => {
    it('a non-member with no grant gets 404 on GET /api/media (unchanged)', async () => {
      expect((await get(`/api/media?circleId=${CIRCLE_ID}`)).status).toBe(404);
    });

    it('a non-member with grants lists only the granted items of the scope', async () => {
      grants.push({ resourceType: 'media_item', resourceId: ITEM_ID, role: 'viewer' });
      const res = await get(`/api/media?circleId=${CIRCLE_ID}`);
      expect(res.status).toBe(200);
      const listCall = context.prismaMock.mediaItem.findMany.mock.calls.find(
        ([args]: [{ take?: number }]) => args?.take !== undefined,
      );
      expect(JSON.stringify(listCall[0].where)).toContain(ITEM_ID);
      expect(listCall[0].where.circleId).toBe(CIRCLE_ID);
    });

    it("a member's list keeps exactly today's where (no grant filter, no grant query)", async () => {
      member = 'viewer';
      const res = await get(`/api/media?circleId=${CIRCLE_ID}`);
      expect(res.status).toBe(200);
      const listCall = context.prismaMock.mediaItem.findMany.mock.calls.find(
        ([args]: [{ take?: number }]) => args?.take !== undefined,
      );
      expect(listCall[0].where).toEqual({ circleId: CIRCLE_ID, deletedAt: null, AND: [{ archivedAt: null }] });
      expect(context.prismaMock.grant.groupBy).not.toHaveBeenCalled();
    });
  });

  describe('shared with me (RETRO-I6 #588)', () => {
    it('lists nothing (200, empty page) when nothing is shared', async () => {
      const res = await get('/api/media/shared-with-me');
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.meta.totalItems).toBe(0);
    });

    it('lists the granted items across libraries, with no owner scope filter', async () => {
      grants.push({ resourceType: 'media_item', resourceId: ITEM_ID, role: 'viewer' });
      context.prismaMock.mediaItem.count.mockResolvedValue(1);
      const res = await get('/api/media/shared-with-me?page=1&pageSize=10');
      expect(res.status).toBe(200);
      const listCall = context.prismaMock.mediaItem.findMany.mock.calls.find(
        ([args]: [{ take?: number }]) => args?.take === 10,
      );
      expect(JSON.stringify(listCall[0].where)).toContain(ITEM_ID);
      expect(JSON.stringify(listCall[0].where)).not.toContain('circleId');
    });

    it('lists the granted albums', async () => {
      grants.push({ resourceType: 'album', resourceId: ALBUM_ID, role: 'viewer' });
      context.prismaMock.grant.groupBy.mockResolvedValue([{ resourceId: ALBUM_ID }]);
      context.prismaMock.album.count.mockResolvedValue(1);
      context.prismaMock.mediaItem.aggregate.mockResolvedValue({ _count: { _all: 0 }, _min: { capturedAt: null }, _max: { capturedAt: null } });
      const res = await get('/api/media/albums/shared-with-me');
      expect(res.status).toBe(200);
      const listCall = context.prismaMock.album.findMany.mock.calls.find(
        ([args]: [{ take?: number }]) => args?.take !== undefined,
      );
      expect(JSON.stringify(listCall[0].where)).toContain(ALBUM_ID);
    });
  });
});
