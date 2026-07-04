import * as ffmpeg from 'fluent-ffmpeg';

/**
 * Shared ffprobe utilities.
 *
 * Extracted from VideoProbeProcessor so the social-media detection handler can
 * re-probe legacy video items during backfill without duplicating the temp-file
 * ffprobe invocation or the container-metadata normalization logic.
 */

/**
 * Maximum serialized (JSON) size, in bytes, allowed for the container tag
 * collections we persist into storage_object metadata. Keeps ffprobe tag dumps
 * from bloating the JSONB column; excess keys are dropped once the budget is
 * exceeded.
 */
const MAX_TAGS_SERIALIZED_BYTES = 4096;

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
 */
export function probeVideoFile(filePath: string): Promise<ffmpeg.FfprobeData> {
  return new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) reject(err);
      else resolve(data);
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
export function extractContainerMetadata(data: ffmpeg.FfprobeData): ContainerMetadata {
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
