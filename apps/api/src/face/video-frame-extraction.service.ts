// =============================================================================
// VideoFrameExtractionService
// =============================================================================
//
// Extracts JPEG frames from a video buffer at evenly spaced timestamps.
//
// Sampling strategy:
//   - Compute durationSec = durationMs / 1000 (or 0 when unknown).
//   - Derive interval = max(sampleIntervalSeconds, durationSec / maxFrames).
//   - Emit timestamps at: interval/2, interval*1.5, interval*2.5, …
//     (mid-interval sampling avoids identical frames near hard boundaries).
//   - Cap at maxFrames timestamps.
//   - When durationMs is 0 / missing, fall back to a single frame at 0 s
//     (poster frame).
//
// Per-frame errors are logged and skipped rather than aborting the whole job,
// so a single corrupted seek still yields frames from the other timestamps.
//
// All temp files are cleaned up in a finally block regardless of success/failure.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import ffmpeg from 'fluent-ffmpeg';

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

@Injectable()
export class VideoFrameExtractionService {
  private readonly logger = new Logger(VideoFrameExtractionService.name);

  // ---------------------------------------------------------------------------
  // extractFrames
  // ---------------------------------------------------------------------------

  /**
   * Write `videoBuffer` to a temp file, extract JPEG frames at computed
   * timestamps, and return them as an array of `{ timestampMs, buffer }`.
   *
   * The returned array may be shorter than `maxFrames` when:
   *   - The video is shorter than expected.
   *   - Individual frame extractions fail (they are skipped with a warning).
   *
   * Always cleans up temp files in a finally block.
   */
  async extractFrames(
    videoBuffer: Buffer,
    opts: FrameExtractionOpts,
  ): Promise<ExtractedFrame[]> {
    const { durationMs, sampleIntervalSeconds, maxFrames, fileExtension } = opts;

    // Compute seek timestamps (seconds)
    const seekTimestamps = computeSeekTimestamps(
      durationMs ?? 0,
      sampleIntervalSeconds,
      maxFrames,
    );

    this.logger.debug(
      `VideoFrameExtraction: durationMs=${durationMs ?? 0}, ` +
        `sampleIntervalSeconds=${sampleIntervalSeconds}, maxFrames=${maxFrames}, ` +
        `planned seeks=${seekTimestamps.length} (${seekTimestamps.map((s) => s.toFixed(1)).join(', ')} s)`,
    );

    // Temp input file — ffmpeg requires a seekable path, not a stream
    const ext = fileExtension || '.mp4';
    const tmpIn = join(tmpdir(), `memoriaHub-vface-in-${randomUUID()}${ext}`);

    // We accumulate per-frame temp paths so they can all be cleaned up
    const tmpFramePaths: string[] = [];

    try {
      await fs.writeFile(tmpIn, videoBuffer);

      const results: ExtractedFrame[] = [];

      for (const seekSecs of seekTimestamps) {
        const tmpOut = join(
          tmpdir(),
          `memoriaHub-vface-frame-${randomUUID()}.jpg`,
        );
        tmpFramePaths.push(tmpOut);

        try {
          await extractFrame(tmpIn, tmpOut, seekSecs);
          const buffer = await fs.readFile(tmpOut);
          results.push({ timestampMs: Math.round(seekSecs * 1000), buffer });
        } catch (frameErr) {
          // A single failed frame extraction is non-fatal.
          const msg =
            frameErr instanceof Error ? frameErr.message : String(frameErr);
          this.logger.warn(
            `VideoFrameExtraction: failed to extract frame at ${seekSecs.toFixed(2)} s — skipping. ${msg}`,
          );
        }
      }

      this.logger.debug(
        `VideoFrameExtraction: extracted ${results.length}/${seekTimestamps.length} frames`,
      );

      return results;
    } finally {
      // Clean up all temp files regardless of success or failure
      await fs.unlink(tmpIn).catch(() => {});
      for (const p of tmpFramePaths) {
        await fs.unlink(p).catch(() => {});
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Compute evenly-spaced seek timestamps (in seconds) for frame extraction.
 *
 * Uses mid-interval sampling: first timestamp = interval/2, then interval*1.5, …
 * This avoids identical scene-change frames at exact interval boundaries.
 *
 * When durationSec is 0 or very small, returns a single timestamp at 0 s
 * (poster frame fallback).
 */
function computeSeekTimestamps(
  durationMs: number,
  sampleIntervalSeconds: number,
  maxFrames: number,
): number[] {
  const durationSec = durationMs / 1000;

  if (!durationSec || durationSec < 0.1) {
    // Duration unknown or too short — extract a single poster frame
    return [0];
  }

  // Use at least sampleIntervalSeconds, but expand if the video is so long
  // that dividing evenly would exceed maxFrames.
  const interval = Math.max(sampleIntervalSeconds, durationSec / maxFrames);

  const timestamps: number[] = [];
  let t = interval / 2; // mid-interval start

  while (t < durationSec && timestamps.length < maxFrames) {
    timestamps.push(t);
    t += interval;
  }

  // Edge case: video shorter than interval/2 — still grab something
  if (timestamps.length === 0) {
    timestamps.push(0);
  }

  return timestamps;
}

/**
 * Extract a single JPEG frame from `tmpIn` at `seekSecs` seconds into `tmpOut`.
 * Wraps fluent-ffmpeg's event-driven API in a Promise.
 */
function extractFrame(
  tmpIn: string,
  tmpOut: string,
  seekSecs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ffmpeg(tmpIn)
      .seekInput(seekSecs)
      .frames(1)
      .output(tmpOut)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}
