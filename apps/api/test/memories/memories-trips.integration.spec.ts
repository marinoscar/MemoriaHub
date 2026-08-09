// DB_GATED: requires a real PostgreSQL with migrations applied. Reachability is
// probed synchronously at module load via `describeMaybeDb`, so with no database
// the whole suite is registered as `describe.skip` and reports SKIPPED — never a
// green PASS that asserted nothing. See test/helpers/db-probe.helper.ts.
//
// WHY THIS SUITE IS DB-BACKED AND NOT MOCKED
// ------------------------------------------
// Issue #304's acceptance criteria are statements about ROWS: "a seeded home
// cluster plus a 5-day away cluster yields exactly one trip memory", "late
// uploads that extend a trip refresh the SAME row", "a tombstoned trip is never
// resurrected even when boundaries shift", "a circle with no geo data skips
// cleanly". Against a mocked Prisma each of those would assert that the code
// called the mock the way the author expected — a restatement of the
// implementation, not evidence that the unique index held or that the overlap
// match actually found the row. The clustering algebra IS unit tested with no
// database in src/memories/curators/trip-clustering.spec.ts; everything here is
// specifically the part only a real database can prove.
//
// Time is pinned: `ctx.now` is a fixed instant, so the 24-month home window and
// the 18-month trip lookback are deterministic and fixtures can be seeded on
// exact dates relative to them.

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { describeMaybeDb } from '../helpers/db-probe.helper';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MemoryCurationService } from '../../src/memories/curation/memory-curation.service';
import { TripCurator } from '../../src/memories/curators/trip.curator';
import { MemoryCuratorContext } from '../../src/memories/curators/memory-curator.interface';
import { resolveMemoriesSettings } from '../../src/memories/memories-settings.util';
import { MemoriesSettingsValue } from '../../src/common/types/settings.types';

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

/** Fixed clock. Home window opens 2024-08-09; trip lookback opens 2025-02-09. */
const NOW = new Date(Date.UTC(2026, 7, 9, 12, 0, 0));

/** San José, Costa Rica — home. */
const HOME = { lat: 9.9281, lng: -84.0907, locality: 'San José', admin1: 'San José' };
/** Tamarindo, Guanacaste — ~180 km from home, well past the 50 km default. */
const AWAY = { lat: 10.2993, lng: -85.8371, locality: 'Tamarindo', admin1: 'Guanacaste' };
/** Puerto Viejo, Limón — a second, unrelated destination. */
const AWAY2 = { lat: 9.6558, lng: -82.7546, locality: 'Puerto Viejo', admin1: 'Limón' };

describeMaybeDb('Memories — Trips curator (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaClient;
  let curation: MemoryCurationService;
  let curator: TripCurator;

  const userId = randomUUID();
  const circleId = randomUUID();
  /** A second circle used for the no-geo / empty cases. */
  const otherCircleId = randomUUID();
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

  function settingsWithTrips(trips: Partial<MemoriesSettingsValue['trips']>): MemoriesSettingsValue {
    return resolveMemoriesSettings({ trips } as Partial<MemoriesSettingsValue>);
  }

  interface SeedItemOptions {
    capturedAt: Date;
    circle?: string;
    lat?: number | null;
    lng?: number | null;
    locality?: string | null;
    admin1?: string | null;
    country?: string | null;
    favorite?: boolean;
    type?: 'photo' | 'video';
    durationMs?: number | null;
    archivedAt?: Date | null;
    deletedAt?: Date | null;
    socialMediaSource?: string | null;
    duplicateGroupId?: string | null;
  }

  async function seedItem(options: SeedItemOptions): Promise<string> {
    const storageObjectId = randomUUID();
    createdStorageObjectIds.push(storageObjectId);
    await prisma.storageObject.create({
      data: {
        id: storageObjectId,
        name: `${storageObjectId}.jpg`,
        size: BigInt(2048),
        mimeType: 'image/jpeg',
        storageKey: `memories-trips/${storageObjectId}`,
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
        takenLat: options.lat ?? null,
        takenLng: options.lng ?? null,
        geoLocality: options.locality ?? null,
        geoAdmin1: options.admin1 ?? null,
        geoCountry: options.country ?? null,
        favorite: options.favorite ?? false,
        durationMs: options.durationMs ?? null,
        archivedAt: options.archivedAt ?? null,
        deletedAt: options.deletedAt ?? null,
        socialMediaSource: options.socialMediaSource ?? null,
        duplicateGroupId: options.duplicateGroupId ?? null,
      },
      select: { id: true },
    });
    return item.id;
  }

  /** A named place, or `null` for "this day has no coordinates at all". */
  type Place = { lat: number; lng: number; locality: string; admin1: string } | null;

  /** `count` items on the UTC calendar day `date`, at `place`. */
  async function seedDay(
    date: Date,
    place: Place,
    count = 4,
    extra: Partial<SeedItemOptions> = {},
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(
        await seedItem({
          capturedAt: new Date(date.getTime() + (8 + i) * 3_600_000),
          lat: place?.lat ?? null,
          lng: place?.lng ?? null,
          locality: place?.locality ?? null,
          admin1: place?.admin1 ?? null,
          country: place ? 'Costa Rica' : null,
          ...extra,
        }),
      );
    }
    return ids;
  }

  /** UTC midnight of `YYYY-MM-DD`. */
  function day(iso: string): Date {
    return new Date(`${iso}T00:00:00.000Z`);
  }

  /**
   * A believable home baseline: `days` days at home, four photos each, spread
   * every four days from 2025-08-15 — inside both the 24-month home window and
   * the 18-month trip lookback, and comfortably past the 30% modal share.
   *
   * The window is deliberately confined to LATE 2025, while every fixture trip
   * below is in 2026. A home day landing inside a trip's date range would be
   * pulled into that trip by `curate()`'s date-range slice (correctly — a photo
   * taken during the trip belongs to it), and a 50/50 split of home and away
   * coordinates on one day gives the marginal median a meaningless midpoint. Both
   * are real properties worth knowing about; neither is what these tests are
   * measuring, so the fixtures keep the two apart.
   */
  async function seedHomeBaseline(days = 40, circle = circleId): Promise<void> {
    for (let i = 0; i < days; i += 1) {
      const date = new Date(Date.UTC(2025, 7, 15) + i * 4 * 86_400_000);
      for (let j = 0; j < 4; j += 1) {
        await seedItem({
          capturedAt: new Date(date.getTime() + (8 + j) * 3_600_000),
          circle,
          lat: HOME.lat,
          lng: HOME.lng,
          locality: HOME.locality,
          admin1: HOME.admin1,
          country: 'Costa Rica',
        });
      }
    }
  }

  async function clearMemories(): Promise<void> {
    await prisma.memory.deleteMany({ where: { circleId: { in: [circleId, otherCircleId] } } });
  }

  async function clearMedia(): Promise<void> {
    await prisma.mediaItem.deleteMany({ where: { circleId: { in: [circleId, otherCircleId] } } });
    if (createdStorageObjectIds.length > 0) {
      await prisma.storageObject.deleteMany({ where: { id: { in: createdStorageObjectIds } } });
      createdStorageObjectIds.length = 0;
    }
  }

  beforeAll(async () => {
    const adapter = new PrismaPg({ connectionString: DATABASE_URL });
    prisma = new PrismaClient({ adapter });
    await prisma.$connect();

    curation = new MemoryCurationService(prisma as unknown as PrismaService);
    curator = new TripCurator(prisma as unknown as PrismaService, curation);

    await prisma.user.create({
      data: { id: userId, email: `memories-trips-${userId}@example.test` },
    });
    await prisma.circle.create({
      data: { id: circleId, name: 'Memories Trips Circle', ownerId: userId },
    });
    await prisma.circle.create({
      data: { id: otherCircleId, name: 'Memories Trips Other Circle', ownerId: userId },
    });
  }, 30000);

  afterAll(async () => {
    if (!prisma) return;
    await clearMemories().catch(() => undefined);
    await clearMedia().catch(() => undefined);
    await prisma.duplicateGroup.deleteMany({ where: { circleId } }).catch(() => undefined);
    await prisma.circle.deleteMany({ where: { id: { in: [circleId, otherCircleId] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }, 30000);

  afterEach(async () => {
    await clearMemories();
    await clearMedia();
    await prisma.duplicateGroup.deleteMany({ where: { circleId } });
  }, 30000);

  // ---------------------------------------------------------------------------
  // The headline scenario
  // ---------------------------------------------------------------------------

  it('turns a home cluster plus a 5-day away cluster into exactly one trip memory', async () => {
    await seedHomeBaseline();
    for (const iso of ['2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15', '2026-03-16']) {
      await seedDay(day(iso), AWAY, 4);
    }

    const result = await curator.run(ctx());

    expect(result.created).toBe(1);
    const memories = await prisma.memory.findMany({ where: { circleId, type: 'trip' } });
    expect(memories).toHaveLength(1);

    const trip = memories[0]!;
    expect(trip.periodKey).toBe('2026-03-12');
    expect(trip.subjectKey).toBe('tamarindo');
    expect(trip.title).toBe('Trip to Tamarindo');
    expect(trip.subtitle).toBe('March 2026');
    expect(trip.titleSource).toBe('template');
    expect(trip.itemCount).toBe(20);
    expect(trip.expiresAt).toBeNull();

    const meta = trip.meta as Record<string, unknown>;
    expect(meta['locality']).toBe('Tamarindo');
    expect(meta['admin1']).toBe('Guanacaste');
    expect(meta['country']).toBe('Costa Rica');
    expect(meta['dayCount']).toBe(5);
    expect(meta['startDate']).toBe('2026-03-12');
    expect(meta['endDate']).toBe('2026-03-16');
    expect(meta['homePlace']).toBe('San José');
    expect(meta['distanceKm'] as number).toBeGreaterThan(150);

    // The curated set is exactly the away days — no home photos leaked in.
    const items = await prisma.memoryItem.findMany({
      where: { memoryId: trip.id },
      orderBy: { position: 'asc' },
    });
    const media = await prisma.mediaItem.findMany({
      where: { id: { in: items.map((i) => i.mediaItemId) } },
      select: { geoLocality: true },
    });
    expect(new Set(media.map((m) => m.geoLocality))).toEqual(new Set(['Tamarindo']));
    expect(items.map((i) => i.position)).toEqual(items.map((_, idx) => idx));
    expect(trip.coverMediaItemId).not.toBeNull();
  }, 120000);

  it('a one-day photo gap mid-trip does not split it, and two trips 3 weeks apart are two memories', async () => {
    await seedHomeBaseline();
    // Trip A: 12th, 13th, (nothing on the 14th), 15th, 16th.
    for (const iso of ['2026-03-12', '2026-03-13', '2026-03-15', '2026-03-16']) {
      await seedDay(day(iso), AWAY, 4);
    }
    // Trip B: three weeks later, a different destination.
    for (const iso of ['2026-04-06', '2026-04-07', '2026-04-08']) {
      await seedDay(day(iso), AWAY2, 4);
    }

    const result = await curator.run(ctx());

    expect(result.created).toBe(2);
    const trips = await prisma.memory.findMany({
      where: { circleId, type: 'trip' },
      orderBy: { periodKey: 'asc' },
    });
    expect(trips.map((t) => t.periodKey)).toEqual(['2026-03-12', '2026-04-06']);
    expect(trips.map((t) => t.subjectKey)).toEqual(['tamarindo', 'puerto-viejo']);
    // The bridged gap is inside the span: 12th..16th is five days.
    expect((trips[0]!.meta as Record<string, unknown>)['dayCount']).toBe(5);
    expect((trips[1]!.meta as Record<string, unknown>)['dayCount']).toBe(3);
    expect(trips[1]!.title).toBe('Trip to Puerto Viejo');
  }, 120000);

  // ---------------------------------------------------------------------------
  // Idempotent regeneration & overlap-based refresh
  // ---------------------------------------------------------------------------

  it('re-running against an unchanged library changes nothing', async () => {
    await seedHomeBaseline();
    for (const iso of ['2026-03-12', '2026-03-13', '2026-03-14']) {
      await seedDay(day(iso), AWAY, 4);
    }

    const first = await curator.run(ctx());
    const before = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'trip' },
      include: { items: { orderBy: { position: 'asc' } } },
    });

    const second = await curator.run(ctx());
    const after = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'trip' },
      include: { items: { orderBy: { position: 'asc' } } },
    });

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.refreshed).toBe(1);
    expect(await prisma.memory.count({ where: { circleId, type: 'trip' } })).toBe(1);
    expect(after.id).toBe(before.id);
    expect(after.generatedAt).toEqual(before.generatedAt);
    expect(after.periodKey).toBe(before.periodKey);
    expect(after.items.map((i) => i.mediaItemId)).toEqual(before.items.map((i) => i.mediaItemId));
  }, 120000);

  it('late uploads that EXTEND a trip refresh the same row — re-keyed, not duplicated', async () => {
    await seedHomeBaseline();
    for (const iso of ['2026-03-14', '2026-03-15', '2026-03-16']) {
      await seedDay(day(iso), AWAY, 4);
    }
    await curator.run(ctx());

    const before = await prisma.memory.findFirstOrThrow({ where: { circleId, type: 'trip' } });
    expect(before.periodKey).toBe('2026-03-14');

    // Per-user state must survive the refresh — this is the whole reason
    // MemoryUserState is a separate table.
    const seenAt = new Date(Date.UTC(2026, 7, 1));
    await prisma.memoryUserState.create({
      data: { memoryId: before.id, userId, seenAt, favoritedAt: seenAt },
    });

    // A second camera's photos land: the trip actually started two days earlier
    // and ran a day longer. The detected boundaries — and therefore the identity
    // keys — move.
    for (const iso of ['2026-03-12', '2026-03-13', '2026-03-17']) {
      await seedDay(day(iso), AWAY, 4);
    }
    const result = await curator.run(ctx());

    expect(result.created).toBe(0);
    expect(result.refreshed).toBe(1);
    // Exactly one row, still the same row, now under the new keys.
    expect(await prisma.memory.count({ where: { circleId, type: 'trip' } })).toBe(1);

    const after = await prisma.memory.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.periodKey).toBe('2026-03-12');
    expect((after.meta as Record<string, unknown>)['endDate']).toBe('2026-03-17');
    expect(after.itemCount).toBe(24);

    const state = await prisma.memoryUserState.findFirstOrThrow({
      where: { memoryId: before.id, userId },
    });
    expect(state.seenAt).toEqual(seenAt);
    expect(state.favoritedAt).toEqual(seenAt);
  }, 120000);

  it('re-keys the subjectKey when a better geocode changes the dominant locality', async () => {
    await seedHomeBaseline();
    for (const iso of ['2026-03-12', '2026-03-13', '2026-03-14']) {
      await seedDay(day(iso), AWAY, 4);
    }
    await curator.run(ctx());
    const before = await prisma.memory.findFirstOrThrow({ where: { circleId, type: 'trip' } });
    expect(before.subjectKey).toBe('tamarindo');

    // A geocode backfill resolves the same coordinates to a nearby town.
    await prisma.mediaItem.updateMany({
      where: { circleId, geoLocality: 'Tamarindo' },
      data: { geoLocality: 'Playa Grande' },
    });
    const result = await curator.run(ctx());

    expect(result.refreshed).toBe(1);
    expect(await prisma.memory.count({ where: { circleId, type: 'trip' } })).toBe(1);
    const after = await prisma.memory.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.subjectKey).toBe('playa-grande');
    // The membership did not move at all, so #303's anti-churn rule would
    // normally preserve the title — leaving a memory keyed "playa-grande" and
    // titled "Trip to Tamarindo" forever. A drifted subject is a falsified
    // title, not an aged one, so the curator passes `retitle`.
    expect(after.title).toBe('Trip to Playa Grande');
    expect(after.titleSource).toBe('template');
  }, 120000);

  it('does NOT retitle when only the item set grew — #303 anti-churn still holds', async () => {
    await seedHomeBaseline();
    for (const iso of ['2026-03-12', '2026-03-13', '2026-03-14']) {
      await seedDay(day(iso), AWAY, 4);
    }
    await curator.run(ctx());
    const before = await prisma.memory.findFirstOrThrow({ where: { circleId, type: 'trip' } });

    // Stand in for #306 having written an AI title over the template.
    await prisma.memory.update({
      where: { id: before.id },
      data: {
        title: 'Five days of salt and sunburn',
        narrative: 'AI narrative',
        titleSource: 'ai',
        titleModel: 'gpt-test',
      },
    });

    // One photo joins a 12-item trip: well below the 30% material threshold, and
    // the place is unchanged, so nothing may touch the AI title.
    await seedDay(day('2026-03-13'), AWAY, 1);
    await curator.run(ctx());

    const after = await prisma.memory.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.title).toBe('Five days of salt and sunburn');
    expect(after.titleSource).toBe('ai');
    expect(after.narrative).toBe('AI narrative');
    expect(after.itemCount).toBe(13);
  }, 120000);

  // ---------------------------------------------------------------------------
  // The tombstone contract
  // ---------------------------------------------------------------------------

  it('NEVER resurrects a deleted trip, even when its detected boundaries shift', async () => {
    await seedHomeBaseline();
    for (const iso of ['2026-03-14', '2026-03-15', '2026-03-16']) {
      await seedDay(day(iso), AWAY, 4);
    }
    await curator.run(ctx());

    const memory = await prisma.memory.findFirstOrThrow({ where: { circleId, type: 'trip' } });
    const deletedAt = new Date();
    await prisma.memory.update({ where: { id: memory.id }, data: { deletedAt } });
    const tombstoned = await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } });

    // Extend the trip so the run would carry DIFFERENT keys than the tombstone.
    // A key-only tombstone check would sail straight past this and insert.
    for (const iso of ['2026-03-12', '2026-03-13', '2026-03-17']) {
      await seedDay(day(iso), AWAY, 4);
    }
    const result = await curator.run(ctx());

    expect(result.tombstoned).toBe(1);
    expect(result.created).toBe(0);
    expect(result.refreshed).toBe(0);
    expect(await prisma.memory.count({ where: { circleId, type: 'trip' } })).toBe(1);

    const after = await prisma.memory.findUniqueOrThrow({
      where: { id: memory.id },
      include: { items: true },
    });
    expect(after.deletedAt).toEqual(deletedAt);
    expect(after.periodKey).toBe(tombstoned.periodKey);
    expect(after.itemCount).toBe(tombstoned.itemCount);
    expect(after.refreshedAt).toEqual(tombstoned.refreshedAt);
    expect(after.updatedAt).toEqual(tombstoned.updatedAt);
  }, 120000);

  it('a tombstoned trip does not block an unrelated trip in the same circle', async () => {
    await seedHomeBaseline();
    for (const iso of ['2026-03-12', '2026-03-13', '2026-03-14']) {
      await seedDay(day(iso), AWAY, 4);
    }
    await curator.run(ctx());
    await prisma.memory.updateMany({
      where: { circleId, type: 'trip' },
      data: { deletedAt: new Date() },
    });

    for (const iso of ['2026-05-01', '2026-05-02', '2026-05-03']) {
      await seedDay(day(iso), AWAY2, 4);
    }
    const result = await curator.run(ctx());

    expect(result.tombstoned).toBe(1);
    expect(result.created).toBe(1);
    const live = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'trip', deletedAt: null },
    });
    expect(live.periodKey).toBe('2026-05-01');
  }, 120000);

  // ---------------------------------------------------------------------------
  // Graceful degradation
  // ---------------------------------------------------------------------------

  it('produces nothing and does not throw for an empty circle', async () => {
    const result = await curator.run(ctx({ circleId: otherCircleId }));

    expect(result).toEqual({ created: 0, refreshed: 0, skipped: 0, tombstoned: 0 });
    expect(await prisma.memory.count({ where: { circleId: otherCircleId } })).toBe(0);
  });

  it('skips cleanly when the circle has media but NO geo data at all', async () => {
    // The epic's failure-mode matrix: "no geo => trips curator skips, all other
    // types unaffected".
    for (const iso of ['2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15']) {
      await seedDay(day(iso), null, 5);
    }

    const result = await curator.run(ctx());

    expect(result).toEqual({ created: 0, refreshed: 0, skipped: 0, tombstoned: 0 });
    expect(await prisma.memory.count({ where: { circleId } })).toBe(0);
  }, 60000);

  it('skips when no locality holds a 30% share — a travel-only archive has no home', async () => {
    // Four destinations in four DIFFERENT provinces, evenly split: nowhere is a
    // center of gravity at either level, so neither the locality pass nor the
    // admin1 fallback can name a home. (Distinct admin1s matter — two towns in
    // one province would hand the fallback a 50% share and a home after all,
    // which is correct behavior and a different test.)
    const places = [
      AWAY,
      AWAY2,
      { lat: 9.9763, lng: -84.8267, locality: 'Jacó', admin1: 'Puntarenas' },
      { lat: 10.4806, lng: -84.6447, locality: 'La Fortuna', admin1: 'Alajuela' },
    ];
    let offset = 0;
    for (const place of places) {
      for (let i = 0; i < 3; i += 1) {
        await seedDay(new Date(Date.UTC(2026, 2, 1) + offset * 86_400_000), place, 4);
        offset += 1;
      }
    }

    const result = await curator.run(ctx());

    expect(result.created).toBe(0);
    expect(await prisma.memory.count({ where: { circleId, type: 'trip' } })).toBe(0);
  }, 120000);

  // ---------------------------------------------------------------------------
  // Thresholds
  // ---------------------------------------------------------------------------

  it('enforces trips.minDays', async () => {
    await seedHomeBaseline();
    // A single away day: below the default minDays of 2.
    await seedDay(day('2026-03-12'), AWAY, 12);

    const result = await curator.run(ctx());

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await prisma.memory.count({ where: { circleId, type: 'trip' } })).toBe(0);
  }, 120000);

  it('enforces trips.minItems', async () => {
    await seedHomeBaseline();
    // Three days away, 4 photos each = 12 candidates. Default minItems is 10, so
    // this qualifies; raising it to 20 must reject the very same fixture.
    for (const iso of ['2026-03-12', '2026-03-13', '2026-03-14']) {
      await seedDay(day(iso), AWAY, 4);
    }

    expect((await curator.run(ctx())).created).toBe(1);
    await clearMemories();

    const strict = await curator.run(ctx({ settings: settingsWithTrips({ minItems: 20 }) }));
    expect(strict.created).toBe(0);
    expect(strict.skipped).toBe(1);
  }, 120000);

  it('enforces trips.minDistanceKm — a day just down the road is not a trip', async () => {
    await seedHomeBaseline();
    // Cartago: ~20 km from San José, under the 50 km default.
    const nearby = { lat: 9.8644, lng: -83.9194, locality: 'Cartago', admin1: 'Cartago' };
    for (const iso of ['2026-03-12', '2026-03-13', '2026-03-14']) {
      await seedDay(day(iso), nearby, 4);
    }

    expect((await curator.run(ctx())).created).toBe(0);

    // Drop the threshold below that distance and the same days become a trip.
    const loose = await curator.run(ctx({ settings: settingsWithTrips({ minDistanceKm: 5 }) }));
    expect(loose.created).toBe(1);
    const trip = await prisma.memory.findFirstOrThrow({ where: { circleId, type: 'trip' } });
    expect(trip.subjectKey).toBe('cartago');
  }, 120000);

  it('honours trips.lookbackMonths, and backfill mode ignores it', async () => {
    await seedHomeBaseline();
    // Three years back: outside both the 18-month default lookback and the
    // 24-month home window, so only a backfill can see it.
    for (const iso of ['2023-03-12', '2023-03-13', '2023-03-14']) {
      await seedDay(day(iso), AWAY, 4);
    }

    expect((await curator.run(ctx())).created).toBe(0);

    const backfilled = await curator.run(ctx({ backfill: true }));
    expect(backfilled.created).toBe(1);
    const trip = await prisma.memory.findFirstOrThrow({ where: { circleId, type: 'trip' } });
    expect(trip.periodKey).toBe('2023-03-12');
    expect(trip.subtitle).toBe('March 2023');
  }, 120000);

  // ---------------------------------------------------------------------------
  // Shared curation engine behaviors, exercised through this curator
  // ---------------------------------------------------------------------------

  it('excludes archived, trashed and social-media items from a trip', async () => {
    await seedHomeBaseline();
    for (const iso of ['2026-03-12', '2026-03-13', '2026-03-14']) {
      await seedDay(day(iso), AWAY, 4);
    }
    // Each violates exactly one base-filter predicate, all inside the trip range.
    for (const extra of [
      { archivedAt: new Date() },
      { deletedAt: new Date() },
      { socialMediaSource: 'tiktok' },
    ]) {
      await seedItem({
        capturedAt: new Date(Date.UTC(2026, 2, 13, 20)),
        lat: AWAY.lat,
        lng: AWAY.lng,
        locality: AWAY.locality,
        admin1: AWAY.admin1,
        country: 'Costa Rica',
        ...extra,
      });
    }

    await curator.run(ctx());

    const trip = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'trip' },
      include: { items: true },
    });
    expect(trip.itemCount).toBe(12);
    const media = await prisma.mediaItem.findMany({
      where: { id: { in: trip.items.map((i) => i.mediaItemId) } },
      select: { archivedAt: true, deletedAt: true, socialMediaSource: true },
    });
    for (const m of media) {
      expect(m.archivedAt).toBeNull();
      expect(m.deletedAt).toBeNull();
      expect(m.socialMediaSource).toBeNull();
    }
  }, 120000);

  it('collapses near-duplicates and caps videos at three', async () => {
    await seedHomeBaseline();
    for (const iso of ['2026-03-12', '2026-03-13', '2026-03-14']) {
      await seedDay(day(iso), AWAY, 4);
    }

    // Six favorite videos inside the range — the cap must hold at three, and the
    // cover must stay a photo.
    for (let i = 0; i < 6; i += 1) {
      await seedItem({
        capturedAt: new Date(Date.UTC(2026, 2, 13, 12, i)),
        lat: AWAY.lat,
        lng: AWAY.lng,
        locality: AWAY.locality,
        admin1: AWAY.admin1,
        country: 'Costa Rica',
        type: 'video',
        durationMs: 15_000,
        favorite: true,
      });
    }

    // A duplicate group of three photos must contribute exactly one item.
    const group = await prisma.duplicateGroup.create({
      data: { circleId, status: 'pending', mediaCount: 3 },
      select: { id: true },
    });
    const members: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      members.push(
        await seedItem({
          capturedAt: new Date(Date.UTC(2026, 2, 14, 15, i)),
          lat: AWAY.lat,
          lng: AWAY.lng,
          locality: AWAY.locality,
          admin1: AWAY.admin1,
          country: 'Costa Rica',
          duplicateGroupId: group.id,
        }),
      );
    }
    await prisma.duplicateGroup.update({
      where: { id: group.id },
      data: { suggestedBestItemId: members[1] },
    });

    await curator.run(ctx());

    const trip = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'trip' },
      include: { items: true },
    });
    const ids = trip.items.map((i) => i.mediaItemId);
    const media = await prisma.mediaItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, type: true },
    });
    expect(media.filter((m) => m.type === 'video')).toHaveLength(3);
    // Exactly the group's own suggested best represents the duplicate group.
    expect(ids.filter((id) => members.includes(id))).toEqual([members[1]!]);

    const cover = await prisma.mediaItem.findUniqueOrThrow({
      where: { id: trip.coverMediaItemId! },
      select: { type: true },
    });
    expect(cover.type).toBe('photo');
  }, 120000);

  it('does not leak another circle\'s away days into a trip', async () => {
    await seedHomeBaseline();
    await seedHomeBaseline(6, otherCircleId);
    for (const iso of ['2026-03-12', '2026-03-13', '2026-03-14']) {
      await seedDay(day(iso), AWAY, 4);
      for (let i = 0; i < 4; i += 1) {
        await seedItem({
          capturedAt: new Date(day(iso).getTime() + (8 + i) * 3_600_000),
          circle: otherCircleId,
          lat: AWAY2.lat,
          lng: AWAY2.lng,
          locality: AWAY2.locality,
          admin1: AWAY2.admin1,
          country: 'Costa Rica',
        });
      }
    }

    await curator.run(ctx());

    const trip = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'trip' },
      include: { items: true },
    });
    expect(trip.itemCount).toBe(12);
    const media = await prisma.mediaItem.findMany({
      where: { id: { in: trip.items.map((i) => i.mediaItemId) } },
      select: { circleId: true },
    });
    expect(new Set(media.map((m) => m.circleId))).toEqual(new Set([circleId]));
  }, 120000);
});
