/**
 * test/date-inference/filename-date.spec.ts
 *
 * Pure unit tests for parseDateFromFilename() — no I/O, no mocking needed.
 * All "current year" bound checks inject a deterministic `opts.now` rather
 * than relying on the real wall-clock date, per filename-date.ts's own
 * `now` injection point.
 */

import { parseDateFromFilename } from '../../src/date-inference/filename-date.js';

// A fixed "current time" comfortably in the future of every example filename
// used below, so match tests never depend on when this suite actually runs.
const NOW = { now: new Date(2030, 0, 1) };

describe('parseDateFromFilename', () => {
  // ---------------------------------------------------------------------------
  // Real-world example filenames (verbatim from the task spec)
  // ---------------------------------------------------------------------------

  describe('real-world examples', () => {
    it('parses iOS-style "20151107_135151000_iOS.jpg" as a timestamp match', () => {
      const m = parseDateFromFilename('20151107_135151000_iOS.jpg', NOW);
      expect(m).not.toBeNull();
      expect(m).toMatchObject({
        year: 2015,
        month: 11,
        day: 7,
        hour: 13,
        minute: 51,
        second: 51,
        hadTime: true,
        pattern: 'timestamp',
      });
    });

    it('parses WhatsApp-style "IMG-20151228-WA0007.jpg" as a whatsapp match with noon default time', () => {
      const m = parseDateFromFilename('IMG-20151228-WA0007.jpg', NOW);
      expect(m).not.toBeNull();
      expect(m).toMatchObject({
        year: 2015,
        month: 12,
        day: 28,
        pattern: 'whatsapp',
        hadTime: false,
        hour: 12,
        minute: 0,
        second: 0,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Timestamp pattern — Pixel / Android screenshot conventions
  // ---------------------------------------------------------------------------

  describe('timestamp pattern', () => {
    it('matches Pixel-style "PXL_20260704_120000.mp4"', () => {
      const m = parseDateFromFilename('PXL_20260704_120000.mp4', NOW);
      expect(m).not.toBeNull();
      expect(m?.pattern).toBe('timestamp');
      expect(m).toMatchObject({ year: 2026, month: 7, day: 4, hour: 12, minute: 0, second: 0 });
    });

    it('matches Android screenshot "Screenshot_20260704-120000.png"', () => {
      const m = parseDateFromFilename('Screenshot_20260704-120000.png', NOW);
      expect(m).not.toBeNull();
      expect(m?.pattern).toBe('timestamp');
      expect(m).toMatchObject({ year: 2026, month: 7, day: 4, hour: 12, minute: 0, second: 0 });
    });
  });

  // ---------------------------------------------------------------------------
  // Delimited pattern — date-only with a separator
  // ---------------------------------------------------------------------------

  describe('delimited pattern', () => {
    it.each([
      ['2015-01-15_x.jpg'],
      ['2015_01_15_x.jpg'],
      ['2015.01.15_x.jpg'],
    ])('matches %s as delimited', (basename) => {
      const m = parseDateFromFilename(basename, NOW);
      expect(m).not.toBeNull();
      expect(m?.pattern).toBe('delimited');
      expect(m).toMatchObject({ year: 2015, month: 1, day: 15, hadTime: false });
    });
  });

  // ---------------------------------------------------------------------------
  // Bare pattern — 8 contiguous digits, lowest confidence
  // ---------------------------------------------------------------------------

  describe('bare pattern', () => {
    it('matches "20150115_x.jpg" as bare (no separator between date components)', () => {
      const m = parseDateFromFilename('20150115_x.jpg', NOW);
      expect(m).not.toBeNull();
      expect(m?.pattern).toBe('bare');
      expect(m).toMatchObject({ year: 2015, month: 1, day: 15, hadTime: false });
    });
  });

  // ---------------------------------------------------------------------------
  // Calendar validation
  // ---------------------------------------------------------------------------

  describe('calendar validation', () => {
    it('rejects an invalid day-of-month ("2015-02-30")', () => {
      expect(parseDateFromFilename('2015-02-30_x.jpg', NOW)).toBeNull();
    });

    it('accepts Feb 29 on a leap year ("2016-02-29")', () => {
      const m = parseDateFromFilename('2016-02-29_x.jpg', NOW);
      expect(m).not.toBeNull();
      expect(m).toMatchObject({ year: 2016, month: 2, day: 29 });
    });

    it('rejects April 31st, which does not exist ("2015-04-31")', () => {
      expect(parseDateFromFilename('2015-04-31_x.jpg', NOW)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Year bounds
  // ---------------------------------------------------------------------------

  describe('year bounds', () => {
    it('rejects a year below the minimum (2002 < 2003)', () => {
      expect(parseDateFromFilename('2002-01-15_x.jpg', NOW)).toBeNull();
    });

    it('accepts the minimum year (2003)', () => {
      const m = parseDateFromFilename('2003-01-15_x.jpg', NOW);
      expect(m).not.toBeNull();
      expect(m?.year).toBe(2003);
    });

    it('rejects a year beyond opts.now\'s year', () => {
      const now = { now: new Date(2020, 0, 1) };
      expect(parseDateFromFilename('2021-01-15_x.jpg', now)).toBeNull();
    });

    it('accepts a year equal to opts.now\'s year (inclusive upper bound)', () => {
      const now = { now: new Date(2020, 0, 1) };
      const m = parseDateFromFilename('2020-01-15_x.jpg', now);
      expect(m).not.toBeNull();
      expect(m?.year).toBe(2020);
    });
  });

  // ---------------------------------------------------------------------------
  // Negative / no-match cases
  // ---------------------------------------------------------------------------

  describe('no match', () => {
    it.each([
      ['IMG_1234.jpg'],
      ['photo_1920x1080.jpg'],
      ['1699999999999.jpg'], // 13-digit unix-ms-style filename
      ['1234567890.jpg'], // 10-digit numeric ID
      ['DSC00042.JPG'],
    ])('returns null for %s', (basename) => {
      expect(parseDateFromFilename(basename, NOW)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Pattern precedence — most specific pattern wins when multiple could match
  // ---------------------------------------------------------------------------

  describe('pattern precedence', () => {
    it('resolves "IMG-20151228-WA0007.jpg" to whatsapp, not bare (both structurally contain an 8-digit date run)', () => {
      const m = parseDateFromFilename('IMG-20151228-WA0007.jpg', NOW);
      expect(m?.pattern).toBe('whatsapp');
      expect(m?.pattern).not.toBe('bare');
    });

    it('resolves a timestamp-shaped filename to timestamp, not delimited or bare', () => {
      const m = parseDateFromFilename('20151107_135151000_iOS.jpg', NOW);
      expect(m?.pattern).toBe('timestamp');
    });
  });

  // ---------------------------------------------------------------------------
  // matchedText / iso sanity
  // ---------------------------------------------------------------------------

  describe('matchedText and iso', () => {
    it('reports the exact matched substring and a zero-padded ISO-shaped string', () => {
      const m = parseDateFromFilename('20151107_135151000_iOS.jpg', NOW);
      expect(m?.matchedText).toBe('20151107_135151000');
      expect(m?.iso).toBe('2015-11-07T13:51:51.000Z');
    });
  });
});
