// =============================================================================
// Shared IANA time-zone helpers (issue #444)
// =============================================================================
//
// One implementation of "is this zone real?" and of civil(wall-clock)<->UTC
// conversion, for every feature that has to reason about a zone other than the
// server's.
//
// These moved here VERBATIM from db-backup-admin.service.ts, where they were
// private, once a second consumer appeared: per-user time zones (#444) need the
// same validation for a zod `.refine`, and #445's date grouping needs the same
// civil-parts conversion. db-backup-admin.service.ts re-exports them so its own
// call sites (and node-backup.service.ts's separate, now-unified predicate)
// keep working unchanged.
//
// The one deliberate unification, and it is a bug fix rather than a rewrite:
// `Intl.supportedValuesOf('timeZone')` OMITS 'UTC' on several runtimes (Node 22
// among them), so a plain `supported.includes(tz)` rejects the single most
// common zone there is — and 'UTC' is `databaseBackup.timezone`'s own default.
// node-backup.service.ts had already worked around this by re-adding 'UTC' to
// its Set; that workaround is now the shared behavior, so
// `isSupportedTimeZone('UTC')` is true on every runtime. Everything else about
// the checks — including the DateTimeFormat degradation path and the
// fixed-point iteration in wallClockToUtc with its documented DST-gap caveat —
// is unchanged.
// =============================================================================

import { BadRequestException } from '@nestjs/common';

/** Civil (wall-clock) date/time parts of an instant, in a given zone. */
export interface CivilParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Valid IANA timezone names. Built lazily; 'UTC' is added explicitly since some
 * runtimes canonicalize it out of Intl.supportedValuesOf('timeZone').
 */
let timezoneSet: Set<string> | null = null;

/**
 * Does `Intl` know this zone?
 *
 * `Intl.supportedValuesOf` is the authoritative list on this runtime; where it
 * is unavailable (very old ICU builds) the check degrades to constructing a
 * formatter, which throws a `RangeError` for an unknown zone — so an invalid
 * value is still rejected, just with a less precise list behind it.
 */
export function isSupportedTimeZone(timezone: string): boolean {
  if (!timezone) return false;

  const supportedValuesOf = (Intl as any).supportedValuesOf as
    | ((key: string) => string[])
    | undefined;

  if (supportedValuesOf) {
    if (!timezoneSet) {
      timezoneSet = new Set([...supportedValuesOf('timeZone'), 'UTC']);
    }
    return timezoneSet.has(timezone);
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Reject a `timezone` that `Intl` does not know. */
export function assertSupportedTimeZone(timezone: string): void {
  if (!isSupportedTimeZone(timezone)) {
    throw new BadRequestException(`Unknown IANA time zone "${timezone}"`);
  }
}

/** Civil (wall-clock) date/time parts of an instant, in a given zone. */
export function civilPartsInZone(date: Date, timeZone: string): CivilParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;

  // Intl can render midnight as hour "24" in the h23/h24 boundary case.
  const hour = Number(map['hour']) % 24;

  return {
    year: Number(map['year']),
    month: Number(map['month']),
    day: Number(map['day']),
    hour,
    minute: Number(map['minute']),
    second: Number(map['second']),
  };
}

/**
 * Civil (wall-clock) date/time parts of an instant, in a given zone.
 *
 * Historical name, kept as an alias so db-backup-admin.service.ts's existing
 * call sites (including a `ReturnType<typeof wallClockParts>`) are untouched.
 */
export const wallClockParts = civilPartsInZone;

/** Offset (ms) of `timeZone` from UTC at the given instant. */
export function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = civilPartsInZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

/**
 * Convert a wall-clock date/time in `timeZone` to the corresponding UTC instant.
 *
 * Two passes, because the offset depends on the instant we are solving for: the
 * first pass uses the offset at the naive guess, the second re-reads it at the
 * corrected instant. That converges everywhere except inside a DST spring-forward
 * gap, where the nominal time does not exist and the result lands just past it —
 * acceptable for a backup schedule (the run happens once, an hour off, on one day
 * a year) and strictly better than throwing.
 */
export function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = naive - zoneOffsetMs(new Date(naive), timeZone);
  ts = naive - zoneOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/**
 * The UTC instant at which the civil day CONTAINING `date` begins, in `timeZone`.
 *
 * i.e. midnight of that zone's calendar day, expressed as a real instant. This
 * is the primitive date-grouping needs (#445): "which day is this photo in, for
 * this user" is a question about civil days in the viewer's zone, never about
 * UTC days.
 *
 * Inherits wallClockToUtc's spring-forward caveat: in the rare zone whose DST
 * transition happens AT midnight, the returned instant is the first moment that
 * actually exists on that day rather than the nominal (non-existent) 00:00.
 */
export function startOfDayInZone(date: Date, timeZone: string): Date {
  const p = civilPartsInZone(date, timeZone);
  return wallClockToUtc(p.year, p.month, p.day, 0, 0, timeZone);
}
