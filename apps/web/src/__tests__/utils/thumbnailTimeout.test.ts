/**
 * Unit tests for the thumbnailTimeout util — the pure predicate gallery
 * tiles use to decide when a persistently-null thumbnailUrl should stop
 * showing a "Processing…" spinner and fall back to a broken-image icon.
 */

import { describe, it, expect } from 'vitest';
import { isThumbnailStuck, THUMBNAIL_STUCK_THRESHOLD_MS } from '../../utils/thumbnailTimeout';

describe('isThumbnailStuck', () => {
  it('returns false for a createdAt from just now', () => {
    expect(isThumbnailStuck(new Date().toISOString())).toBe(false);
  });

  it('returns false for a createdAt just under the threshold', () => {
    const createdAt = new Date(Date.now() - (THUMBNAIL_STUCK_THRESHOLD_MS - 60_000)).toISOString();
    expect(isThumbnailStuck(createdAt)).toBe(false);
  });

  it('returns true for a createdAt just over the threshold', () => {
    const createdAt = new Date(Date.now() - (THUMBNAIL_STUCK_THRESHOLD_MS + 60_000)).toISOString();
    expect(isThumbnailStuck(createdAt)).toBe(true);
  });

  it('returns true for a createdAt from years ago', () => {
    expect(isThumbnailStuck('2020-01-01T00:00:00.000Z')).toBe(true);
  });

  it('respects a custom thresholdMs override', () => {
    const createdAt = new Date(Date.now() - 5_000).toISOString();
    expect(isThumbnailStuck(createdAt, 10_000)).toBe(false);
    expect(isThumbnailStuck(createdAt, 1_000)).toBe(true);
  });

  it('returns false (fails safe) for an unparseable createdAt', () => {
    expect(isThumbnailStuck('not-a-date')).toBe(false);
  });
});
