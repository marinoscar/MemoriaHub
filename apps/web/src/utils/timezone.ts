/**
 * IANA time-zone helpers for the per-user timezone preference (issue #444,
 * epic #440).
 *
 * ⚠️ NOTHING HERE IS GEOLOCATION. `detectTimeZone()` reads the time-zone
 * SETTING the operating system already handed the JavaScript runtime, via
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`. There is no permission
 * prompt, no `navigator.geolocation` call, no network request, and no
 * coordinate anywhere in this file — the value is a string the browser has
 * held since page load. Do not "upgrade" this to a GPS or IP lookup: that
 * would turn a free, silent, private read into a permission dialog (or a
 * third-party request) for a preference the user can simply pick from a list.
 */

/**
 * Zones a runtime may report when it genuinely does not know where it is.
 * `Etc/Unknown` is the spec-blessed placeholder (CLDR's "unknown or invalid
 * zone"); treating it as a real answer would auto-save nonsense.
 */
const UNKNOWN_ZONES = new Set(['Etc/Unknown', 'Factory', 'localtime']);

/**
 * A last-resort option list for runtimes without `Intl.supportedValuesOf`
 * (Safari < 15.4, older Android WebViews). Deliberately short: it exists so
 * the picker still offers *something* selectable rather than rendering an
 * empty dropdown, not to be a complete tz database.
 */
const FALLBACK_ZONES = [
  'UTC',
  'America/Anchorage',
  'America/Bogota',
  'America/Chicago',
  'America/Costa_Rica',
  'America/Denver',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Sao_Paulo',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/Berlin',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Moscow',
  'Europe/Paris',
  'Pacific/Auckland',
];

/**
 * True when the runtime accepts `zone` as a real IANA identifier.
 *
 * Never throws: an unknown zone makes `DateTimeFormat` throw a `RangeError`,
 * which is exactly the signal we want, expressed as a boolean.
 */
export function isValidTimeZone(zone: string): boolean {
  if (!zone || UNKNOWN_ZONES.has(zone)) return false;
  try {
    // Throws RangeError for an identifier the runtime does not know.
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The browser's current IANA time zone, or `null` when it cannot be
 * determined.
 *
 * Returns `null` — never a guess and never a throw — when `Intl` is missing,
 * when the runtime reports a placeholder such as `Etc/Unknown`, or when the
 * reported value is not an identifier the runtime itself will accept. Callers
 * treat `null` as "we learned nothing", which is different from "the user is
 * in UTC".
 */
export function detectTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof zone !== 'string') return null;
    return isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/**
 * Every IANA zone the runtime knows, sorted, for the settings picker.
 *
 * Falls back to {@link FALLBACK_ZONES} where `Intl.supportedValuesOf` is
 * unavailable so an older browser gets a usable — if short — list instead of
 * a crash or an empty dropdown.
 */
export function listTimeZones(): string[] {
  try {
    const supported = (
      Intl as typeof Intl & {
        supportedValuesOf?: (key: string) => string[];
      }
    ).supportedValuesOf;

    if (typeof supported === 'function') {
      const zones = supported('timeZone');
      if (Array.isArray(zones) && zones.length > 0) {
        return [...zones].sort();
      }
    }
  } catch {
    // fall through to the static list
  }
  return [...FALLBACK_ZONES];
}

/**
 * "now", rendered in `zone`, for the settings page's live sample.
 *
 * Returns `null` rather than throwing when the zone is not usable, so a
 * stored value written by some other client can never break the page.
 */
export function formatNowInZone(zone: string, now: Date = new Date()): string | null {
  try {
    return now.toLocaleString(undefined, {
      timeZone: zone,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return null;
  }
}
