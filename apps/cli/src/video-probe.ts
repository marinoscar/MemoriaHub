/**
 * video-probe.ts — ffprobe-based capture-date + GPS reader for video files.
 *
 * exifr (used for photos in metadata.ts) cannot read QuickTime/MP4 container
 * metadata, so the `organize` command historically bucketed every video into
 * NODATE.  This module fills that gap by shelling out to `ffprobe` (which ships
 * with ffmpeg) and parsing the container tags for a creation date and location.
 *
 * Uses Node built-ins only (child_process) — ffprobe is a runtime binary, NOT an
 * npm dependency.  When ffprobe is absent the reader degrades gracefully to
 * `{ capturedAt: null, hasGps: false }` (i.e. the pre-existing NODATE behavior),
 * so `organize` still runs offline on hosts without ffmpeg installed.
 *
 * This module NEVER throws — every failure path resolves to nulls, mirroring the
 * defensive posture of metadata.ts.
 */

import { execFile } from 'node:child_process';

// ---------------------------------------------------------------------------
// ffprobe availability detection (memoized per process)
// ---------------------------------------------------------------------------

let cachedProbeAvailable: Promise<boolean> | null = null;

/**
 * Detect whether `ffprobe` is runnable on the PATH by invoking `ffprobe
 * -version`.  Never throws — resolves `false` on ENOENT or a non-zero exit.
 * Memoized for the lifetime of the process so a probe-less host never spawns a
 * failing subprocess per video.
 */
export function detectFfprobe(bin = 'ffprobe'): Promise<boolean> {
  if (cachedProbeAvailable) return cachedProbeAvailable;

  cachedProbeAvailable = new Promise<boolean>((resolve) => {
    execFile(bin, ['-version'], { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });

  return cachedProbeAvailable;
}

/** Reset the memoized detection result (test-only). */
export function _resetProbeCache(): void {
  cachedProbeAvailable = null;
}

// ---------------------------------------------------------------------------
// ffprobe invocation
// ---------------------------------------------------------------------------

/** Shape of the slice of ffprobe's JSON output we care about. */
interface FfprobeJson {
  format?: { tags?: Record<string, unknown> };
  streams?: Array<{ tags?: Record<string, unknown> }>;
}

/**
 * Run `ffprobe` on a file and return the merged container/stream tag map, or
 * `null` on any failure.  Format-level tags take precedence over stream-level
 * tags (Apple writes the authoritative `creationdate`/`ISO6709` at the format
 * level).  Never throws.
 */
async function runFfprobe(
  filePath: string,
  bin = 'ffprobe',
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    execFile(
      bin,
      [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout)) as FfprobeJson;
          const merged: Record<string, unknown> = {};
          // Stream tags first so format tags override them on key collisions.
          for (const stream of parsed.streams ?? []) {
            Object.assign(merged, stream.tags ?? {});
          }
          Object.assign(merged, parsed.format?.tags ?? {});
          resolve(merged);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Pure parsing helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Case-insensitive lookup of the first present, non-empty string tag. */
function firstStringTag(tags: Record<string, unknown>, keys: string[]): string | null {
  const lowered = new Map<string, unknown>();
  for (const [k, v] of Object.entries(tags)) lowered.set(k.toLowerCase(), v);
  for (const key of keys) {
    const v = lowered.get(key.toLowerCase());
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * Parse a container creation timestamp into a LOCAL-time `Date` built from its
 * wall-clock digits, so `organize`'s local-getter bucketing lands the video in
 * the month it was actually recorded.
 *
 * Mirrors the photo path's philosophy (metadata.ts `exifDateToIso`): the digits
 * are used verbatim rather than being reinterpreted through the host timezone.
 * Apple's `com.apple.quicktime.creationdate` carries a real UTC offset, so its
 * leading digits already express local capture time; the generic `creation_time`
 * tag is UTC, so near a midnight boundary its bucket can be off by the offset —
 * an accepted approximation, still far better than NODATE.
 *
 * Returns `null` for an unparseable or sentinel-zero timestamp.
 */
export function parseContainerDate(value: string | null): Date | null {
  if (!value) return null;
  const m = value
    .trim()
    .match(/^(\d{4})[:\-/](\d{2})[:\-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (y === '0000' || mo === '00' || d === '00') return null;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Does an ISO 6709 location string (e.g. `+37.7749-122.4194+000.000/`) contain a
 * parseable latitude+longitude pair?  Returns true when both a signed lat and a
 * signed lng are present (matching the photo path, which counts 0,0 as present).
 */
export function iso6709HasCoords(value: string | null): boolean {
  if (!value) return false;
  return /[+-]\d+(?:\.\d+)?[+-]\d+(?:\.\d+)?/.test(value.trim());
}

/**
 * Extract `{ capturedAt, hasGps }` from a merged ffprobe tag map.  Pure and
 * synchronous — the subprocess concern lives in `readVideoPlacement`.
 */
export function parseVideoPlacement(
  tags: Record<string, unknown>,
): { capturedAt: Date | null; hasGps: boolean } {
  const dateStr =
    firstStringTag(tags, ['com.apple.quicktime.creationdate']) ??
    firstStringTag(tags, ['creation_time', 'date']);
  const capturedAt = parseContainerDate(dateStr);

  const loc = firstStringTag(tags, [
    'com.apple.quicktime.location.iso6709',
    'location',
    'location-eng',
  ]);
  const hasGps = iso6709HasCoords(loc);

  return { capturedAt, hasGps };
}

// ---------------------------------------------------------------------------
// Public reader
// ---------------------------------------------------------------------------

/**
 * Read a video's capture date + GPS presence via ffprobe, for the `organize`
 * command's date/GPS bucketing.  Returns a LOCAL-time `Date` (or null) and a GPS
 * boolean, matching the shape of metadata.ts `readExifPlacement`.
 *
 * Degrades to `{ capturedAt: null, hasGps: false }` when ffprobe is unavailable
 * or the file carries no usable metadata.  Never throws.
 *
 * @param filePath  Absolute path to the video file.
 * @param opts      `bin` overrides the ffprobe binary (for tests).
 */
export async function readVideoPlacement(
  filePath: string,
  opts?: { bin?: string },
): Promise<{ capturedAt: Date | null; hasGps: boolean }> {
  const bin = opts?.bin ?? 'ffprobe';
  if (!(await detectFfprobe(bin))) {
    return { capturedAt: null, hasGps: false };
  }
  const tags = await runFfprobe(filePath, bin);
  if (!tags) return { capturedAt: null, hasGps: false };
  return parseVideoPlacement(tags);
}
