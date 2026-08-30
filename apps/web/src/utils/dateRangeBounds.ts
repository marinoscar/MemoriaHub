/**
 * Date-range bound normalisation for filters (issue #446, epic #440).
 *
 * A `<input type="date">` yields a bare `YYYY-MM-DD` — a calendar date with no
 * time and no zone. Turning that into the pair of instants a range filter needs
 * requires knowing **which kind of value the column holds**, and the two
 * answers are different (see `docs/specs/date-model.md`):
 *
 * | Field | Kind | "June 16" means | Bound anchored in |
 * |---|---|---|---|
 * | `capturedAt` | civil timestamp | June 16 on the *photographer's* calendar | **UTC** |
 * | `uploadedAt` → `createdAt` | instant | June 16 on the *user's* calendar | **the user's zone** |
 *
 * `capturedAt` is already civil-in-UTC, so a UTC-anchored bound reads the
 * photographer's own day. An upload time is a real instant displayed to the
 * user in their own clock, so anchoring its bounds to UTC shifts the window by
 * the user's offset — the reported symptom in #446, where an item whose drawer
 * read "Aug 16, 9:30 PM" was excluded from an `Aug 16 → Aug 16` filter.
 *
 * ⚠️ The two functions below look almost identical and are NOT
 * interchangeable. Do not "unify" them.
 */

/** Both bounds of a range, as ISO instants. */
export interface RangeBounds {
  from?: string;
  to?: string;
}

/** `true` for a bare `YYYY-MM-DD`. */
function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Bounds for a **civil** field (`capturedAt`): the whole calendar day, read in
 * UTC, end-inclusive.
 */
export function civilDayRange(from?: string, to?: string): RangeBounds {
  const bounds: RangeBounds = {};
  if (from && isDateOnly(from)) {
    bounds.from = new Date(`${from}T00:00:00.000Z`).toISOString();
  } else if (from) {
    bounds.from = new Date(from).toISOString();
  }
  if (to && isDateOnly(to)) {
    // End-inclusive: without this the range covers only the instant of the
    // final day's midnight, silently dropping that whole day.
    bounds.to = new Date(`${to}T23:59:59.999Z`).toISOString();
  } else if (to) {
    bounds.to = new Date(to).toISOString();
  }
  return bounds;
}

/**
 * Bounds for an **instant** field (`uploadedAt`): the user's local
 * midnight-to-midnight window, expressed as the UTC instants that delimit it.
 *
 * @param timeZone the user's stored IANA zone (issue #444). When omitted the
 * browser's own zone is used, which is correct for an ordinary session and is
 * what makes this fix independent of whether a preference has been saved.
 */
export function instantDayRange(
  from?: string,
  to?: string,
  timeZone?: string,
): RangeBounds {
  const bounds: RangeBounds = {};
  if (from) {
    bounds.from = isDateOnly(from)
      ? localDayBoundary(from, 'start', timeZone)
      : new Date(from).toISOString();
  }
  if (to) {
    bounds.to = isDateOnly(to)
      ? localDayBoundary(to, 'end', timeZone)
      : new Date(to).toISOString();
  }
  return bounds;
}

/**
 * The UTC instant at which `ymd` starts (or ends) in `timeZone`.
 *
 * With no zone this is a one-liner: `new Date('2026-08-16T00:00:00')` — with
 * NO zone designator — is parsed as local time by ECMA-262, which is exactly
 * the browser-zone answer. With an explicit zone we cannot lean on the parser,
 * so the offset is measured by formatting a probe instant in that zone and
 * comparing it to the same components read in UTC.
 */
function localDayBoundary(
  ymd: string,
  edge: 'start' | 'end',
  timeZone?: string,
): string {
  const clock = edge === 'start' ? '00:00:00.000' : '23:59:59.999';

  if (!timeZone) {
    return new Date(`${ymd}T${clock}`).toISOString();
  }

  // Treat the wall clock as UTC first, then subtract the zone's offset at that
  // moment. Done twice because the offset itself can differ across a DST
  // boundary between the naive guess and the corrected instant.
  const naive = new Date(`${ymd}T${clock}Z`).getTime();
  let guess = naive - offsetMs(naive, timeZone);
  guess = naive - offsetMs(guess, timeZone);
  return new Date(guess).toISOString();
}

/**
 * `timeZone`'s UTC offset in milliseconds at instant `at`. Returns 0 for a
 * zone the runtime rejects, degrading to UTC rather than throwing inside a
 * filter the user is typing into.
 */
function offsetMs(at: number, timeZone: string): number {
  try {
    // `en-CA` + `hourCycle: h23` gives a strictly parseable `YYYY-MM-DD, HH:mm:ss`.
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(at));

    const get = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((p) => p.type === type)?.value ?? '0');

    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    // Sub-second precision is not represented in the parts; add it back so a
    // `.999` end bound stays `.999`.
    return asUtc + (at % 1000) - at;
  } catch {
    return 0;
  }
}
