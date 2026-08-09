/**
 * Unit tests — story player timing model (epic #300, issue #313).
 *
 * These are the numbers the player's whole feel depends on, and they are pure
 * functions precisely so they can be asserted without a Dialog, a `<video>` and
 * four CSS animations in the way.
 */

import { describe, it, expect } from 'vitest';
import {
  PHOTO_DURATION_MS,
  VIDEO_MAX_DURATION_MS,
  VIDEO_MIN_DURATION_MS,
  describeStep,
  formatItemCaption,
  isVideoItem,
  resolveItemDurationMs,
} from '../../../components/memories/storyTiming';
import type { MemoryDetailItem } from '../../../types/memories';

function item(overrides: Partial<MemoryDetailItem> = {}): MemoryDetailItem {
  return {
    id: 'item-1',
    mediaItemId: 'media-1',
    position: 0,
    mediaType: 'image/jpeg',
    width: 4000,
    height: 3000,
    durationMs: null,
    capturedAt: '2023-03-12T15:04:00.000Z',
    thumbnailUrl: 'https://cdn/thumb.jpg',
    ...overrides,
  };
}

describe('isVideoItem', () => {
  it('classifies on the media type prefix', () => {
    expect(isVideoItem(item({ mediaType: 'video/mp4' }))).toBe(true);
    expect(isVideoItem(item({ mediaType: 'image/heic' }))).toBe(false);
  });
});

describe('resolveItemDurationMs', () => {
  it('gives every photo the same beat, ignoring any duration noise', () => {
    expect(resolveItemDurationMs(item())).toBe(PHOTO_DURATION_MS);
    expect(resolveItemDurationMs(item({ durationMs: 90_000 }), 90_000)).toBe(
      PHOTO_DURATION_MS,
    );
  });

  it('plays a short video for its own length', () => {
    const video = item({ mediaType: 'video/mp4', durationMs: 6_000 });
    expect(resolveItemDurationMs(video)).toBe(6_000);
  });

  it('caps a long video at 15 seconds', () => {
    const video = item({ mediaType: 'video/mp4', durationMs: 240_000 });
    expect(resolveItemDurationMs(video)).toBe(VIDEO_MAX_DURATION_MS);
  });

  it('floors a sub-second clip so it reads as a slide, not a flicker', () => {
    const video = item({ mediaType: 'video/mp4', durationMs: 300 });
    expect(resolveItemDurationMs(video)).toBe(VIDEO_MIN_DURATION_MS);
  });

  it('prefers the measured duration over the ingest-time one', () => {
    const video = item({ mediaType: 'video/mp4', durationMs: 12_000 });
    expect(resolveItemDurationMs(video, 4_000)).toBe(4_000);
  });

  it('falls back to the full cap when no duration is known at all', () => {
    // An old import or a failed ffprobe: playing for the cap is right, silently
    // skipping past the clip is not.
    const video = item({ mediaType: 'video/mp4', durationMs: null });
    expect(resolveItemDurationMs(video)).toBe(VIDEO_MAX_DURATION_MS);
    expect(resolveItemDurationMs(video, Number.NaN)).toBe(VIDEO_MAX_DURATION_MS);
    expect(resolveItemDurationMs(video, 0)).toBe(VIDEO_MAX_DURATION_MS);
  });
});

describe('formatItemCaption', () => {
  it('returns null when there is nothing to say', () => {
    expect(formatItemCaption(null)).toBeNull();
    expect(formatItemCaption('not-a-date')).toBeNull();
  });

  it('appends the place when the full media record supplied one', () => {
    const caption = formatItemCaption('2023-03-12T15:04:00.000Z', 'Tamarindo');
    expect(caption).toContain('Tamarindo');
    expect(caption).toContain('·');
  });

  it('carries just the place when the capture date is missing', () => {
    expect(formatItemCaption(null, 'Tamarindo')).toBe('Tamarindo');
  });
});

describe('describeStep', () => {
  const items = [item({ id: 'a' }), item({ id: 'b', mediaType: 'video/mp4' })];

  it('announces the title card, each position, and the end', () => {
    expect(describeStep(-1, items, 'Trip to Guanacaste')).toContain(
      'Trip to Guanacaste',
    );
    expect(describeStep(0, items, 'Trip')).toContain('Photo 1 of 2');
    expect(describeStep(1, items, 'Trip')).toContain('Video 2 of 2');
    expect(describeStep(2, items, 'Trip')).toContain('End of Trip');
  });
});
