/**
 * dates/month-bucket.ts — Shared year/month bucketing helper.
 *
 * Extracted from organize/plan.ts (issue #314) so the organize command and the
 * backup layout (src/backup/layout.ts) share ONE definition of "which
 * YYYY / zero-padded-MM does this Date fall in" instead of duplicating the
 * padding/getter logic.
 *
 * Two accessor flavors exist deliberately:
 *  - localMonthBucket: LOCAL getters. Used by organize — EXIF capture dates are
 *    naive wall-clock timestamps parsed into local time, so a file must bucket
 *    by the local date it was recorded, not the UTC date (which can shift
 *    across a day boundary).
 *  - utcMonthBucket: UTC getters. Used by the backup layout — the server sends
 *    `capturedAt` as a UTC instant plus `capturedAtOffset` in MINUTES; the
 *    caller shifts the instant by the offset first, after which the human-local
 *    capture date is exactly the UTC fields of the shifted Date.
 */

export interface MonthBucket {
  /** Four-digit year, e.g. '2024'. */
  year: string;
  /** Zero-padded two-digit month, '01'–'12'. */
  month: string;
  /** Month index 0–11 (0 = January) — for callers that need the month name. */
  monthIndex: number;
}

function format(year: number, monthIndex: number): MonthBucket {
  return {
    year: String(year),
    month: String(monthIndex + 1).padStart(2, '0'),
    monthIndex,
  };
}

/** Year/month of `date` read with LOCAL getters (organize semantics). */
export function localMonthBucket(date: Date): MonthBucket {
  return format(date.getFullYear(), date.getMonth());
}

/** Year/month of `date` read with UTC getters (backup layout semantics). */
export function utcMonthBucket(date: Date): MonthBucket {
  return format(date.getUTCFullYear(), date.getUTCMonth());
}
