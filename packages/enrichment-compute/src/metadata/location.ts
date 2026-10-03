/**
 * Video container location (issue #545).
 *
 * Photos carry GPS in EXIF; videos do not. Phones instead write the capture
 * location into the MP4/MOV container as an ISO 6709 string, which ffprobe
 * surfaces as a format tag (occasionally a stream tag):
 *
 *   - `location` / `location-eng` — Android and Samsung (`©xyz` atom),
 *     e.g. `+30.1234-095.4567/`
 *   - `com.apple.quicktime.location.ISO6709` — iPhone, with altitude,
 *     e.g. `+30.1234-095.4567+012.345/`
 *
 * Both executors (the API and a worker node) call this module, so a video's
 * coordinates are identical whichever one probed it
 * (docs/specs/distributed-nodes.md §7).
 */

/** A parsed ISO 6709 point. Altitude is metres, present only when stated. */
export interface Iso6709Point {
  latitude: number;
  longitude: number;
  altitude?: number;
}

/** A location read from a video container, plus the tag it came from. */
export interface VideoLocation extends Iso6709Point {
  tag: string;
}

/**
 * `±lat ±lng [±alt] [CRSxxx] [/]`, each coordinate an integer part with an
 * optional fraction. The integer digit count selects the form (degrees,
 * degrees-minutes or degrees-minutes-seconds), so it is captured separately.
 */
const ISO6709_RE =
  /^([+-])(\d+)(?:\.(\d+))?([+-])(\d+)(?:\.(\d+))?(?:([+-])(\d+(?:\.\d+)?))?(?:CRS[A-Za-z0-9_:.-]*)?\/?$/;

/**
 * Convert one ISO 6709 coordinate to decimal degrees.
 *
 * `degDigits` is the width of the degrees field: 2 for latitude, 3 for
 * longitude. The integer part's length decides the form:
 *   - up to `degDigits`      → degrees           (`DD.DDDD`)
 *   - `degDigits + 2`        → degrees, minutes  (`DDMM.MMM`)
 *   - `degDigits + 4`        → deg, min, seconds (`DDMMSS.SS`)
 * The fraction always belongs to the last field. Anything else is ambiguous
 * and rejected rather than guessed.
 */
function toDecimalDegrees(
  sign: string,
  intPart: string,
  fracPart: string | undefined,
  degDigits: number,
): number | null {
  const frac = fracPart ? parseFloat(`0.${fracPart}`) : 0;
  const len = intPart.length;
  let degrees: number;

  if (len <= degDigits) {
    degrees = parseInt(intPart, 10) + frac;
  } else if (len === degDigits + 2) {
    const deg = parseInt(intPart.slice(0, degDigits), 10);
    const min = parseInt(intPart.slice(degDigits), 10) + frac;
    if (min >= 60) return null;
    degrees = deg + min / 60;
  } else if (len === degDigits + 4) {
    const deg = parseInt(intPart.slice(0, degDigits), 10);
    const min = parseInt(intPart.slice(degDigits, degDigits + 2), 10);
    const sec = parseInt(intPart.slice(degDigits + 2), 10) + frac;
    if (min >= 60 || sec >= 60) return null;
    degrees = deg + min / 60 + sec / 3600;
  } else {
    return null;
  }

  if (!Number.isFinite(degrees)) return null;
  return sign === '-' ? -degrees : degrees;
}

/**
 * Parse an ISO 6709 point string (`+30.1234-095.4567+012.345/`).
 *
 * Accepts decimal degrees, degrees-minutes and degrees-minutes-seconds forms,
 * with or without the trailing `/` and an optional altitude and CRS suffix.
 * Returns null for anything unparseable, out of range (|lat| > 90,
 * |lng| > 180), or exactly `0,0` — the value some devices write when they had
 * no fix, which must not be mistaken for a point in the Gulf of Guinea.
 */
export function parseIso6709(value: unknown): Iso6709Point | null {
  if (typeof value !== 'string') return null;
  const m = ISO6709_RE.exec(value.trim());
  if (!m) return null;

  const [, latSign, latInt, latFrac, lngSign, lngInt, lngFrac, altSign, altNum] = m;

  const latitude = toDecimalDegrees(latSign, latInt, latFrac, 2);
  const longitude = toDecimalDegrees(lngSign, lngInt, lngFrac, 3);
  if (latitude === null || longitude === null) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  if (latitude === 0 && longitude === 0) return null;

  const point: Iso6709Point = { latitude, longitude };
  if (altSign !== undefined && altNum !== undefined) {
    const altitude = parseFloat(altNum);
    if (Number.isFinite(altitude)) point.altitude = altSign === '-' ? -altitude : altitude;
  }
  return point;
}

/**
 * Container tags known to carry an ISO 6709 location, most specific first.
 * Keys are lower-case: callers pass a lower-cased tag map.
 */
const VIDEO_LOCATION_TAGS = [
  'com.apple.quicktime.location.iso6709',
  'location',
  'location-eng',
] as const;

/**
 * Read the capture location from a video container's tags.
 *
 * `tags` is the merged, lower-cased tag map from ffprobe (format tags taking
 * precedence over the video stream's). The known keys are tried first; after
 * that, any other key mentioning `location` (vendor variants such as
 * `com.android.capture.location`) is tried, so an unfamiliar spelling of a
 * real ISO 6709 value is not lost. Returns undefined when nothing parses.
 */
export function extractVideoLocation(
  tags: Record<string, unknown>,
): VideoLocation | undefined {
  const known = new Set<string>(VIDEO_LOCATION_TAGS);
  const candidates = [
    ...VIDEO_LOCATION_TAGS,
    ...Object.keys(tags)
      .filter((key) => !known.has(key) && key.includes('location'))
      .sort(),
  ];

  for (const tag of candidates) {
    const point = parseIso6709(tags[tag]);
    if (point) return { ...point, tag };
  }
  return undefined;
}
