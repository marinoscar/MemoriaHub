/**
 * Unit tests for formatBytes utilities.
 *
 * Covers: formatBytes (string-based BigInt-safe), formatCompactNumber,
 * percent (BigInt-safe divide-by-zero guard), and relativeTime.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatBytes,
  formatCompactNumber,
  percent,
  relativeTime,
} from '../../utils/formatBytes';

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------

describe('formatBytes', () => {
  it('formats 0 as "0 B"', () => {
    expect(formatBytes('0')).toBe('0 B');
  });

  it('formats bytes below 1 KB as "N B"', () => {
    expect(formatBytes('512')).toBe('512 B');
  });

  it('formats exactly 1 KB', () => {
    expect(formatBytes('1024')).toBe('1.00 KB');
  });

  it('formats 1.5 MB', () => {
    expect(formatBytes('1572864')).toBe('1.50 MB');
  });

  it('formats 1 GB', () => {
    expect(formatBytes('1073741824')).toBe('1.00 GB');
  });

  it('formats 1 TB', () => {
    expect(formatBytes('1099511627776')).toBe('1.00 TB');
  });

  it('formats ~1.12 TB (1 234 567 890 123 bytes)', () => {
    const result = formatBytes('1234567890123');
    // 1234567890123 / 1024^4 ≈ 1.12 TB
    expect(result).toMatch(/^1\.1[0-9] TB$/);
  });

  it('accepts a bigint directly', () => {
    expect(formatBytes(1024n)).toBe('1.00 KB');
  });

  it('formats 472 000 000 bytes (~450 MB)', () => {
    const result = formatBytes('472000000');
    expect(result).toMatch(/^4[45][0-9]\.\d{2} MB$/);
  });

  it('formats 788 000 000 bytes (~751 MB)', () => {
    const result = formatBytes('788000000');
    expect(result).toMatch(/^7[45][0-9]\.\d{2} MB$/);
  });

  it('returns a string containing the correct unit label for PB range', () => {
    // 1 PB = 1024^5 bytes
    const onePB = (1024n ** 5n).toString();
    const result = formatBytes(onePB);
    expect(result).toContain('PB');
  });
});

// ---------------------------------------------------------------------------
// formatCompactNumber
// ---------------------------------------------------------------------------

describe('formatCompactNumber', () => {
  it('formats numbers below 10 000 in standard notation', () => {
    // 4217 → "4,217"
    const result = formatCompactNumber(4217);
    expect(result).toBe('4,217');
  });

  it('formats numbers at or above 10 000 in compact notation', () => {
    // 12 480 → "12.5K" or "12.4K" depending on rounding
    const result = formatCompactNumber(12480);
    expect(result).toMatch(/^12\.[0-9]K$/);
  });

  it('formats 0 as "0"', () => {
    expect(formatCompactNumber(0)).toBe('0');
  });

  it('formats 1000 in standard notation', () => {
    expect(formatCompactNumber(1000)).toBe('1,000');
  });

  it('formats 1 000 000 in compact notation (~1M)', () => {
    const result = formatCompactNumber(1_000_000);
    expect(result).toMatch(/M$/);
  });

  it('formats exactly 9999 in standard notation', () => {
    // below 10 000 threshold
    const result = formatCompactNumber(9999);
    expect(result).toBe('9,999');
  });

  it('formats exactly 10000 in compact notation', () => {
    const result = formatCompactNumber(10000);
    expect(result).toMatch(/^10K$/);
  });
});

// ---------------------------------------------------------------------------
// percent
// ---------------------------------------------------------------------------

describe('percent', () => {
  it('calculates 65% for 650 of 1000', () => {
    expect(percent('650', '1000')).toBe(65);
  });

  it('calculates 100% when part equals whole', () => {
    expect(percent('500', '500')).toBe(100);
  });

  it('returns 0 when whole is 0 (divide-by-zero guard)', () => {
    expect(percent('5', '0')).toBe(0);
  });

  it('returns 0 when part is 0', () => {
    expect(percent('0', '1000')).toBe(0);
  });

  it('accepts number arguments as well as strings', () => {
    expect(percent(300, 1000)).toBe(30);
  });

  it('handles large BigInt-range values correctly', () => {
    // 1 GB out of 4 GB = 25%
    const oneGB = '1073741824';
    const fourGB = '4294967296';
    expect(percent(oneGB, fourGB)).toBe(25);
  });

  it('returns a fractional value for non-integer percentages', () => {
    // 1 of 3 → 33.33...
    const result = percent('1', '3');
    expect(result).toBeGreaterThan(33);
    expect(result).toBeLessThan(34);
  });
});

// ---------------------------------------------------------------------------
// relativeTime
// ---------------------------------------------------------------------------

describe('relativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for timestamps within the last minute', () => {
    const now = new Date();
    const thirtySecondsAgo = new Date(now.getTime() - 30 * 1000).toISOString();
    expect(relativeTime(thirtySecondsAgo)).toBe('just now');
  });

  it('returns "1m ago" for a timestamp ~1 minute ago', () => {
    const now = new Date();
    const oneMinuteAgo = new Date(now.getTime() - 65 * 1000).toISOString();
    expect(relativeTime(oneMinuteAgo)).toBe('1m ago');
  });

  it('returns "2h ago" for a timestamp ~2 hours ago', () => {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 3600 * 1000 - 1000).toISOString();
    expect(relativeTime(twoHoursAgo)).toBe('2h ago');
  });

  it('returns "1d ago" for a timestamp ~1 day ago', () => {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 25 * 3600 * 1000).toISOString();
    expect(relativeTime(oneDayAgo)).toBe('1d ago');
  });

  it('returns "59m ago" for a timestamp 59 minutes ago', () => {
    const now = new Date();
    const fiftyNineMinutesAgo = new Date(now.getTime() - 59 * 60 * 1000 - 1000).toISOString();
    expect(relativeTime(fiftyNineMinutesAgo)).toBe('59m ago');
  });
});
