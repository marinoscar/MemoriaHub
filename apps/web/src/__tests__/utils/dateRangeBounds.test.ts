/**
 * `utils/dateRangeBounds` — the regression guard for issue #446 (epic #440).
 *
 * The two builders look almost identical and are deliberately NOT the same
 * rule: a capture-date bound is anchored in UTC (the column holds a civil
 * timestamp), an upload-date bound is anchored in the user's zone (the column
 * holds a real instant). Under `TZ=UTC` both produce the same output and the
 * defect is invisible, so every meaningful case here pins a non-UTC zone.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { civilDayRange, instantDayRange } from '../../utils/dateRangeBounds';

const WEST = 'America/Costa_Rica'; // UTC-6, no DST
const EAST = 'Asia/Kolkata'; // UTC+5:30
const originalTz = process.env.TZ;

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

describe('civilDayRange', () => {
  it('covers the whole end day — the dropped-end-day defect', () => {
    const { from, to } = civilDayRange('2026-06-01', '2026-06-30');
    expect(from).toBe('2026-06-01T00:00:00.000Z');
    expect(to).toBe('2026-06-30T23:59:59.999Z');
    // A photo captured at the last instant of June 30 is inside the range.
    expect(new Date('2026-06-30T23:59:59.000Z').getTime()).toBeLessThanOrEqual(
      new Date(to!).getTime(),
    );
  });

  it('is anchored in UTC regardless of the viewer zone', () => {
    // Guards against someone "unifying" this with instantDayRange.
    const west = inZone(WEST, () => civilDayRange('2026-06-16', '2026-06-16'));
    const east = inZone(EAST, () => civilDayRange('2026-06-16', '2026-06-16'));
    expect(west).toEqual(east);
    expect(west.from).toBe('2026-06-16T00:00:00.000Z');
    expect(west.to).toBe('2026-06-16T23:59:59.999Z');
  });

  it('passes an explicit instant bound through unchanged', () => {
    const { to } = civilDayRange(undefined, '2026-06-30T12:00:00.000Z');
    expect(to).toBe('2026-06-30T12:00:00.000Z');
  });

  it('omits an absent bound', () => {
    expect(civilDayRange('2026-06-01', undefined)).toEqual({
      from: '2026-06-01T00:00:00.000Z',
    });
    expect(civilDayRange(undefined, undefined)).toEqual({});
  });
});

describe('instantDayRange', () => {
  it('resolves a single calendar day in the viewer zone (UTC-6)', () => {
    // The reported symptom: an item imported at 21:30 local on Aug 16 has
    // created_at = Aug 17 03:30Z and must be INSIDE an Aug 16 → Aug 16 filter.
    const { from, to } = inZone(WEST, () => instantDayRange('2026-08-16', '2026-08-16'));
    expect(from).toBe('2026-08-16T06:00:00.000Z');
    expect(to).toBe('2026-08-17T05:59:59.999Z');

    const item = new Date('2026-08-17T03:30:00.000Z').getTime();
    expect(item).toBeGreaterThanOrEqual(new Date(from!).getTime());
    expect(item).toBeLessThanOrEqual(new Date(to!).getTime());
  });

  it('excludes an item that is the next local day (UTC-6)', () => {
    const { to } = inZone(WEST, () => instantDayRange('2026-08-16', '2026-08-16'));
    // 00:30 local on Aug 17 == 06:30Z — outside the window.
    const nextDay = new Date('2026-08-17T06:30:00.000Z').getTime();
    expect(nextDay).toBeGreaterThan(new Date(to!).getTime());
  });

  it('resolves in the opposite direction for a positive offset (UTC+5:30)', () => {
    const { from, to } = inZone(EAST, () => instantDayRange('2026-08-16', '2026-08-16'));
    expect(from).toBe('2026-08-15T18:30:00.000Z');
    expect(to).toBe('2026-08-16T18:29:59.999Z');
  });

  it('prefers an explicit zone over the ambient one', () => {
    // A session on a borrowed laptop still filters in the user's stored zone.
    const explicit = inZone(EAST, () => instantDayRange('2026-08-16', '2026-08-16', WEST));
    expect(explicit.from).toBe('2026-08-16T06:00:00.000Z');
    expect(explicit.to).toBe('2026-08-17T05:59:59.999Z');
  });

  it('handles a DST boundary without landing on the wrong hour', () => {
    // US DST began 2026-03-08. A New York day in March is UTC-4, in January
    // UTC-5 — the offset must be read AT the bound, not once globally.
    const march = instantDayRange('2026-03-20', '2026-03-20', 'America/New_York');
    expect(march.from).toBe('2026-03-20T04:00:00.000Z');
    const january = instantDayRange('2026-01-20', '2026-01-20', 'America/New_York');
    expect(january.from).toBe('2026-01-20T05:00:00.000Z');
  });

  it('passes an explicit instant bound through unchanged', () => {
    const { to } = inZone(WEST, () =>
      instantDayRange(undefined, '2026-06-30T12:00:00.000Z'),
    );
    expect(to).toBe('2026-06-30T12:00:00.000Z');
  });

  it('degrades to UTC rather than throwing on an unusable zone', () => {
    const { from } = instantDayRange('2026-08-16', undefined, 'Mars/Olympus');
    expect(from).toBe('2026-08-16T00:00:00.000Z');
  });

  it('omits an absent bound', () => {
    expect(instantDayRange(undefined, undefined)).toEqual({});
  });
});

describe('the two builders disagree — and must', () => {
  it('produces different bounds for the same calendar day in a non-UTC zone', () => {
    const civil = inZone(WEST, () => civilDayRange('2026-08-16', '2026-08-16'));
    const instant = inZone(WEST, () => instantDayRange('2026-08-16', '2026-08-16'));
    expect(civil.from).not.toBe(instant.from);
    expect(civil.to).not.toBe(instant.to);
  });
});
