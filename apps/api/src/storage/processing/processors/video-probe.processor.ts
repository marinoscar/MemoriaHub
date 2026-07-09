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

      // --- creation_time → capturedAt ---
      // Prefer format-level tag; fall back to the video stream's tag.
      const videoStream = probeData.streams?.find(s => s.codec_type === 'video');
      const rawCreationTime: unknown =
        probeData.format?.tags?.['creation_time'] ??
        videoStream?.tags?.['creation_time'];

      let capturedAt: string | undefined;
      if (typeof rawCreationTime === 'string' && rawCreationTime.length > 0) {
        const d = new Date(rawCreationTime);
        if (!isNaN(d.getTime())) {
          capturedAt = d.toISOString();
        }
      }

      const metadata: Record<string, unknown> = {};
      if (durationMs !== undefined) metadata['durationMs'] = durationMs;
      if (typeof width === 'number') metadata['width'] = width;
      if (typeof height === 'number') metadata['height'] = height;
      if (typeof codec === 'string') metadata['codec'] = codec;
      if (capturedAt !== undefined) metadata['capturedAt'] = capturedAt;
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
