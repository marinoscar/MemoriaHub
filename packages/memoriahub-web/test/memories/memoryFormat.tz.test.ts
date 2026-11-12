/**
 * The memory period label is a CIVIL value (docs/specs/date-model.md): `periodStart` and `periodEnd` cover the
 * capture range, whose wall clock the server stores re-encoded as UTC, so the label must read the same in every
 * viewer zone. Under `TZ=UTC` the buggy (browser-local) and the correct (UTC) reading agree and the defect is
 * invisible, so each case sets `process.env.TZ` to two opposite-signed zones (west and east of Greenwich) and
 * to one whose offset is larger than a half day each way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatMemoryPeriod, memoryAriaLabel } from '../../src/memories/ui/components/memoryFormat.js';
import type { MemoryCard } from '../../src/memories/headless/types.js';

const originalTz = process.env.TZ;
const ZONES = ['Pacific/Honolulu', 'America/Costa_Rica', 'UTC', 'Asia/Kolkata', 'Pacific/Kiritimati'] as const; // UTC-10 .. UTC+14

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

describe('formatMemoryPeriod under opposite-signed time zones', () => {
  for (const zone of ZONES) {
    describe(`TZ=${zone}`, () => {
      it('collapses a same-month range onto the stored month, even at the month edges', () => {
        // First and last instants of March, as the civil wall clock stored in UTC.
        const label = inZone(zone, () => formatMemoryPeriod('2023-03-01T00:00:00.000Z', '2023-03-31T23:59:59.000Z'));
        expect(label).toMatch(/March/);
        expect(label).toMatch(/2023/);
      });

      it('names both months for a same-year range that crosses a boundary', () => {
        const label = inZone(zone, () => formatMemoryPeriod('2023-03-31T23:30:00.000Z', '2023-04-01T00:30:00.000Z'));
        expect(label).toMatch(/Mar/);
        expect(label).toMatch(/Apr/);
        expect(label).toMatch(/2023/);
      });

      it('names both years for a range across New Year, from the stored years', () => {
        const label = inZone(zone, () => formatMemoryPeriod('2022-12-31T23:30:00.000Z', '2023-01-01T00:30:00.000Z'));
        expect(label).toBe('2022 – 2023');
      });
    });
  }

  it('reads the same label in every zone', () => {
    const labels = new Set(ZONES.map((zone) => inZone(zone, () => formatMemoryPeriod('2023-03-31T23:30:00.000Z', '2023-04-01T00:30:00.000Z'))));
    expect(labels.size).toBe(1);
  });

  it('the screen-reader label carries the same period in every zone', () => {
    const card = {
      id: 'mem-1',
      type: 'trip',
      title: 'Trip to the coast',
      itemCount: 3,
      periodStart: '2023-03-01T00:00:00.000Z',
      periodEnd: '2023-03-31T23:59:59.000Z',
      myState: { seen: false, favorited: false },
    } as unknown as MemoryCard;
    const labels = new Set(ZONES.map((zone) => inZone(zone, () => memoryAriaLabel(card))));
    expect(labels.size).toBe(1);
  });
});
