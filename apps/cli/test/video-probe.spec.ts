/**
 * test/video-probe.spec.ts
 *
 * Unit tests for the PURE, synchronous parsing helpers exported by
 * src/video-probe.ts: parseContainerDate, iso6709HasCoords, and
 * parseVideoPlacement. These never touch the filesystem or spawn ffprobe —
 * that async/subprocess concern (readVideoPlacement, detectFfprobe) is
 * explicitly out of scope here since no ffprobe binary is guaranteed in CI.
 *
 * Following the style of test/metadata.spec.ts: local-getter assertions
 * (.getFullYear()/.getMonth()/.getDate()/...) are used instead of
 * .toISOString(), since parseContainerDate builds a LOCAL-time Date from the
 * wall-clock digits verbatim (not reinterpreted as UTC) — asserting via ISO
 * string would make the test timezone-sensitive.
 */

import {
  parseContainerDate,
  iso6709HasCoords,
  parseVideoPlacement,
} from '../src/video-probe.js';

describe('parseContainerDate', () => {
  it('parses an Apple offset string using the wall-clock digits verbatim (local getters)', () => {
    const result = parseContainerDate('2023-06-20T20:16:07-0500');

    expect(result).toBeInstanceOf(Date);
    expect(result!.getFullYear()).toBe(2023);
    expect(result!.getMonth()).toBe(5); // 0-indexed: June
    expect(result!.getDate()).toBe(20);
    expect(result!.getHours()).toBe(20);
    expect(result!.getMinutes()).toBe(16);
    expect(result!.getSeconds()).toBe(7);
  });

  it('parses a UTC creation_time value using only the captured date/time digits (trailing .000000Z ignored)', () => {
    const result = parseContainerDate('2024-11-02T08:30:00.000000Z');

    expect(result).toBeInstanceOf(Date);
    expect(result!.getFullYear()).toBe(2024);
    expect(result!.getMonth()).toBe(10); // 0-indexed: November
    expect(result!.getDate()).toBe(2);
  });

  it('returns null for null, empty, garbage, and the sentinel all-zero timestamp', () => {
    expect(parseContainerDate(null)).toBeNull();
    expect(parseContainerDate('')).toBeNull();
    expect(parseContainerDate('garbage')).toBeNull();
    expect(parseContainerDate('0000-00-00T00:00:00')).toBeNull();
  });
});

describe('iso6709HasCoords', () => {
  it('returns true for a well-formed ISO 6709 lat+lng+altitude string', () => {
    expect(iso6709HasCoords('+37.7749-122.4194+000.000/')).toBe(true);
  });

  it('returns true for 0,0 coordinates (counts as present)', () => {
    expect(iso6709HasCoords('+00.0000+000.0000/')).toBe(true);
  });

  it('returns false for null', () => {
    expect(iso6709HasCoords(null)).toBe(false);
  });

  it('returns false for a non-coordinate string', () => {
    expect(iso6709HasCoords('abc')).toBe(false);
  });
});

describe('parseVideoPlacement', () => {
  it('parses an Apple-style tag map (quicktime creationdate + ISO6709 location)', () => {
    const result = parseVideoPlacement({
      'com.apple.quicktime.creationdate': '2023-06-20T20:16:07-0500',
      'com.apple.quicktime.location.ISO6709': '+37.7749-122.4194+000.000/',
    });

    expect(result.capturedAt).toBeInstanceOf(Date);
    expect(result.capturedAt!.getFullYear()).toBe(2023);
    expect(result.capturedAt!.getMonth()).toBe(5);
    expect(result.capturedAt!.getDate()).toBe(20);
    expect(result.hasGps).toBe(true);
  });

  it('parses an Android-style tag map (creation_time only, no location) with hasGps=false', () => {
    const result = parseVideoPlacement({
      creation_time: '2024-11-02T08:30:00.000000Z',
    });

    expect(result.capturedAt).toBeInstanceOf(Date);
    expect(result.capturedAt!.getFullYear()).toBe(2024);
    expect(result.capturedAt!.getMonth()).toBe(10);
    expect(result.capturedAt!.getDate()).toBe(2);
    expect(result.hasGps).toBe(false);
  });

  it('returns {capturedAt: null, hasGps: false} for an empty tag map', () => {
    expect(parseVideoPlacement({})).toEqual({ capturedAt: null, hasGps: false });
  });

  it('looks up tag keys case-insensitively', () => {
    const result = parseVideoPlacement({
      Creation_Time: '2024-11-02T08:30:00.000000Z',
    });

    expect(result.capturedAt).toBeInstanceOf(Date);
    expect(result.capturedAt!.getFullYear()).toBe(2024);
    expect(result.capturedAt!.getMonth()).toBe(10);
    expect(result.capturedAt!.getDate()).toBe(2);
  });

  it('prefers com.apple.quicktime.creationdate over creation_time when both are present', () => {
    const result = parseVideoPlacement({
      'com.apple.quicktime.creationdate': '2023-06-20T20:16:07-0500',
      creation_time: '2020-01-01T00:00:00Z',
    });

    expect(result.capturedAt).toBeInstanceOf(Date);
    expect(result.capturedAt!.getFullYear()).toBe(2023);
    expect(result.capturedAt!.getMonth()).toBe(5);
    expect(result.capturedAt!.getDate()).toBe(20);
  });
});
