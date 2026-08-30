import { Injectable, Logger } from '@nestjs/common';
import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { ObjectProcessor, ObjectProcessorResult } from '../object-processor.interface';
import { streamToTempFile } from './stream-utils';
import { probeVideoFileWithTimeout, extractContainerMetadata } from './ffprobe.util';
import { parseVideoCaptureTimestamp } from '@memoriahub/enrichment-compute/metadata';

/**
 * VideoProbeProcessor — extracts duration, dimensions, codec, and container
 * metadata from video files.
 *
 * Name:     video-probe
 * Priority: 20
 * Handles:  video/* MIME types only
 *
 * ffprobe requires a seekable file path, so this processor:
 *   1. Streams the download to a temp file in os.tmpdir() with constant memory
 *      (never buffers the full video in RAM).
 *   2. Runs ffprobe against the temp file (via the shared ffprobe.util).
 *   3. Deletes the temp file in a finally block.
 *
 * Requires ffmpeg/ffprobe to be installed in the container (see Dockerfile).
 *
 * Writes: { durationMs: number, width: number, height: number, codec: string,
 *           capturedAt?: string, formatName?: string,
 *           formatTags: Record<string,string>,
 *           streamTags: Array<Record<string,string>> }
 *
 * capturedAt is an ISO-8601 string derived from the video's creation_time tag
 * (format.tags.creation_time, or the video-stream's tags.creation_time).  Only
 * written when the tag is present and parseable as a valid date; invalid or
 * missing values are silently omitted.
 *
 * formatName, formatTags, and streamTags carry the container-level metadata used
 * by the social-media video detection feature.  Tag collections have lowercased
 * keys, string-coerced values, and are size-capped to keep storage_object
 * metadata compact (see ffprobe.util).
 */
@Injectable()
export class VideoProbeProcessor implements ObjectProcessor {
  private readonly logger = new Logger(VideoProbeProcessor.name);

  readonly name = 'video-probe';
  readonly priority = 20;
  // Duration/codec metadata is enrichment, not load-bearing — a probe failure
  // must not fail an object whose thumbnail succeeded.
  readonly optional = true;

  canProcess(object: StorageObject): boolean {
    return object.mimeType.startsWith('video/');
  }

  async process(
    object: StorageObject,
    getStream: () => Promise<Readable>,
  ): Promise<ObjectProcessorResult> {
    const tmpPath = join(tmpdir(), `memoriaHub-probe-${randomUUID()}`);

    try {
      // Stream the download to a temp file
      const stream = await getStream();
      await streamToTempFile(stream, tmpPath);

      // Run ffprobe (bounded — ffprobe can hang on corrupt containers)
      const timeoutMs = parseInt(process.env.FFPROBE_TIMEOUT_MS ?? '30000', 10);
      const probeData = await probeVideoFileWithTimeout(tmpPath, timeoutMs);

      const container = extractContainerMetadata(probeData);
      const { durationMs, width, height, codec, formatName, formatTags, streamTags } = container;

      // --- capture time → capturedAt (+ capturedAtOffset) ---
      //
      // `captured_at` is a CIVIL timestamp for photos — the wall clock at
      // capture, re-encoded as UTC (see docs/specs/date-model.md). Videos used
      // to store a real INSTANT in the same column, because container
      // `creation_time` is spec'd as UTC, so a video shot at 20:16 in a UTC-6
      // zone landed on the NEXT calendar day and separated from photos taken
      // minutes beside it (#443).
      //
      // parseVideoCaptureTimestamp applies the same wall-clock re-encode the
      // photo path uses whenever a tag states a local time with its offset
      // (Apple writes `com.apple.quicktime.creationdate`), and falls back to
      // the old instant behaviour only when the container carries no local
      // information at all — the true zone is then unknowable, and guessing
      // one would be worse than a known-imperfect value.
      const videoStream = probeData.streams?.find(s => s.codec_type === 'video');
      const captureTags: Record<string, unknown> = {
        ...lowerCaseKeys(videoStream?.tags),
        ...lowerCaseKeys(probeData.format?.tags),
      };

      const capture = parseVideoCaptureTimestamp(captureTags);
      const capturedAt = capture?.capturedAt;

      if (capture?.source === 'instant') {
        // Logged so the size of the residual gap is measurable rather than
        // assumed: these are the videos a re-run can never correct.
        this.logger.debug(
          `video-probe for object ${object.id}: no local-time tag; ` +
            `capturedAt kept as a UTC instant from '${capture.tag}'`,
        );
      }

      const metadata: Record<string, unknown> = {};
      if (durationMs !== undefined) metadata['durationMs'] = durationMs;
      if (typeof width === 'number') metadata['width'] = width;
      if (typeof height === 'number') metadata['height'] = height;
      if (typeof codec === 'string') metadata['codec'] = codec;
      if (capturedAt !== undefined) metadata['capturedAt'] = capturedAt;
      if (capture?.capturedAtOffset !== undefined) {
        metadata['capturedAtOffset'] = capture.capturedAtOffset;
      }
      if (formatName !== undefined) metadata['formatName'] = formatName;
      metadata['formatTags'] = formatTags;
      metadata['streamTags'] = streamTags;

      this.logger.debug(
        `video-probe for object ${object.id}: ${durationMs}ms ${width}x${height} ${codec}` +
          (capturedAt ? ` capturedAt=${capturedAt}` : '') +
          (formatName ? ` format=${formatName}` : ''),
      );

      return { success: true, metadata };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`video-probe failed for object ${object.id}: ${message}`);
      return { success: false, error: message };
    } finally {
      await fs.unlink(tmpPath).catch(() => {
        // Ignore errors when cleaning up the temp file
      });
    }
  }
}

/**
 * Lower-case a tag map's keys so lookups are container-case-independent
 * (ffprobe reports `creation_time` but some muxers write `Creation_Time`).
 * Built from the RAW probe data rather than the size-capped `formatTags`, so a
 * large tag set can never cap away the capture time itself.
 */
function lowerCaseKeys(tags: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!tags) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tags)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}
