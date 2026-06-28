import { Injectable, Logger } from '@nestjs/common';
import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as ffmpeg from 'fluent-ffmpeg';
import { ObjectProcessor, ObjectProcessorResult } from '../object-processor.interface';
import { streamToBuffer } from './stream-utils';

/**
 * VideoProbeProcessor — extracts duration, dimensions, and codec from video files.
 *
 * Name:     video-probe
 * Priority: 20
 * Handles:  video/* MIME types only
 *
 * ffprobe requires a seekable file path, so this processor:
 *   1. Buffers the download stream.
 *   2. Writes to a temp file in os.tmpdir().
 *   3. Runs ffprobe against the temp file.
 *   4. Deletes the temp file in a finally block.
 *
 * Requires ffmpeg/ffprobe to be installed in the container (see Dockerfile).
 *
 * Writes: { durationMs: number, width: number, height: number, codec: string,
 *           capturedAt?: string }
 *
 * capturedAt is an ISO-8601 string derived from the video's creation_time tag
 * (format.tags.creation_time, or the video-stream's tags.creation_time).  Only
 * written when the tag is present and parseable as a valid date; invalid or
 * missing values are silently omitted.
 */
@Injectable()
export class VideoProbeProcessor implements ObjectProcessor {
  private readonly logger = new Logger(VideoProbeProcessor.name);

  readonly name = 'video-probe';
  readonly priority = 20;

  canProcess(object: StorageObject): boolean {
    return object.mimeType.startsWith('video/');
  }

  async process(
    object: StorageObject,
    getStream: () => Promise<Readable>,
  ): Promise<ObjectProcessorResult> {
    const tmpPath = join(tmpdir(), `memoriaHub-probe-${randomUUID()}`);

    try {
      // Download to temp file
      const stream = await getStream();
      const buffer = await streamToBuffer(stream);
      await fs.writeFile(tmpPath, buffer);

      // Run ffprobe
      const probeData = await this.probe(tmpPath);

      const videoStream = probeData.streams?.find(s => s.codec_type === 'video');
      const durationSec = probeData.format?.duration;

      const durationMs =
        durationSec !== undefined ? Math.round(parseFloat(String(durationSec)) * 1000) : undefined;

      const width = videoStream?.width;
      const height = videoStream?.height;
      const codec = videoStream?.codec_name;

      // --- creation_time → capturedAt ---
      // Prefer format-level tag; fall back to the video stream's tag.
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

      // Harvest container tags for social detection (keys + values lowercased, empty values omitted)
      const CONTAINER_TAG_KEYS = [
        'major_brand', 'minor_version', 'compatible_brands', 'encoder', 'handler_name',
        'com.android.version', 'com.android.manufacturer', 'com.android.model',
        'com.android.capture.fps', 'com.apple.quicktime.make', 'com.apple.quicktime.model',
        'com.apple.quicktime.software', 'com.apple.quicktime.location.iso6709',
        'make', 'model', 'location', 'location-eng', 'title', 'artist', 'comment', 'vendor_id',
      ];
      const formatTags = (probeData.format?.tags ?? {}) as Record<string, unknown>;
      const streamTags = (videoStream?.tags ?? {}) as Record<string, unknown>;
      const containerTags: Record<string, string> = {};
      for (const key of CONTAINER_TAG_KEYS) {
        const rawVal = formatTags[key] ?? streamTags[key];
        if (typeof rawVal === 'string' && rawVal.trim().length > 0) {
          containerTags[key.toLowerCase()] = rawVal.toLowerCase();
        }
      }
      if (Object.keys(containerTags).length > 0) {
        metadata['containerTags'] = containerTags;
      }
      // hasContainerCreationTime: true if format.tags.creation_time OR video stream tags.creation_time present
      const hasContainerCreationTime =
        typeof (formatTags['creation_time']) === 'string' ||
        typeof (streamTags['creation_time']) === 'string';
      metadata['hasContainerCreationTime'] = hasContainerCreationTime;

      this.logger.debug(
        `video-probe for object ${object.id}: ${durationMs}ms ${width}x${height} ${codec}` +
          (capturedAt ? ` capturedAt=${capturedAt}` : ''),
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

  private probe(filePath: string): Promise<ffmpeg.FfprobeData> {
    return new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  }
}
