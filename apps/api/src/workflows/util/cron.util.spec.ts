/**
 * Unit tests for the 5-field cron validator used to gate `trigger='scheduled'`
 * workflows (issue #139). Pure function, no I/O.
 */
import { isValidCron } from './cron.util';

describe('isValidCron', () => {
  describe('valid expressions', () => {
    it('accepts every-field wildcard "* * * * *"', () => {
      expect(isValidCron('* * * * *')).toBe(true);
    });

    it('accepts midnight daily "0 0 * * *"', () => {
      expect(isValidCron('0 0 * * *')).toBe(true);
    });

    it('accepts a step expression "*/5 * * * *"', () => {
      expect(isValidCron('*/5 * * * *')).toBe(true);
    });

    it('accepts a range expression "0 9-17 * * *"', () => {
      expect(isValidCron('0 9-17 * * *')).toBe(true);
    });

    it('accepts a comma list "0,30 8-17 * * 1-5"', () => {
      expect(isValidCron('0,30 8-17 * * 1-5')).toBe(true);
    });

    it('accepts a stepped range "0 0 1-30/5 * *"', () => {
      expect(isValidCron('0 0 1-30/5 * *')).toBe(true);
    });

    it('accepts day-of-week 0 and 7 (both mean Sunday)', () => {
      expect(isValidCron('0 0 * * 0')).toBe(true);
      expect(isValidCron('0 0 * * 7')).toBe(true);
    });

    it('accepts boundary values for every field', () => {
      // minute 0-59, hour 0-23, day-of-month 1-31, month 1-12, day-of-week 0-7
      expect(isValidCron('59 23 31 12 7')).toBe(true);
      expect(isValidCron('0 0 1 1 0')).toBe(true);
    });

    it('tolerates extra internal whitespace between fields', () => {
      expect(isValidCron('0   0  *  *   *')).toBe(true);
    });

    it('tolerates leading/trailing whitespace', () => {
      expect(isValidCron('  0 0 * * *  ')).toBe(true);
    });
  });

  describe('malformed expressions', () => {
    it('rejects too few fields', () => {
      expect(isValidCron('0 0 * *')).toBe(false);
    });

    it('rejects too many fields', () => {
      expect(isValidCron('0 0 * * * *')).toBe(false);
    });

    it('rejects an empty string', () => {
      expect(isValidCron('')).toBe(false);
    });

    it('rejects a non-string input', () => {
      expect(isValidCron(null as unknown as string)).toBe(false);
      expect(isValidCron(undefined as unknown as string)).toBe(false);
      expect(isValidCron(42 as unknown as string)).toBe(false);
    });

    it('rejects an out-of-range minute (60)', () => {
      expect(isValidCron('60 0 * * *')).toBe(false);
    });

    it('rejects an out-of-range hour (24)', () => {
      expect(isValidCron('0 24 * * *')).toBe(false);
    });

    it('rejects an out-of-range day-of-month (0)', () => {
      expect(isValidCron('0 0 0 * *')).toBe(false);
    });

    it('rejects an out-of-range day-of-month (32)', () => {
      expect(isValidCron('0 0 32 * *')).toBe(false);
    });

    it('rejects an out-of-range month (0)', () => {
      expect(isValidCron('0 0 * 0 *')).toBe(false);
    });

    it('rejects an out-of-range month (13)', () => {
      expect(isValidCron('0 0 * 13 *')).toBe(false);
    });

    it('rejects an out-of-range day-of-week (8)', () => {
      expect(isValidCron('0 0 * * 8')).toBe(false);
    });

    it('rejects a non-numeric token', () => {
      expect(isValidCron('a 0 * * *')).toBe(false);
    });

    it('rejects a malformed range (inverted lo > hi)', () => {
      expect(isValidCron('0 17-9 * * *')).toBe(false);
    });

    it('rejects a step of zero', () => {
      expect(isValidCron('*/0 * * * *')).toBe(false);
    });

    it('rejects a negative step', () => {
      expect(isValidCron('*/-5 * * * *')).toBe(false);
    });

    it('rejects an empty comma-list segment', () => {
      expect(isValidCron('0,,30 * * * *')).toBe(false);
    });

    it('rejects a non-numeric step', () => {
      expect(isValidCron('*/x * * * *')).toBe(false);
    });
  });
});
