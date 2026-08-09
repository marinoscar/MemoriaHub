// DB_GATED: requires a real PostgreSQL with migrations applied (through
// 20260809140000_memories_on_this_day_index). Reachability is probed
// synchronously at module load via `describeMaybeDb`, so with no database the
// whole suite is registered as `describe.skip` and reports SKIPPED — never a
// green PASS that asserted nothing. See test/helpers/db-probe.helper.ts.
//
// WHY THIS SUITE IS DB-BACKED AND NOT MOCKED
// ------------------------------------------
// Issue #303's acceptance criteria are almost entirely statements about SQL and
// about rows: "items violating the base filter never appear", "re-running
// changes nothing", "MemoryUserState survives a refresh", "a tombstoned memory
// is NEVER recreated". Against a mocked PrismaService each of those tests would
// assert that the code calls the mock the way the test author expected — which
// is a restatement of the implementation, not evidence the filter actually
// excludes an archived photo or that the unique index actually holds. The pure
// scoring/selection/collapse algebra IS unit tested, with no database, in
// src/memories/curation/memory-curation.pure.spec.ts; everything here is
// specifically the part that only a real database can prove.
//
// Time is pinned: the curator's anchors derive from `ctx.now`, which this suite
// supplies as a fixed instant, so "today" and "tomorrow" are deterministic and
// the fixtures can be seeded on exact past anniversaries.

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { describeMaybeDb } from '../helpers/db-probe.helper';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MemoryCurationService } from '../../src/memories/curation/memory-curation.service';
import {
  ON_THIS_DAY_RETENTION_DAYS,
  OnThisDayCurator,
} from '../../src/memories/curators/on-this-day.curator';
import { MemoryCuratorContext } from '../../src/memories/curators/memory-curator.interface';
import { resolveMemoriesSettings } from '../../src/memories/memories-settings.util';

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
const MS_PER_DAY = 86_400_000;

/** Fixed clock: anchors are 2026-08-09 (today) and 2026-08-10 (tomorrow) UTC. */
const NOW = new Date(Date.UTC(2026, 7, 9, 12, 0, 0));
const ANCHOR_MONTH = 8;
const ANCHOR_DAY = 9;

describeMaybeDb('Memories — curation engine & On This Day (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaClient;
  let curation: MemoryCurationService;
  let curator: OnThisDayCurator;

  const userId = randomUUID();
  const circleId = randomUUID();
  /** A second, deliberately empty circle — the new-install / empty-library case. */
  const emptyCircleId = randomUUID();
  const createdStorageObjectIds: string[] = [];

  function ctx(over: Partial<MemoryCuratorContext> = {}): MemoryCuratorContext {
    return {
      circleId,
      settings: resolveMemoriesSettings(undefined),
      now: NOW,
      backfill: false,
      ...over,
    };
  }

  /**
   * Seed one media item. Returns its id.
   *
   * `capturedAt` accepts null so the base filter's NULL-date exclusion can be
   * exercised for real rather than trusted.
   */
  async function seedItem(options: {
    capturedAt: Date | null;
    circle?: string;
    favorite?: boolean;
    sharpnessScore?: number | null;
    type?: 'photo' | 'video';
    durationMs?: number | null;
    archivedAt?: Date | null;
    deletedAt?: Date | null;
    socialMediaSource?: string | null;
    burstGroupId?: string | null;
    duplicateGroupId?: string | null;
  }): Promise<string> {
    const storageObjectId = randomUUID();
    createdStorageObjectIds.push(storageObjectId);
    await prisma.storageObject.create({
      data: {
        id: storageObjectId,
        name: `${storageObjectId}.jpg`,
        size: BigInt(2048),
        mimeType: 'image/jpeg',
        storageKey: `memories-curation/${storageObjectId}`,
        status: 'ready',
        uploadedById: userId,
      },
    });
    const item = await prisma.mediaItem.create({
      data: {
        storageObjectId,
        circleId: options.circle ?? circleId,
        addedById: userId,
        type: options.type ?? 'photo',
        source: 'web',
        originalFilename: `${storageObjectId}.jpg`,
        capturedAt: options.capturedAt,
        favorite: options.favorite ?? false,
        sharpnessScore: options.sharpnessScore ?? null,
        durationMs: options.durationMs ?? null,
        archivedAt: options.archivedAt ?? null,
        deletedAt: options.deletedAt ?? null,
        socialMediaSource: options.socialMediaSource ?? null,
        burstGroupId: options.burstGroupId ?? null,
        duplicateGroupId: options.duplicateGroupId ?? null,
      },
      select: { id: true },
    });
    return item.id;
  }

  /** An instant on the anchor month/day of `year`, `hour` hours in. */
  function anniversary(year: number, hour: number): Date {
    return new Date(Date.UTC(year, ANCHOR_MONTH - 1, ANCHOR_DAY, hour, 0, 0));
  }

  /** Wipe every memory in the fixture circles between tests. */
  async function clearMemories(): Promise<void> {
    await prisma.memory.deleteMany({ where: { circleId: { in: [circleId, emptyCircleId] } } });
  }

  /** Wipe every media item in the fixture circles between tests. */
  async function clearMedia(): Promise<void> {
    await prisma.mediaItem.deleteMany({ where: { circleId: { in: [circleId, emptyCircleId] } } });
    if (createdStorageObjectIds.length > 0) {
      await prisma.storageObject.deleteMany({ where: { id: { in: createdStorageObjectIds } } });
      createdStorageObjectIds.length = 0;
    }
  }

  beforeAll(async () => {
    const adapter = new PrismaPg({ connectionString: DATABASE_URL });
    prisma = new PrismaClient({ adapter });
    await prisma.$connect();

    // The services take a PrismaService (a Nest-lifecycle subclass of
    // PrismaClient); a raw client satisfies every method they actually call.
    curation = new MemoryCurationService(prisma as unknown as PrismaService);
    curator = new OnThisDayCurator(prisma as unknown as PrismaService, curation);

    await prisma.user.create({
      data: { id: userId, email: `memories-curation-${userId}@example.test` },
    });
    await prisma.circle.create({
      data: { id: circleId, name: 'Memories Curation Circle', ownerId: userId },
    });
    await prisma.circle.create({
      data: { id: emptyCircleId, name: 'Memories Empty Circle', ownerId: userId },
    });
  }, 30000);

  afterAll(async () => {
    if (!prisma) return;
    await clearMemories().catch(() => undefined);
    await clearMedia().catch(() => undefined);
    await prisma.burstGroup.deleteMany({ where: { circleId } }).catch(() => undefined);
    await prisma.duplicateGroup.deleteMany({ where: { circleId } }).catch(() => undefined);
    await prisma.circle.deleteMany({ where: { id: { in: [circleId, emptyCircleId] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }, 30000);

  afterEach(async () => {
    await clearMemories();
    await clearMedia();
    await prisma.burstGroup.deleteMany({ where: { circleId } });
    await prisma.duplicateGroup.deleteMany({ where: { circleId } });
  });

  // ---------------------------------------------------------------------------
  // Empty library / new install
  // ---------------------------------------------------------------------------

  it('produces zero rows and does not throw on an empty circle', async () => {
    const result = await curator.run(ctx({ circleId: emptyCircleId }));

    expect(result).toEqual({ created: 0, refreshed: 0, skipped: 0, tombstoned: 0 });
    expect(await prisma.memory.count({ where: { circleId: emptyCircleId } })).toBe(0);
  });

  it('does not choke on items with a NULL capturedAt', async () => {
    // The whole reason the base filter names capturedAt explicitly: an import
    // with no EXIF date is common, and every memory is time-anchored.
    await seedItem({ capturedAt: null });
    await seedItem({ capturedAt: null });
    await seedItem({ capturedAt: null });

    const result = await curator.run(ctx());

    expect(result.created).toBe(0);
    expect(await prisma.memory.count({ where: { circleId } })).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Base filter
  // ---------------------------------------------------------------------------

  it('excludes archived, trashed, social-media and NULL-date items from a memory', async () => {
    const keep = [
      await seedItem({ capturedAt: anniversary(2019, 9) }),
      await seedItem({ capturedAt: anniversary(2019, 11) }),
      await seedItem({ capturedAt: anniversary(2019, 13) }),
    ];
    // Each of these violates exactly one base-filter predicate.
    await seedItem({ capturedAt: anniversary(2019, 10), archivedAt: new Date() });
    await seedItem({ capturedAt: anniversary(2019, 12), deletedAt: new Date() });
    await seedItem({ capturedAt: anniversary(2019, 14), socialMediaSource: 'tiktok' });
    await seedItem({ capturedAt: null });

    await curator.run(ctx());

    const memory = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'on_this_day' },
      include: { items: true },
    });
    expect(memory.items.map((i) => i.mediaItemId).sort()).toEqual([...keep].sort());
    expect(memory.itemCount).toBe(3);
  });

  it('ignores items from other circles', async () => {
    await seedItem({ capturedAt: anniversary(2019, 9) });
    await seedItem({ capturedAt: anniversary(2019, 10) });
    await seedItem({ capturedAt: anniversary(2019, 11) });
    // Same day, different circle: must not leak in.
    await seedItem({ capturedAt: anniversary(2019, 12), circle: emptyCircleId });
    await seedItem({ capturedAt: anniversary(2019, 13), circle: emptyCircleId });

    await curator.run(ctx());

    const memory = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'on_this_day' },
    });
    expect(memory.itemCount).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // On This Day shape
  // ---------------------------------------------------------------------------

  it('creates one memory per qualifying past year, keyed by anchor date and source year', async () => {
    for (const year of [2019, 2023]) {
      for (const hour of [8, 10, 12]) {
        await seedItem({ capturedAt: anniversary(year, hour) });
      }
    }
    // 2024 has too few items to clear onThisDay.minItems (3).
    await seedItem({ capturedAt: anniversary(2024, 9) });

    const result = await curator.run(ctx());

    const memories = await prisma.memory.findMany({
      where: { circleId, type: 'on_this_day' },
      orderBy: { subjectKey: 'asc' },
    });
    expect(memories).toHaveLength(2);
    expect(result.created).toBe(2);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    expect(memories.map((m) => m.subjectKey)).toEqual(['2019', '2023']);
    expect(new Set(memories.map((m) => m.periodKey))).toEqual(new Set(['2026-08-09']));
    expect(memories[0]!.title).toBe('On this day — 7 years ago');
    expect(memories[1]!.title).toBe('On this day — 3 years ago');
    expect(memories[0]!.subtitle).toBe('August 9, 2019');
    expect(memories[0]!.titleSource).toBe('template');
    expect(memories[0]!.titleModel).toBeNull();
    expect((memories[0]!.meta as Record<string, unknown>)['yearsAgo']).toBe(7);
  });

  it('orders items chronologically, picks the highest-scored photo as cover, and expires at end of the anchor day', async () => {
    const early = await seedItem({ capturedAt: anniversary(2019, 6), sharpnessScore: 100 });
    const best = await seedItem({ capturedAt: anniversary(2019, 12), favorite: true });
    const late = await seedItem({ capturedAt: anniversary(2019, 20), sharpnessScore: 200 });

    await curator.run(ctx());

    const memory = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'on_this_day', subjectKey: '2019' },
      include: { items: { orderBy: { position: 'asc' } } },
    });

    expect(memory.items.map((i) => i.mediaItemId)).toEqual([early, best, late]);
    expect(memory.items.map((i) => i.position)).toEqual([0, 1, 2]);
    expect(memory.coverMediaItemId).toBe(best);
    expect(memory.periodStart).toEqual(anniversary(2019, 6));
    expect(memory.periodEnd).toEqual(anniversary(2019, 20));
    // Exclusive end-of-day bound: `Active = expiresAt IS NULL OR expiresAt > now()`.
    expect(memory.expiresAt).toEqual(new Date(Date.UTC(2026, 7, 10)));
  });

  it('also pre-generates tomorrow, so a morning digest cannot race generation', async () => {
    for (const hour of [8, 10, 12]) {
      await seedItem({ capturedAt: new Date(Date.UTC(2019, 7, 10, hour)) });
    }

    await curator.run(ctx());

    const memory = await prisma.memory.findFirstOrThrow({ where: { circleId } });
    expect(memory.periodKey).toBe('2026-08-10');
  });

  it('never generates a memory for the anchor year itself', async () => {
    // Today's own photos are not a memory yet — yearsAgo is always >= 1.
    for (const hour of [8, 10, 12]) {
      await seedItem({ capturedAt: anniversary(2026, hour) });
    }

    await curator.run(ctx());

    expect(await prisma.memory.count({ where: { circleId } })).toBe(0);
  });

  it('honours onThisDay.lookbackYears', async () => {
    for (const hour of [8, 10, 12]) {
      await seedItem({ capturedAt: anniversary(2010, hour) }); // 16 years ago
      await seedItem({ capturedAt: anniversary(2022, hour) }); // 4 years ago
    }
    const settings = resolveMemoriesSettings({ onThisDay: { lookbackYears: 5 } } as never);

    await curator.run(ctx({ settings }));

    const memories = await prisma.memory.findMany({ where: { circleId } });
    expect(memories.map((m) => m.subjectKey)).toEqual(['2022']);
  });

  // ---------------------------------------------------------------------------
  // Near-duplicate collapse
  // ---------------------------------------------------------------------------

  it('contributes at most one item per burst group, preferring suggestedBestItemId', async () => {
    const solo = await seedItem({ capturedAt: anniversary(2019, 6) });
    const soloB = await seedItem({ capturedAt: anniversary(2019, 7) });

    const burstGroup = await prisma.burstGroup.create({
      data: { circleId, status: 'pending', mediaCount: 3 },
      select: { id: true },
    });
    const members: string[] = [];
    for (const hour of [12, 13, 14]) {
      members.push(
        await seedItem({
          capturedAt: anniversary(2019, hour),
          burstGroupId: burstGroup.id,
          // The LAST member is deliberately the favorite, so a naive
          // "highest score wins" would pick a different item than the group's
          // own suggestion — proving the suggestion is what actually decides.
          favorite: hour === 14,
        }),
      );
    }
    await prisma.burstGroup.update({
      where: { id: burstGroup.id },
      data: { suggestedBestItemId: members[0] },
    });

    await curator.run(ctx());

    const memory = await prisma.memory.findFirstOrThrow({
      where: { circleId, subjectKey: '2019' },
      include: { items: true },
    });
    const ids = memory.items.map((i) => i.mediaItemId).sort();
    expect(ids).toEqual([solo, soloB, members[0]!].sort());
    expect(memory.itemCount).toBe(3);
  });

  it('falls back to the best-scored member when the suggested best was filtered out', async () => {
    await seedItem({ capturedAt: anniversary(2019, 6) });
    await seedItem({ capturedAt: anniversary(2019, 7) });

    const group = await prisma.duplicateGroup.create({
      data: { circleId, status: 'pending', mediaCount: 3 },
      select: { id: true },
    });
    const plain = await seedItem({ capturedAt: anniversary(2019, 12), duplicateGroupId: group.id });
    const favorite = await seedItem({
      capturedAt: anniversary(2019, 13),
      duplicateGroupId: group.id,
      favorite: true,
    });
    // The group's suggestion has since been archived, so it is not a candidate.
    const archived = await seedItem({
      capturedAt: anniversary(2019, 14),
      duplicateGroupId: group.id,
      archivedAt: new Date(),
    });
    await prisma.duplicateGroup.update({
      where: { id: group.id },
      data: { suggestedBestItemId: archived },
    });

    await curator.run(ctx());

    const memory = await prisma.memory.findFirstOrThrow({
      where: { circleId, subjectKey: '2019' },
      include: { items: true },
    });
    const ids = memory.items.map((i) => i.mediaItemId);
    expect(ids).toContain(favorite);
    expect(ids).not.toContain(plain);
    expect(ids).not.toContain(archived);
  });

  // ---------------------------------------------------------------------------
  // Idempotent regeneration
  // ---------------------------------------------------------------------------

  it('re-running against an unchanged library changes nothing', async () => {
    for (const hour of [8, 10, 12]) await seedItem({ capturedAt: anniversary(2019, hour) });

    const first = await curator.run(ctx());
    const before = await prisma.memory.findFirstOrThrow({
      where: { circleId },
      include: { items: { orderBy: { position: 'asc' } } },
    });

    const second = await curator.run(ctx());
    const after = await prisma.memory.findFirstOrThrow({
      where: { circleId },
      include: { items: { orderBy: { position: 'asc' } } },
    });

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.refreshed).toBe(1);
    // Exactly one row, same identity, same content, same generatedAt.
    expect(await prisma.memory.count({ where: { circleId } })).toBe(1);
    expect(after.id).toBe(before.id);
    expect(after.generatedAt).toEqual(before.generatedAt);
    expect(after.itemCount).toBe(before.itemCount);
    expect(after.items.map((i) => i.mediaItemId)).toEqual(before.items.map((i) => i.mediaItemId));
    expect(after.title).toBe(before.title);
  });

  it('refreshes the item set in place when the library grows', async () => {
    for (const hour of [8, 10, 12]) await seedItem({ capturedAt: anniversary(2019, hour) });
    await curator.run(ctx());
    const before = await prisma.memory.findFirstOrThrow({ where: { circleId } });

    const added = await seedItem({ capturedAt: anniversary(2019, 16) });
    await curator.run(ctx());

    const after = await prisma.memory.findFirstOrThrow({
      where: { circleId },
      include: { items: true },
    });
    expect(after.id).toBe(before.id);
    expect(after.itemCount).toBe(4);
    expect(after.items.map((i) => i.mediaItemId)).toContain(added);
    expect(after.refreshedAt.getTime()).toBeGreaterThanOrEqual(before.refreshedAt.getTime());
  });

  it('preserves MemoryUserState across a refresh', async () => {
    for (const hour of [8, 10, 12]) await seedItem({ capturedAt: anniversary(2019, hour) });
    await curator.run(ctx());
    const memory = await prisma.memory.findFirstOrThrow({ where: { circleId } });

    const seenAt = new Date(Date.UTC(2026, 7, 9, 6));
    await prisma.memoryUserState.create({
      data: { memoryId: memory.id, userId, seenAt, favoritedAt: seenAt },
    });

    await seedItem({ capturedAt: anniversary(2019, 18) });
    await curator.run(ctx());

    // Per-user state lives in its own table keyed by memory id — which is
    // exactly why a refresh that replaces every MemoryItem row cannot touch it.
    const state = await prisma.memoryUserState.findFirstOrThrow({
      where: { memoryId: memory.id, userId },
    });
    expect(state.seenAt).toEqual(seenAt);
    expect(state.favoritedAt).toEqual(seenAt);
  });

  it('preserves the title on a minor refresh and resets it on a material one', async () => {
    const original = [];
    for (const hour of [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]) {
      original.push(await seedItem({ capturedAt: anniversary(2019, hour) }));
    }
    await curator.run(ctx());
    const memory = await prisma.memory.findFirstOrThrow({ where: { circleId } });

    // Simulate #306 having written an AI title over the template.
    await prisma.memory.update({
      where: { id: memory.id },
      data: {
        title: 'A summer afternoon',
        subtitle: 'AI subtitle',
        narrative: 'AI narrative',
        titleSource: 'ai',
        titleModel: 'gpt-test',
      },
    });

    // One photo joins a 10-item set: ~9% membership change, below the 30%
    // material threshold, so the AI title must survive.
    await seedItem({ capturedAt: anniversary(2019, 21) });
    await curator.run(ctx());

    let after = await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } });
    expect(after.title).toBe('A summer afternoon');
    expect(after.titleSource).toBe('ai');
    expect(after.narrative).toBe('AI narrative');
    expect(after.itemCount).toBe(11);

    // Now trash most of the original set: the memory is materially a different
    // collection, so the stale AI title is reset to the template.
    await prisma.mediaItem.updateMany({
      where: { id: { in: original.slice(0, 8) } },
      data: { deletedAt: new Date() },
    });
    await curator.run(ctx());

    after = await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } });
    expect(after.titleSource).toBe('template');
    expect(after.title).toBe('On this day — 7 years ago');
    expect(after.titleModel).toBeNull();
    expect(after.narrative).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // The tombstone contract (stated epic success criterion)
  // ---------------------------------------------------------------------------

  it('NEVER recreates or modifies a user-deleted (tombstoned) memory', async () => {
    for (const hour of [8, 10, 12]) await seedItem({ capturedAt: anniversary(2019, hour) });
    await curator.run(ctx());

    const memory = await prisma.memory.findFirstOrThrow({ where: { circleId } });
    const deletedAt = new Date();
    await prisma.memory.update({ where: { id: memory.id }, data: { deletedAt } });
    const tombstoned = await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } });

    // Change the library so a regeneration would definitely want to refresh it.
    await seedItem({ capturedAt: anniversary(2019, 16) });
    await seedItem({ capturedAt: anniversary(2019, 18) });
    const result = await curator.run(ctx());

    expect(result.tombstoned).toBe(1);
    expect(result.created).toBe(0);
    expect(result.refreshed).toBe(0);

    // Still exactly one row — no second memory slipped in under the same key.
    expect(await prisma.memory.count({ where: { circleId } })).toBe(1);

    const after = await prisma.memory.findUniqueOrThrow({
      where: { id: memory.id },
      include: { items: true },
    });
    expect(after.deletedAt).toEqual(deletedAt);
    expect(after.itemCount).toBe(tombstoned.itemCount);
    expect(after.items).toHaveLength(3);
    expect(after.refreshedAt).toEqual(tombstoned.refreshedAt);
    expect(after.updatedAt).toEqual(tombstoned.updatedAt);
  });

  it('the tombstone does not block OTHER years of the same anchor day', async () => {
    for (const year of [2019, 2023]) {
      for (const hour of [8, 10, 12]) await seedItem({ capturedAt: anniversary(year, hour) });
    }
    await curator.run(ctx());
    await prisma.memory.updateMany({
      where: { circleId, subjectKey: '2019' },
      data: { deletedAt: new Date() },
    });

    await seedItem({ capturedAt: anniversary(2023, 16) });
    const result = await curator.run(ctx());

    expect(result.tombstoned).toBe(1);
    expect(result.refreshed).toBe(1);
    const live = await prisma.memory.findFirstOrThrow({
      where: { circleId, subjectKey: '2023' },
    });
    expect(live.itemCount).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // Retention tail
  // ---------------------------------------------------------------------------

  it('purges on_this_day memories past the retention window, tombstoned or not', async () => {
    for (const hour of [8, 10, 12]) await seedItem({ capturedAt: anniversary(2019, hour) });
    await curator.run(ctx());

    const stale = new Date(NOW.getTime() - (ON_THIS_DAY_RETENTION_DAYS + 5) * MS_PER_DAY);
    const fresh = new Date(NOW.getTime() - 1 * MS_PER_DAY);

    const [old1, old2, recent] = await Promise.all([
      prisma.memory.create({
        data: {
          circleId,
          type: 'on_this_day',
          periodKey: '2026-05-01',
          subjectKey: '2015',
          title: 'old',
          titleSource: 'template',
          periodStart: stale,
          periodEnd: stale,
          itemCount: 0,
          generatedAt: stale,
          refreshedAt: stale,
          expiresAt: stale,
        },
      }),
      prisma.memory.create({
        data: {
          circleId,
          type: 'on_this_day',
          periodKey: '2026-05-02',
          subjectKey: '2016',
          title: 'old tombstoned',
          titleSource: 'template',
          periodStart: stale,
          periodEnd: stale,
          itemCount: 0,
          generatedAt: stale,
          refreshedAt: stale,
          expiresAt: stale,
          // Deliberately tombstoned: past the retention window the tombstone has
          // done its job and the row is reaped like any other.
          deletedAt: stale,
        },
      }),
      prisma.memory.create({
        data: {
          circleId,
          type: 'on_this_day',
          periodKey: '2026-08-08',
          subjectKey: '2017',
          title: 'recent',
          titleSource: 'template',
          periodStart: fresh,
          periodEnd: fresh,
          itemCount: 0,
          generatedAt: fresh,
          refreshedAt: fresh,
          expiresAt: fresh,
        },
      }),
    ]);

    const purged = await curator.purge(ctx());

    expect(purged).toBe(2);
    expect(await prisma.memory.findUnique({ where: { id: old1.id } })).toBeNull();
    expect(await prisma.memory.findUnique({ where: { id: old2.id } })).toBeNull();
    expect(await prisma.memory.findUnique({ where: { id: recent.id } })).not.toBeNull();
    // The freshly generated memory for today is untouched.
    expect(
      await prisma.memory.count({ where: { circleId, periodKey: '2026-08-09' } }),
    ).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Backfill mode
  // ---------------------------------------------------------------------------

  it('backfill widens to every (month, day) the circle has data on', async () => {
    // Two distinct calendar days, neither of them today or tomorrow.
    for (const hour of [8, 10, 12]) {
      await seedItem({ capturedAt: new Date(Date.UTC(2019, 0, 15, hour)) });
      await seedItem({ capturedAt: new Date(Date.UTC(2020, 5, 30, hour)) });
    }

    const scheduled = await curator.run(ctx());
    expect(scheduled.created).toBe(0);

    const backfilled = await curator.run(ctx({ backfill: true }));

    expect(backfilled.created).toBe(2);
    const memories = await prisma.memory.findMany({
      where: { circleId },
      orderBy: { periodKey: 'asc' },
    });
    // Anchors map to their NEXT occurrence, so a backfilled row is never born
    // already expired: Jan 15 has passed in 2026, June 30 has passed too.
    expect(memories.map((m) => m.periodKey)).toEqual(['2027-01-15', '2027-06-30']);
    for (const m of memories) {
      expect(m.expiresAt!.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  // ---------------------------------------------------------------------------
  // Engine internals against real SQL
  // ---------------------------------------------------------------------------

  it('loadCandidates pages through more rows than one page holds, without duplicates', async () => {
    // CANDIDATE_PAGE_SIZE is 500; 520 rows forces a second keyset page and
    // proves the cursor neither skips nor repeats at the boundary.
    const total = 520;
    const rows = Array.from({ length: total }, (_, i) => ({
      capturedAt: new Date(Date.UTC(2019, 7, 9, 0, 0, 0) + i * 60_000),
    }));
    for (const row of rows) await seedItem(row);

    const { candidates, truncated } = await curation.loadCandidates(circleId, {});

    expect(truncated).toBe(false);
    expect(candidates).toHaveLength(total);
    expect(new Set(candidates.map((c) => c.id)).size).toBe(total);
    // Keyset order is (capturedAt ASC, id ASC).
    for (let i = 1; i < candidates.length; i += 1) {
      expect(candidates[i]!.capturedAt.getTime()).toBeGreaterThanOrEqual(
        candidates[i - 1]!.capturedAt.getTime(),
      );
    }
  }, 60000);

  it('loadCandidates stops at maxCandidates and reports truncation', async () => {
    for (let i = 0; i < 12; i += 1) {
      await seedItem({ capturedAt: new Date(Date.UTC(2019, 7, 9, 0, i)) });
    }

    const { candidates, truncated } = await curation.loadCandidates(
      circleId,
      {},
      { maxCandidates: 5 },
    );

    expect(candidates).toHaveLength(5);
    expect(truncated).toBe(true);
  });

  it('caps videos at three and never uses one as cover', async () => {
    for (let i = 0; i < 6; i += 1) {
      await seedItem({
        capturedAt: anniversary(2019, 4 + i),
        type: 'video',
        durationMs: 15_000,
        favorite: true,
      });
    }
    const photo = await seedItem({ capturedAt: anniversary(2019, 20) });

    await curator.run(ctx());

    const memory = await prisma.memory.findFirstOrThrow({
      where: { circleId },
      include: { items: true },
    });
    const items = await prisma.mediaItem.findMany({
      where: { id: { in: memory.items.map((i) => i.mediaItemId) } },
      select: { id: true, type: true },
    });
    expect(items.filter((i) => i.type === 'video')).toHaveLength(3);
    expect(memory.coverMediaItemId).toBe(photo);
  });
});
