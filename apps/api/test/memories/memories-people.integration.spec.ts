// DB_GATED: requires a real PostgreSQL with migrations applied. Reachability is
// probed synchronously at module load via `describeMaybeDb`, so with no database
// the whole suite is registered as `describe.skip` and reports SKIPPED — never a
// green PASS that asserted nothing. See test/helpers/db-probe.helper.ts.
//
// WHY THIS SUITE IS DB-BACKED AND NOT MOCKED
// ------------------------------------------
// Issue #305's people acceptance criteria are statements about ROWS and about
// SQL: "a favorite person with photos across four years gets one memory per
// qualifying year plus one spanning them", "favoritesOnly=false widens the set",
// "a hidden person NEVER gets a memory", "deleting or merging a person cascades
// their memories away and the next run regenerates under the survivor", "a
// tombstoned memory is never resurrected". Against a mocked Prisma each of those
// would assert that the code called the mock the way the author expected — not
// that the Cascade FK fired, that the eligibility predicate actually excluded
// the hidden person, or that the unique index held. The pure halves (bucketed
// selection, thresholds) are unit tested with no database in
// src/memories/curators/curator-rules.spec.ts.
//
// Time is pinned so "current year" and "last year" are deterministic and the
// fixtures can be seeded on exact years relative to them.

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { describeMaybeDb } from '../helpers/db-probe.helper';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MemoryCurationService } from '../../src/memories/curation/memory-curation.service';
import { neverCalledTitleService } from './memory-title.stub';
import { PersonHighlightsCurator } from '../../src/memories/curators/person-highlights.curator';
import { PersonOverYearsCurator } from '../../src/memories/curators/person-over-years.curator';
import { PERSON_OVER_YEARS_MAX_PER_YEAR } from '../../src/memories/curators/person-candidates';
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

/** Fixed clock — "this year" is 2026, "last year" 2025. */
const NOW = new Date(Date.UTC(2026, 7, 9, 12, 0, 0));

describeMaybeDb('Memories — people curators (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaClient;
  let curation: MemoryCurationService;
  let highlights: PersonHighlightsCurator;
  let overYears: PersonOverYearsCurator;

  const userId = randomUUID();
  const circleId = randomUUID();
  /** A second, deliberately face-less circle — the no-persons degradation case. */
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

  function settingsWithPeople(
    people: Partial<MemoriesSettingsValue['people']>,
  ): MemoriesSettingsValue {
    return resolveMemoriesSettings({ people } as Partial<MemoriesSettingsValue>);
  }

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
  }): Promise<string> {
    const storageObjectId = randomUUID();
    createdStorageObjectIds.push(storageObjectId);
    await prisma.storageObject.create({
      data: {
        id: storageObjectId,
        name: `${storageObjectId}.jpg`,
        size: BigInt(2048),
        mimeType: 'image/jpeg',
        storageKey: `memories-people/${storageObjectId}`,
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
      },
      select: { id: true },
    });
    return item.id;
  }

  async function seedPerson(options: {
    name?: string | null;
    favorite?: boolean;
    hiddenAt?: Date | null;
    deletedAt?: Date | null;
    circle?: string;
  }): Promise<string> {
    const person = await prisma.person.create({
      data: {
        circleId: options.circle ?? circleId,
        addedById: userId,
        name: options.name === undefined ? `Person ${randomUUID().slice(0, 8)}` : options.name,
        favorite: options.favorite ?? true,
        hiddenAt: options.hiddenAt ?? null,
        deletedAt: options.deletedAt ?? null,
      },
      select: { id: true },
    });
    return person.id;
  }

  async function seedFace(options: {
    mediaItemId: string;
    personId: string | null;
    circle?: string;
    confidence?: number | null;
    hiddenAt?: Date | null;
  }): Promise<string> {
    const face = await prisma.face.create({
      data: {
        mediaItemId: options.mediaItemId,
        circleId: options.circle ?? circleId,
        personId: options.personId,
        boundingBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        confidence: options.confidence ?? 0.9,
        embedding: [],
        providerKey: 'compreface',
        modelVersion: 'test',
        hiddenAt: options.hiddenAt ?? null,
      },
      select: { id: true },
    });
    return face.id;
  }

  /** `count` photos of `personId` in `year`, one per day from Jan 2. */
  async function seedPersonYear(
    personId: string,
    year: number,
    count: number,
    over: { favorite?: boolean; confidence?: number } = {},
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = await seedItem({
        capturedAt: new Date(Date.UTC(year, 0, 2 + i, 10, 0, 0)),
        favorite: over.favorite ?? false,
      });
      await seedFace({ mediaItemId: id, personId, confidence: over.confidence ?? 0.9 });
      ids.push(id);
    }
    return ids;
  }

  async function clearAll(): Promise<void> {
    await prisma.memory.deleteMany({ where: { circleId: { in: [circleId, emptyCircleId] } } });
    await prisma.face.deleteMany({ where: { circleId: { in: [circleId, emptyCircleId] } } });
    await prisma.person.deleteMany({ where: { circleId: { in: [circleId, emptyCircleId] } } });
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

    curation = new MemoryCurationService(
      prisma as unknown as PrismaService,
      // #306: never invoked here — these contexts carry no `titling` run,
      // so upsertMemory short-circuits to deterministic template titles.
      neverCalledTitleService(),
    );
    highlights = new PersonHighlightsCurator(prisma as unknown as PrismaService, curation);
    overYears = new PersonOverYearsCurator(prisma as unknown as PrismaService, curation);

    await prisma.user.create({
      data: { id: userId, email: `memories-people-${userId}@example.test` },
    });
    await prisma.circle.create({
      data: { id: circleId, name: 'Memories People Circle', ownerId: userId },
    });
    await prisma.circle.create({
      data: { id: emptyCircleId, name: 'Memories People Empty', ownerId: userId },
    });
  }, 30000);

  afterAll(async () => {
    if (!prisma) return;
    await clearAll().catch(() => undefined);
    await prisma.circle.deleteMany({ where: { id: { in: [circleId, emptyCircleId] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }, 30000);

  afterEach(async () => {
    await clearAll();
  });

  // ---------------------------------------------------------------------------
  // Graceful degradation
  // ---------------------------------------------------------------------------

  it('skips cleanly when the circle has no persons at all', async () => {
    // The epic's failure-mode matrix: no faces/persons ⇒ people curators skip,
    // everything else unaffected. It must not throw and must not write.
    await seedItem({ capturedAt: new Date(Date.UTC(2025, 5, 1)) });

    await expect(highlights.run(ctx({ circleId: emptyCircleId }))).resolves.toEqual({
      created: 0,
      refreshed: 0,
      skipped: 0,
      tombstoned: 0,
    });
    await expect(overYears.run(ctx({ circleId: emptyCircleId }))).resolves.toEqual({
      created: 0,
      refreshed: 0,
      skipped: 0,
      tombstoned: 0,
    });
    expect(await prisma.memory.count({ where: { circleId: emptyCircleId } })).toBe(0);
  });

  it('skips a person who has no faces on any qualifying media', async () => {
    const personId = await seedPerson({ name: 'Ghost' });
    // Faces exist, but only on items the base filter rejects.
    const archived = await seedItem({
      capturedAt: new Date(Date.UTC(2025, 5, 1)),
      archivedAt: new Date(),
    });
    await seedFace({ mediaItemId: archived, personId });

    const result = await highlights.run(ctx());

    expect(result.created).toBe(0);
    expect(await prisma.memory.count({ where: { circleId } })).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // person_highlights
  // ---------------------------------------------------------------------------

  it('creates one memory per qualifying year, keyed by year and personId', async () => {
    const personId = await seedPerson({ name: 'Abuela' });
    await seedPersonYear(personId, 2025, 10);
    await seedPersonYear(personId, 2026, 9);
    // Below the default minItems of 8 — must not produce a memory.
    await seedPersonYear(personId, 2024, 4);

    const result = await highlights.run(ctx());

    const memories = await prisma.memory.findMany({
      where: { circleId, type: 'person_highlights' },
      orderBy: { periodKey: 'asc' },
    });
    expect(memories.map((m) => m.periodKey)).toEqual(['2025', '2026']);
    expect(memories.every((m) => m.subjectKey === personId)).toBe(true);
    expect(memories.every((m) => m.personId === personId)).toBe(true);
    expect(memories[0]!.title).toBe('Best of Abuela');
    expect(memories[0]!.subtitle).toBe('2025');
    expect(memories[0]!.titleSource).toBe('template');
    expect(result.created).toBe(2);
    // 2024 is in scope (it is not current/previous year) only under backfill —
    // scheduled runs never even look at it, so it is not counted as skipped.
    expect(result.skipped).toBe(0);
  });

  it('limits a scheduled run to the current and previous year, and backfill to all', async () => {
    const personId = await seedPerson({ name: 'Camila' });
    for (const year of [2019, 2020, 2025, 2026]) await seedPersonYear(personId, year, 10);

    await highlights.run(ctx());
    expect(
      (await prisma.memory.findMany({ where: { circleId, type: 'person_highlights' } }))
        .map((m) => m.periodKey)
        .sort(),
    ).toEqual(['2025', '2026']);

    await highlights.run(ctx({ backfill: true }));
    expect(
      (await prisma.memory.findMany({ where: { circleId, type: 'person_highlights' } }))
        .map((m) => m.periodKey)
        .sort(),
    ).toEqual(['2019', '2020', '2025', '2026']);
  });

  it('excludes base-filter violations and archived faces from the item set', async () => {
    const personId = await seedPerson({ name: 'Nora' });
    const keep = await seedPersonYear(personId, 2025, 8);

    // Each violates exactly one rule and must not appear.
    const archived = await seedItem({
      capturedAt: new Date(Date.UTC(2025, 6, 1)),
      archivedAt: new Date(),
    });
    await seedFace({ mediaItemId: archived, personId });
    const trashed = await seedItem({
      capturedAt: new Date(Date.UTC(2025, 6, 2)),
      deletedAt: new Date(),
    });
    await seedFace({ mediaItemId: trashed, personId });
    const social = await seedItem({
      capturedAt: new Date(Date.UTC(2025, 6, 3)),
      socialMediaSource: 'tiktok',
    });
    await seedFace({ mediaItemId: social, personId });
    // A LIVE item, but the person's face on it was archived — an archived face
    // is no longer evidence the person is in that photo.
    const hiddenFaceItem = await seedItem({ capturedAt: new Date(Date.UTC(2025, 6, 4)) });
    await seedFace({ mediaItemId: hiddenFaceItem, personId, hiddenAt: new Date() });

    await highlights.run(ctx());

    const memory = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'person_highlights', periodKey: '2025' },
      include: { items: true },
    });
    expect(memory.items.map((i) => i.mediaItemId).sort()).toEqual([...keep].sort());
  });

  it('never generates for a hidden or soft-deleted person', async () => {
    const hidden = await seedPerson({ name: 'Hidden', hiddenAt: new Date() });
    const deleted = await seedPerson({ name: 'Deleted', deletedAt: new Date() });
    await seedPersonYear(hidden, 2025, 12);
    await seedPersonYear(deleted, 2025, 12);

    await highlights.run(ctx());
    await overYears.run(ctx());

    expect(await prisma.memory.count({ where: { circleId } })).toBe(0);
  });

  it('honours favoritesOnly, and widens to any named person when it is off', async () => {
    const favorite = await seedPerson({ name: 'Favorite', favorite: true });
    const plain = await seedPerson({ name: 'Plain', favorite: false });
    await seedPersonYear(favorite, 2025, 10);
    await seedPersonYear(plain, 2025, 10);

    await highlights.run(ctx());
    expect(
      (await prisma.memory.findMany({ where: { circleId, type: 'person_highlights' } })).map(
        (m) => m.subjectKey,
      ),
    ).toEqual([favorite]);

    await highlights.run(ctx({ settings: settingsWithPeople({ favoritesOnly: false }) }));
    expect(
      (await prisma.memory.findMany({ where: { circleId, type: 'person_highlights' } }))
        .map((m) => m.subjectKey)
        .sort(),
    ).toEqual([favorite, plain].sort());
  });

  it('ignores a person with neither a name nor a cover face', async () => {
    // An unlabeled, uncovered cluster the user has never engaged with is not
    // something to build "Best of …" around.
    const anonymous = await seedPerson({ name: null });
    await seedPersonYear(anonymous, 2025, 12);

    await highlights.run(ctx({ settings: settingsWithPeople({ favoritesOnly: false }) }));

    expect(await prisma.memory.count({ where: { circleId } })).toBe(0);
  });

  it('includes an unnamed person that has a cover face, with the generic title', async () => {
    const personId = await seedPerson({ name: null });
    const items = await seedPersonYear(personId, 2025, 10);
    const coverFace = await seedFace({ mediaItemId: items[0]!, personId });
    await prisma.person.update({ where: { id: personId }, data: { coverFaceId: coverFace } });

    await highlights.run(ctx());

    const memory = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'person_highlights' },
    });
    expect(memory.title).toBe('Best moments together');
  });

  it('prefers the item carrying the person’s highest-confidence face as cover', async () => {
    const personId = await seedPerson({ name: 'Cover' });
    const items = await seedPersonYear(personId, 2025, 9, { confidence: 0.5 });
    // The engine's own cover rule would pick the highest-SCORED item; make a
    // different item the one where this person is most confidently detected.
    const star = items[6]!;
    await prisma.face.updateMany({ where: { mediaItemId: star, personId }, data: { confidence: 0.99 } });
    // …and make a different item score highest, so the two rules disagree.
    await prisma.mediaItem.update({ where: { id: items[0]! }, data: { favorite: true } });

    await highlights.run(ctx());

    const memory = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'person_highlights' },
    });
    expect(memory.coverMediaItemId).toBe(star);
  });

  // ---------------------------------------------------------------------------
  // person_over_years
  // ---------------------------------------------------------------------------

  it('requires at least three distinct years', async () => {
    const twoYears = await seedPerson({ name: 'Two' });
    await seedPersonYear(twoYears, 2024, 8);
    await seedPersonYear(twoYears, 2025, 8);

    const result = await overYears.run(ctx());

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await prisma.memory.count({ where: { circleId, type: 'person_over_years' } })).toBe(0);
  });

  it('creates one all-time memory keyed by personId, spanning every year', async () => {
    const personId = await seedPerson({ name: 'Camila' });
    for (const year of [2022, 2023, 2024, 2025]) await seedPersonYear(personId, year, 6);

    const result = await overYears.run(ctx());

    const memory = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'person_over_years' },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    expect(result.created).toBe(1);
    expect(memory.periodKey).toBe('all');
    expect(memory.subjectKey).toBe(personId);
    expect(memory.personId).toBe(personId);
    expect(memory.title).toBe('Camila through the years');
    expect(memory.subtitle).toBe('2022–2025');
    expect(memory.meta).toMatchObject({ firstYear: 2022, lastYear: 2025, yearCount: 4 });

    // Year-bucketed: every year represented, none above the per-year cap.
    const items = await prisma.mediaItem.findMany({
      where: { id: { in: memory.items.map((i) => i.mediaItemId) } },
      select: { id: true, capturedAt: true },
    });
    const perYear = new Map<number, number>();
    for (const item of items) {
      const year = item.capturedAt!.getUTCFullYear();
      perYear.set(year, (perYear.get(year) ?? 0) + 1);
    }
    expect([...perYear.keys()].sort()).toEqual([2022, 2023, 2024, 2025]);
    expect([...perYear.values()].every((n) => n <= PERSON_OVER_YEARS_MAX_PER_YEAR)).toBe(true);
  });

  it('orders items chronologically — the "growing up" effect', async () => {
    const personId = await seedPerson({ name: 'Growing' });
    for (const year of [2018, 2021, 2024]) await seedPersonYear(personId, year, 6);

    await overYears.run(ctx());

    const memory = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'person_over_years' },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    const captured = await Promise.all(
      memory.items.map(async (item) => {
        const media = await prisma.mediaItem.findUniqueOrThrow({
          where: { id: item.mediaItemId },
          select: { capturedAt: true },
        });
        return media.capturedAt!.getTime();
      }),
    );
    expect(captured).toEqual([...captured].sort((a, b) => a - b));
  });

  it('behaves identically under backfill, since its period is always "all"', async () => {
    const personId = await seedPerson({ name: 'Same' });
    for (const year of [2022, 2023, 2024]) await seedPersonYear(personId, year, 6);

    await overYears.run(ctx());
    const first = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'person_over_years' },
    });

    const second = await overYears.run(ctx({ backfill: true }));

    expect(second.created).toBe(0);
    expect(second.refreshed).toBe(1);
    expect(await prisma.memory.count({ where: { circleId, type: 'person_over_years' } })).toBe(1);
    expect(
      (await prisma.memory.findFirstOrThrow({ where: { id: first.id } })).id,
    ).toBe(first.id);
  });

  // ---------------------------------------------------------------------------
  // Idempotency, tombstones, and the person cascade
  // ---------------------------------------------------------------------------

  it('is idempotent: a second run refreshes in place and creates nothing', async () => {
    const personId = await seedPerson({ name: 'Idem' });
    for (const year of [2024, 2025, 2026]) await seedPersonYear(personId, year, 10);

    await highlights.run(ctx());
    await overYears.run(ctx());
    const before = await prisma.memory.findMany({
      where: { circleId },
      orderBy: [{ type: 'asc' }, { periodKey: 'asc' }],
      select: { id: true, type: true, periodKey: true, itemCount: true },
    });

    const h = await highlights.run(ctx());
    const o = await overYears.run(ctx());

    const after = await prisma.memory.findMany({
      where: { circleId },
      orderBy: [{ type: 'asc' }, { periodKey: 'asc' }],
      select: { id: true, type: true, periodKey: true, itemCount: true },
    });
    expect(h.created).toBe(0);
    expect(o.created).toBe(0);
    // Same rows, same ids, same membership — not a fresh set that happens to
    // look alike.
    expect(after).toEqual(before);
  });

  it('never recreates a tombstoned person memory', async () => {
    const personId = await seedPerson({ name: 'Tombstone' });
    for (const year of [2024, 2025, 2026]) await seedPersonYear(personId, year, 10);
    await highlights.run(ctx());
    await overYears.run(ctx());

    const doomed = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'person_highlights', periodKey: '2025' },
    });
    const overYearsMemory = await prisma.memory.findFirstOrThrow({
      where: { circleId, type: 'person_over_years' },
    });
    const deletedAt = new Date();
    await prisma.memory.updateMany({
      where: { id: { in: [doomed.id, overYearsMemory.id] } },
      data: { deletedAt, itemCount: 0 },
    });

    const h = await highlights.run(ctx());
    const o = await overYears.run(ctx());

    expect(h.tombstoned).toBe(1);
    expect(o.tombstoned).toBe(1);
    for (const id of [doomed.id, overYearsMemory.id]) {
      const row = await prisma.memory.findUniqueOrThrow({ where: { id } });
      // Untouched: still tombstoned, still zeroed, not refreshed back to life.
      expect(row.deletedAt).not.toBeNull();
      expect(row.itemCount).toBe(0);
    }
  });

  it('cascades a person’s memories away on delete and regenerates under the survivor', async () => {
    // The merge shape: source is soft-deleted and its faces are reassigned to
    // the target, exactly as PeopleService.merge does.
    const source = await seedPerson({ name: 'Source' });
    const target = await seedPerson({ name: 'Target' });
    for (const year of [2024, 2025, 2026]) await seedPersonYear(source, year, 10);
    for (const year of [2024, 2025, 2026]) await seedPersonYear(target, year, 10);

    await highlights.run(ctx());
    await overYears.run(ctx());
    expect(await prisma.memory.count({ where: { circleId, personId: source } })).toBeGreaterThan(0);

    await prisma.face.updateMany({ where: { personId: source }, data: { personId: target } });
    await prisma.person.update({
      where: { id: source },
      data: { deletedAt: new Date(), mergedIntoId: target },
    });
    // Hard-deleting the person is what a real delete does; the merge leaves the
    // row soft-deleted, which alone only stops FUTURE generation. Assert the
    // Cascade FK for the hard-delete case.
    const survivingBefore = await prisma.memory.count({ where: { circleId, personId: target } });
    await prisma.person.delete({ where: { id: source } });

    expect(await prisma.memory.count({ where: { circleId, personId: source } })).toBe(0);
    expect(await prisma.memory.count({ where: { circleId, personId: target } })).toBe(
      survivingBefore,
    );

    // The next run regenerates under the survivor, now holding both face sets.
    const h = await highlights.run(ctx());
    const o = await overYears.run(ctx());
    expect(h.created + h.refreshed).toBeGreaterThan(0);
    expect(o.refreshed).toBe(1);
    expect(await prisma.memory.count({ where: { circleId, personId: source } })).toBe(0);
  });

  it('respects a raised minItems', async () => {
    const personId = await seedPerson({ name: 'Strict' });
    await seedPersonYear(personId, 2025, 10);

    await highlights.run(ctx({ settings: settingsWithPeople({ minItems: 20 }) }));

    expect(await prisma.memory.count({ where: { circleId, type: 'person_highlights' } })).toBe(0);
  });
});
