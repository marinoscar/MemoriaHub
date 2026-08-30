/**
 * Metadata-extraction compute cores (moved from
 * apps/api/src/storage/processing/processors/{exif.processor,
 * image-dimensions.processor}.ts and .../ffprobe.util.ts).
 *
 * This module holds ONLY the pure halves of the exif / dimensions /
 * video-probe processors: EXIF field extraction, orientation-corrected pixel
 * dimensions, and ffprobe invocation + container-metadata normalization.
 * The ObjectProcessor classes (stream handling, temp files, logging, env
 * reads, Prisma types) stay in the API and delegate here, so a distributed
 * worker node extracts EXACTLY the same values as the server for the same
 * bytes (docs/specs/distributed-nodes.md §7).
 *
 * exifr is loaded lazily and ffprobe is spawned through the package's own
 * thin wrapper (../ffmpeg/index.js — see issue #219, which removed the
 * deprecated fluent-ffmpeg dependency), so importing this subpath is always
 * safe; ffprobe additionally requires the ffmpeg suite on PATH at probe time
 * (a host/deployment concern).
 */

import { runFfprobe } from '../ffmpeg/index.js';
import { getOrientedDimensions } from '../image/index.js';

// =============================================================================
// EXIF
// =============================================================================

type ExifrModule = {
  parse: (src: Buffer, opts?: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
};

async function getExifr(): Promise<ExifrModule> {
  // Dynamic import handles both ESM and CJS environments
  const mod = await import('exifr');
  // exifr default export is the parse function itself in some builds
  return (mod.default ?? mod) as unknown as ExifrModule;
}

/**
 * Parse an EXIF offset string like "+05:30" or "-06:00" into minutes.
 * Returns null if the value cannot be parsed.
 */
export function parseExifOffsetToMinutes(offset: string): number | null {
  const match = /^([+-])(\d{1,2}):(\d{2})$/.exec(offset.trim());
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3], 10);
  return sign * (hours * 60 + minutes);
}

/**
 * Re-encode a wall clock as a CIVIL timestamp: the components exactly as
 * written, stamped `Z`.
 *
 * This is the single definition of how a capture time becomes the value stored
 * in `media_items.captured_at` (see `docs/specs/date-model.md`). Photos went
 * through this shape from the start; video ingest did not, and stored a real
 * instant in the same column instead, so a video and a photo taken a minute
 * apart could land on different days (issue #443). One helper, so the two
 * paths cannot drift — and so both executors (the API and a worker node)
 * produce byte-identical values.
 */
export function wallClockToCivilTimestamp(parts: {
  year: number;
  month: number; // 1-12, NOT the JS 0-11 index
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms?: number;
}): string {
  return new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      parts.ms ?? 0,
    ),
  ).toISOString();
}

/**
 * Container tags that may carry a capture time, most reliable first.
 *
 * `com.apple.quicktime.creationdate` is the one that actually solves the
 * problem: Apple writes the local wall clock *plus* its true offset
 * (`2026-06-20T20:16:07-0600`). `date` is the equivalent written by several
 * other vendors. `creation_time` is listed last because MP4/MOV spec it as
 * UTC, so it usually carries no local information at all.
 */
const VIDEO_CREATION_TAGS = [
  'com.apple.quicktime.creationdate',
  'date',
  'creation_time',
] as const;

/**
 * An ISO-ish datetime with an EXPLICIT numeric UTC offset — the only form that
 * lets us recover the wall clock at capture. `Z` is deliberately not matched:
 * it means "this is UTC", which is an instant with the local time discarded.
 */
const OFFSET_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?\s*([+-])(\d{2}):?(\d{2})$/;

export interface VideoCaptureTimestamp {
  /** Civil timestamp for `media_items.captured_at`. */
  capturedAt: string;
  /** True UTC offset in minutes, when the container stated one. */
  capturedAtOffset?: number;
  /**
   * How it was derived:
   *  - `wall_clock` — a tag carried the local time and its offset (correct).
   *  - `instant`    — only a UTC instant was available, so `capturedAt` is NOT
   *                   civil and the item may bucket on the neighbouring day.
   *                   Unknowable, not guessable: inventing a zone (the
   *                   server's, the owner's) would be worse than a
   *                   known-imperfect value. Hosts log this so the residual
   *                   gap stays measurable.
   */
  source: 'wall_clock' | 'instant';
  /** Which container tag supplied the value. */
  tag: string;
}

/**
 * Derive a capture timestamp from a video container's tags (issue #443).
 *
 * `tags` is the merged, lower-cased tag map from ffprobe (format tags first,
 * then the video stream's). Returns `undefined` when no tag parses.
 */
export function parseVideoCaptureTimestamp(
  tags: Record<string, unknown>,
): VideoCaptureTimestamp | undefined {
  // Tier 1 — a tag carrying local time AND its offset.
  for (const tag of VIDEO_CREATION_TAGS) {
    const raw = tags[tag];
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;

    const m = OFFSET_DATETIME_RE.exec(raw.trim());
    if (!m) continue;

    const [, y, mo, d, h, mi, sec, frac, sign, offH, offM] = m;
    const ms = frac ? Math.round(parseFloat(`0.${frac}`) * 1000) : 0;
    const offsetMinutes =
      (sign === '-' ? -1 : 1) * (parseInt(offH, 10) * 60 + parseInt(offM, 10));

    return {
      capturedAt: wallClockToCivilTimestamp({
        year: Number(y),
        month: Number(mo),
        day: Number(d),
        hour: Number(h),
        minute: Number(mi),
        second: Number(sec),
        ms,
      }),
      capturedAtOffset: offsetMinutes,
      source: 'wall_clock',
      tag,
    };
  }

  // Tier 2 — a bare instant plus an offset stated by some OTHER tag. Rare, but
  // free: applying a known offset to a known instant recovers the wall clock.
  const offsetFromTags = findOffsetMinutes(tags);

  // Tier 3 — an instant with no offset anywhere. Kept as-is.
  for (const tag of VIDEO_CREATION_TAGS) {
    const raw = tags[tag];
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;

    const parsed = new Date(raw.trim());
    if (isNaN(parsed.getTime())) continue;

    if (offsetFromTags !== null) {
      const shifted = new Date(parsed.getTime() + offsetFromTags * 60_000);
      return {
        capturedAt: wallClockToCivilTimestamp({
          year: shifted.getUTCFullYear(),
          month: shifted.getUTCMonth() + 1,
          day: shifted.getUTCDate(),
          hour: shifted.getUTCHours(),
          minute: shifted.getUTCMinutes(),
          second: shifted.getUTCSeconds(),
          ms: shifted.getUTCMilliseconds(),
        }),
        capturedAtOffset: offsetFromTags,
        source: 'wall_clock',
        tag,
      };
    }

    return { capturedAt: parsed.toISOString(), source: 'instant', tag };
  }

  return undefined;
}

/** Tags that sometimes state a UTC offset on their own. */
const OFFSET_ONLY_TAGS = ['com.apple.quicktime.creationdate', 'date', 'time_offset'] as const;

function findOffsetMinutes(tags: Record<string, unknown>): number | null {
  for (const tag of OFFSET_ONLY_TAGS) {
    const raw = tags[tag];
    if (typeof raw !== 'string') continue;
    const m = /([+-])(\d{2}):?(\d{2})$/.exec(raw.trim());
    if (!m) continue;
    return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
  }
  return null;
}

/**
 * Extract EXIF metadata from an image buffer.
 *
 * Extracted fields (missing fields are omitted — never written as null):
 *   capturedAt        — DateTimeOriginal as ISO 8601 UTC string
 *   capturedAtOffset  — UTC offset in minutes at capture time (from OffsetTimeOriginal)
 *   latitude          — GPS latitude (decimal)
 *   longitude         — GPS longitude (decimal)
 *   altitude          — GPS altitude in metres
 *   cameraMake        — EXIF Make
 *   cameraModel       — EXIF Model
 *   orientation       — EXIF Orientation tag (1–8)
 *   burstUuid         — Apple BurstUUID from EXIF MakerNote
 *
 * Returns {} when the image carries no EXIF data (normal for screenshots,
 * web graphics, etc.). Decode/parse ERRORS propagate to the caller — the
 * host processor owns the never-throws success/failure envelope.
 */
export async function extractExif(buffer: Buffer): Promise<Record<string, unknown>> {
  const exifr = await getExifr();

  const raw = await exifr.parse(buffer, {
    tiff: true,
    exif: true,
    gps: true,
    ifd0: true,
    makerNote: true,
    mergeOutput: true,
    translateValues: false,
    reviveValues: true,
    sanitize: true,
  }).catch(() => undefined);

  if (!raw) {
    // No EXIF data present — normal for screenshots, web graphics, etc.
    return {};
  }

  const metadata: Record<string, unknown> = {};

  // Captured timestamp
  const dto = raw['DateTimeOriginal'];
  if (dto instanceof Date) {
    let ms = 0;
    const subSec = raw['SubSecTimeOriginal'];
    if (typeof subSec === 'string' && subSec.trim()) {
      const trimmed = subSec.trim().replace(/^\./, '');
      const frac = parseFloat('0.' + trimmed);
      if (!isNaN(frac)) ms = Math.round(frac * 1000);
    }
    // Rebuild the timestamp from local-getter wall-clock components as UTC so
    // the result is timezone-deterministic. EXIF DateTimeOriginal is tz-naive
    // (e.g. "2026:06:20 20:16:07"); exifr parses it using the process's local
    // timezone, so dto.getTime() varies by server TZ. The local getters
    // (getFullYear/getMonth/…) always reflect the original wall-clock digits, so
    // we re-encode them as UTC. On the production UTC container this produces
    // the same value as before; on a non-UTC host it now produces the correct
    // wall-clock UTC instead of an offset-shifted instant.
    // The real capture-time offset is preserved separately in capturedAtOffset.
    metadata['capturedAt'] = wallClockToCivilTimestamp({
      year: dto.getFullYear(),
      month: dto.getMonth() + 1,
      day: dto.getDate(),
      hour: dto.getHours(),
      minute: dto.getMinutes(),
      second: dto.getSeconds(),
      ms,
    });
  }

  // UTC offset (stored as "+HH:MM" / "-HH:MM" or numeric minutes)
  const offsetRaw = raw['OffsetTimeOriginal'] ?? raw['OffsetTime'];
  if (typeof offsetRaw === 'string') {
    const minutes = parseExifOffsetToMinutes(offsetRaw);
    if (minutes !== null) metadata['capturedAtOffset'] = minutes;
  }

  // GPS
  const lat = raw['latitude'] ?? raw['GPSLatitude'];
  const lng = raw['longitude'] ?? raw['GPSLongitude'];
  const alt = raw['altitude'] ?? raw['GPSAltitude'];

  if (typeof lat === 'number') metadata['latitude'] = lat;
  if (typeof lng === 'number') metadata['longitude'] = lng;
  if (typeof alt === 'number') metadata['altitude'] = alt;

  // Camera info
  const make = raw['Make'];
  const model = raw['Model'];
  const orientation = raw['Orientation'];

  if (typeof make === 'string' && make.trim()) metadata['cameraMake'] = make.trim();
  if (typeof model === 'string' && model.trim()) metadata['cameraModel'] = model.trim();
  if (typeof orientation === 'number') metadata['orientation'] = orientation;

  // BurstUUID (Apple MakerNote)
  const burstUuid =
    (raw['BurstUUID'] as string | undefined) ??
    ((raw['MakerNote'] as Record<string, unknown> | undefined)?.['BurstUUID'] as string | undefined);
  if (typeof burstUuid === 'string' && burstUuid.trim()) {
    metadata['burstUuid'] = burstUuid.trim();
  }

  return metadata;
}

// =============================================================================
// Dimensions
// =============================================================================

/**
 * Extract the display-oriented pixel dimensions of an image (EXIF orientation
 * applied: width/height are swapped for 90°/270° rotations).
 *
 * Thin alias over /image's getOrientedDimensions — ONE implementation — kept
 * here so the metadata subpath exposes the complete extraction surface.
 * Returns null when dimensions cannot be determined.
 */
export async function extractDimensions(
  buffer: Buffer,
): Promise<{ width: number; height: number } | null> {
  return getOrientedDimensions(buffer);
}

// =============================================================================
// Video probe (ffprobe)
// =============================================================================

/**
 * Maximum serialized (JSON) size, in bytes, allowed for the container tag
 * collections we persist into storage_object metadata. Keeps ffprobe tag dumps
 * from bloating the JSONB column; excess keys are dropped once the budget is
 * exceeded.
 */
const MAX_TAGS_SERIALIZED_BYTES = 4096;

/**
 * Minimal structural view of ffprobe's `-show_streams -show_format` result.
 *
 * Declared locally — and kept deliberately loose — so the public .d.ts never
 * exposes an ffprobe-parser type from elsewhere in the package (it historically
 * existed so consumers never needed `@types/fluent-ffmpeg`; that property is
 * preserved now that the parser is in-house).
 */
export interface FfprobeStreamLike {
  codec_type?: string | undefined;
  codec_name?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  tags?: Record<string, unknown> | undefined;
}

export interface FfprobeDataLike {
  streams?: FfprobeStreamLike[] | undefined;
  format?:
    | {
        duration?: number | string | undefined;
        format_name?: string | undefined;
        tags?: Record<string, unknown> | undefined;
      }
    | undefined;
}

/**
 * Normalized container metadata shape shared by the video-probe processor and
 * the social-media detection backfill path.
 */
export interface ContainerMetadata {
  formatName?: string;
  formatTags: Record<string, string>;
  streamTags: Array<Record<string, string>>;
  durationMs?: number;
  width?: number;
  height?: number;
  codec?: string;
}

/**
 * Run ffprobe against a seekable file path.
 *
 * ffprobe requires a real file path (it seeks), so callers must have already
 * materialized the video bytes to disk (see VideoProbeProcessor's temp-file
 * handling).
 *
 * Unbounded — use {@link probeVideo} when a timeout is wanted.
 */
export async function probeVideoFile(filePath: string): Promise<FfprobeDataLike> {
  return (await runFfprobe(filePath)) as unknown as FfprobeDataLike;
}

/**
 * Run ffprobe with an upper bound on runtime. ffprobe has no built-in timeout
 * and can hang on corrupt/truncated containers.
 *
 * The hung ffprobe process IS killed (SIGKILL) when the timeout fires. This is
 * an improvement over the previous fluent-ffmpeg implementation, whose
 * callback-only `ffprobe()` API exposed no process handle — that version could
 * only race a timer and leave the probe orphaned until it finished reading the
 * input on its own (issue #219).
 *
 * `ffprobeTimeoutMs` defaults to 30 000 ms (the API's FFPROBE_TIMEOUT_MS
 * default); pass an explicit value to override.
 */
export async function probeVideo(
  filePath: string,
  opts?: { ffprobeTimeoutMs?: number },
): Promise<FfprobeDataLike> {
  const timeoutMs = opts?.ffprobeTimeoutMs ?? 30000;
  const data = await runFfprobe(filePath, {
    timeoutMs,
    timeoutMessage: `ffprobe timed out after ${timeoutMs}ms`,
  });
  return data as unknown as FfprobeDataLike;
}

/**
 * Lowercase every key and string-coerce every value of a raw ffprobe tag bag.
 * Undefined/null inputs yield an empty object. Nullish values are skipped.
 */
function normalizeTags(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

/**
 * Trim a tag object so its JSON serialization stays within
 * MAX_TAGS_SERIALIZED_BYTES. Keys are dropped (insertion order) until the
 * budget is met. Returns a possibly-smaller copy.
 */
function capTagObjectSize(tags: Record<string, string>): Record<string, string> {
  if (Buffer.byteLength(JSON.stringify(tags), 'utf8') <= MAX_TAGS_SERIALIZED_BYTES) {
    return tags;
  }
  const capped: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    const candidate = { ...capped, [key]: value };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_TAGS_SERIALIZED_BYTES) {
      break;
    }
    capped[key] = value;
  }
  return capped;
}

/**
 * Trim an array of per-stream tag objects so the whole array's JSON
 * serialization stays within MAX_TAGS_SERIALIZED_BYTES. Whole entries are
 * dropped (in order) once the budget is exceeded.
 */
function capStreamTagsSize(
  streamTags: Array<Record<string, string>>,
): Array<Record<string, string>> {
  if (Buffer.byteLength(JSON.stringify(streamTags), 'utf8') <= MAX_TAGS_SERIALIZED_BYTES) {
    return streamTags;
  }
  const capped: Array<Record<string, string>> = [];
  for (const entry of streamTags) {
    const candidate = [...capped, entry];
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_TAGS_SERIALIZED_BYTES) {
      break;
    }
    capped.push(entry);
  }
  return capped;
}

/**
 * Build the normalized ContainerMetadata shape from a raw ffprobe result.
 *
 * Defensive against missing streams/format/tags. formatTags and per-stream
 * streamTags have lowercased keys and string-coerced values, and are size-capped
 * to avoid bloating storage_object metadata. durationMs/width/height/codec mirror
 * the values the video-probe processor already persists.
 */
export function extractContainerMetadata(data: FfprobeDataLike): ContainerMetadata {
  const streams = data.streams ?? [];
  const videoStream = streams.find(s => s.codec_type === 'video');

  const durationSec = data.format?.duration;
  const durationMs =
    durationSec !== undefined ? Math.round(parseFloat(String(durationSec)) * 1000) : undefined;

  const width = typeof videoStream?.width === 'number' ? videoStream.width : undefined;
  const height = typeof videoStream?.height === 'number' ? videoStream.height : undefined;
  const codec = typeof videoStream?.codec_name === 'string' ? videoStream.codec_name : undefined;

  const formatName =
    typeof data.format?.format_name === 'string' ? data.format.format_name : undefined;

  const formatTags = capTagObjectSize(normalizeTags(data.format?.tags));

  const streamTags = capStreamTagsSize(
    streams
      .map(s => normalizeTags((s as { tags?: unknown }).tags))
      .filter(t => Object.keys(t).length > 0),
  );

  return { formatName, formatTags, streamTags, durationMs, width, height, codec };
}
