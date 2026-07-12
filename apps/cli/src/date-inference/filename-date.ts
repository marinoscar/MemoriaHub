/**
 * date-inference/filename-date.ts — Pure filename → capture-date parser.
 *
 * No I/O, no dependencies. Tries an ordered list of regexes against a file's
 * basename, most specific / highest-signal pattern first, and returns the
 * first candidate that is also calendar-valid (real month/day, year in a
 * sane range). Used by the Date Inference tool to propose a capture date for
 * files with no EXIF/container date at all.
 */

export type FilenameDatePattern = 'whatsapp' | 'timestamp' | 'delimited' | 'bare';

export interface FilenameDateMatch {
  /**
   * ISO-shaped timestamp string preserving the filename's WALL-CLOCK value
   * verbatim (not a real UTC instant) — same convention as
   * `exifDateToIso()` in metadata.ts. Time defaults to noon when the
   * filename carried no time component (see `hadTime`).
   */
  iso: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** False when hour/minute/second were defaulted to noon (no time in the filename). */
  hadTime: boolean;
  /** Which pattern matched, for report/debug display. */
  pattern: FilenameDatePattern;
  /** The exact substring of the filename that matched. */
  matchedText: string;
}

const MIN_YEAR = 2003;

// Ordered most-specific/highest-signal first. Each entry's regex must expose
// capture groups 1-3 as YYYY/MM/DD and, when present, 4-6 as HH/MM/SS.
const PATTERNS: Array<{ id: FilenameDatePattern; re: RegExp; hasTime: boolean }> = [
  // WhatsApp re-share convention: IMG-20151228-WA0007.jpg / VID-20151228-WA0007.mp4
  { id: 'whatsapp', re: /(?:IMG|VID)-(\d{4})(\d{2})(\d{2})-WA\d+/i, hasTime: false },
  // Full timestamp with a separator between date and time: iOS
  // (20151107_135151000_iOS.jpg), Pixel (PXL_20260704_120000.mp4), Android
  // screenshots (Screenshot_20260704-120000.png). Trailing 0-3 digits (e.g.
  // milliseconds) after the seconds are matched but discarded.
  { id: 'timestamp', re: /(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})\d{0,3}/, hasTime: true },
  // Delimited date only: 2015-01-15, 2015_01_15, 2015.01.15
  { id: 'delimited', re: /(?<!\d)(\d{4})[-_.](\d{2})[-_.](\d{2})(?!\d)/, hasTime: false },
  // Bare 8-digit date, lowest confidence — guarded so it never matches inside
  // a longer digit run (a 10/13-digit unix timestamp, a long numeric ID).
  { id: 'bare', re: /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/, hasTime: false },
];

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  // Round-trip through Date.UTC: an invalid day (e.g. 2015-02-30) rolls over
  // into the next month, so the components no longer match what we asked for.
  // This also handles leap years for free.
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
  );
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Try to infer a capture date from a file's basename.
 *
 * @param basename  The file's basename (with or without extension — either works).
 * @param opts.now  Injectable "current time" for the max-year bound, defaults to `new Date()`.
 * @returns  The first structurally- and calendar-valid match, or `null` if nothing matched.
 */
export function parseDateFromFilename(
  basename: string,
  opts?: { now?: Date },
): FilenameDateMatch | null {
  const maxYear = (opts?.now ?? new Date()).getFullYear();

  for (const { id, re, hasTime } of PATTERNS) {
    const m = basename.match(re);
    if (!m) continue;

    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);

    if (year < MIN_YEAR || year > maxYear) continue;
    if (month < 1 || month > 12) continue;
    if (day < 1 || day > 31) continue;
    if (!isValidCalendarDate(year, month, day)) continue;

    let hour = 12;
    let minute = 0;
    let second = 0;
    let hadTime = false;

    if (hasTime) {
      const h = Number(m[4]);
      const mi = Number(m[5]);
      const s = Number(m[6]);
      if (h > 23 || mi > 59 || s > 59) continue;
      hour = h;
      minute = mi;
      second = s;
      hadTime = true;
    }

    return {
      iso: `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}.000Z`,
      year,
      month,
      day,
      hour,
      minute,
      second,
      hadTime,
      pattern: id,
      matchedText: m[0],
    };
  }

  return null;
}
