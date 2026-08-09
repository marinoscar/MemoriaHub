// DB_GATED: requires a real PostgreSQL with migrations applied. Reachability is
// probed synchronously at module load via `describeMaybeDb`, so with no database
// the whole suite is registered as `describe.skip` and reports SKIPPED — never a
// green PASS that asserted nothing. See test/helpers/db-probe.helper.ts.
//
// WHY THIS SUITE IS DB-BACKED AND NOT MOCKED
// ------------------------------------------
// Issue #305's theme/seasonal/year acceptance criteria are statements about SQL
// and about rows: "manual-only tags don't produce themes (source='ai' is
// required)", "a disabled tag_label stops producing", "the completed season and
// the December year-in-review generate on schedule while backfill fills
// history", "no AI tags ⇒ the theme curator skips cleanly and the others are
// unaffected". Against a mocked Prisma those would restate the implementation
// rather than prove the three-way join, the enum predicate or the census sum.
// The pure halves (tag ranking, the December/January window, denylist,
// bucketing) are unit tested with no database in
// src/memories/curators/curator-rules.spec.ts.
//
// Time is pinned so "the most recently completed season" and the year-in-review
// window are deterministic.

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { describeMaybeDb } from '../helpers/db-probe.helper';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MemoryCurationService } from '../../src/memories/curation/memory-curation.service';
import { neverCalledTitleService } from './memory-title.stub';
import { ThemeCurator } from '../../src/memories/curators/theme.curator';
import { SeasonalCurator } from '../../src/memories/curators/seasonal.curator';
import { YearInReviewCurator } from '../../src/memories/curators/year-in-review.curator';
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

/**
 * Fixed clock: 2026-08-09. Most recently completed season is spring 2026
 * (Mar–May); the year-in-review window is closed (August is neither December
 * nor January).
 */
const NOW = new Date(Date.UTC(2026, 7, 9, 12, 0, 0));
/** Inside the year-in-review window, for the December half of the rule. */
const DECEMBER_NOW = new Date(Date.UTC(2026, 11, 5, 12, 0, 0));
/** Inside the January half of the same rule — the New Year reminiscing window. */
const JANUARY_NOW = new Date(Date.UTC(2027, 0, 20, 12, 0, 0));
/** The January that makes 2025 the scheduled review year. */
const JANUARY_2026 = new Date(Date.UTC(2026, 0, 20, 12, 0, 0));

describeMaybeDb('Memories — theme / seasonal / year-in-review (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaClient;
  let curation: MemoryCurationService;
  let theme: ThemeCurator;
  let seasonal: SeasonalCurator;
  let yearInReview: YearInReviewCurator;

  const userId = randomUUID();
  const circleId = randomUUID();
  const emptyCircleId = randomUUID();
  const createdStorageObjectIds: string[] = [];
  /** TagLabel.name is GLOBALLY unique, so only labels this suite created are removed. */
  const createdTagLabelIds: string[] = [];

  function ctx(over: Partial<MemoryCuratorContext> = {}): MemoryCuratorContext {
    return {
      circleId,
      settings: resolveMemoriesSettings(undefined),
      now: NOW,
      backfill: false,
      ...over,
    };
  }

  function settingsWithThemes(
    themes: Partial<MemoriesSettingsValue['themes']>,
  ): MemoriesSettingsValue {
    return resolveMemoriesSettings({ themes } as Partial<MemoriesSettingsValue>);
  }

  async function seedItem(options: {
    capturedAt: Date | null;
    circle?: string;
    favorite?: boolean;
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
        storageKey: `memories-periodic/${storageObjectId}`,
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
        durationMs: options.durationMs ?? null,
        archivedAt: options.archivedAt ?? null,
        deletedAt: options.deletedAt ?? null,
        socialMediaSource: options.socialMediaSource ?? null,
      },
      select: { id: true },
    });
    return item.id;
  }

  /** A circle Tag plus (optionally) its global vocabulary entry. */
  async function seedTag(
    name: string,
    options: { label?: boolean; labelEnabled?: boolean } = {},
  ): Promise<string> {
    const tag = await prisma.tag.create({
      data: { circleId, addedById: userId, name },
      select: { id: true },
    });
    if (options.label !== false) {
      const label = await prisma.tagLabel.upsert({
        where: { name },
        update: { enabled: options.labelEnabled ?? true },
        create: { name, enabled: options.labelEnabled ?? true },
        select: { id: true },
      });
      createdTagLabelIds.push(label.id);
    }
    return tag.id;
  }

  async function tagItems(
    tagId: string,
    mediaItemIds: string[],
    source: 'ai' | 'manual' = 'ai',
  ): Promise<void> {
    await prisma.mediaTag.createMany({
      data: mediaItemIds.map((mediaItemId) => ({ tagId, mediaItemId, source })),
    });
  }

  /** `count` photos, one per day starting at the given UTC month/day. */
  async function seedDays(
    year: number,
    month0: number,
    day: number,
    count: number,
    over: { circle?: string; favorite?: boolean } = {},
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(
        await seedItem({
          capturedAt: new Date(Date.UTC(year, month0, day + i, 10, 0, 0)),
          circle: over.circle,
          favorite: over.favorite ?? false,
        }),
      );
    }
    return ids;
  }

  async function clearAll(): Promise<void> {
    await prisma.memory.deleteMany({ where: { circleId: { in: [circleId, emptyCircleId] } } });
    await prisma.mediaItem.deleteMany({ where: { circleId: { in: [circleId, emptyCircleId] } } });
    await prisma.tag.deleteMany({ where: { circleId } });
    if (createdTagLabelIds.length > 0) {
      await prisma.tagLabel.deleteMany({ where: { id: { in: createdTagLabelIds } } });
      createdTagLabelIds.length = 0;
    }
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
    theme = new ThemeCurator(prisma as unknown as PrismaService, curation);
    seasonal = new SeasonalCurator(prisma as unknown as PrismaService, curation);
    yearInReview = new YearInReviewCurator(prisma as unknown as PrismaService, curation);

    await prisma.user.create({
      data: { id: userId, email: `memories-periodic-${userId}@example.test` },
    });
    await prisma.circle.create({
      data: { id: circleId, name: 'Memories Periodic Circle', ownerId: userId },
    });
    await prisma.circle.create({
      data: { id: emptyCircleId, name: 'Memories Periodic Empty', ownerId: userId },
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

  // ===========================================================================
  // Theme
  // ===========================================================================

  describe('theme curator', () => {
    it('skips cleanly when the circle has no AI tags at all', async () => {
      // The epic's failure-mode matrix: no AI tags ⇒ theme curator skips,
      // everything else unaffected.
      await seedDays(2026, 4, 1, 12);

      await expect(theme.run(ctx())).resolves.toEqual({
        created: 0,
        refreshed: 0,
        skipped: 0,
        tombstoned: 0,
      });
      expect(await prisma.memory.count({ where: { circleId, type: 'theme' } })).toBe(0);
    });

    it('creates a memory for an AI-tagged theme, keyed by year and lowercased tag', async () => {
      const items = await seedDays(2026, 2, 1, 12);
      const tagId = await seedTag('Sunset');
      await tagItems(tagId, items);

      const result = await theme.run(ctx());

      const memory = await prisma.memory.findFirstOrThrow({
        where: { circleId, type: 'theme' },
      });
      expect(result.created).toBe(1);
      expect(memory.periodKey).toBe('2026');
      // Lowercased regardless of the Tag row's own casing, per the enum contract.
      expect(memory.subjectKey).toBe('sunset');
      expect(memory.title).toBe('Sunset');
      expect(memory.meta).toMatchObject({ tag: 'sunset', year: 2026 });
      expect(memory.personId).toBeNull();
    });

    it('ignores manual tag instances — source=ai is required', async () => {
      const items = await seedDays(2026, 2, 1, 12);
      const tagId = await seedTag('Taxes');
      await tagItems(tagId, items, 'manual');

      await theme.run(ctx());

      expect(await prisma.memory.count({ where: { circleId, type: 'theme' } })).toBe(0);
    });

    it('ignores a tag whose vocabulary label is disabled or absent', async () => {
      const disabledItems = await seedDays(2026, 2, 1, 12);
      const disabled = await seedTag('Retired', { labelEnabled: false });
      await tagItems(disabled, disabledItems);

      const unknownItems = await seedDays(2026, 3, 1, 12);
      const unknown = await seedTag('NotInVocabulary', { label: false });
      await tagItems(unknown, unknownItems);

      await theme.run(ctx());

      expect(await prisma.memory.count({ where: { circleId, type: 'theme' } })).toBe(0);
    });

    it('never produces a memory for a denylisted tag', async () => {
      const items = await seedDays(2026, 2, 1, 15);
      const tagId = await seedTag('screenshot');
      await tagItems(tagId, items);

      await theme.run(ctx());

      expect(await prisma.memory.count({ where: { circleId, type: 'theme' } })).toBe(0);
    });

    it('drops tags below minItems and keeps only the top maxPerPeriod', async () => {
      const beach = await seedTag('beach');
      const sunset = await seedTag('sunset');
      const pets = await seedTag('pets');
      const sparse = await seedTag('sparse');
      await tagItems(beach, await seedDays(2026, 1, 1, 20));
      await tagItems(sunset, await seedDays(2026, 2, 1, 16));
      await tagItems(pets, await seedDays(2026, 3, 1, 12));
      await tagItems(sparse, await seedDays(2026, 4, 1, 3));

      await theme.run(ctx({ settings: settingsWithThemes({ maxPerPeriod: 2 }) }));

      const memories = await prisma.memory.findMany({
        where: { circleId, type: 'theme' },
        orderBy: { subjectKey: 'asc' },
      });
      // Densest two only; "pets" qualifies on minItems but loses the ranking,
      // "sparse" never qualifies at all.
      expect(memories.map((m) => m.subjectKey)).toEqual(['beach', 'sunset']);
    });

    it('excludes base-filter violations from the item set and from ranking', async () => {
      const keep = await seedDays(2026, 2, 1, 9);
      const archived = await seedItem({
        capturedAt: new Date(Date.UTC(2026, 2, 20)),
        archivedAt: new Date(),
      });
      const trashed = await seedItem({
        capturedAt: new Date(Date.UTC(2026, 2, 21)),
        deletedAt: new Date(),
      });
      const social = await seedItem({
        capturedAt: new Date(Date.UTC(2026, 2, 22)),
        socialMediaSource: 'tiktok',
      });
      const undated = await seedItem({ capturedAt: null });
      const tagId = await seedTag('sunset');
      await tagItems(tagId, [...keep, archived, trashed, social, undated]);

      await theme.run(ctx());

      const memory = await prisma.memory.findFirstOrThrow({
        where: { circleId, type: 'theme' },
        include: { items: true },
      });
      expect(memory.items.map((i) => i.mediaItemId).sort()).toEqual([...keep].sort());
    });

    it('generates only the current year on a scheduled run, and per-year plus all on backfill', async () => {
      const tagId = await seedTag('sunset');
      await tagItems(tagId, await seedDays(2024, 2, 1, 10));
      await tagItems(tagId, await seedDays(2026, 2, 1, 10));

      await theme.run(ctx());
      expect(
        (await prisma.memory.findMany({ where: { circleId, type: 'theme' } })).map(
          (m) => m.periodKey,
        ),
      ).toEqual(['2026']);

      await theme.run(ctx({ backfill: true }));
      expect(
        (await prisma.memory.findMany({ where: { circleId, type: 'theme' } }))
          .map((m) => m.periodKey)
          .sort(),
      ).toEqual(['2024', '2026', 'all']);

      const all = await prisma.memory.findFirstOrThrow({
        where: { circleId, type: 'theme', periodKey: 'all' },
      });
      // The all-history memory draws from BOTH years, which is the whole point
      // of having one: neither year alone would need to clear the floor.
      expect(all.periodStart.getUTCFullYear()).toBe(2024);
      expect(all.periodEnd.getUTCFullYear()).toBe(2026);
    });

    it('never recreates a tombstoned theme', async () => {
      const tagId = await seedTag('sunset');
      await tagItems(tagId, await seedDays(2026, 2, 1, 12));
      await theme.run(ctx());

      const memory = await prisma.memory.findFirstOrThrow({ where: { circleId, type: 'theme' } });
      await prisma.memory.update({
        where: { id: memory.id },
        data: { deletedAt: new Date(), itemCount: 0 },
      });

      const result = await theme.run(ctx());

      expect(result.tombstoned).toBe(1);
      const after = await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } });
      expect(after.deletedAt).not.toBeNull();
      expect(after.itemCount).toBe(0);
    });

    it('is idempotent across runs', async () => {
      const tagId = await seedTag('sunset');
      await tagItems(tagId, await seedDays(2026, 2, 1, 12));

      await theme.run(ctx());
      const before = await prisma.memory.findMany({
        where: { circleId, type: 'theme' },
        select: { id: true, periodKey: true, subjectKey: true, itemCount: true },
      });

      const second = await theme.run(ctx());

      expect(second.created).toBe(0);
      expect(second.refreshed).toBe(1);
      expect(
        await prisma.memory.findMany({
          where: { circleId, type: 'theme' },
          select: { id: true, periodKey: true, subjectKey: true, itemCount: true },
        }),
      ).toEqual(before);
    });
  });

  // ===========================================================================
  // Seasonal
  // ===========================================================================

  describe('seasonal curator', () => {
    it('generates the most recently COMPLETED season and not the one in progress', async () => {
      // Spring 2026 (Mar–May) is complete; summer 2026 is still running.
      await seedDays(2026, 3, 1, 14);
      await seedDays(2026, 6, 1, 20);

      const result = await seasonal.run(ctx());

      const memories = await prisma.memory.findMany({ where: { circleId, type: 'seasonal' } });
      expect(result.created).toBe(1);
      expect(memories.map((m) => m.periodKey)).toEqual(['2026-spring']);
      expect(memories[0]!.title).toBe('Spring 2026');
      expect(memories[0]!.subjectKey).toBe('');
      expect(memories[0]!.expiresAt).toBeNull();
    });

    it('skips a season below minItems without curating', async () => {
      await seedDays(2026, 3, 1, 5);

      const result = await seasonal.run(ctx());

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
      expect(await prisma.memory.count({ where: { circleId, type: 'seasonal' } })).toBe(0);
    });

    it('files a December photo under the winter of ITS OWN year, spanning into January', async () => {
      // Winter 2025 = Dec 2025 through Feb 2026. Both halves must land in one
      // memory keyed to 2025, which is the whole reason the season year exists.
      const december = await seedDays(2025, 11, 5, 7);
      const january = await seedDays(2026, 0, 5, 7);

      await seasonal.run(ctx({ backfill: true }));

      const winter = await prisma.memory.findFirstOrThrow({
        where: { circleId, type: 'seasonal', periodKey: '2025-winter' },
        include: { items: true },
      });
      const ids = winter.items.map((i) => i.mediaItemId);
      expect(ids.some((id) => december.includes(id))).toBe(true);
      expect(ids.some((id) => january.includes(id))).toBe(true);
      expect(winter.title).toBe('Winter 2025');
    });

    it('sweeps every completed season with material on backfill', async () => {
      await seedDays(2025, 6, 1, 14); // summer 2025
      await seedDays(2025, 9, 1, 14); // fall 2025
      await seedDays(2026, 3, 1, 14); // spring 2026
      await seedDays(2026, 6, 1, 14); // summer 2026 — still running

      await seasonal.run(ctx({ backfill: true }));

      expect(
        (await prisma.memory.findMany({ where: { circleId, type: 'seasonal' } }))
          .map((m) => m.periodKey)
          .sort(),
      ).toEqual(['2025-fall', '2025-summer', '2026-spring']);
    });

    it('produces nothing for a circle whose only photos are in the running season', async () => {
      await seedDays(2026, 6, 1, 30);

      await seasonal.run(ctx({ backfill: true }));

      expect(await prisma.memory.count({ where: { circleId, type: 'seasonal' } })).toBe(0);
    });

    it('never recreates a tombstoned season', async () => {
      await seedDays(2026, 3, 1, 14);
      await seasonal.run(ctx());
      const memory = await prisma.memory.findFirstOrThrow({
        where: { circleId, type: 'seasonal' },
      });
      await prisma.memory.update({
        where: { id: memory.id },
        data: { deletedAt: new Date(), itemCount: 0 },
      });

      const result = await seasonal.run(ctx());

      expect(result.tombstoned).toBe(1);
      const after = await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } });
      expect(after.deletedAt).not.toBeNull();
      expect(after.itemCount).toBe(0);
    });

    it('is idempotent and returns nothing on an empty circle', async () => {
      await seedDays(2026, 3, 1, 14);
      await seasonal.run(ctx());
      const before = await prisma.memory.findMany({
        where: { circleId, type: 'seasonal' },
        select: { id: true, periodKey: true, itemCount: true },
      });

      const second = await seasonal.run(ctx());

      expect(second.created).toBe(0);
      expect(second.refreshed).toBe(1);
      expect(
        await prisma.memory.findMany({
          where: { circleId, type: 'seasonal' },
          select: { id: true, periodKey: true, itemCount: true },
        }),
      ).toEqual(before);

      await expect(seasonal.run(ctx({ circleId: emptyCircleId }))).resolves.toEqual({
        created: 0,
        refreshed: 0,
        skipped: 0,
        tombstoned: 0,
      });
    });
  });

  // ===========================================================================
  // Year in review
  // ===========================================================================

  describe('year-in-review curator', () => {
    it('generates nothing outside the December/January window', async () => {
      await seedDays(2025, 3, 1, 20);

      const result = await yearInReview.run(ctx());

      expect(result).toEqual({ created: 0, refreshed: 0, skipped: 0, tombstoned: 0 });
      expect(await prisma.memory.count({ where: { circleId, type: 'year_in_review' } })).toBe(0);
    });

    it('generates for the current year during December', async () => {
      await seedDays(2026, 3, 1, 20);

      await yearInReview.run(ctx({ now: DECEMBER_NOW }));

      const memory = await prisma.memory.findFirstOrThrow({
        where: { circleId, type: 'year_in_review' },
      });
      expect(memory.periodKey).toBe('2026');
      expect(memory.subjectKey).toBe('');
      expect(memory.title).toBe('Your 2026 in review');
      expect(memory.subtitle).toMatch(/highlights from the year$/);
    });

    it('keeps generating for the previous year through January', async () => {
      await seedDays(2026, 3, 1, 20);

      await yearInReview.run(ctx({ now: JANUARY_NOW }));

      expect(
        (await prisma.memory.findMany({ where: { circleId, type: 'year_in_review' } })).map(
          (m) => m.periodKey,
        ),
      ).toEqual(['2026']);
    });

    it('spreads items across months rather than clustering on the busiest one', async () => {
      // 28 photos in March, 6 each in June and October. Equal-span diversity
      // would still favour the dense cluster; month buckets must not.
      await seedDays(2025, 2, 1, 28);
      await seedDays(2025, 5, 1, 6);
      await seedDays(2025, 9, 1, 6);

      await yearInReview.run(ctx({ now: JANUARY_2026 }));

      const memory = await prisma.memory.findFirstOrThrow({
        where: { circleId, type: 'year_in_review', periodKey: '2025' },
        include: { items: true },
      });
      const items = await prisma.mediaItem.findMany({
        where: { id: { in: memory.items.map((i) => i.mediaItemId) } },
        select: { capturedAt: true },
      });
      const months = new Set(items.map((i) => i.capturedAt!.getUTCMonth()));
      expect([...months].sort((a, b) => a - b)).toEqual([2, 5, 9]);
      // June and October have 6 candidates each and both are represented well
      // beyond the single item an equal-span split would have guaranteed.
      expect(items.filter((i) => i.capturedAt!.getUTCMonth() === 5).length).toBeGreaterThan(1);
      expect(memory.meta).toMatchObject({ year: 2025, monthsCovered: 3 });
    });

    it('backfills every past year but refuses the still-running current one', async () => {
      await seedDays(2023, 3, 1, 20);
      await seedDays(2025, 3, 1, 20);
      await seedDays(2026, 3, 1, 20);

      await yearInReview.run(ctx({ backfill: true }));

      // NOW is August 2026, so 2026 is not eligible yet — a three-month "Your
      // 2026 in review" would churn for the rest of the year.
      expect(
        (await prisma.memory.findMany({ where: { circleId, type: 'year_in_review' } }))
          .map((m) => m.periodKey)
          .sort(),
      ).toEqual(['2023', '2025']);

      await yearInReview.run(ctx({ backfill: true, now: DECEMBER_NOW }));
      expect(
        (await prisma.memory.findMany({ where: { circleId, type: 'year_in_review' } }))
          .map((m) => m.periodKey)
          .sort(),
      ).toEqual(['2023', '2025', '2026']);
    });

    it('skips a year below minItems', async () => {
      await seedDays(2026, 3, 1, 10);

      const result = await yearInReview.run(ctx({ now: DECEMBER_NOW }));

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
      expect(await prisma.memory.count({ where: { circleId, type: 'year_in_review' } })).toBe(0);
    });

    it('never recreates a tombstoned year in review, and is otherwise idempotent', async () => {
      await seedDays(2026, 3, 1, 20);
      await yearInReview.run(ctx({ now: DECEMBER_NOW }));
      const memory = await prisma.memory.findFirstOrThrow({
        where: { circleId, type: 'year_in_review' },
      });

      const refresh = await yearInReview.run(ctx({ now: DECEMBER_NOW }));
      expect(refresh.created).toBe(0);
      expect(refresh.refreshed).toBe(1);

      await prisma.memory.update({
        where: { id: memory.id },
        data: { deletedAt: new Date(), itemCount: 0 },
      });
      const result = await yearInReview.run(ctx({ now: DECEMBER_NOW }));

      expect(result.tombstoned).toBe(1);
      const after = await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } });
      expect(after.deletedAt).not.toBeNull();
      expect(after.itemCount).toBe(0);
    });
  });

  // ===========================================================================
  // Independence
  // ===========================================================================

  it('leaves the other curators unaffected when one has nothing to work with', async () => {
    // Enough material for the most recently completed season (fall 2026, as of
    // DECEMBER_NOW) and for the 2026 year in review, but zero AI tags. Per the
    // epic's failure-mode matrix the theme curator must skip silently while
    // seasonal and year-in-review still produce.
    await seedDays(2026, 3, 1, 20);
    await seedDays(2026, 9, 1, 20);

    const themeResult = await theme.run(ctx({ now: DECEMBER_NOW }));
    const seasonalResult = await seasonal.run(ctx({ now: DECEMBER_NOW }));
    const yearResult = await yearInReview.run(ctx({ now: DECEMBER_NOW }));

    expect(themeResult.created).toBe(0);
    expect(seasonalResult.created).toBe(1);
    expect(yearResult.created).toBe(1);
  });
});
