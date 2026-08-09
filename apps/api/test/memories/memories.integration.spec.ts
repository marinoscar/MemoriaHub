// DB_GATED: This test requires a real PostgreSQL database with migrations
// applied (specifically 20260809130452_add_memories). It will not run in
// environments without database connectivity — reachability is probed
// synchronously at module load via `describeMaybeDb`
// (test/helpers/db-probe.helper.ts), the same shared helper every other
// DB-gated spec in this repo uses (see e.g.
// test/notifications/notification-dedup.integration.spec.ts and
// test/review-runs/review-runs.integration.spec.ts). When the probe fails,
// the whole suite is registered via a real `describe.skip`, so Jest reports
// these tests as SKIPPED, never PASSED — in CI (no live database, see
// docs/ci-known-failing-tests.md) this suite is a no-op.
//
// Purpose: exercise the REAL Postgres behaviors that a mocked PrismaService
// (jest-mock-extended) cannot verify, proving the issue #301 acceptance
// criteria and the tombstone contract documented in
// docs/specs/memories.md §2.5:
//
//   1. A second `create()` for the same (circleId, type, periodKey,
//      subjectKey) is rejected with a genuine unique-constraint violation
//      (P2002) naming the natural-key fields.
//   2. `upsert()` against that same natural key updates the existing row in
//      place — same id, refreshed fields — rather than creating a second
//      row.
//   3. THE TOMBSTONE CONTRACT: once a Memory's deletedAt is set, the
//      @@unique index still blocks a fresh create() under the same natural
//      key — a tombstoned memory can never be silently recreated by a
//      regeneration run.
//   4. Deleting a MediaItem cascades away its MemoryItem rows (Cascade).
//   5. Deleting a MediaItem that is a Memory's coverMediaItemId nulls the
//      cover (SetNull) while the Memory itself survives.
//   6. Deleting a Person cascades away its person_highlights /
//      person_over_years Memory rows (Cascade).
//   7. Deleting a Memory cascades away its MemoryItem and MemoryUserState
//      rows (Cascade).
//   8. Deleting a Circle cascades away all its Memory rows (Cascade).
//
// This suite was verified to actually pass against a real local Postgres 16
// instance (with the `vector` extension) during development — see the PR
// description / session notes for the manual verification run — even though
// it necessarily reports SKIPPED wherever `npm test` runs without a live
// database at DATABASE_URL/POSTGRES_* (e.g. this repo's CI, and — by
// `.env.test`'s POSTGRES_PORT=5433 default — most local `npm test` runs too,
// mirroring every other DB_GATED suite in this repo).

import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { describeMaybeDb } from '../helpers/db-probe.helper';

function resolveDatabaseUrl(): string {
  if (process.env['DATABASE_URL']) return process.env['DATABASE_URL'] as string;
  const host = process.env['POSTGRES_HOST'] ?? 'localhost';
  const port = process.env['POSTGRES_PORT'] ?? '5432';
  const user = process.env['POSTGRES_USER'] ?? 'postgres';
  const password = process.env['POSTGRES_PASSWORD'] ?? 'postgres';
  const db = process.env['POSTGRES_DB'] ?? 'appdb';
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${db}`;
}

const DATABASE_URL = resolveDatabaseUrl();

describeMaybeDb('Memories — DB constraints and cascades (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaClient;

  // Shared fixture ids, created once in beforeAll and torn down in afterAll.
  const userId = randomUUID();
  const circleId = randomUUID();
  const storageObjectId = randomUUID();
  const mediaItemId = randomUUID();
  const now = new Date();

  beforeAll(async () => {
    const adapter = new PrismaPg({ connectionString: DATABASE_URL });
    prisma = new PrismaClient({ adapter });
    await prisma.$connect();

    await prisma.user.create({
      data: { id: userId, email: `memories-test-${userId}@example.test` },
    });
    await prisma.circle.create({
      data: { id: circleId, name: 'Memories Test Circle', ownerId: userId },
    });
    await prisma.storageObject.create({
      data: {
        id: storageObjectId,
        name: 'memories-test.jpg',
        size: BigInt(1024),
        mimeType: 'image/jpeg',
        storageKey: `memories-test/${storageObjectId}`,
        status: 'ready',
        uploadedById: userId,
      },
    });
    await prisma.mediaItem.create({
      data: {
        id: mediaItemId,
        storageObjectId,
        circleId,
        addedById: userId,
        type: 'photo',
        source: 'web',
        originalFilename: 'memories-test.jpg',
      },
    });
  }, 30000);

  afterAll(async () => {
    if (!prisma) return;
    // Reverse-order teardown. Deleting the circle cascades away everything
    // else scoped to it (memories, media items) via ON DELETE CASCADE, but
    // we delete explicitly and scoped to this suite's fixture ids so a
    // shared database is never touched beyond what this suite created.
    await prisma.memory.deleteMany({ where: { circleId } }).catch(() => undefined);
    await prisma.mediaItem.deleteMany({ where: { id: mediaItemId } });
    await prisma.storageObject.deleteMany({ where: { id: storageObjectId } });
    await prisma.circle.deleteMany({ where: { id: circleId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }, 30000);

  function baseMemoryData(overrides: Partial<Prisma.MemoryUncheckedCreateInput> = {}) {
    return {
      circleId,
      type: 'on_this_day' as const,
      periodKey: '2026-08-08',
      subjectKey: '2019',
      title: 'On this day — 7 years ago',
      titleSource: 'template',
      periodStart: now,
      periodEnd: now,
      itemCount: 0,
      generatedAt: now,
      refreshedAt: now,
      ...overrides,
    };
  }

  // ===========================================================================
  // 1. Unique constraint on (circleId, type, periodKey, subjectKey)
  // ===========================================================================

  describe('unique constraint on (circleId, type, periodKey, subjectKey)', () => {
    it('rejects a second create() for the same natural key as a P2002 unique-constraint violation', async () => {
      const first = await prisma.memory.create({ data: baseMemoryData() });
      expect(first.id).toBeTruthy();

      let caught: unknown;
      try {
        await prisma.memory.create({ data: baseMemoryData({ title: 'Duplicate attempt' }) });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const err = caught as Prisma.PrismaClientKnownRequestError;
      expect(err.code).toBe('P2002');
      // Prisma's ORM-level P2002 message lists the conflicting fields.
      expect(String(err.message)).toMatch(/circleId|circle_id/);

      await prisma.memory.delete({ where: { id: first.id } });
    });

    it('upsert() against the same natural key updates the existing row in place, never creating a second row', async () => {
      const created = await prisma.memory.upsert({
        where: {
          circleId_type_periodKey_subjectKey: {
            circleId,
            type: 'theme',
            periodKey: '2025',
            subjectKey: 'sunsets',
          },
        },
        update: { itemCount: 999 },
        create: baseMemoryData({
          type: 'theme',
          periodKey: '2025',
          subjectKey: 'sunsets',
          title: 'Golden sunsets',
          itemCount: 3,
        }),
      });
      expect(created.itemCount).toBe(3); // create branch ran

      const refreshed = await prisma.memory.upsert({
        where: {
          circleId_type_periodKey_subjectKey: {
            circleId,
            type: 'theme',
            periodKey: '2025',
            subjectKey: 'sunsets',
          },
        },
        update: { itemCount: 42, refreshedAt: new Date() },
        create: baseMemoryData({
          type: 'theme',
          periodKey: '2025',
          subjectKey: 'sunsets',
          title: 'should never be used',
          itemCount: -1,
        }),
      });

      expect(refreshed.id).toBe(created.id); // same row, not a new one
      expect(refreshed.itemCount).toBe(42);

      const rows = await prisma.memory.findMany({
        where: { circleId, type: 'theme', periodKey: '2025', subjectKey: 'sunsets' },
      });
      expect(rows).toHaveLength(1);

      await prisma.memory.delete({ where: { id: created.id } });
    });
  });

  // ===========================================================================
  // 2. The tombstone contract (docs/specs/memories.md §2.5)
  // ===========================================================================

  describe('tombstone contract: a deleted (deletedAt set) memory still blocks recreation', () => {
    it('a fresh create() under the same natural key as a tombstoned row is still rejected as P2002', async () => {
      const memory = await prisma.memory.create({
        data: baseMemoryData({ type: 'seasonal', periodKey: '2025-summer', subjectKey: '' }),
      });

      // Tombstone it (application-level soft-delete, NOT a Prisma delete()).
      await prisma.memory.update({ where: { id: memory.id }, data: { deletedAt: new Date() } });

      let caught: unknown;
      try {
        await prisma.memory.create({
          data: baseMemoryData({
            type: 'seasonal',
            periodKey: '2025-summer',
            subjectKey: '',
            title: 'Attempted resurrection after tombstone',
          }),
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');

      // Exactly one row (the tombstoned original) exists for this natural key.
      const rows = await prisma.memory.findMany({
        where: { circleId, type: 'seasonal', periodKey: '2025-summer', subjectKey: '' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].deletedAt).not.toBeNull();

      await prisma.memory.delete({ where: { id: memory.id } });
    });
  });

  // ===========================================================================
  // 3. MediaItem cascades: MemoryItem removed, coverMediaItemId SetNull
  // ===========================================================================

  describe('MediaItem deletion effects', () => {
    it('deleting a MediaItem cascades away its MemoryItem row, and SetNulls a Memory.coverMediaItemId pointing at it (memory survives)', async () => {
      const localStorageId = randomUUID();
      const localMediaId = randomUUID();
      await prisma.storageObject.create({
        data: {
          id: localStorageId,
          name: 'memories-cascade-test.jpg',
          size: BigInt(512),
          mimeType: 'image/jpeg',
          storageKey: `memories-test/${localStorageId}`,
          status: 'ready',
          uploadedById: userId,
        },
      });
      await prisma.mediaItem.create({
        data: {
          id: localMediaId,
          storageObjectId: localStorageId,
          circleId,
          addedById: userId,
          type: 'photo',
          source: 'web',
          originalFilename: 'memories-cascade-test.jpg',
        },
      });

      const memory = await prisma.memory.create({
        data: baseMemoryData({
          type: 'year_in_review',
          periodKey: '2024',
          subjectKey: '',
          coverMediaItemId: localMediaId,
          items: { create: [{ mediaItemId: localMediaId, position: 0 }] },
        }),
      });

      const itemsBefore = await prisma.memoryItem.count({ where: { memoryId: memory.id } });
      expect(itemsBefore).toBe(1);

      await prisma.mediaItem.delete({ where: { id: localMediaId } });

      const itemsAfter = await prisma.memoryItem.count({ where: { memoryId: memory.id } });
      expect(itemsAfter).toBe(0); // Cascade

      const memoryAfter = await prisma.memory.findUnique({ where: { id: memory.id } });
      expect(memoryAfter).not.toBeNull(); // the Memory itself survives
      expect(memoryAfter!.coverMediaItemId).toBeNull(); // SetNull

      await prisma.memory.delete({ where: { id: memory.id } });
      await prisma.storageObject.deleteMany({ where: { id: localStorageId } });
    });
  });

  // ===========================================================================
  // 4. Person cascade
  // ===========================================================================

  describe('Person deletion cascades its person_* Memory rows', () => {
    it('deleting a Person removes its person_highlights Memory outright', async () => {
      const person = await prisma.person.create({
        data: { circleId, addedById: userId, name: 'Abuela' },
      });

      const memory = await prisma.memory.create({
        data: baseMemoryData({
          type: 'person_highlights',
          periodKey: '2025',
          subjectKey: person.id,
          personId: person.id,
          title: 'Best of Abuela, 2025',
        }),
      });

      await prisma.person.delete({ where: { id: person.id } });

      const found = await prisma.memory.findUnique({ where: { id: memory.id } });
      expect(found).toBeNull(); // Cascade
    });
  });

  // ===========================================================================
  // 5. Memory -> MemoryItem / MemoryUserState cascade
  // ===========================================================================

  describe('Memory deletion cascades its MemoryItem and MemoryUserState rows', () => {
    it('deleting a Memory removes its MemoryItem and MemoryUserState rows', async () => {
      const memory = await prisma.memory.create({
        data: baseMemoryData({
          type: 'trip',
          periodKey: '2023-03-12',
          subjectKey: 'guanacaste',
          title: 'Trip to Guanacaste, March 2023',
          items: { create: [{ mediaItemId, position: 0 }] },
          userStates: { create: [{ userId, favoritedAt: new Date() }] },
        }),
      });

      expect(await prisma.memoryItem.count({ where: { memoryId: memory.id } })).toBe(1);
      expect(await prisma.memoryUserState.count({ where: { memoryId: memory.id } })).toBe(1);

      await prisma.memory.delete({ where: { id: memory.id } });

      expect(await prisma.memoryItem.count({ where: { memoryId: memory.id } })).toBe(0);
      expect(await prisma.memoryUserState.count({ where: { memoryId: memory.id } })).toBe(0);
    });
  });

  // ===========================================================================
  // 6. Circle cascade
  // ===========================================================================

  describe('Circle deletion cascades all its Memory rows', () => {
    it('deleting a Circle removes every Memory scoped to it', async () => {
      const localUserId = randomUUID();
      const localCircleId = randomUUID();
      await prisma.user.create({
        data: { id: localUserId, email: `memories-circle-cascade-${localUserId}@example.test` },
      });
      await prisma.circle.create({
        data: { id: localCircleId, name: 'Circle Cascade Test', ownerId: localUserId },
      });
      const memory = await prisma.memory.create({
        data: {
          circleId: localCircleId,
          type: 'year_in_review',
          periodKey: '2025',
          subjectKey: '',
          title: 'Your 2025 in review',
          titleSource: 'template',
          periodStart: now,
          periodEnd: now,
          itemCount: 0,
          generatedAt: now,
          refreshedAt: now,
        },
      });

      await prisma.circle.delete({ where: { id: localCircleId } });

      const found = await prisma.memory.findUnique({ where: { id: memory.id } });
      expect(found).toBeNull(); // Cascade

      await prisma.user.deleteMany({ where: { id: localUserId } });
    });
  });
});
