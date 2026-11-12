/**
 * The gallery's day groups are keyed on the CIVIL `capturedAt` (docs/specs/date-model.md): the capture wall clock
 * stored as UTC, read back in UTC in every viewer zone, while the `importedAt` fallback is a real instant read in
 * the viewer's zone. `civilDate.test.ts` covers the half-day zones; these cases run the extremes, UTC-10 and UTC+14,
 * where a browser-local reading moves a photo across a day boundary in BOTH directions, and check the labels.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { groupByDay } from '../../src/media/headless/utils/groupByDay.js';
import type { MediaItem } from '../../src/media/headless/types.js';

const originalTz = process.env.TZ;
const WEST = 'Pacific/Honolulu'; // UTC-10
const EAST = 'Pacific/Kiritimati'; // UTC+14

afterEach(() => {
  process.env.TZ = originalTz;
});

const item = (id: string, partial: Partial<MediaItem>): MediaItem => ({ id, capturedAt: null, importedAt: null, ...partial }) as MediaItem;

function groupsIn(zone: string, items: MediaItem[]) {
  process.env.TZ = zone;
  return groupByDay(items).map((g) => ({ key: g.key, label: g.label, ids: g.items.map((i) => i.id) }));
}

describe('groupByDay under UTC-10 and UTC+14', () => {
  const items = [
    item('late', { capturedAt: '2026-06-20T23:59:00.000Z' }),
    item('early', { capturedAt: '2026-06-20T00:01:00.000Z' }),
    item('next', { capturedAt: '2026-06-21T00:01:00.000Z' }),
  ];

  it('files each photo under the day its stored wall clock names, in either zone', () => {
    for (const zone of [WEST, EAST]) {
      expect(groupsIn(zone, items).map((g) => [g.key, g.ids])).toEqual([
        ['2026-06-21', ['next']],
        ['2026-06-20', ['late', 'early']],
      ]);
    }
  });

  it('labels a group from its key, identically in both zones', () => {
    const west = groupsIn(WEST, items).map((g) => g.label);
    const east = groupsIn(EAST, items).map((g) => g.label);
    expect(west).toEqual(east);
    expect(west[0]).toMatch(/21/);
    expect(west[1]).toMatch(/20/);
  });

  it('reads the importedAt fallback in the viewer zone, since it is a real instant', () => {
    const imported = [item('imp', { importedAt: '2026-06-20T12:00:00.000Z' })];
    expect(groupsIn(WEST, imported)[0].key).toBe('2026-06-20');
    expect(groupsIn(EAST, imported)[0].key).toBe('2026-06-21'); // 02:00 the next day at UTC+14
  });

  it('puts an undated item last', () => {
    const keys = groupsIn(WEST, [item('none', {}), ...items]).map((g) => g.key);
    expect(keys[keys.length - 1]).toBe('undated');
  });
});
