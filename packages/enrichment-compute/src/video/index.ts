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
 * ffmpeg is invoked through the package's own thin `spawn()` wrapper
 * (../ffmpeg/index.js) rather than the deprecated fluent-ffmpeg package
 * (issue #219). Importing this subpath is always safe — `node:child_process`
 * is a builtin, and a missing binary surfaces only when a run is attempted;
 * the ffmpeg/ffprobe binaries on PATH remain a host/deployment concern.
 *
 * Also exports `extractPosterFrame` — a single-frame "poster frame" extractor
 * used by thumbnail generation (video poster/cover images), as opposed to the
 * multi-frame sampling functions above used by face detection / OCR. It was
 * ported out of `apps/api/src/storage/processing/processors/thumbnail.processor.ts`
 * so both the API's ThumbnailProcessor and a distributed worker node's
 * thumbnail compute module share one, numerically-identical implementation of
 * the three-attempt fallback ladder (seek 1s → seek 0s → `thumbnail` filter).
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { buildAudioLeadArgs, buildFrameExtractionArgs, runFfmpeg } from '../ffmpeg/index.js';
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
  /**
   * Per-frame ffmpeg timeout in ms before SIGKILL.
   *
   * Historically UNBOUNDED here (only `extractPosterFrame` was bounded), which
   * was survivable against a local file. Against a remote URL it is not: a
   * stalled network read would hang a worker slot until the 20-minute job
   * timeout fired. Absent, this falls back to `FFMPEG_TIMEOUT_MS` (default
   * 60000) — so the previously-unbounded local path also gains a ceiling.
   */
  ffmpegTimeoutMs?: number;
}

/**
 * A video source ffmpeg can read: either a local file path or an HTTP(S) URL.
 *
 * ffmpeg speaks HTTP and issues Range requests, so `-ss` fast input seek
 * against a URL fetches only the ranges around each seek point — megabytes
 * rather than the whole multi-gigabyte file. The functions here do not care
 * which form they are given; `isHttpUrl` below is only used to pick a longer
 * default timeout for the network case.
 */
export type VideoSource = string;

/** True for an http(s) URL, as opposed to a local filesystem path. */
export function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/**
 * Default ffmpeg timeout for a single frame/audio extraction, in ms.
 *
 * A network source gets a longer budget than a local file: the first seek has
 * to fetch the container header before it can read anything.
 */
function defaultFfmpegTimeoutMs(source: string): number {
  const configured = parseInt(process.env.FFMPEG_TIMEOUT_MS ?? '60000', 10);
  const base = Number.isFinite(configured) && configured > 0 ? configured : 60000;
  return isHttpUrl(source) ? base * 2 : base;
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
  videoPath: VideoSource,
  opts: FrameExtractionOpts,
): Promise<ExtractedFrame[]> {
  const { durationMs, sampleIntervalSeconds, maxFrames } = opts;
  const ffmpegTimeoutMs = opts.ffmpegTimeoutMs ?? defaultFfmpegTimeoutMs(videoPath);

  const seekTimestamps = computeSeekTimestamps(durationMs ?? 0, sampleIntervalSeconds, maxFrames);

  const tmpFramePaths: string[] = [];

  try {
    const results: ExtractedFrame[] = [];

    for (const seekSecs of seekTimestamps) {
      const tmpOut = join(tmpdir(), `memoriaHub-vface-frame-${randomUUID()}.jpg`);
      tmpFramePaths.push(tmpOut);

      try {
        await extractFrame(videoPath, tmpOut, seekSecs, ffmpegTimeoutMs);
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
  videoPath: VideoSource,
  timestampsMs: number[],
  _fileExtension?: string,
  ffmpegTimeoutMs?: number,
): Promise<ExtractedFrame[]> {
  const timeoutMs = ffmpegTimeoutMs ?? defaultFfmpegTimeoutMs(videoPath);
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
        await extractFrame(videoPath, tmpOut, seekSecs, timeoutMs);
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
// extractAudioLead — bounded audio extraction for transcription
// ---------------------------------------------------------------------------

export interface AudioLeadOpts {
  /**
   * Seconds of audio to extract, from the START of the video (ffmpeg `-t`).
   *
   * This is the entire cost bound for transcription: a 3-hour video and a
   * 30-second clip both yield at most `leadSeconds` of billable audio.
   * Transcribing the whole track was rejected outright — ~180 billable
   * minutes for a 3-hour video, and well past the transcription API's ~25 MB
   * request cap. See docs/specs/video-auto-tagging.md.
   */
  leadSeconds: number;
  /**
   * ffmpeg timeout in ms before SIGKILL. Defaults to `FFMPEG_TIMEOUT_MS`
   * (read at call time — this package has no NestJS DI/config), falling back
   * to 60000 when unset/unparsable.
   */
  ffmpegTimeoutMs?: number;
}

export interface ExtractedAudioLead {
  /** Encoded audio bytes, ready to hand to a transcription API. */
  buffer: Buffer;
  /** MIME type of `buffer`. */
  mimeType: string;
  /** The `leadSeconds` actually requested — recorded for audit/re-run detection. */
  leadSeconds: number;
}

/**
 * Extract the first `leadSeconds` of audio from the video already on disk at
 * `videoPath`, as mono 16 kHz AAC in an m4a container.
 *
 * Mono 16 kHz is what the transcription models downsample to anyway, and it
 * keeps the payload tiny — ~30 s lands well under 1 MB, so the request is
 * never near the provider's size cap regardless of the source video.
 *
 * `videoPath` must already be a seekable file on disk — like the frame
 * extractors above, this function does NOT take ownership of it. It owns and
 * unlinks its OWN temp output in a `finally`. The temp prefix is
 * `memoriaHub-audio-*` so the API's TempFileJanitorTask reaps an orphan left
 * behind by a SIGKILLed worker.
 *
 * Throws when ffmpeg fails or produces no audio (a video with no audio track
 * exits non-zero, or writes an empty file). Callers treat transcription as
 * best-effort and proceed visual-only.
 */
export async function extractAudioLead(
  videoPath: VideoSource,
  opts: AudioLeadOpts,
): Promise<ExtractedAudioLead> {
  const ffmpegTimeoutMs = opts.ffmpegTimeoutMs ?? defaultFfmpegTimeoutMs(videoPath);

  const tmpOut = join(tmpdir(), `memoriaHub-audio-${randomUUID()}.m4a`);

  try {
    await runFfmpeg(buildAudioLeadArgs({ input: videoPath, output: tmpOut, durationSecs: opts.leadSeconds }), {
      timeoutMs: ffmpegTimeoutMs,
      timeoutMessage: `ffmpeg audio extraction timed out after ${ffmpegTimeoutMs}ms`,
    });
    await assertNonEmptyFile(tmpOut);

    return {
      buffer: await fs.readFile(tmpOut),
      mimeType: 'audio/mp4',
      leadSeconds: opts.leadSeconds,
    };
  } finally {
    await fs.unlink(tmpOut).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// extractPosterFrame — single-frame poster/cover extraction (thumbnails)
// ---------------------------------------------------------------------------

export interface PosterFrameOpts {
  /**
   * Per-attempt ffmpeg timeout in ms before SIGKILL. Defaults to the
   * `FFMPEG_TIMEOUT_MS` env var (read at call time, since this package has no
   * NestJS DI/config), falling back to 60000 when unset/unparsable.
   */
  ffmpegTimeoutMs?: number;
}

/**
 * Extract a single "poster frame" JPEG from the video already on disk at
 * `videoPath`, via a three-attempt fallback ladder ported verbatim (by
 * behavior) from the server's `ThumbnailProcessor.processVideo`:
 *   1. seek to 1 s
 *   2. seek to 0 s
 *   3. no seek — apply the ffmpeg `thumbnail` video filter instead, which
 *      picks a representative frame heuristically
 *
 * Each attempt writes to its OWN temp output path and is validated
 * non-empty afterward (ffmpeg can exit 0 without writing a frame, e.g. a
 * seek past the end of a short clip); the previous attempt's temp file is
 * unlinked before the next attempt runs. Each attempt is also individually
 * bounded by `opts.ffmpegTimeoutMs` (or `FFMPEG_TIMEOUT_MS`, default 60000)
 * and killed with SIGKILL if it hangs — a corrupt input or codec loop must
 * never wedge the caller.
 *
 * If all three attempts fail, throws the LAST attempt's error (matching the
 * server's `if (!frameExtracted) throw lastError;`).
 *
 * On success, reads the winning temp file into a Buffer and returns it. This
 * function does NOT resize/re-encode via sharp — it returns the raw
 * extracted JPEG bytes only; the caller runs the result through its OWN
 * sharp resize pipeline, exactly mirroring how the server's
 * `processVideo` does `extractFrame` → `fs.readFile` → `sharp(...).resize(...)`.
 * ALL per-attempt temp files (including the winning one) are cleaned up in a
 * finally block.
 *
 * `videoPath` must already be a seekable file on disk — like `extractFrames`/
 * `extractFramesAt` above, this function does NOT take ownership of it; the
 * caller owns downloading/materializing the source video and its cleanup.
 */
export async function extractPosterFrame(videoPath: string, opts?: PosterFrameOpts): Promise<Buffer> {
  const ffmpegTimeoutMs =
    opts?.ffmpegTimeoutMs ?? parseInt(process.env.FFMPEG_TIMEOUT_MS ?? '60000', 10);

  const attempts: Array<{ label: string; seekSecs: number | null }> = [
    { label: '1s seek', seekSecs: 1 },
    { label: '0s seek', seekSecs: 0 },
    { label: 'thumbnail filter', seekSecs: null },
  ];

  const tmpOutPaths: string[] = [];
  let winningPath: string | null = null;
  let lastError: Error = new Error('poster frame extraction not attempted');

  try {
    for (const attempt of attempts) {
      const tmpOut = join(tmpdir(), `memoriaHub-poster-${randomUUID()}.jpg`);
      tmpOutPaths.push(tmpOut);

      try {
        await extractPosterFrameAttempt(videoPath, tmpOut, attempt.seekSecs, ffmpegTimeoutMs);
        await assertNonEmptyFile(tmpOut);
        winningPath = tmpOut;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        computeLog.warn(
          `extractPosterFrame: attempt (${attempt.label}) failed for ${videoPath} — ` +
            `${lastError.message}; falling back to next attempt`,
        );
      }
    }

    if (!winningPath) {
      throw lastError;
    }

    return await fs.readFile(winningPath);
  } finally {
    for (const p of tmpOutPaths) {
      await fs.unlink(p).catch(() => {});
    }
  }
}

/**
 * Reject unless `path` exists with size > 0 — ffmpeg can exit 0 without
 * writing a frame (e.g. a seek past the end of the stream).
 */
async function assertNonEmptyFile(path: string): Promise<void> {
  const stats = await fs.stat(path);
  if (stats.size === 0) {
    throw new Error(`ffmpeg produced an empty output file: ${path}`);
  }
}

/**
 * Run a single poster-frame extraction attempt from `tmpIn` into `tmpOut`.
 * With `seekSecs` set, seeks to that timestamp; with `seekSecs === null`,
 * applies the ffmpeg `thumbnail` video filter instead (no seek — last rung
 * of the fallback ladder).
 *
 * The command is killed with SIGKILL once `timeoutMs` elapses (the runner's
 * `settled` guard makes the child's resulting late 'close'/'error' a no-op,
 * so the promise still settles exactly once).
 *
 * Argv parity: the seek branch produces
 * `['-ss', <s>, '-i', tmpIn, '-y', '-vframes', '1', tmpOut]` and the filter
 * branch `['-i', tmpIn, '-y', '-vframes', '1', '-filter:v', 'thumbnail', tmpOut]`
 * — exactly what fluent-ffmpeg emitted for the equivalent chains. `-ss` MUST
 * stay before `-i` (input seek); see ../ffmpeg/index.ts.
 */
function extractPosterFrameAttempt(
  tmpIn: string,
  tmpOut: string,
  seekSecs: number | null,
  timeoutMs: number,
): Promise<void> {
  return runFfmpeg(
    buildFrameExtractionArgs({
      input: tmpIn,
      output: tmpOut,
      seekSecs,
      videoFilter: seekSecs === null ? 'thumbnail' : null,
    }),
    {
      timeoutMs,
      timeoutMessage: `ffmpeg frame extraction timed out after ${timeoutMs}ms`,
    },
  );
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
 * `tmpOut`.
 *
 * Argv: `['-ss', <seekSecs>, '-i', tmpIn, '-y', '-vframes', '1', tmpOut]` —
 * identical to what fluent-ffmpeg's `.seekInput(s).frames(1).output(out)`
 * chain produced. `tmpIn` may be a local path OR an http(s) URL; ffmpeg does
 * not care, and `-ss` before `-i` stays an INPUT seek either way, which is
 * exactly what makes a URL source fetch only the bytes around the seek point.
 *
 * Bounded by `timeoutMs` (issue #456). This path used to be unbounded —
 * survivable against a local file, but against a remote URL a stalled network
 * read would hang a worker slot until the 20-minute job timeout. Each caller
 * already treats a per-frame failure as skippable, so a timed-out frame costs
 * that frame, not the video.
 */
function extractFrame(
  tmpIn: VideoSource,
  tmpOut: string,
  seekSecs: number,
  timeoutMs: number,
): Promise<void> {
  return runFfmpeg(buildFrameExtractionArgs({ input: tmpIn, output: tmpOut, seekSecs }), {
    timeoutMs,
    timeoutMessage: `ffmpeg frame extraction timed out after ${timeoutMs}ms`,
  });
}

// ---------------------------------------------------------------------------
// Range-seek suitability probe (issue #456)
// ---------------------------------------------------------------------------

export type RangeSeekVerdict =
  /** Range honored AND the container's index is at the front — stream it. */
  | 'suitable'
  /**
   * Range honored but the index is at the END of the file (a non-faststart
   * MP4/MOV), so ffmpeg must fetch the tail before it can seek at all —
   * collapsing the saving and doing it slowly. Download instead.
   */
  | 'not-faststart'
  /** The provider ignored the Range header, so there is no saving to be had. */
  | 'no-range-support'
  /** Could not tell (network error, unrecognized container). Download instead. */
  | 'unknown';

export interface RangeSeekProbeResult {
  verdict: RangeSeekVerdict;
  /** Human-readable reason, for the decision log. */
  detail: string;
  /** Bytes actually read by the probe itself. */
  bytesRead: number;
}

/** How much of the file head to read when looking for the `moov` atom. */
const FASTSTART_PROBE_BYTES = 64 * 1024;

/**
 * Decide whether a video URL is worth streaming to ffmpeg instead of
 * downloading whole.
 *
 * This answers BOTH preconditions in a single small ranged request:
 *
 *   1. Does the provider honor `Range`? A 206 with a `Content-Range` header
 *      says yes. A 200 means the whole object was sent and ffmpeg's seeks
 *      would re-download the file repeatedly — strictly worse than one clean
 *      download.
 *   2. For MP4/MOV, is the `moov` atom at the FRONT ("faststart")? The atom
 *      layout is definitive and readable from the first few KB, which is why
 *      this reads the bytes rather than trying to infer it from ffprobe
 *      metadata — ffprobe's `-show_format` output does not report atom order
 *      at all, so there is nothing in the persisted `_processing['video-probe']`
 *      blob that could answer this.
 *
 * NEVER THROWS: any failure resolves to `'unknown'`, and every non-`suitable`
 * verdict means "use the proven download path". The worst case of this whole
 * feature is therefore exactly today's behavior plus one 64 KB read.
 */
export async function probeRangeSeekSuitability(
  url: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<RangeSeekProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const doFetch = opts.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(url, {
      headers: { Range: `bytes=0-${FASTSTART_PROBE_BYTES - 1}` },
      signal: controller.signal,
    });

    if (!response.ok) {
      return { verdict: 'unknown', detail: `probe returned HTTP ${response.status}`, bytesRead: 0 };
    }
    if (response.status !== 206 || !response.headers.get('content-range')) {
      // A 200 means the provider sent the WHOLE object — no ranged reads, so
      // streaming would re-fetch the file per seek.
      return {
        verdict: 'no-range-support',
        detail: `provider answered HTTP ${response.status} without Content-Range`,
        bytesRead: 0,
      };
    }

    const head = Buffer.from(await response.arrayBuffer());
    const layout = findMp4IndexPosition(head);

    if (layout === 'front') {
      return { verdict: 'suitable', detail: 'moov atom at the front (faststart)', bytesRead: head.length };
    }
    if (layout === 'back') {
      return {
        verdict: 'not-faststart',
        detail: 'mdat precedes moov — the index is at the end of the file',
        bytesRead: head.length,
      };
    }
    return {
      verdict: 'unknown',
      detail: 'container layout not recognized in the probed head',
      bytesRead: head.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { verdict: 'unknown', detail: `probe failed: ${msg}`, bytesRead: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk the top-level ISO-BMFF (MP4/MOV) box list in `head` and report whether
 * the `moov` index box comes before or after the `mdat` media payload.
 *
 * Returns `'unknown'` for a non-ISO-BMFF container (WebM, AVI, …) or when the
 * probed window ends before either box is seen — both of which route to the
 * download path rather than guessing.
 */
function findMp4IndexPosition(head: Buffer): 'front' | 'back' | 'unknown' {
  let offset = 0;

  // A box is: 4-byte big-endian size, 4-byte type. Size 1 means the real
  // 64-bit size follows the type; size 0 means "to end of file".
  while (offset + 8 <= head.length) {
    const size32 = head.readUInt32BE(offset);
    const type = head.toString('latin1', offset + 4, offset + 8);

    if (type === 'moov') return 'front';
    if (type === 'mdat') return 'back';

    let boxSize: number;
    if (size32 === 1) {
      if (offset + 16 > head.length) return 'unknown';
      // Read the 64-bit size as a Number — real box sizes are far below 2^53.
      boxSize = Number(head.readBigUInt64BE(offset + 8));
    } else if (size32 === 0) {
      // Extends to EOF, so nothing further can appear before it.
      return 'unknown';
    } else {
      boxSize = size32;
    }

    // A malformed or absurd size means this is not an ISO-BMFF file (or is
    // corrupt); either way, do not guess.
    if (boxSize < 8 || !Number.isSafeInteger(boxSize)) return 'unknown';
    offset += boxSize;
  }

  return 'unknown';
}
