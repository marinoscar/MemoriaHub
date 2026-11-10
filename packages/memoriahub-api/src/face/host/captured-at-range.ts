// =============================================================================
// The captured-at range of a backfill
// =============================================================================
//
// `capturedAt` is a CIVIL timestamp (the capture wall clock re-encoded as UTC), so a date range
// bounds it in UTC and an upper bound that is exactly a UTC midnight means "through the end of
// that day" (exclusive next midnight). This is the rule of the search where-builder, kept here so
// the slice needs nothing of the search slice; it moves to a shared home when that slice moves.
// =============================================================================

function upperBound(to: Date): { lt: Date } | { lte: Date } {
  const isMidnightUtc =
    to.getUTCHours() === 0 && to.getUTCMinutes() === 0 && to.getUTCSeconds() === 0 && to.getUTCMilliseconds() === 0;

  if (!isMidnightUtc) return { lte: to };
  return { lt: new Date(to.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * The `where` fragment bounding `capturedAt` by an optional range.
 *
 * @param from - the inclusive lower bound.
 * @param to - the upper bound; a UTC midnight bound includes that whole day.
 * @returns `{}` when no bound is given.
 * @stability experimental
 */
export function whereCapturedAtRange(from?: Date, to?: Date): Record<string, unknown> {
  if (!from && !to) return {};
  return {
    capturedAt: {
      ...(from && { gte: from }),
      ...(to && upperBound(to)),
    },
  };
}
