/**
 * `utils/civilDate` + `utils/groupByDay` — the regression guard for issue #442
 * (epic #440).
 *
 * ⚠️ These tests are only meaningful in a NON-UTC zone. `captured_at` is the
 * capture wall clock re-encoded as UTC, so under `TZ=UTC` the buggy
 * browser-local reading and the correct UTC reading produce identical output
 * and the defect is invisible. The suite therefore sets `process.env.TZ`
 * explicitly per case — CI does not pin one — and runs the same fixture under
 * two zones with opposite-signed offsets so a regression in either direction
 * fails.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  civilDayKey,
  civilInputToIso,
  formatCivilDate,
  formatCivilDateTime,
  instantDayKey,
  isoToCivilInput,
} from '../../utils/civilDate';
import { groupByDay } from '../../utils/groupByDay';
import type { MediaItem } from '../../types/media';

const WEST = 'America/Costa_Rica'; // UTC-6, no DST
const EAST = 'Asia/Kolkata'; // UTC+5:30
const originalTz = process.env.TZ;

/** Run `fn` with the process time zone set to `zone`. */
function inZone<T>(zone: string, fn: () => T): T {
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    process.env.TZ = originalTz;
  }
}

afterEach(() => {
  process.env.TZ = originalTz;
});

function item(partial: Partial<MediaItem>): MediaItem {
  return {
    id: Math.random().toString(36).slice(2),
    capturedAt: null,
    importedAt: null,
    ...partial,
  } as MediaItem;
}

describe('civilDayKey', () => {
  // The whole point: the stored components are read back unchanged.
  const cases: Array<[string, string]> = [
    ['2026-06-20T00:30:00.000Z', '2026-06-20'],
    ['2026-06-20T02:00:00.000Z', '2026-06-20'],
    ['2026-06-20T12:00:00.000Z', '2026-06-20'],
    ['2026-06-20T23:30:00.000Z', '2026-06-20'],
  ];

  for (const zone of [WEST, EAST, 'UTC']) {
    describe(`under TZ=${zone}`, () => {
      for (const [iso, expected] of cases) {
        it(`keys ${iso} as ${expected}`, () => {
          expect(inZone(zone, () => civilDayKey(iso))).toBe(expected);
        });
      }
    });
  }

  it('returns "undated" for an unparseable value rather than throwing', () => {
    expect(civilDayKey('not a date')).toBe('undated');
  });
});

describe('formatCivilDate / formatCivilDateTime', () => {
  it('renders the same calendar day in every zone', () => {
    const iso = '2026-06-20T02:00:00.000Z';
    const west = inZone(WEST, () => formatCivilDate(iso));
    const east = inZone(EAST, () => formatCivilDate(iso));
    expect(west).toBe(east);
    expect(west).toContain('20');
  });

  it('renders the photographer wall clock, not the viewer clock', () => {
    // 20:16 stored means 20:16 shown — in Costa Rica and in Kolkata alike.
    const iso = '2026-06-20T20:16:00.000Z';
    const west = inZone(WEST, () =>
      formatCivilDateTime(iso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    );
    const east = inZone(EAST, () =>
      formatCivilDateTime(iso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    );
    expect(west).toBe(east);
    expect(west).toContain('20:16');
  });

  it('returns an empty string for an unparseable value', () => {
    expect(formatCivilDate('nope')).toBe('');
    expect(formatCivilDateTime('nope')).toBe('');
  });
});

describe('instantDayKey', () => {
  it('keys an instant in the viewer zone — the mirror of civilDayKey', () => {
    // 02:00Z is still June 19 in Costa Rica and already June 20 in Kolkata.
    const iso = '2026-06-20T02:00:00.000Z';
    expect(inZone(WEST, () => instantDayKey(iso))).toBe('2026-06-19');
    expect(inZone(EAST, () => instantDayKey(iso))).toBe('2026-06-20');
  });

  it('honours an explicit zone over the ambient one', () => {
    expect(instantDayKey('2026-06-20T02:00:00.000Z', WEST)).toBe('2026-06-19');
  });
});

describe('isoToCivilInput / civilInputToIso', () => {
  it('round-trips a civil timestamp unchanged in a non-UTC zone', () => {
    // The bug this guards: `new Date('2026-06-20T20:16')` parses as browser
    // local, so opening the edit form and saving without a change used to move
    // the photo by the viewer's offset.
    const iso = '2026-06-20T20:16:00.000Z';
    for (const zone of [WEST, EAST, 'UTC']) {
      const roundTripped = inZone(zone, () => civilInputToIso(isoToCivilInput(iso)));
      expect(roundTripped).toBe(iso);
    }
  });

  it('reads back the stored wall clock into the input', () => {
    expect(inZone(WEST, () => isoToCivilInput('2026-06-20T20:16:00.000Z'))).toBe(
      '2026-06-20T20:16',
    );
  });

  it('accepts a value that includes seconds', () => {
    expect(civilInputToIso('2026-06-20T20:16:07')).toBe('2026-06-20T20:16:07.000Z');
  });

  it('maps empty and invalid input to null', () => {
    expect(civilInputToIso('')).toBeNull();
    expect(civilInputToIso('garbage')).toBeNull();
    expect(isoToCivilInput(null)).toBe('');
  });
});

describe('groupByDay', () => {
  const fixture: MediaItem[] = [
    item({ id: 'a', capturedAt: '2026-06-20T00:30:00.000Z' }),
    item({ id: 'b', capturedAt: '2026-06-20T02:00:00.000Z' }),
    item({ id: 'c', capturedAt: '2026-06-20T12:00:00.000Z' }),
    item({ id: 'd', capturedAt: '2026-06-20T23:30:00.000Z' }),
    item({ id: 'e', capturedAt: '2026-06-19T23:30:00.000Z' }),
  ];

  it('groups a capture-date fixture identically in every zone', () => {
    const west = inZone(WEST, () => groupByDay(fixture));
    const east = inZone(EAST, () => groupByDay(fixture));
    const utc = inZone('UTC', () => groupByDay(fixture));

    const shape = (
      groups: ReturnType<typeof groupByDay>,
    ): Array<[string, string, string[]]> =>
      groups.map((g) => [g.key, g.label, g.items.map((i) => i.id)]);

    expect(shape(west)).toEqual(shape(east));
    expect(shape(west)).toEqual(shape(utc));
  });

  it('files every capture on its own capture day, newest first', () => {
    const groups = inZone(WEST, () => groupByDay(fixture));
    expect(groups.map((g) => g.key)).toEqual(['2026-06-20', '2026-06-19']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(groups[1].items.map((i) => i.id)).toEqual(['e']);
  });

  it('labels a bucket from its own key, so the label matches the day', () => {
    const groups = inZone(EAST, () => groupByDay([fixture[0]]));
    expect(groups[0].label).toContain('20');
    expect(groups[0].label).not.toContain('19');
  });

  it('buckets the importedAt fallback in the VIEWER zone, not UTC', () => {
    // An upload is a real instant with no "where it was taken", so it belongs
    // on the day it happened on the viewer's clock — deliberately different
    // from the capturedAt rule directly above.
    const undated = [item({ id: 'u', importedAt: '2026-06-20T02:00:00.000Z' })];
    expect(inZone(WEST, () => groupByDay(undated))[0].key).toBe('2026-06-19');
    expect(inZone(EAST, () => groupByDay(undated))[0].key).toBe('2026-06-20');
  });

  it('prefers capturedAt over importedAt when both are present', () => {
    const both = [
      item({
        id: 'x',
        capturedAt: '2026-06-20T02:00:00.000Z',
        importedAt: '2026-07-01T00:00:00.000Z',
      }),
    ];
    expect(inZone(WEST, () => groupByDay(both))[0].key).toBe('2026-06-20');
  });

  it('sorts the undated bucket last', () => {
    const groups = groupByDay([item({ id: 'n' }), ...fixture]);
    expect(groups[groups.length - 1].key).toBe('undated');
    expect(groups[groups.length - 1].label).toBe('Undated');
  });
});
