/**
 * @packageDocumentation
 * Zod building blocks shared by the wire schemas of every slice: ISO date-time
 * fields, the `bbox` query encoding and the IANA time-zone check.
 */
import { z } from 'zod';

/**
 * Zod schema for a date-time field in a response shape.
 *
 * Emits `{ type: 'string', format: 'date-time' }` in JSON Schema, which a Swagger
 * generator can represent (unlike `z.date()`).
 *
 * @stability stable
 */
export const isoDateTime = z.iso.datetime();

/**
 * Zod schema for a date-time field in a request shape (body or query).
 *
 * Validates the ISO 8601 string, then coerces it to a `Date` so a service can
 * hand it to the database as is.
 *
 * @stability stable
 */
export const isoDateTimeInput = z.iso.datetime().pipe(z.coerce.date());

/**
 * A parsed geographic bounding box.
 *
 * @stability stable
 */
export interface Bbox {
  /** Western edge, degrees longitude. */
  minLng: number;
  /** Southern edge, degrees latitude. */
  minLat: number;
  /** Eastern edge, degrees longitude. */
  maxLng: number;
  /** Northern edge, degrees latitude. */
  maxLat: number;
}

/**
 * Zod schema for a `bbox` query parameter encoded as `"minLng,minLat,maxLng,maxLat"`.
 *
 * Transforms the string into a {@link Bbox} of four finite numbers and rejects
 * anything else. Combine with `.optional()` at the call site.
 *
 * @stability stable
 */
export const bboxInput = z.string().transform((val, ctx): Bbox => {
  const parts = val.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    ctx.addIssue({
      code: 'custom',
      message: 'bbox must be "minLng,minLat,maxLng,maxLat" of four finite numbers',
    });
    return z.NEVER;
  }
  const [minLng, minLat, maxLng, maxLat] = parts;
  return { minLng, minLat, maxLng, maxLat };
});

let timezoneSet: Set<string> | null = null;

/**
 * Does `Intl` know this IANA zone name?
 *
 * The `Intl.supportedValuesOf('timeZone')` list holds canonical names only
 * (`Asia/Kolkata` is absent on some runtimes, `UTC` too), so it is a cache in
 * front of the real predicate, never a veto: a name the list lacks is still
 * accepted when `Intl.DateTimeFormat` constructs with it.
 *
 * @param timezone - The candidate zone name.
 * @returns `true` when the zone is usable by every `Intl` call.
 * @stability stable
 */
export function isSupportedTimeZone(timezone: string): boolean {
  if (!timezone) return false;

  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;

  if (supportedValuesOf) {
    if (!timezoneSet) {
      timezoneSet = new Set([...supportedValuesOf('timeZone'), 'UTC']);
    }
    if (timezoneSet.has(timezone)) return true;
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
