/**
 * convert/ffmpeg.ts — ffmpeg subprocess wrapper (the only subprocess module in
 * the convert feature).
 *
 * Uses Node built-ins only (child_process + os) — ffmpeg is a runtime binary the
 * user must have installed, NOT an npm dependency.  The wrapper detects its
 * absence and surfaces a clear, platform-aware install hint.
 *
 * Conversion strategy: a fast, lossless stream-copy remux is attempted first
 * (`-c:v copy`), transcoding only audio to AAC (MTS/AVI audio is frequently
 * AC-3/MP2/WMA, which MP4 handles poorly).  If the remux fails — e.g. the video
 * codec is not MP4-compatible (ProRes, some exotic AVI) — a full H.264 re-encode
 * is attempted as a fallback.
 */

import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import type { ConvertMode } from './events.js';

// ---------------------------------------------------------------------------
// ffmpeg-not-found error with a platform-aware install hint
// ---------------------------------------------------------------------------

/** Per-platform ffmpeg install hint. */
export function ffmpegInstallHint(platform: NodeJS.Platform = os.platform()): string {
  switch (platform) {
    case 'darwin':
      return 'Install ffmpeg with: brew install ffmpeg';
    case 'win32':
      return 'Install ffmpeg with: winget install ffmpeg  (or: choco install ffmpeg)';
    default:
      return 'Install ffmpeg with: sudo apt install ffmpeg  (or your distro package manager)';
  }
}

export class FfmpegNotFoundError extends Error {
  /** A ready-to-print install hint for the current platform. */
  readonly hint: string;

  constructor(message?: string) {
    super(message ?? 'ffmpeg was not found on your PATH.');
    this.name = 'FfmpegNotFoundError';
    this.hint = ffmpegInstallHint();
  }
}

// ---------------------------------------------------------------------------
// Availability detection (memoized per process)
// ---------------------------------------------------------------------------

export interface FfmpegInfo {
  available: boolean;
  version?: string;
}

let cachedDetect: Promise<FfmpegInfo> | null = null;

/**
 * Detect whether `ffmpeg` is runnable on the PATH by invoking `ffmpeg -version`.
 * Never throws — resolves `{ available: false }` on ENOENT or a non-zero exit.
 * The result is memoized for the lifetime of the process.
 */
export function detectFfmpeg(bin = 'ffmpeg'): Promise<FfmpegInfo> {
  if (cachedDetect) return cachedDetect;

  cachedDetect = new Promise<FfmpegInfo>((resolve) => {
    execFile(bin, ['-version'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({ available: false });
        return;
      }
      // First line looks like: "ffmpeg version 6.1.1 Copyright ..."
      const firstLine = String(stdout).split('\n', 1)[0]?.trim();
      const match = firstLine?.match(/ffmpeg version (\S+)/i);
      resolve({ available: true, version: match?.[1] });
    });
  });

  return cachedDetect;
}

/** Reset the memoized detection result (test-only). */
export function _resetDetectCache(): void {
  cachedDetect = null;
}

// ---------------------------------------------------------------------------
// ffmpeg argument construction (pure — exported for unit testing)
// ---------------------------------------------------------------------------

export interface ConvertArgOptions {
  crf?: number;
}

/** Default constant rate factor for the re-encode fallback. */
export const DEFAULT_CRF = 20;

/**
 * Build the ffmpeg argument vector for a single conversion.
 *
 * remux    — copy the video stream losslessly, transcode audio to AAC.
 * reencode — full H.264 (libx264) + AAC re-encode.
 *
 * Both paths preserve container metadata (`-map_metadata 0`, keeps capture date)
 * and enable web-friendly progressive playback (`+faststart`).
 */
export function buildConvertArgs(
  src: string,
  tmpOut: string,
  mode: ConvertMode,
  opts: ConvertArgOptions = {},
): string[] {
  const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src];
  if (mode === 'remux') {
    return [
      ...common,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-map_metadata', '0',
      '-movflags', '+faststart',
      tmpOut,
    ];
  }
  const crf = opts.crf ?? DEFAULT_CRF;
  return [
    ...common,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', String(crf),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-map_metadata', '0',
    '-movflags', '+faststart',
    tmpOut,
  ];
}

// ---------------------------------------------------------------------------
// Single-file conversion
// ---------------------------------------------------------------------------

export interface ConvertFileOptions {
  /** Force the full re-encode path (skip the remux attempt). */
  forceReencode?: boolean;
  /** Constant rate factor for the re-encode path. */
  crf?: number;
  /** ffmpeg binary (override for tests). */
  bin?: string;
  /** Abort signal to cancel an in-flight conversion. */
  signal?: AbortSignal;
}

export interface ConvertFileResult {
  mode: ConvertMode;
  bytesIn: number;
  bytesOut: number;
}

/** Run one ffmpeg invocation to completion; resolve on exit 0, reject otherwise. */
function runFfmpeg(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      // Keep only the tail so a chatty encoder can't balloon memory.
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new FfmpegNotFoundError());
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = stderr.trim().split('\n').slice(-3).join('\n');
        reject(new Error(`ffmpeg exited with code ${code}${tail ? `: ${tail}` : ''}`));
      }
    });
  });
}

/**
 * Convert `src` to `finalTarget` (an `.mp4` path).
 *
 * Writes to a temp sibling (`<finalTarget>.partial`) and renames on success, so
 * a crash/kill never leaves a truncated `.mp4` that a later idempotent-skip run
 * would mistake for a finished conversion.  Attempts a remux first, falling back
 * to a full re-encode when the remux fails (unless `forceReencode`).  Cleans up
 * the temp file on any failure.
 */
export async function convertFile(
  src: string,
  finalTarget: string,
  opts: ConvertFileOptions = {},
): Promise<ConvertFileResult> {
  const bin = opts.bin ?? 'ffmpeg';
  const tmpOut = `${finalTarget}.partial`;

  const cleanupTmp = (): void => {
    try {
      if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    } catch {
      // best-effort
    }
  };

  const attempt = async (mode: ConvertMode): Promise<void> => {
    cleanupTmp();
    await runFfmpeg(bin, buildConvertArgs(src, tmpOut, mode, { crf: opts.crf }), opts.signal);
  };

  let mode: ConvertMode;
  try {
    if (opts.forceReencode) {
      await attempt('reencode');
      mode = 'reencode';
    } else {
      try {
        await attempt('remux');
        mode = 'remux';
      } catch (remuxErr) {
        // ffmpeg genuinely missing — no point retrying the re-encode path.
        if (remuxErr instanceof FfmpegNotFoundError) throw remuxErr;
        await attempt('reencode');
        mode = 'reencode';
      }
    }
  } catch (err) {
    cleanupTmp();
    throw err;
  }

  // Verify the output is real and non-empty before committing.
  let outStat: fs.Stats;
  try {
    outStat = fs.statSync(tmpOut);
  } catch {
    cleanupTmp();
    throw new Error(`ffmpeg reported success but produced no output for ${src}`);
  }
  if (outStat.size === 0) {
    cleanupTmp();
    throw new Error(`ffmpeg produced an empty file for ${src}`);
  }

  const bytesIn = fs.statSync(src).size;
  const bytesOut = outStat.size;

  // Commit: rename temp → final, with a cross-device fallback (copied from the
  // organize engine's move logic).
  try {
    fs.renameSync(tmpOut, finalTarget);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
      fs.copyFileSync(tmpOut, finalTarget);
      fs.unlinkSync(tmpOut);
    } else {
      cleanupTmp();
      throw err;
    }
  }

  return { mode, bytesIn, bytesOut };
}
