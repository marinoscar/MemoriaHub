/**
 * test/format-bytes.spec.ts
 *
 * Unit tests for formatBytes() — human-readable byte size with binary (1024)
 * units and adaptive decimal precision.
 */

import { formatBytes } from '../src/format-bytes.js';

describe('formatBytes', () => {
  describe('invalid / missing input', () => {
    it('returns em dash for null', () => {
      expect(formatBytes(null)).toBe('—');
    });

    it('returns em dash for undefined', () => {
      expect(formatBytes(undefined)).toBe('—');
    });

    it('returns em dash for a negative number', () => {
      expect(formatBytes(-1)).toBe('—');
    });

    it('returns em dash for NaN', () => {
      expect(formatBytes(NaN)).toBe('—');
    });

    it('returns em dash for Infinity', () => {
      expect(formatBytes(Infinity)).toBe('—');
    });
  });

  describe('sub-1024 bytes', () => {
    it('formats 0 bytes', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('formats 512 bytes', () => {
      expect(formatBytes(512)).toBe('512 B');
    });

    it('rounds a fractional byte count below 1024', () => {
      expect(formatBytes(511.6)).toBe('512 B');
    });
  });

  describe('KB / MB / GB / TB scaling', () => {
    it('formats exactly 1024 bytes as 1.0 KB', () => {
      expect(formatBytes(1024)).toBe('1.0 KB');
    });

    it('formats 1536 bytes as 1.5 KB', () => {
      expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('formats 1048576 bytes as 1.0 MB', () => {
      expect(formatBytes(1048576)).toBe('1.0 MB');
    });

    it('drops the decimal at/above 100 units (150 MB)', () => {
      expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
    });

    it('formats a GB-scale value with one decimal below 100', () => {
      expect(formatBytes(2.4 * 1024 * 1024 * 1024)).toBe('2.4 GB');
    });

    it('formats a TB-scale value', () => {
      expect(formatBytes(1.1 * 1024 * 1024 * 1024 * 1024)).toBe('1.1 TB');
    });

    it('caps at PB and does not overflow the unit array', () => {
      const hugeBytes = 2 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024; // 2048 PB
      const result = formatBytes(hugeBytes);
      expect(result.endsWith('PB')).toBe(true);
    });
  });
});
