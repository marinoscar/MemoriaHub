/**
 * Unit tests for OnThisDayCurator's anchor resolution (epic #300, issue #315).
 *
 * Anchor selection is the axis a library backfill is sharded along, so it is
 * worth pinning down directly:
 *
 *  • a SCHEDULED run resolves today + tomorrow and never touches the DISTINCT
 *    scan, so nothing about sharding leaks into the hourly cron;
 *  • a full backfill scans every month;
 *  • a SHARDED backfill pushes its month filter into SQL rather than filtering
 *    the result set, which is what stops twelve shards from each scanning the
 *    whole circle.
 *
 * PrismaService and MemoryCurationService are mocked — this asserts the query
 * that is built and the anchors that come out of it, not the database.
 */

import { Prisma } from '@prisma/client';
import { MemoryCurationService } from '../curation/memory-curation.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_SYSTEM_SETTINGS, MemoriesSettingsValue } from '../../common/types/settings.types';
import { OnThisDayCurator } from './on-this-day.curator';
import { MemoryCuratorContext } from './memory-curator.interface';

const SETTINGS = DEFAULT_SYSTEM_SETTINGS.memories as MemoriesSettingsValue;

function makeContext(over: Partial<MemoryCuratorContext> = {}): MemoryCuratorContext {
  return {
    circleId: '11111111-1111-1111-1111-111111111111',
    settings: SETTINGS,
    now: new Date('2026-08-09T12:00:00.000Z'),
    backfill: false,
    ...over,
  };
}

describe('OnThisDayCurator — anchor resolution', () => {
  let curator: OnThisDayCurator;
  let queryRaw: jest.Mock;

  /** The anchor `periodKey`s the curator ended up curating, in order. */
  let curatedPeriodKeys: string[];

  beforeEach(() => {
    curatedPeriodKeys = [];
    queryRaw = jest.fn();

    const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
    const curation = {
      // Every anchor's per-year query returns nothing, so `curateAnchor` exits
      // early — the anchor SET is what this spec is about.
      curate: jest.fn(),
      upsertMemory: jest.fn(),
    } as unknown as MemoryCurationService;

    curator = new OnThisDayCurator(prisma, curation);

    // First call per anchor is the DISTINCT month/day scan (backfill only);
    // every subsequent one is that anchor's per-year id query.
    queryRaw.mockImplementation((sql: Prisma.Sql) => {
      const text = sql.text ?? '';
      if (text.includes('SELECT DISTINCT')) return Promise.resolve([]);
      curatedPeriodKeys.push('anchor');
      return Promise.resolve([]);
    });
  });

  // -------------------------------------------------------------------------
  it('SCHEDULED: resolves today + tomorrow without the DISTINCT scan', async () => {
    await curator.run(makeContext());

    const statements = queryRaw.mock.calls.map((call) => (call[0] as Prisma.Sql).text ?? '');
    expect(statements.some((s) => s.includes('SELECT DISTINCT'))).toBe(false);
    // One per-anchor query for today, one for tomorrow.
    expect(statements).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  it('BACKFILL: scans every month when no shard filter is present', async () => {
    queryRaw.mockImplementationOnce(() => Promise.resolve([{ month: 3, day: 14 }]));

    await curator.run(makeContext({ backfill: true }));

    const distinct = queryRaw.mock.calls[0]![0] as Prisma.Sql;
    expect(distinct.text).toContain('SELECT DISTINCT');
    expect(distinct.text).not.toContain('IN (');
    // Only the circle id is bound — no month parameters.
    expect(distinct.values).toEqual(['11111111-1111-1111-1111-111111111111']);
  });

  // -------------------------------------------------------------------------
  it('SHARDED BACKFILL: pushes the month filter into SQL', async () => {
    queryRaw.mockImplementationOnce(() => Promise.resolve([{ month: 7, day: 4 }]));

    await curator.run(makeContext({ backfill: true, anchorMonths: [7] }));

    const distinct = queryRaw.mock.calls[0]![0] as Prisma.Sql;
    expect(distinct.text).toContain('EXTRACT(MONTH');
    expect(distinct.text).toContain('IN (');
    // Bound as a parameter, not interpolated — the month reaches SQL as data.
    expect(distinct.values).toContain(7);
  });

  // -------------------------------------------------------------------------
  it('SHARDED BACKFILL: an empty month list means "no restriction"', async () => {
    queryRaw.mockImplementationOnce(() => Promise.resolve([]));

    await curator.run(makeContext({ backfill: true, anchorMonths: [] }));

    const distinct = queryRaw.mock.calls[0]![0] as Prisma.Sql;
    expect(distinct.text).not.toContain('IN (');
  });

  // -------------------------------------------------------------------------
  it('BACKFILL: maps each (month, day) to its NEXT occurrence, deduplicated', async () => {
    // March 14 is behind "now" (2026-08-09) and must roll to 2027; August 9 is
    // today and must stay. A day listed twice must not produce two anchors.
    queryRaw.mockImplementationOnce(() =>
      Promise.resolve([
        { month: 3, day: 14 },
        { month: 8, day: 9 },
        { month: 3, day: 14 },
      ]),
    );

    await curator.run(makeContext({ backfill: true }));

    // One DISTINCT scan + one per-anchor query per unique anchor.
    expect(queryRaw).toHaveBeenCalledTimes(3);
    const perAnchor = queryRaw.mock.calls.slice(1).map((call) => call[0] as Prisma.Sql);
    // Anchors are sorted ascending, so 2026-08-09 precedes 2027-03-14.
    expect(perAnchor[0]!.values).toContain(8);
    expect(perAnchor[1]!.values).toContain(3);
  });

  // -------------------------------------------------------------------------
  it('BACKFILL: an empty library produces no anchors and no further queries', async () => {
    queryRaw.mockImplementationOnce(() => Promise.resolve([]));

    const result = await curator.run(makeContext({ backfill: true }));

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ created: 0, refreshed: 0, skipped: 0, tombstoned: 0 });
  });
});
