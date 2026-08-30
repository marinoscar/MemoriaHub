import type { MediaItem } from '../types/media';
import { civilDayKey, formatCivilDate, instantDayKey } from './civilDate';

/**
 * Group media into day buckets, newest day first, `undated` last.
 *
 * ⚠️ The two date fields this reads are different KINDS of value and are
 * deliberately bucketed differently (issue #442, epic #440 — see
 * `docs/specs/date-model.md`):
 *
 * - `capturedAt` is a **civil timestamp**: the EXIF wall clock re-encoded as
 *   UTC. It is bucketed in **UTC**, which reads the photographer's own clock
 *   back out unchanged. Using browser-local getters here — what this function
 *   used to do — applied the viewer's offset a *second* time and filed a band
 *   of hours near midnight under the wrong day, disagreeing with the server,
 *   which buckets the same photo in UTC.
 * - `importedAt` is a genuine **instant**, used only as a fallback for items
 *   with no capture date. An upload has no "where it was taken", so the
 *   correct day for it is the day it happened *on the viewer's clock*. It is
 *   therefore bucketed in the viewer's zone.
 *
 * The two kinds can interleave inside one bucket, and that is fine: each is
 * on its own correct day, and the bucket is identified by a calendar date
 * rather than by a zone.
 */
export function groupByDay(
  items: MediaItem[],
): Array<{ key: string; label: string; items: MediaItem[] }> {
  const groups = new Map<string, { label: string; items: MediaItem[] }>();

  for (const item of items) {
    // Civil timestamp → UTC; instant fallback → viewer-local.
    const key = item.capturedAt
      ? civilDayKey(item.capturedAt)
      : item.importedAt
        ? instantDayKey(item.importedAt)
        : 'undated';

    if (!groups.has(key)) {
      // The label is derived from the KEY, not from whichever item happened
      // to create the bucket, so a bucket holding both kinds cannot end up
      // labelled with a different day than it is keyed by. A `YYYY-MM-DD` key
      // is a calendar date, so it is formatted as a civil value.
      groups.set(key, {
        label: key === 'undated' ? 'Undated' : formatCivilDate(`${key}T00:00:00.000Z`),
        items: [],
      });
    }
    groups.get(key)!.items.push(item);
  }

  // Newest day first; undated last
  return Array.from(groups.entries())
    .sort(([a], [b]) => {
      if (a === 'undated') return 1;
      if (b === 'undated') return -1;
      return b.localeCompare(a);
    })
    .map(([key, value]) => ({ key, ...value }));
}
