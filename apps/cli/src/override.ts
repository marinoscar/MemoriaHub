/**
 * override.ts — Per-folder metadata override reader for the sync/upload flow.
 *
 * A user may drop a `memoriahub.json` file into a media folder to supply
 * FALLBACK "date taken" and "GPS location" for the files in THAT folder that
 * lack the datum in their own EXIF. The contract is deliberately narrow:
 *
 *   - EXIF ALWAYS WINS per-field. An override value is only ever used to fill a
 *     gap the file's own metadata left open (no capture date / no GPS).
 *   - The file is OPTIONAL. If it is absent, `loadOverrideFile` returns null.
 *   - If it is PRESENT but INVALID, the CLI must FAIL LOUDLY — an invalid
 *     override is thrown as an `OverrideValidationError`, never silently
 *     ignored. Silently dropping a malformed override would attach the wrong
 *     date/location to a user's photos, which is worse than refusing to run.
 *
 * This module only parses/validates/normalizes the file and computes the
 * effective per-file fallback. It performs NO uploads and knows nothing about
 * the sync engine — a later task wires it into the pipeline. `loadOverrideFile`
 * does its own fs read on every call (a caller-level cache wraps it); the
 * decision logic in `pickFallback` is a pure, never-throwing function.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { MediaMetadata } from './metadata.js';

// Re-export the relevant metadata surface for reference; `MediaMetadata`
// exposes `hasGps` and `capturedAt`, the two inputs `pickFallback` gates on.
export type { MediaMetadata };

/** The magic filename a user drops into a folder to override metadata. */
export const OVERRIDE_FILENAME = 'memoriahub.json';

/** A GPS location parsed from an override file. */
export interface OverrideLocation {
  latitude: number;
  longitude: number;
  /** Altitude in meters, or null when not supplied. */
  altitude: number | null;
}

/**
 * A normalized override entry. `capturedAt` has already been expanded to a full
 * ISO 8601 datetime string (see `normalizeCapturedAt`), or is null.
 */
export interface OverrideEntry {
  capturedAt: string | null;
  /** Signed minutes of the original UTC offset, or null when none was present
   * (date-only or offset-less inputs). */
  capturedAtOffset: number | null;
  location: OverrideLocation | null;
}

/** The parsed, validated, normalized contents of a `memoriahub.json` file. */
export interface FolderOverride {
  version: number;
  fallback: OverrideEntry | null;
  files: Array<{ name: string } & OverrideEntry>;
}

/**
 * Thrown when a present `memoriahub.json` is malformed. Carries the file path so
 * callers can surface exactly which folder's override is broken.
 */
export class OverrideValidationError extends Error {
  constructor(
    public filePath: string,
    reason: string,
  ) {
    super(`memoriahub.json invalid (${filePath}): ${reason}`);
    this.name = 'OverrideValidationError';
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_RE = /([+-]\d{2}:?\d{2}|Z)$/;

/**
 * Normalize a raw capturedAt string into a full ISO 8601 datetime plus the
 * signed UTC-offset minutes carried by the original (or null when none).
 *
 * - Date-only `YYYY-MM-DD` → LOCAL noon of that day (avoids date drift across
 *   time zones), offsetMinutes = null.
 * - Otherwise `Date.parse` must yield a finite timestamp; if the original
 *   string carried a `Z` or `±HH:MM` offset, that offset is reported in
 *   minutes (Z → 0). Throws a plain Error on unparseable input — the caller
 *   wraps it into an OverrideValidationError with context.
 */
export function normalizeCapturedAt(raw: string): { iso: string; offsetMinutes: number | null } {
  if (DATE_ONLY_RE.test(raw)) {
    const [y, m, d] = raw.split('-').map((p) => Number(p));
    const local = new Date(y, m - 1, d, 12, 0, 0, 0);
    if (isNaN(local.getTime())) {
      throw new Error(`unparseable capturedAt "${raw}"`);
    }
    return { iso: local.toISOString(), offsetMinutes: null };
  }

  const parsed = Date.parse(raw);
  if (!isFinite(parsed)) {
    throw new Error(`unparseable capturedAt "${raw}"`);
  }

  let offsetMinutes: number | null = null;
  const match = OFFSET_RE.exec(raw);
  if (match) {
    const token = match[1];
    if (token === 'Z') {
      offsetMinutes = 0;
    } else {
      const sign = token[0] === '-' ? -1 : 1;
      const digits = token.slice(1).replace(':', '');
      const hh = Number(digits.slice(0, 2));
      const mm = Number(digits.slice(2, 4));
      offsetMinutes = sign * (hh * 60 + mm);
    }
  }

  return { iso: new Date(parsed).toISOString(), offsetMinutes };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate + normalize an object's `capturedAt` / `location` fields into an
 * OverrideEntry. `where` labels the source ("fallback" or `files[i] "name"`)
 * for clear error messages. Throws a plain Error on violation.
 */
function parseEntry(source: Record<string, unknown>, where: string): OverrideEntry {
  let capturedAt: string | null = null;
  let capturedAtOffset: number | null = null;

  if (source.capturedAt !== undefined && source.capturedAt !== null) {
    if (typeof source.capturedAt !== 'string') {
      throw new Error(`${where}.capturedAt must be a string`);
    }
    try {
      const norm = normalizeCapturedAt(source.capturedAt);
      capturedAt = norm.iso;
      capturedAtOffset = norm.offsetMinutes;
    } catch (err) {
      throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let location: OverrideLocation | null = null;
  if (source.location !== undefined && source.location !== null) {
    if (!isPlainObject(source.location)) {
      throw new Error(`${where}.location must be an object`);
    }
    const loc = source.location;
    const lat = loc.latitude;
    const lng = loc.longitude;
    if (typeof lat !== 'number' || !isFinite(lat)) {
      throw new Error(`${where}.location.latitude is required and must be a number`);
    }
    if (typeof lng !== 'number' || !isFinite(lng)) {
      throw new Error(`${where}.location.longitude is required and must be a number`);
    }
    if (lat < -90 || lat > 90) {
      throw new Error(`${where}.location.latitude must be within [-90, 90]`);
    }
    if (lng < -180 || lng > 180) {
      throw new Error(`${where}.location.longitude must be within [-180, 180]`);
    }
    let altitude: number | null = null;
    if (loc.altitude !== undefined && loc.altitude !== null) {
      if (typeof loc.altitude !== 'number' || !isFinite(loc.altitude)) {
        throw new Error(`${where}.location.altitude must be a finite number`);
      }
      altitude = loc.altitude;
    }
    location = { latitude: lat, longitude: lng, altitude };
  }

  return { capturedAt, capturedAtOffset, location };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load and validate the `memoriahub.json` override in a folder.
 *
 * @param dir  Directory to look in.
 * @returns    The parsed FolderOverride, or null when no override file exists.
 * @throws     OverrideValidationError when the file exists but is unreadable,
 *             not valid JSON, or violates any rule in the format spec.
 */
export function loadOverrideFile(dir: string): FolderOverride | null {
  const filePath = path.join(dir, OVERRIDE_FILENAME);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new OverrideValidationError(
      filePath,
      `could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new OverrideValidationError(filePath, 'not valid JSON');
  }

  if (!isPlainObject(data)) {
    throw new OverrideValidationError(filePath, 'top-level value must be an object');
  }

  // version — required int, only 1 supported.
  const version = data.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new OverrideValidationError(filePath, 'version is required and must be an integer');
  }
  if (version !== 1) {
    throw new OverrideValidationError(filePath, `unsupported version ${version} (only 1 is supported)`);
  }

  // fallback — optional object.
  let fallback: OverrideEntry | null = null;
  if (data.fallback !== undefined && data.fallback !== null) {
    if (!isPlainObject(data.fallback)) {
      throw new OverrideValidationError(filePath, 'fallback must be an object');
    }
    try {
      fallback = parseEntry(data.fallback, 'fallback');
    } catch (err) {
      throw new OverrideValidationError(filePath, err instanceof Error ? err.message : String(err));
    }
  }

  // files — optional array.
  const files: Array<{ name: string } & OverrideEntry> = [];
  if (data.files !== undefined && data.files !== null) {
    if (!Array.isArray(data.files)) {
      throw new OverrideValidationError(filePath, 'files must be an array');
    }
    const seen = new Set<string>();
    data.files.forEach((raw, i) => {
      if (!isPlainObject(raw)) {
        throw new OverrideValidationError(filePath, `files[${i}] must be an object`);
      }
      const name = raw.name;
      if (typeof name !== 'string' || name.trim() === '') {
        throw new OverrideValidationError(filePath, `files[${i}].name is required and must be a non-empty string`);
      }
      if (seen.has(name)) {
        throw new OverrideValidationError(filePath, `duplicate files entry for name "${name}"`);
      }
      seen.add(name);
      let entry: OverrideEntry;
      try {
        entry = parseEntry(raw, `files[${i}] "${name}"`);
      } catch (err) {
        throw new OverrideValidationError(filePath, err instanceof Error ? err.message : String(err));
      }
      files.push({ name, ...entry });
    });
  }

  return { version, fallback, files };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** The subset of MediaMetadata `pickFallback` gates on. */
type MetaGate = Pick<MediaMetadata, 'hasGps' | 'capturedAt'>;

/** Fields `pickFallback` may contribute to fill EXIF gaps. */
export interface PickedFallback {
  capturedAt?: string;
  capturedAtOffset?: number;
  takenLat?: number;
  takenLng?: number;
  takenAltitude?: number;
}

/**
 * Compute the override values that apply to a single file, filling only the
 * gaps its own EXIF left open. Pure — never reads the filesystem, never throws.
 *
 * The effective entry is the folder `fallback` merged per-field with the
 * matching `files` entry (a `files` entry's present fields override the
 * fallback; absent fields inherit it). A value is contributed ONLY WHEN the
 * file lacks that datum:
 *   - capturedAt (and capturedAtOffset when non-null) only when the file has no
 *     EXIF capture date.
 *   - takenLat/takenLng (and takenAltitude when non-null) only when the file
 *     has no EXIF GPS.
 *
 * @param override  The folder override, or null (→ returns `{}`).
 * @param basename  The file's basename, matched against `files[].name`.
 * @param meta      The file's own metadata gate (hasGps + capturedAt).
 */
export function pickFallback(
  override: FolderOverride | null,
  basename: string,
  meta: MetaGate,
): PickedFallback {
  if (!override) {
    return {};
  }

  // Per-field merge: start from fallback, let a matching files entry override.
  const fileEntry = override.files.find((f) => f.name === basename);
  const capturedAt = fileEntry?.capturedAt ?? override.fallback?.capturedAt ?? null;
  const capturedAtOffset =
    fileEntry?.capturedAt != null
      ? fileEntry.capturedAtOffset
      : override.fallback?.capturedAt != null
        ? override.fallback.capturedAtOffset
        : null;
  const location = fileEntry?.location ?? override.fallback?.location ?? null;

  const result: PickedFallback = {};

  const fileHasDate = typeof meta.capturedAt === 'string' && meta.capturedAt.trim() !== '';
  if (!fileHasDate && capturedAt) {
    result.capturedAt = capturedAt;
    if (capturedAtOffset !== null) {
      result.capturedAtOffset = capturedAtOffset;
    }
  }

  if (meta.hasGps === false && location) {
    result.takenLat = location.latitude;
    result.takenLng = location.longitude;
    if (location.altitude !== null) {
      result.takenAltitude = location.altitude;
    }
  }

  return result;
}
