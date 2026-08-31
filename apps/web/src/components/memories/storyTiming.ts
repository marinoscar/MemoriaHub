// ---------------------------------------------------------------------------
// Story player timing model (epic #300, issue #313)
//
// Every number the player's pacing depends on lives HERE, as pure functions
// over the DTO, so the timing can be unit-tested without mounting a full-screen
// Dialog, a `<video>` element and four CSS animations. The component imports
// these; it never inlines a duration of its own.
// ---------------------------------------------------------------------------

import type { MemoryDetailItem } from '../../types/memories';
import { formatCivilDate } from '../../utils/civilDate';

/** The title card holds before the first photo. Issue #313 specifies 2.5s. */
export const TITLE_CARD_DURATION_MS = 2500;

/** Every photo gets the same beat. Issue #313 specifies 5s. */
export const PHOTO_DURATION_MS = 5000;

/**
 * A video plays for `min(duration, 15s)`. The cap exists because a memory may
 * legitimately contain a 4-minute clip and a story that stalls on it for four
 * minutes is not a story — the curation engine caps videos at 3 per memory
 * precisely so this truncation stays rare.
 */
export const VIDEO_MAX_DURATION_MS = 15000;

/**
 * Floor for a video segment. `min(duration, 15s)` taken literally would give a
 * 300ms clip a 300ms segment, which reads as a flicker rather than a slide —
 * the viewer never registers it and the progress bar jumps a whole segment.
 * A short clip therefore holds for at least this long (looping, since the
 * element is `loop`ed), which is the one deliberate deviation from the literal
 * spec wording and is documented in docs/specs/memories.md §8.12.
 */
export const VIDEO_MIN_DURATION_MS = 1500;

/** Crossfade between consecutive slides. Suppressed under reduced motion. */
export const CROSSFADE_MS = 400;

/** How long a pointer must stay down before it counts as hold-to-pause. */
export const HOLD_TO_PAUSE_MS = 220;

/** Pointer travel beyond which a press is a swipe, not a tap. */
export const SWIPE_THRESHOLD_PX = 50;

/** Pointer travel beyond which a press can no longer become a hold. */
export const HOLD_CANCEL_SLOP_PX = 12;

/**
 * Fraction of the surface width that maps to "previous" on tap. Instagram uses
 * roughly a third; the remainder advances, because forward is the dominant
 * intent and deserves the larger target.
 */
export const TAP_BACK_ZONE_FRACTION = 0.3;

/** How many upcoming slides are warmed in the browser cache. */
export const PRELOAD_AHEAD = 2;

/** Index sentinel for the title card — one step before the first item. */
export const TITLE_INDEX = -1;

export function isVideoItem(item: MemoryDetailItem): boolean {
  return (item.mediaType ?? '').startsWith('video');
}

/**
 * How long the slide at `item` should be held on screen.
 *
 * `measuredDurationMs` is what the `<video>` element reported once its metadata
 * loaded, and it WINS over the DTO's `durationMs`: the DTO value comes from
 * ffprobe at ingest and can be absent (an old import, a failed probe) or stale
 * relative to the bytes actually being played. When neither is known a video
 * gets the full cap, so an unprobed clip plays for 15s rather than being
 * skipped past instantly.
 */
export function resolveItemDurationMs(
  item: MemoryDetailItem,
  measuredDurationMs?: number | null,
): number {
  if (!isVideoItem(item)) return PHOTO_DURATION_MS;

  const known = measuredDurationMs ?? item.durationMs;
  if (known == null || !Number.isFinite(known) || known <= 0) {
    return VIDEO_MAX_DURATION_MS;
  }
  return Math.min(
    VIDEO_MAX_DURATION_MS,
    Math.max(VIDEO_MIN_DURATION_MS, Math.round(known)),
  );
}

/**
 * Total steps in a story: the title card, every item, and the end card. Used
 * only for the announcement copy — the player's own bounds are expressed
 * against `items.length` directly.
 */
export function storyStepCount(itemCount: number): number {
  return itemCount + 2;
}

/**
 * Caption under a slide: the capture date, plus the place when the full media
 * record has resolved and carries one.
 *
 * Returns `null` rather than an empty string when there is nothing to say, so
 * the caller can skip rendering the scrim entirely instead of drawing an empty
 * black band over the photo.
 */
export function formatItemCaption(
  capturedAt: string | null,
  locality?: string | null,
): string | null {
  const parts: string[] = [];
  if (capturedAt) {
    // capturedAt is a civil timestamp — rendered in UTC so the caption shows
    // the day the photo was taken, not the viewer's day (epic #440).
    const label = formatCivilDate(capturedAt, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    if (label) parts.push(label);
  }
  if (locality) parts.push(locality);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * What the polite live region says when the slide changes.
 *
 * Screen-reader users get no benefit from the visual progress bar, so this is
 * the ONLY channel that tells them where they are in the story — which is why
 * it names the position rather than just describing the photo.
 */
export function describeStep(
  index: number,
  items: MemoryDetailItem[],
  memoryTitle: string,
): string {
  if (index <= TITLE_INDEX) return `${memoryTitle}. Starting story.`;
  if (index >= items.length) return `End of ${memoryTitle}.`;

  const item = items[index];
  const kind = isVideoItem(item) ? 'Video' : 'Photo';
  const caption = formatItemCaption(item.capturedAt);
  const position = `${kind} ${index + 1} of ${items.length}`;
  return caption ? `${position}. ${caption}` : position;
}
