import { describe, it, expect } from 'vitest';
import { formatDuration } from '../../src/core/headless/format-bytes.js';

describe('formatDuration', () => {
  it('uses the two largest units', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(800)).toBe('800ms');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
    expect(formatDuration(90_000_000)).toBe('1d 1h');
  });
});
