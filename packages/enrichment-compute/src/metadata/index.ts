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
 * exifr and fluent-ffmpeg are loaded lazily so importing this subpath is
 * always safe; ffprobe additionally requires the ffmpeg suite on PATH at
 * probe time (a host/deployment concern).
 */

import { nodeRequire } from '../node-require.cjs';
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
    const ts = new Date(Date.UTC(
      dto.getFullYear(), dto.getMonth(), dto.getDate(),
      dto.getHours(), dto.getMinutes(), dto.getSeconds(), ms,
    ));
    metadata['capturedAt'] = ts.toISOString();
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
 * Minimal structural view of fluent-ffmpeg's FfprobeData — declared locally so
 * the public .d.ts never forces consumers to install @types/fluent-ffmpeg.
 * The real FfprobeData is structurally assignable to this shape.
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

type FfmpegModule = {
  ffprobe: (filePath: string, cb: (err: unknown, data: FfprobeDataLike) => void) => void;
};

function loadFfmpeg(): FfmpegModule {
  try {
    const mod = nodeRequire('fluent-ffmpeg') as FfmpegModule & { default?: FfmpegModule };
    return typeof mod.ffprobe === 'function' ? mod : (mod.default as FfmpegModule);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Video probe compute requires the dependency fluent-ffmpeg, which could not be loaded: ${msg}`,
    );
  }
}

/**
 * Run ffprobe against a seekable file path.
 *
 * ffprobe requires a real file path (it seeks), so callers must have already
 * materialized the video bytes to disk (see VideoProbeProcessor's temp-file
 * handling).
 */
export function probeVideoFile(filePath: string): Promise<FfprobeDataLike> {
  const ffmpeg = loadFfmpeg();
  return new Promise<FfprobeDataLike>((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

/**
 * Run ffprobe with an upper bound on runtime.  ffprobe has no built-in timeout
 * and can hang on corrupt/truncated containers; the race guarantees the caller
 * settles.  NOTE: the underlying ffprobe process is not killed on timeout —
 * fluent-ffmpeg's ffprobe API exposes no process handle — but an orphaned probe
 * exits on its own once it finishes reading the input.
 *
 * `ffprobeTimeoutMs` defaults to 30 000 ms (the API's FFPROBE_TIMEOUT_MS
 * default); pass an explicit value to override.
 */
export function probeVideo(
  filePath: string,
  opts?: { ffprobeTimeoutMs?: number },
): Promise<FfprobeDataLike> {
  const timeoutMs = opts?.ffprobeTimeoutMs ?? 30000;
  return new Promise<FfprobeDataLike>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`ffprobe timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    probeVideoFile(filePath)
      .then(data => {
        clearTimeout(timer);
        resolve(data);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
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
