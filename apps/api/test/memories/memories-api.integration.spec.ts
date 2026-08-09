/**
 * Memories API integration (epic #300, issue #307)
 *
 * Boots the REAL AppModule over a mocked PrismaService
 * (`createTestApp({ useMockDatabase: true })`), which is the right harness for
 * what this suite is about: routing, guards, the RBAC matrix, status codes and
 * the projection/ordering logic the service performs in memory. None of that
 * needs real SQL, and every assertion here runs in CI without a database.
 *
 * The DB-level guarantees this feature leans on — the natural-key unique index
 * spanning tombstoned rows, the cascades — are already covered by the DB-gated
 * `test/memories/memories.integration.spec.ts` from issue #301.
 *
 * What is proven here:
 *   - the feature flag OFF (the default) returns EMPTY lists, not errors, and
 *     404s the per-id routes — the epic's "zero cost when off" criterion;
 *   - the RBAC matrix: viewer reads and writes state but cannot delete or
 *     save-as-album; collaborator can; a non-member gets 404, never 403;
 *   - keyset pagination shape and the raw-page cursor rule;
 *   - the tombstone and active-expiry filters reach every query;
 *   - per-user preference filtering (hidden person + overlapping date range);
 *   - feed ordering: today's on_this_day → unseen → seen, capped at 10;
 *   - save-as-album reuses the album service path, in memory order, with cover.
 */

import request from 'supertest';
import { randomUUID } from 'crypto';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import {
  setupBaseMocks,
  setupMockUserSettings,
} from '../fixtures/mock-setup.helper';
import {
  createMockContributorUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { MediaThumbnailService } from '../../src/media/media-thumbnail.service';

const CIRCLE_ID = '5c1c1e00-0000-4000-8000-000000000001';
const OTHER_CIRCLE_ID = '5c1c1e00-0000-4000-8000-000000000002';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupCircleMocks(
  context: TestContext,
  userId: string,
  circleId: string,
  role: string,
): void {
  context.prismaMock.circle.findUnique.mockResolvedValue({ id: circleId });
  context.prismaMock.circleMember.findUnique.mockImplementation(
    async ({ where }: any) =>
      where?.circleId_userId?.circleId === circleId &&
      where?.circleId_userId?.userId === userId
        ? { circleId, userId, role, joinedAt: new Date() }
        : null,
  );
}

/** Enable features.memories and bust the SystemSettingsService 5 s cache. */
function enableMemories(context: TestContext): void {
  context.prismaMock.systemSettings.findUnique.mockResolvedValue({
    id: 'settings-1',
    key: 'global',
    value: {
      ...DEFAULT_SYSTEM_SETTINGS,
      features: { ...DEFAULT_SYSTEM_SETTINGS.features, memories: true },
    },
    version: 1,
    updatedAt: new Date(),
    updatedByUserId: null,
    updatedByUser: null,
  } as any);
  (context.module.get(SystemSettingsService) as any).settingsCache = null;
}

/** The default: the flag is off. */
function disableMemories(context: TestContext): void {
  context.prismaMock.systemSettings.findUnique.mockResolvedValue({
    id: 'settings-1',
    key: 'global',
    value: { ...DEFAULT_SYSTEM_SETTINGS },
    version: 1,
    updatedAt: new Date(),
    updatedByUserId: null,
    updatedByUser: null,
  } as any);
  (context.module.get(SystemSettingsService) as any).settingsCache = null;
}

function makeMemoryRow(overrides: Record<string, any> = {}) {
  const now = new Date();
  return {
    id: randomUUID(),
    circleId: CIRCLE_ID,
    type: 'trip',
    periodKey: '2023-03-12',
    subjectKey: 'guanacaste',
    personId: null,
    title: 'Trip to Guanacaste',
    subtitle: 'March 2023',
    narrative: null,
    titleSource: 'template',
    titleModel: null,
    coverMediaItemId: null,
    periodStart: new Date('2023-03-12T00:00:00.000Z'),
    periodEnd: new Date('2023-03-16T00:00:00.000Z'),
    itemCount: 12,
    meta: null,
    generatedAt: now,
    refreshedAt: now,
    expiresAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    // Relation payloads the card projection selects.
    coverMediaItem: null,
    userStates: [],
    items: [],
    ...overrides,
  };
}

describe('Memories API (issue #307)', () => {
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
    jest.clearAllMocks();
  });

  // =========================================================================
  // Feature flag — the default-off contract
  // =========================================================================

  describe('feature flag off (default)', () => {
    it('GET /api/memories returns an empty page, not an error', async () => {
      disableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');

      const res = await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.meta).toEqual({
        pageSize: 20,
        nextCursor: null,
        hasMore: false,
      });
    });

    it('costs ZERO memory queries when off', async () => {
      disableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');

      await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(context.prismaMock.memory.findMany).not.toHaveBeenCalled();
      // The gate is checked BEFORE the circle-access check, so not even the
      // membership lookups run.
      expect(context.prismaMock.circleMember.findUnique).not.toHaveBeenCalled();
    });

    it('GET /api/memories/feed returns an empty list', async () => {
      disableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');

      const res = await request(context.app.getHttpServer())
        .get(`/api/memories/feed?circleId=${CIRCLE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data.items).toEqual([]);
      expect(context.prismaMock.memory.findMany).not.toHaveBeenCalled();
    });

    it('GET /api/memories/:id 404s while the feature is off', async () => {
      disableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');

      await request(context.app.getHttpServer())
        .get(`/api/memories/${randomUUID()}`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(context.prismaMock.memory.findFirst).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Auth
  // =========================================================================

  describe('authentication', () => {
    it('401s without a token', async () => {
      await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}`)
        .expect(401);
    });

    it('400s on a non-uuid circleId', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .get('/api/memories?circleId=not-a-uuid')
        .set(authHeader(user.accessToken))
        .expect(400);
    });
  });

  // =========================================================================
  // GET /api/memories — filters, keyset, tombstone
  // =========================================================================

  describe('GET /api/memories', () => {
    it('excludes tombstoned, expired and per-user hidden rows in SQL', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      context.prismaMock.memory.findMany.mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      const where = context.prismaMock.memory.findMany.mock.calls[0][0].where;
      expect(where.circleId).toBe(CIRCLE_ID);
      expect(where.deletedAt).toBeNull();
      // Active filter: expiresAt IS NULL OR expiresAt > now()
      expect(where.OR).toEqual([
        { expiresAt: null },
        { expiresAt: { gt: expect.any(Date) } },
      ]);
      expect(where.NOT).toEqual({
        userStates: { some: { userId: user.id, hiddenAt: { not: null } } },
      });
    });

    it('orders by (generatedAt DESC, id DESC) and takes pageSize + 1', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      context.prismaMock.memory.findMany.mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}&pageSize=5`)
        .set(authHeader(user.accessToken))
        .expect(200);

      const args = context.prismaMock.memory.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([{ generatedAt: 'desc' }, { id: 'desc' }]);
      expect(args.take).toBe(6);
      expect(args.cursor).toBeUndefined();
    });

    it('applies the cursor with skip: 1', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      context.prismaMock.memory.findMany.mockResolvedValue([]);
      const cursor = randomUUID();

      await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}&cursor=${cursor}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      const args = context.prismaMock.memory.findMany.mock.calls[0][0];
      expect(args.cursor).toEqual({ id: cursor });
      expect(args.skip).toBe(1);
    });

    it('returns hasMore + nextCursor from the last row of the page', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');

      const rows = [makeMemoryRow(), makeMemoryRow(), makeMemoryRow()];
      context.prismaMock.memory.findMany.mockResolvedValue(rows);

      const res = await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}&pageSize=2`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data.items).toHaveLength(2);
      expect(res.body.data.meta.hasMore).toBe(true);
      expect(res.body.data.meta.nextCursor).toBe(rows[1].id);
      // No COUNT anywhere in keyset mode.
      expect(context.prismaMock.memory.count).not.toHaveBeenCalled();
    });

    it('keeps nextCursor from the RAW page even when every row is preference-hidden', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      const personId = randomUUID();
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { useProviderImage: true },
        memories: { hiddenPersonIds: [personId] },
      });

      const rows = [
        makeMemoryRow({ type: 'person_highlights', personId }),
        makeMemoryRow({ type: 'person_highlights', personId }),
        makeMemoryRow({ type: 'person_highlights', personId }),
      ];
      context.prismaMock.memory.findMany.mockResolvedValue(rows);

      const res = await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}&pageSize=2`)
        .set(authHeader(user.accessToken))
        .expect(200);

      // Everything filtered out of THIS page...
      expect(res.body.data.items).toEqual([]);
      // ...but pagination can still continue past it.
      expect(res.body.data.meta.hasMore).toBe(true);
      expect(res.body.data.meta.nextCursor).toBe(rows[1].id);
    });

    it('compiles ?year= to a period-range overlap', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      context.prismaMock.memory.findMany.mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}&year=2023`)
        .set(authHeader(user.accessToken))
        .expect(200);

      const where = context.prismaMock.memory.findMany.mock.calls[0][0].where;
      expect(where.periodStart).toEqual({ lt: new Date('2024-01-01T00:00:00.000Z') });
      expect(where.periodEnd).toEqual({ gte: new Date('2023-01-01T00:00:00.000Z') });
    });

    it('narrows to the caller\'s own favorites with ?favorite=true', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      context.prismaMock.memory.findMany.mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}&favorite=true`)
        .set(authHeader(user.accessToken))
        .expect(200);

      const where = context.prismaMock.memory.findMany.mock.calls[0][0].where;
      expect(where.userStates).toEqual({
        some: { userId: user.id, favoritedAt: { not: null } },
      });
    });

    it('passes ?type= straight through', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      context.prismaMock.memory.findMany.mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}&type=year_in_review`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(
        context.prismaMock.memory.findMany.mock.calls[0][0].where.type,
      ).toBe('year_in_review');
    });

    it('400s on an unknown type', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}&type=not_a_type`)
        .set(authHeader(user.accessToken))
        .expect(400);
    });

    it('403s a non-member (a circle-scoped list is not enumeration-sensitive)', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      context.prismaMock.circle.findUnique.mockResolvedValue({ id: CIRCLE_ID });
      context.prismaMock.circleMember.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(403);
    });

    it('signs cover thumbnails with ONE batched storageObject query', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');

      const rows = [1, 2, 3].map((n) =>
        makeMemoryRow({
          coverMediaItemId: randomUUID(),
          coverMediaItem: {
            id: randomUUID(),
            metadata: { thumbnailStorageKey: `thumbnails/cover-${n}.jpg` },
          },
        }),
      );
      context.prismaMock.memory.findMany.mockResolvedValue(rows);
      context.prismaMock.storageObject.findMany.mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      // Batched: one findMany for three covers, and never a per-item findUnique.
      expect(context.prismaMock.storageObject.findMany).toHaveBeenCalledTimes(1);
      expect(
        context.prismaMock.storageObject.findMany.mock.calls[0][0].where
          .storageKey.in,
      ).toHaveLength(3);
      expect(context.prismaMock.storageObject.findUnique).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Preference filtering
  // =========================================================================

  describe('per-user preference filtering', () => {
    it('drops memories keyed to a hidden person', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      const hidden = randomUUID();
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { useProviderImage: true },
        memories: { hiddenPersonIds: [hidden] },
      });

      const kept = makeMemoryRow({ title: 'Kept' });
      context.prismaMock.memory.findMany.mockResolvedValue([
        makeMemoryRow({ type: 'person_highlights', personId: hidden, title: 'Dropped' }),
        kept,
      ]);

      const res = await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data.items.map((m: any) => m.title)).toEqual(['Kept']);
    });

    it('drops memories whose period OVERLAPS a sensitive range (partial hit counts)', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { useProviderImage: true },
        memories: {
          hiddenDateRanges: [{ from: '2023-03-15', to: '2023-03-20' }],
        },
      });

      context.prismaMock.memory.findMany.mockResolvedValue([
        // 2023-03-12 .. 2023-03-16 — overlaps the range only at its tail.
        makeMemoryRow({ title: 'Overlapping' }),
        makeMemoryRow({
          title: 'Before',
          periodStart: new Date('2023-01-01T00:00:00.000Z'),
          periodEnd: new Date('2023-01-05T00:00:00.000Z'),
        }),
      ]);

      const res = await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data.items.map((m: any) => m.title)).toEqual(['Before']);
    });

    it('treats a hidden range as INCLUSIVE of its `to` day', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { useProviderImage: true },
        memories: {
          hiddenDateRanges: [{ from: '2023-06-01', to: '2023-06-01' }],
        },
      });

      context.prismaMock.memory.findMany.mockResolvedValue([
        makeMemoryRow({
          title: 'On the single hidden day',
          periodStart: new Date('2023-06-01T18:00:00.000Z'),
          periodEnd: new Date('2023-06-01T22:00:00.000Z'),
        }),
      ]);

      const res = await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data.items).toEqual([]);
    });

    it('filters ONLY that user — another member still sees the memory', async () => {
      enableMemories(context);
      const other = await createMockViewerUser(context, 'other@example.test');
      setupCircleMocks(context, other.id, CIRCLE_ID, 'viewer');
      // No `memories` namespace for this user: absent means no preference.
      context.prismaMock.memory.findMany.mockResolvedValue([
        makeMemoryRow({ type: 'person_highlights', personId: randomUUID() }),
      ]);

      const res = await request(context.app.getHttpServer())
        .get(`/api/memories?circleId=${CIRCLE_ID}`)
        .set(authHeader(other.accessToken))
        .expect(200);

      expect(res.body.data.items).toHaveLength(1);
    });

    it('does NOT apply preference filters to detail (direct links keep working)', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      const hidden = randomUUID();
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { useProviderImage: true },
        memories: { hiddenPersonIds: [hidden] },
      });

      const row = makeMemoryRow({ type: 'person_highlights', personId: hidden });
      context.prismaMock.memory.findFirst.mockResolvedValue(row);

      const res = await request(context.app.getHttpServer())
        .get(`/api/memories/${row.id}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data.id).toBe(row.id);
    });
  });

  // =========================================================================
  // GET /api/memories/feed
  // =========================================================================

  describe('GET /api/memories/feed', () => {
    it("orders today's on_this_day (closest year first) → unseen → seen, capped at 10", async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');

      const today = [
        makeMemoryRow({ title: 'otd-9', type: 'on_this_day', meta: { yearsAgo: 9 } }),
        makeMemoryRow({ title: 'otd-1', type: 'on_this_day', meta: { yearsAgo: 1 } }),
      ];
      const rest = [
        makeMemoryRow({ title: 'seen-a', userStates: [{ seenAt: new Date(), hiddenAt: null, favoritedAt: null }] }),
        makeMemoryRow({ title: 'unseen-a' }),
        makeMemoryRow({ title: 'unseen-b' }),
      ];
      context.prismaMock.memory.findMany
        .mockResolvedValueOnce(today)
        .mockResolvedValueOnce(rest);

      const res = await request(context.app.getHttpServer())
        .get(`/api/memories/feed?circleId=${CIRCLE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data.items.map((m: any) => m.title)).toEqual([
        'otd-1',
        'otd-9',
        'unseen-a',
        'unseen-b',
        'seen-a',
      ]);
    });

    it('caps the feed at 10 cards', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');

      context.prismaMock.memory.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(
          Array.from({ length: 25 }, (_, i) => makeMemoryRow({ title: `m-${i}` })),
        );

      const res = await request(context.app.getHttpServer())
        .get(`/api/memories/feed?circleId=${CIRCLE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data.items).toHaveLength(10);
    });

    it('returns up to four item thumbnails per card, signed in ONE batched call', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');

      // Stub the signer rather than the storage layer: this suite's app boots
      // with the REAL storage provider (unconfigured), so a genuine signing
      // attempt resolves to null and would hide the batching contract being
      // asserted here.
      const thumbs = context.module.get(MediaThumbnailService);
      const signSpy = jest
        .spyOn(thumbs, 'signThumbsBatched')
        .mockImplementation(async (keys: string[]) =>
          new Map(keys.map((k) => [k, `https://signed.test/${k}`])),
        );

      const withItems = makeMemoryRow({
        coverMediaItemId: randomUUID(),
        coverMediaItem: {
          id: randomUUID(),
          metadata: { thumbnailStorageKey: 'thumbnails/cover.jpg' },
        },
        items: [1, 2, 3, 4].map((n) => ({
          mediaItem: { metadata: { thumbnailStorageKey: `thumbnails/i-${n}.jpg` } },
        })),
      });
      context.prismaMock.memory.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([withItems]);

      const res = await request(context.app.getHttpServer())
        .get(`/api/memories/feed?circleId=${CIRCLE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data.items[0].coverThumbnailUrl).toBe(
        'https://signed.test/thumbnails/cover.jpg',
      );
      expect(res.body.data.items[0].itemThumbnailUrls).toEqual([
        'https://signed.test/thumbnails/i-1.jpg',
        'https://signed.test/thumbnails/i-2.jpg',
        'https://signed.test/thumbnails/i-3.jpg',
        'https://signed.test/thumbnails/i-4.jpg',
      ]);

      // THE contract: cover + every item thumbnail signed in a SINGLE call.
      expect(signSpy).toHaveBeenCalledTimes(1);
      expect(signSpy.mock.calls[0][0]).toHaveLength(5);

      // The DB is asked for exactly four, so the fan never over-fetches.
      const itemsArg = context.prismaMock.memory.findMany.mock.calls[1][0].select.items;
      expect(itemsArg.take).toBe(4);
      expect(itemsArg.orderBy).toEqual({ position: 'asc' });

      signSpy.mockRestore();
    });

    it("excludes today's on_this_day rows from the 'rest' query so they cannot double-appear", async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      context.prismaMock.memory.findMany.mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .get(`/api/memories/feed?circleId=${CIRCLE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      const todayKey = new Date().toISOString().slice(0, 10);
      const todayWhere = context.prismaMock.memory.findMany.mock.calls[0][0].where;
      expect(todayWhere.type).toBe('on_this_day');
      expect(todayWhere.periodKey).toBe(todayKey);

      const restWhere = context.prismaMock.memory.findMany.mock.calls[1][0].where;
      expect(restWhere.NOT).toEqual([
        { AND: [{ type: 'on_this_day' }, { periodKey: todayKey }] },
      ]);
    });
  });

  // =========================================================================
  // GET /api/memories/:id
  // =========================================================================

  describe('GET /api/memories/:id', () => {
    it('returns detail with ordered items and myState', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');

      const row = makeMemoryRow({ narrative: 'Four days on the Pacific coast.' });
      context.prismaMock.memory.findFirst.mockResolvedValue(row);
      context.prismaMock.memory.findFirst.mockResolvedValueOnce(row);
      const mediaItemId = randomUUID();
      context.prismaMock.memory.findFirst.mockResolvedValue({
        ...row,
        userStates: [{ seenAt: new Date(), hiddenAt: null, favoritedAt: new Date() }],
        items: [
          {
            id: randomUUID(),
            mediaItemId,
            position: 0,
            mediaItem: {
              type: 'photo',
              width: 4032,
              height: 3024,
              durationMs: null,
              capturedAt: new Date('2023-03-12T10:00:00.000Z'),
              metadata: null,
            },
          },
        ],
      });

      const res = await request(context.app.getHttpServer())
        .get(`/api/memories/${row.id}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data.narrative).toBe('Four days on the Pacific coast.');
      expect(res.body.data.myState).toEqual({
        seen: true,
        hidden: false,
        favorited: true,
      });
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0]).toMatchObject({
        mediaItemId,
        position: 0,
        mediaType: 'photo',
        width: 4032,
        thumbnailUrl: null,
      });
      const itemsArg =
        context.prismaMock.memory.findFirst.mock.calls.at(-1)[0].include.items;
      expect(itemsArg.orderBy).toEqual({ position: 'asc' });
    });

    it('404s a tombstoned memory (the query filters deletedAt)', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      // The service filters deletedAt IS NULL, so the DB returns nothing.
      context.prismaMock.memory.findFirst.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get(`/api/memories/${randomUUID()}`)
        .set(authHeader(user.accessToken))
        .expect(404);

      const where = context.prismaMock.memory.findFirst.mock.calls[0][0].where;
      expect(where.deletedAt).toBeNull();
      expect(where.OR).toEqual([
        { expiresAt: null },
        { expiresAt: { gt: expect.any(Date) } },
      ]);
    });

    it('404s — NOT 403 — for a memory in a circle the caller is not a member of', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      const row = makeMemoryRow({ circleId: OTHER_CIRCLE_ID });
      context.prismaMock.memory.findFirst.mockResolvedValue(row);
      context.prismaMock.circleMember.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get(`/api/memories/${row.id}`)
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });

  // =========================================================================
  // Per-user state
  // =========================================================================

  describe('per-user state', () => {
    it('POST /:id/seen upserts and preserves an existing seenAt (COALESCE)', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      const row = makeMemoryRow();
      context.prismaMock.memory.findFirst.mockResolvedValue(row);
      context.prismaMock.memoryUserState.upsert.mockResolvedValue({});
      context.prismaMock.memoryUserState.updateMany.mockResolvedValue({ count: 0 });

      await request(context.app.getHttpServer())
        .post(`/api/memories/${row.id}/seen`)
        .set(authHeader(user.accessToken))
        .expect(204);

      expect(context.prismaMock.memoryUserState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { memoryId_userId: { memoryId: row.id, userId: user.id } },
          update: {},
        }),
      );
      // The guarded second statement only fills a still-null column.
      expect(
        context.prismaMock.memoryUserState.updateMany.mock.calls[0][0].where,
      ).toEqual({ memoryId: row.id, userId: user.id, seenAt: null });
    });

    it('POST/DELETE /:id/hide set and clear hiddenAt', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      const row = makeMemoryRow();
      context.prismaMock.memory.findFirst.mockResolvedValue(row);
      context.prismaMock.memoryUserState.upsert.mockResolvedValue({});
      context.prismaMock.memoryUserState.updateMany.mockResolvedValue({ count: 1 });

      await request(context.app.getHttpServer())
        .post(`/api/memories/${row.id}/hide`)
        .set(authHeader(user.accessToken))
        .expect(204);

      await request(context.app.getHttpServer())
        .delete(`/api/memories/${row.id}/hide`)
        .set(authHeader(user.accessToken))
        .expect(204);

      const clear = context.prismaMock.memoryUserState.updateMany.mock.calls.at(-1)[0];
      expect(clear).toEqual({
        where: { memoryId: row.id, userId: user.id },
        data: { hiddenAt: null },
      });
      // Clearing never creates a state row.
      expect(context.prismaMock.memoryUserState.upsert).toHaveBeenCalledTimes(1);
    });

    it('POST/DELETE /:id/favorite set and clear favoritedAt', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      setupCircleMocks(context, user.id, CIRCLE_ID, 'viewer');
      const row = makeMemoryRow();
      context.prismaMock.memory.findFirst.mockResolvedValue(row);
      context.prismaMock.memoryUserState.upsert.mockResolvedValue({});
      context.prismaMock.memoryUserState.updateMany.mockResolvedValue({ count: 1 });

      await request(context.app.getHttpServer())
        .post(`/api/memories/${row.id}/favorite`)
        .set(authHeader(user.accessToken))
        .expect(204);
      await request(context.app.getHttpServer())
        .delete(`/api/memories/${row.id}/favorite`)
        .set(authHeader(user.accessToken))
        .expect(204);

      expect(
        context.prismaMock.memoryUserState.updateMany.mock.calls.at(-1)[0].data,
      ).toEqual({ favoritedAt: null });
    });

    it('a viewer CAN write their own state (membership only)', async () => {
      enableMemories(context);
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');
      const row = makeMemoryRow();
      context.prismaMock.memory.findFirst.mockResolvedValue(row);
      context.prismaMock.memoryUserState.upsert.mockResolvedValue({});
      context.prismaMock.memoryUserState.updateMany.mockResolvedValue({ count: 0 });

      await request(context.app.getHttpServer())
        .post(`/api/memories/${row.id}/seen`)
        .set(authHeader(viewer.accessToken))
        .expect(204);
    });

    it('404s state writes for a non-member', async () => {
      enableMemories(context);
      const user = await createMockViewerUser(context);
      const row = makeMemoryRow({ circleId: OTHER_CIRCLE_ID });
      context.prismaMock.memory.findFirst.mockResolvedValue(row);
      context.prismaMock.circleMember.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post(`/api/memories/${row.id}/seen`)
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });

  // =========================================================================
  // DELETE /api/memories/:id — the tombstone
  // =========================================================================

  describe('DELETE /api/memories/:id', () => {
    it('403s a viewer holding media:read but not media:write', async () => {
      enableMemories(context);
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');

      await request(context.app.getHttpServer())
        .delete(`/api/memories/${randomUUID()}`)
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });

    it('403s a member with media:write but only the viewer circle role', async () => {
      enableMemories(context);
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');
      context.prismaMock.memory.findFirst.mockResolvedValue(makeMemoryRow());

      await request(context.app.getHttpServer())
        .delete(`/api/memories/${randomUUID()}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);

      expect(context.prismaMock.memory.update).not.toHaveBeenCalled();
    });

    it('tombstones for a collaborator and writes a memory:deleted audit event', async () => {
      enableMemories(context);
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');
      const row = makeMemoryRow();
      context.prismaMock.memory.findFirst.mockResolvedValue(row);
      context.prismaMock.memory.update.mockResolvedValue({ ...row, deletedAt: new Date() });

      await request(context.app.getHttpServer())
        .delete(`/api/memories/${row.id}`)
        .set(authHeader(contributor.accessToken))
        .expect(204);

      const update = context.prismaMock.memory.update.mock.calls[0][0];
      expect(update.where).toEqual({ id: row.id });
      expect(update.data.deletedAt).toBeInstanceOf(Date);

      const audit = context.prismaMock.auditEvent.create.mock.calls.at(-1)[0].data;
      expect(audit).toMatchObject({
        actorUserId: contributor.id,
        action: 'memory:deleted',
        targetType: 'memory',
        targetId: row.id,
      });
    });

    it('404s — not 403 — for a non-member collaborator elsewhere', async () => {
      enableMemories(context);
      const contributor = await createMockContributorUser(context);
      context.prismaMock.memory.findFirst.mockResolvedValue(
        makeMemoryRow({ circleId: OTHER_CIRCLE_ID }),
      );
      context.prismaMock.circleMember.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete(`/api/memories/${randomUUID()}`)
        .set(authHeader(contributor.accessToken))
        .expect(404);
    });
  });

  // =========================================================================
  // POST /api/memories/:id/save-album
  // =========================================================================

  describe('POST /api/memories/:id/save-album', () => {
    function setupAlbumMocks(context: TestContext, albumId: string) {
      context.prismaMock.album.create.mockResolvedValue({
        id: albumId,
        circleId: CIRCLE_ID,
        name: 'x',
        description: null,
        coverMediaItemId: null,
      });
      context.prismaMock.album.findUnique.mockResolvedValue({
        id: albumId,
        circleId: CIRCLE_ID,
        name: 'x',
        coverMediaItemId: null,
      });
      context.prismaMock.album.update.mockResolvedValue({ id: albumId });
      context.prismaMock.albumItem.upsert.mockImplementation(async ({ create }: any) => ({
        id: randomUUID(),
        ...create,
        addedAt: new Date(),
      }));
      context.prismaMock.albumItem.findFirst.mockResolvedValue({ id: randomUUID() });
      context.prismaMock.mediaItem.updateMany.mockResolvedValue({ count: 0 });
    }

    it('403s a viewer (no media:write)', async () => {
      enableMemories(context);
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');

      await request(context.app.getHttpServer())
        .post(`/api/memories/${randomUUID()}/save-album`)
        .set(authHeader(viewer.accessToken))
        .send({})
        .expect(403);
    });

    it('creates an album from the memory in position order with the cover set', async () => {
      enableMemories(context);
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      const coverId = randomUUID();
      const secondId = randomUUID();
      const row = makeMemoryRow({ title: 'Trip to Guanacaste', coverMediaItemId: coverId });
      context.prismaMock.memory.findFirst.mockResolvedValue(row);
      context.prismaMock.memoryItem.findMany.mockResolvedValue([
        { mediaItemId: coverId },
        { mediaItemId: secondId },
      ]);
      context.prismaMock.mediaItem.findMany.mockResolvedValue([
        { id: coverId },
        { id: secondId },
      ]);
      const albumId = randomUUID();
      setupAlbumMocks(context, albumId);

      const res = await request(context.app.getHttpServer())
        .post(`/api/memories/${row.id}/save-album`)
        .set(authHeader(contributor.accessToken))
        .send({})
        .expect(201);

      expect(res.body.data.albumId).toBe(albumId);
      // Default name = the memory's title.
      expect(context.prismaMock.album.create.mock.calls[0][0].data.name).toBe(
        'Trip to Guanacaste',
      );
      // Items in memory position order.
      expect(
        context.prismaMock.albumItem.upsert.mock.calls.map(
          (c: any) => c[0].create.mediaItemId,
        ),
      ).toEqual([coverId, secondId]);
      // The memory's cover becomes the album's cover.
      expect(context.prismaMock.album.update.mock.calls[0][0].data).toEqual({
        coverMediaItemId: coverId,
      });
      // The memoryItem read is ordered by position, not insertion.
      expect(
        context.prismaMock.memoryItem.findMany.mock.calls[0][0].orderBy,
      ).toEqual({ position: 'asc' });
    });

    it('honors an explicit album name', async () => {
      enableMemories(context);
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');
      const row = makeMemoryRow();
      context.prismaMock.memory.findFirst.mockResolvedValue(row);
      context.prismaMock.memoryItem.findMany.mockResolvedValue([]);
      context.prismaMock.mediaItem.findMany.mockResolvedValue([]);
      setupAlbumMocks(context, randomUUID());

      await request(context.app.getHttpServer())
        .post(`/api/memories/${row.id}/save-album`)
        .set(authHeader(contributor.accessToken))
        .send({ name: 'Costa Rica 2023' })
        .expect(201);

      expect(context.prismaMock.album.create.mock.calls[0][0].data.name).toBe(
        'Costa Rica 2023',
      );
    });

    it('drops trashed items rather than failing the whole save', async () => {
      enableMemories(context);
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      const liveId = randomUUID();
      const trashedId = randomUUID();
      const row = makeMemoryRow({ coverMediaItemId: trashedId });
      context.prismaMock.memory.findFirst.mockResolvedValue(row);
      context.prismaMock.memoryItem.findMany.mockResolvedValue([
        { mediaItemId: trashedId },
        { mediaItemId: liveId },
      ]);
      // Only the live one comes back from the deletedAt: null lookup.
      context.prismaMock.mediaItem.findMany.mockResolvedValue([{ id: liveId }]);
      setupAlbumMocks(context, randomUUID());

      await request(context.app.getHttpServer())
        .post(`/api/memories/${row.id}/save-album`)
        .set(authHeader(contributor.accessToken))
        .send({})
        .expect(201);

      expect(
        context.prismaMock.albumItem.upsert.mock.calls.map(
          (c: any) => c[0].create.mediaItemId,
        ),
      ).toEqual([liveId]);
      // A trashed cover is not carried over.
      expect(context.prismaMock.album.update).not.toHaveBeenCalled();
    });

    it('is NOT idempotent — a second save creates a second album', async () => {
      enableMemories(context);
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');
      const row = makeMemoryRow();
      context.prismaMock.memory.findFirst.mockResolvedValue(row);
      context.prismaMock.memoryItem.findMany.mockResolvedValue([]);
      context.prismaMock.mediaItem.findMany.mockResolvedValue([]);
      setupAlbumMocks(context, randomUUID());

      await request(context.app.getHttpServer())
        .post(`/api/memories/${row.id}/save-album`)
        .set(authHeader(contributor.accessToken))
        .send({})
        .expect(201);
      await request(context.app.getHttpServer())
        .post(`/api/memories/${row.id}/save-album`)
        .set(authHeader(contributor.accessToken))
        .send({})
        .expect(201);

      expect(context.prismaMock.album.create).toHaveBeenCalledTimes(2);
    });
  });
});
