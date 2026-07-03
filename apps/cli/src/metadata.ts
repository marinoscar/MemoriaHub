/**
 * metadata.ts — Client-side media metadata reader for the scan (dry-run) flow.
 *
 * Analogous to hash.ts: a small, dependency-light helper the ScanEngine calls
 * per file.  Its primary job is answering the two questions the scan report is
 * built around — "does this photo have EXIF?" and "is there GPS location inside
 * that EXIF?" — cheaply, by reading only the file header via exifr.
 *
 * The remaining fields (capturedAt, dimensions, camera make/model, coordinates)
 * come for free from the same exifr parse and are surfaced only in the Excel
 * detail sheet as bonus analysis columns.
 *
 * This function NEVER throws.  Any failure (unreadable file, corrupt EXIF,
 * unsupported container) is captured in the returned `error` field so a single
 * bad file can never abort a scan — mirroring the defensive posture of
 * enumerateFiles().
 */

import type { MediaKind } from './db/types.js';

// exifr ships ES-module and CJS builds; use dynamic import so both resolve.
type ExifrModule = {
  parse: (src: string, opts?: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
};

let _exifr: ExifrModule | null = null;
async function getExifr(): Promise<ExifrModule> {
  if (_exifr) return _exifr;
  const mod = await import('exifr');
  // exifr's default export is the object exposing parse().
  _exifr = (mod.default ?? mod) as unknown as ExifrModule;
  return _exifr;
}

export interface MediaMetadata {
  /** Photo vs. video, derived from the MIME type. */
  mediaKind: MediaKind;
  /** True when the file carried any EXIF/TIFF/GPS tags. */
  hasExif: boolean;
  /** True when EXIF contained usable GPS latitude + longitude. */
  hasGps: boolean;
  /** ISO 8601 capture timestamp (DateTimeOriginal / CreateDate), or null. */
  capturedAt: string | null;
  width: number | null;
  height: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  takenLat: number | null;
  takenLng: number | null;
  /** Non-null when metadata extraction failed for this file. */
  error: string | null;
}

function emptyMetadata(kind: MediaKind, error: string | null = null): MediaMetadata {
  return {
    mediaKind: kind,
    hasExif: false,
    hasGps: false,
    capturedAt: null,
    width: null,
    height: null,
    cameraMake: null,
    cameraModel: null,
    takenLat: null,
    takenLng: null,
    error,
  };
}

function toIso(value: unknown): string | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.toISOString();
  }
  return null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && isFinite(value) ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Read lightweight metadata for a media file.
 *
 * @param filePath  Absolute path to the file.
 * @param mimeType  MIME type resolved from the file extension (see files.ts).
 * @returns  A MediaMetadata object.  Never rejects; failures populate `error`.
 */
export async function readMediaMetadata(
  filePath: string,
  mimeType: string,
): Promise<MediaMetadata> {
  const kind: MediaKind = mimeType.startsWith('video/') ? 'video' : 'photo';

  // Videos: classify + size only. No ffmpeg probe (see plan / spec).
  // TODO(video-probe): optionally probe duration/resolution/codec via ffmpeg.
  if (kind === 'video') {
    return emptyMetadata('video');
  }

  try {
    const exifr = await getExifr();
    const raw = await exifr
      .parse(filePath, {
        tiff: true,
        exif: true,
        gps: true,
        ifd0: true,
        mergeOutput: true,
        translateValues: false,
        reviveValues: true,
        sanitize: true,
      })
      .catch((e: unknown) => {
        // Re-throw genuine I/O errors (missing/unreadable/dir) so they surface
        // in the `error` field per this module's contract; treat a parse failure
        // on a readable-but-unsupported/no-EXIF file as simply "no EXIF".
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code && ['ENOENT', 'EACCES', 'EISDIR', 'EPERM', 'ENOTDIR'].includes(code)) {
          throw e;
        }
        return undefined;
      });

    // No EXIF at all (screenshots, web graphics, stripped files) — normal.
    if (!raw || Object.keys(raw).length === 0) {
      return emptyMetadata('photo');
    }

    const lat = numOrNull(raw['latitude'] ?? raw['GPSLatitude']);
    const lng = numOrNull(raw['longitude'] ?? raw['GPSLongitude']);
    const capturedAt =
      toIso(raw['DateTimeOriginal']) ??
      toIso(raw['CreateDate']) ??
      toIso(raw['ModifyDate']);

    return {
      mediaKind: 'photo',
      hasExif: true,
      hasGps: lat !== null && lng !== null,
      capturedAt,
      width: numOrNull(raw['ExifImageWidth'] ?? raw['ImageWidth']),
      height: numOrNull(raw['ExifImageHeight'] ?? raw['ImageHeight']),
      cameraMake: strOrNull(raw['Make']),
      cameraModel: strOrNull(raw['Model']),
      takenLat: lat,
      takenLng: lng,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return emptyMetadata('photo', message);
  }
}
