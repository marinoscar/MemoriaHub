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

import * as fs from 'node:fs';

import type { MediaKind, CaptureDateSource } from './db/types.js';

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

/**
 * Read ONLY the EXIF capture date of a media file, returned as a raw `Date`.
 *
 * Used by the `organize` command, which buckets files by their recorded
 * local-time capture date and therefore needs the naive wall-clock `Date`
 * object rather than an ISO string.
 *
 * Videos always resolve to `null` (the CLI never probes video metadata), so
 * they land in the `NODATE/` bucket — matching the behavior of readMediaMetadata.
 *
 * When `opts.full` is true, exifr is told to read the ENTIRE file
 * (`chunked: false`) rather than just the header, so a capture date recorded
 * deep in the file is never missed.  This is the explicit requirement of the
 * organize flow, which trades a little speed for correctness.
 *
 * Never throws: any parse failure, missing tags, or genuine I/O error
 * (ENOENT/EACCES/EISDIR/EPERM/ENOTDIR) resolves to `null`.
 *
 * @param filePath  Absolute path to the file.
 * @param mimeType  MIME type resolved from the file extension (see files.ts).
 * @param opts      `full: true` reads the whole file instead of just the header.
 */
export async function readExifCaptureDate(
  filePath: string,
  mimeType: string,
  opts?: { full?: boolean },
): Promise<Date | null> {
  // Videos: no EXIF capture date (no ffmpeg probe) — always NODATE.
  if (mimeType.startsWith('video/')) {
    return null;
  }

  try {
    const exifr = await getExifr();
    const parseOpts: Record<string, unknown> = {
      tiff: true,
      exif: true,
      gps: true,
      ifd0: true,
      mergeOutput: true,
      translateValues: false,
      reviveValues: true,
      sanitize: true,
    };
    // Full read: force exifr to scan the entire file, not just the header, so a
    // capture date buried deep in the file is still found.
    if (opts?.full) {
      parseOpts['chunked'] = false;
    }

    const raw = await exifr.parse(filePath, parseOpts).catch((e: unknown) => {
      // Swallow parse failures on readable-but-unsupported/no-EXIF files; treat
      // genuine I/O errors the same way (return null) rather than throwing — the
      // organize flow must never abort on a single bad file.
      void e;
      return undefined;
    });

    if (!raw || Object.keys(raw).length === 0) {
      return null;
    }

    const value =
      raw['DateTimeOriginal'] ?? raw['CreateDate'] ?? raw['ModifyDate'];
    if (value instanceof Date && !isNaN(value.getTime())) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Capture-date inference from filesystem timestamps
// ---------------------------------------------------------------------------

export interface ResolvedCaptureDate {
  /** Best capture timestamp (ISO 8601): EXIF when present, else oldest file stamp. */
  capturedAt: string | null;
  /** Where `capturedAt` came from. */
  source: CaptureDateSource;
  /** The file's creation time (birthtime, ISO 8601) for provenance, or null. */
  originalCreatedAt: string | null;
}

/**
 * Read a file's filesystem timestamps and return both the OLDEST of
 * created (birthtime) / modified (mtime) / accessed (atime), and the birthtime
 * on its own.
 *
 * Picking the oldest is deliberate: copying or moving files bumps some stamps to
 * "now", so the oldest surviving stamp is the best guess at the true original
 * date.  Values that are non-finite, `<= 0` (some filesystems report an unknown
 * birthtime as the epoch), or absurdly in the future (clock skew) are ignored.
 *
 * Never throws — a missing/unreadable file yields `{ oldestIso: null, birthtimeIso: null }`.
 */
export function oldestFileTimestamp(
  filePath: string,
): { oldestIso: string | null; birthtimeIso: string | null } {
  try {
    const st = fs.statSync(filePath);
    const maxValid = Date.now() + 24 * 60 * 60 * 1000; // now + 24h skew guard
    const valid = (ms: number): boolean =>
      typeof ms === 'number' && isFinite(ms) && ms > 0 && ms <= maxValid;

    const candidates = [st.birthtimeMs, st.mtimeMs, st.atimeMs].filter(valid);
    const oldestIso = candidates.length
      ? new Date(Math.min(...candidates)).toISOString()
      : null;
    const birthtimeIso = valid(st.birthtimeMs)
      ? new Date(st.birthtimeMs).toISOString()
      : null;
    return { oldestIso, birthtimeIso };
  } catch {
    return { oldestIso: null, birthtimeIso: null };
  }
}

/**
 * Resolve the best capture date for a media file: the EXIF date taken when
 * present, otherwise the oldest of the file's created/modified/accessed stamps.
 *
 * @param filePath        Absolute path to the file.
 * @param mimeType        MIME type resolved from the extension.
 * @param exifCapturedAt  Optional pre-parsed EXIF capture date (ISO 8601 | null).
 *                        Pass it from a prior `readMediaMetadata` call (e.g. the
 *                        scan path) to avoid a second exifr parse; omit it and
 *                        this function reads EXIF itself.
 */
export async function resolveCapturedAt(
  filePath: string,
  mimeType: string,
  exifCapturedAt?: string | null,
): Promise<ResolvedCaptureDate> {
  let exif = exifCapturedAt;
  if (exif === undefined) {
    exif = (await readMediaMetadata(filePath, mimeType)).capturedAt;
  }

  const { oldestIso, birthtimeIso } = oldestFileTimestamp(filePath);

  if (exif) {
    return { capturedAt: exif, source: 'exif', originalCreatedAt: birthtimeIso };
  }
  return {
    capturedAt: oldestIso,
    source: oldestIso ? 'file' : 'none',
    originalCreatedAt: birthtimeIso,
  };
}
