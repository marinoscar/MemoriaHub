/**
 * Video frame-sampling core (moved from
 * apps/api/src/face/video-frame-extraction.service.ts).
 *
 * This module holds ONLY the pure ffmpeg-invocation halves of frame
 * extraction — computing seek timestamps and running ffmpeg's seek+capture
 * against an already-materialized video file on disk. Stream handling,
 * downloading/cleaning up the SOURCE video file, env reads, and NestJS DI all
 * stay in the host (the API's VideoFrameExtractionService, or a distributed
 * worker node's social-media-detection compute module) — this module never
 * downloads anything itself, it only reads a local path.
 *
 * fluent-ffmpeg is loaded lazily via nodeRequire (mirrors /metadata's
 * loadFfmpeg) so importing this subpath is always safe; the ffmpeg/ffprobe
 * binaries on PATH remain a host/deployment concern.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { nodeRequire } from '../node-require.cjs';
import { computeLog } from '../logging.js';

export interface ExtractedFrame {
  timestampMs: number;
  buffer: Buffer;
}

export interface FrameExtractionOpts {
  /** Total video duration in milliseconds. 0 or undefined → single frame at 0 s. */
  durationMs?: number | null;
  /** Desired gap between sampled frames in seconds (default: 5). */
  sampleIntervalSeconds: number;
  /** Hard cap on total frames extracted (default: 60). */
  maxFrames: number;
  /**
   * Optional extension hint for ffmpeg container detection.
   * Falls back to '.mp4' when absent.
   */
  fileExtension?: string;
}

type FfmpegChain = {
  seekInput(seconds: number): FfmpegChain;
  frames(n: number): FfmpegChain;
  output(path: string): FfmpegChain;
  on(event: 'end' | 'error', cb: (err?: Error) => void): FfmpegChain;
  run(): void;
};
type FfmpegModule = (input: string) => FfmpegChain;

function loadFfmpeg(): FfmpegModule {
  const mod = nodeRequire('fluent-ffmpeg') as Record<string, unknown>;
  return (typeof mod === 'function' ? mod : mod['default']) as FfmpegModule;
}

// ---------------------------------------------------------------------------
// extractFrames — evenly-spaced schedule
// ---------------------------------------------------------------------------

/**
 * Extract JPEG frames at computed, evenly-spaced timestamps from the video
 * already on disk at `videoPath`, and return them as an array of
 * `{ timestampMs, buffer }`.
 *
 * `videoPath` must already be a seekable file on disk — the caller owns
 * downloading/materializing it (and its cleanup); this function only owns
 * the per-frame output temp files it creates internally.
 *
 * The returned array may be shorter than `maxFrames` when:
 *   - The video is shorter than expected.
 *   - Individual frame extractions fail (they are skipped).
 *
 * Always cleans up its own (per-frame output) temp files in a finally block.
 */
export async function extractFrames(
  videoPath: string,
  opts: FrameExtractionOpts,
): Promise<ExtractedFrame[]> {
  const { durationMs, sampleIntervalSeconds, maxFrames } = opts;

  const seekTimestamps = computeSeekTimestamps(durationMs ?? 0, sampleIntervalSeconds, maxFrames);

  const tmpFramePaths: string[] = [];

  try {
    const results: ExtractedFrame[] = [];

    for (const seekSecs of seekTimestamps) {
      const tmpOut = join(tmpdir(), `memoriaHub-vface-frame-${randomUUID()}.jpg`);
      tmpFramePaths.push(tmpOut);

      try {
        await extractFrame(videoPath, tmpOut, seekSecs);
        const buffer = await fs.readFile(tmpOut);
        results.push({ timestampMs: Math.round(seekSecs * 1000), buffer });
      } catch (err) {
        // A single failed frame extraction is non-fatal — skip it.
        const msg = err instanceof Error ? err.message : String(err);
        computeLog.warn(
          `extractFrames: failed to extract frame at ${seekSecs.toFixed(2)} s — skipping. ${msg}`,
        );
      }
    }

    return results;
  } finally {
    for (const p of tmpFramePaths) {
      await fs.unlink(p).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// extractFramesAt — explicit timestamp list
// ---------------------------------------------------------------------------

/**
 * Extract JPEG frames at an EXPLICIT list of timestamps (in milliseconds),
 * rather than an evenly-spaced schedule.
 *
 * Used by OCR-based social-media detection, which wants a few targeted
 * frames (e.g. near the start and end of a clip where platform watermarks
 * appear).
 *
 * `videoPath` must already be a seekable file on disk — the caller owns
 * downloading/materializing it (and its cleanup). Each requested timestamp
 * is seeked independently against that file. Timestamps are deduped and
 * clamped to >= 0, then sorted ascending. Per-frame extraction failures are
 * skipped (never abort the batch). This function only cleans up the
 * per-frame output temp files it creates internally, in a finally block.
 */
export async function extractFramesAt(
  videoPath: string,
  timestampsMs: number[],
  _fileExtension?: string,
): Promise<ExtractedFrame[]> {
  const cleaned = Array.from(new Set(timestampsMs.map((t) => Math.max(0, Math.round(t))))).sort(
    (a, b) => a - b,
  );

  if (cleaned.length === 0) {
    return [];
  }

  const tmpFramePaths: string[] = [];

  try {
    const results: ExtractedFrame[] = [];

    for (const ms of cleaned) {
      const seekSecs = ms / 1000;
      const tmpOut = join(tmpdir(), `memoriaHub-ocr-frame-${randomUUID()}.jpg`);
      tmpFramePaths.push(tmpOut);

      try {
        await extractFrame(videoPath, tmpOut, seekSecs);
        const buffer = await fs.readFile(tmpOut);
        results.push({ timestampMs: ms, buffer });
      } catch (err) {
        // A single failed frame extraction is non-fatal — skip it.
        const msg = err instanceof Error ? err.message : String(err);
        computeLog.warn(
          `extractFramesAt: failed to extract frame at ${seekSecs.toFixed(2)} s — skipping. ${msg}`,
        );
      }
    }

    return results;
  } finally {
    for (const p of tmpFramePaths) {
      await fs.unlink(p).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Compute evenly-spaced seek timestamps (in seconds) for frame extraction.
 *
 * Uses mid-interval sampling: first timestamp = interval/2, then
 * interval*1.5, … — this avoids identical scene-change frames at exact
 * interval boundaries.
 *
 * When durationSec is 0 or very small, returns a single timestamp at 0 s
 * (poster frame fallback).
 */
export function computeSeekTimestamps(
  durationMs: number,
  sampleIntervalSeconds: number,
  maxFrames: number,
): number[] {
  const durationSec = durationMs / 1000;

  if (!durationSec || durationSec < 0.1) {
    return [0];
  }

  const interval = Math.max(sampleIntervalSeconds, durationSec / maxFrames);

  const timestamps: number[] = [];
  let t = interval / 2;

  while (t < durationSec && timestamps.length < maxFrames) {
    timestamps.push(t);
    t += interval;
  }

  if (timestamps.length === 0) {
    timestamps.push(0);
  }

  return timestamps;
}

/**
 * Extract a single JPEG frame from `tmpIn` at `seekSecs` seconds into
 * `tmpOut`. Wraps fluent-ffmpeg's event-driven API in a Promise.
 */
function extractFrame(tmpIn: string, tmpOut: string, seekSecs: number): Promise<void> {
  const ffmpeg = loadFfmpeg();
  return new Promise<void>((resolve, reject) => {
    ffmpeg(tmpIn)
      .seekInput(seekSecs)
      .frames(1)
      .output(tmpOut)
      .on('end', () => resolve())
      .on('error', (err?: Error) => reject(err))
      .run();
  });
}
