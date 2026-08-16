/**
 * `utils/timezone` — unit tests (issue #444).
 *
 * The interesting cases are all "the runtime told us something useless":
 * a placeholder zone, a missing `Intl`, an absent `supportedValuesOf`. None of
 * them may throw, and none may be mistaken for a real answer.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  detectTimeZone,
  formatNowInZone,
  isValidTimeZone,
  listTimeZones,
} from '../../utils/timezone';

const realIntl = globalThis.Intl;

/** Swap in an `Intl` stub, restored by the afterEach below. */
function stubIntl(value: unknown) {
  Object.defineProperty(globalThis, 'Intl', {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'Intl', {
    value: realIntl,
    configurable: true,
    writable: true,
  });
  vi.restoreAllMocks();
});

describe('isValidTimeZone', () => {
  it('accepts a real IANA identifier', () => {
    expect(isValidTimeZone('America/Costa_Rica')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('rejects placeholders and unknown identifiers', () => {
    expect(isValidTimeZone('Etc/Unknown')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });
});

describe('detectTimeZone', () => {
  it('returns the resolved zone when the runtime reports a real one', () => {
    stubIntl({
      DateTimeFormat: function (this: unknown, _l?: unknown, opts?: { timeZone?: string }) {
        // Constructed twice: once for detection, once by isValidTimeZone.
        void opts;
        return { resolvedOptions: () => ({ timeZone: 'Europe/Madrid' }) };
      },
    });

    expect(detectTimeZone()).toBe('Europe/Madrid');
  });

  it('returns null for the Etc/Unknown placeholder', () => {
    stubIntl({
      DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Etc/Unknown' }) }),
    });

    expect(detectTimeZone()).toBeNull();
  });

  it('returns null when the reported zone is not one the runtime accepts', () => {
    stubIntl({
      DateTimeFormat: (_l?: unknown, opts?: { timeZone?: string }) => {
        if (opts?.timeZone) throw new RangeError('Invalid time zone');
        return { resolvedOptions: () => ({ timeZone: 'Mars/Olympus_Mons' }) };
      },
    });

    expect(detectTimeZone()).toBeNull();
  });

  it('returns null — and does not throw — when Intl is unavailable', () => {
    stubIntl(undefined);

    expect(() => detectTimeZone()).not.toThrow();
    expect(detectTimeZone()).toBeNull();
  });

  it('returns null when the runtime reports a non-string', () => {
    stubIntl({
      DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: undefined }) }),
    });

    expect(detectTimeZone()).toBeNull();
  });
});

describe('listTimeZones', () => {
  it('returns the runtime list, sorted, when supportedValuesOf exists', () => {
    stubIntl({
      supportedValuesOf: () => ['Europe/Paris', 'Africa/Cairo', 'UTC'],
    });

    expect(listTimeZones()).toEqual(['Africa/Cairo', 'Europe/Paris', 'UTC']);
  });

  it('falls back to a non-empty static list when supportedValuesOf is missing', () => {
    stubIntl({});

    const zones = listTimeZones();
    expect(zones.length).toBeGreaterThan(0);
    expect(zones).toContain('UTC');
  });

  it('falls back when supportedValuesOf throws', () => {
    stubIntl({
      supportedValuesOf: () => {
        throw new RangeError('unsupported key');
      },
    });

    expect(listTimeZones()).toContain('UTC');
  });

  it('does not hand callers a reference to its own fallback array', () => {
    stubIntl({});

    const first = listTimeZones();
    first.length = 0;
    expect(listTimeZones().length).toBeGreaterThan(0);
  });
});

describe('formatNowInZone', () => {
  it('formats an instant in the requested zone', () => {
    const at = new Date('2026-06-15T12:00:00Z');
    const utc = formatNowInZone('UTC', at);
    const tokyo = formatNowInZone('Asia/Tokyo', at);

    expect(utc).toBeTruthy();
    expect(tokyo).toBeTruthy();
    // Same instant, two zones — the rendered strings must differ.
    expect(utc).not.toBe(tokyo);
  });

  it('returns null rather than throwing for an unusable zone', () => {
    expect(formatNowInZone('Not/AZone')).toBeNull();
  });
});
