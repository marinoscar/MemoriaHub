/**
 * Thin in-house ffmpeg / ffprobe process wrapper (issue #219, epic #214).
 *
 * Replaces the deprecated `fluent-ffmpeg` package, which was a DIRECT
 * first-party dependency of both `apps/api` and this package and the only
 * remaining violator of epic #214's "npm install emits no deprecation warning
 * traceable to a direct first-party dependency" criterion. `fluent-ffmpeg@2.1.3`
 * is the latest published release, is marked "no longer supported", and has no
 * maintained successor under that name.
 *
 * The wrapper lives HERE, in the shared parity package, rather than in
 * apps/api or apps/cli, because the server and every distributed worker node
 * must invoke ffmpeg with byte-identical arguments — a divergent argv (most
 * critically, moving `-ss` from before `-i` to after it, which switches
 * ffmpeg from fast input seek to slow-but-exact output seek and lands on a
 * DIFFERENT frame) would silently break the numerical-parity guarantee in
 * docs/specs/distributed-nodes.md §7. There is exactly one implementation and
 * `test/ffmpeg.test.mjs` pins the exact argv for every call shape.
 *
 * PARITY NOTE — the argv builders below reproduce, byte for byte, what
 * fluent-ffmpeg's own `FfmpegCommand#_getArguments()` produced for the four
 * chains this codebase actually used (measured against the real library
 * before its removal):
 *
 *   ffmpeg(in).seekInput(s).frames(1).output(out)
 *     -> ['-ss', s, '-i', in, '-y', '-vframes', '1', out]
 *   ffmpeg(in).videoFilters('thumbnail').frames(1).output(out)
 *     -> ['-i', in, '-y', '-vframes', '1', '-filter:v', 'thumbnail', out]
 *   ffmpeg(in).frames(1).output(out)
 *     -> ['-i', in, '-y', '-vframes', '1', out]
 *
 * and, for ffprobe:
 *
 *   ffmpeg.ffprobe(src, cb)  ->  spawn(ffprobe, ['-show_streams', '-show_format', src])
 *
 * `parseFfprobeOutput` below is a verbatim port of fluent-ffmpeg's
 * `lib/ffprobe.js` parser (including its legacy `TAG:` / `DISPOSITION:` key
 * folding). It deliberately does NOT switch to `-print_format json`: ffprobe's
 * JSON writer emits most numerics as STRINGS, whereas this parser coerces them
 * to JS numbers, and those values are persisted into
 * `storage_object.metadata._processing` and normalized into `ContainerMetadata`.
 * Switching output formats would silently change persisted data types.
 *
 * Importing this module NEVER requires the ffmpeg binaries to exist —
 * `node:child_process` is a builtin, and a missing binary surfaces only when a
 * run is actually attempted (as an ENOENT spawn error).
 */

import { spawn as childProcessSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

// ---------------------------------------------------------------------------
// Spawn seam (test-only)
// ---------------------------------------------------------------------------

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

let spawnImpl: SpawnLike = childProcessSpawn as unknown as SpawnLike;

/**
 * TEST-ONLY seam: swap the `child_process.spawn` implementation used by
 * `runFfmpeg`/`runFfprobe`.
 *
 * This package's tests run under `node --test` with no module-mocking flag
 * available (see test/video.test.mjs's header), and apps/api's Jest specs can
 * no longer mock a third-party module that does not exist. An explicit,
 * documented seam is both simpler and more honest than either. Pass `null` to
 * restore the real `spawn`. Production code must never call this.
 */
export function __setSpawnForTests(impl: SpawnLike | null): void {
  spawnImpl = impl ?? (childProcessSpawn as unknown as SpawnLike);
}

// ---------------------------------------------------------------------------
// Binary path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the ffmpeg binary, preserving fluent-ffmpeg's contract: honour the
 * `FFMPEG_PATH` env var when set, otherwise use the bare name and let the OS
 * resolve it through PATH. Deployments may set these, so this must not change.
 */
export function resolveFfmpegPath(): string {
  const configured = process.env.FFMPEG_PATH;
  return configured && configured.trim() ? configured : 'ffmpeg';
}

/** ffprobe counterpart of {@link resolveFfmpegPath} (`FFPROBE_PATH`). */
export function resolveFfprobePath(): string {
  const configured = process.env.FFPROBE_PATH;
  return configured && configured.trim() ? configured : 'ffprobe';
}

// ---------------------------------------------------------------------------
// Argument builders (pure — the parity surface)
// ---------------------------------------------------------------------------

export interface FrameExtractionArgsSpec {
  /** Source media path handed to `-i`. */
  input: string;
  /** Destination path (ffmpeg's positional output argument). */
  output: string;
  /**
   * Seconds to seek to. Emitted as an INPUT option (`-ss` BEFORE `-i`) —
   * fluent-ffmpeg's `seekInput()`. Fast, imprecise seek; moving it after `-i`
   * changes which frame is decoded and is a parity break.
   */
  seekSecs?: number | null;
  /** `-filter:v` value (fluent-ffmpeg's `videoFilters()`), e.g. `'thumbnail'`. */
  videoFilter?: string | null;
}

/**
 * Build the argv for a single-frame ffmpeg extraction/transcode.
 *
 * Argument ORDER is load-bearing — see this module's header for the measured
 * fluent-ffmpeg equivalences this reproduces, and test/ffmpeg.test.mjs for the
 * regression guard.
 */
export function buildFrameExtractionArgs(spec: FrameExtractionArgsSpec): string[] {
  const args: string[] = [];

  // Input options come first — `-ss` before `-i` is an INPUT seek.
  if (spec.seekSecs !== null && spec.seekSecs !== undefined) {
    args.push('-ss', String(spec.seekSecs));
  }

  args.push('-i', spec.input);
  args.push('-y');
  args.push('-vframes', '1');

  if (spec.videoFilter) {
    args.push('-filter:v', spec.videoFilter);
  }

  args.push(spec.output);
  return args;
}

/** Build the argv fluent-ffmpeg's `ffprobe()` used: default (INI-ish) output. */
export function buildFfprobeArgs(input: string): string[] {
  return ['-show_streams', '-show_format', input];
}

// ---------------------------------------------------------------------------
// stderr handling (ported from fluent-ffmpeg's linesRing + utils.extractError)
// ---------------------------------------------------------------------------

const NEWLINE_RE = /\r\n|\r|\n/;

/** Max stderr lines retained, matching fluent-ffmpeg's default ring size. */
const STDERR_MAX_LINES = 100;

function makeLineRing(maxLines: number) {
  const lines: string[] = [];
  let partial = '';

  return {
    append(chunk: string): void {
      partial += chunk;
      const parts = partial.split(NEWLINE_RE);
      partial = parts.pop() ?? '';
      for (const line of parts) {
        lines.push(line);
        if (lines.length > maxLines) lines.shift();
      }
    },
    get(): string {
      return (partial ? [...lines, partial] : lines).join('\n');
    },
  };
}

/**
 * Verbatim port of fluent-ffmpeg's `utils.extractError`: return only the
 * trailing stderr lines that do not start with a space or a square bracket
 * (i.e. drop ffmpeg's banner/progress noise, keep the actual complaint).
 */
export function extractFfmpegError(stderr: string): string {
  return stderr
    .split(NEWLINE_RE)
    .reduce<string[]>((messages, message) => {
      if (message.charAt(0) === ' ' || message.charAt(0) === '[') {
        return [];
      }
      messages.push(message);
      return messages;
    }, [])
    .join('\n');
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

export interface RunOptions {
  /**
   * Hard timeout in ms. The child is killed with SIGKILL (not SIGTERM —
   * ffmpeg ignores SIGTERM mid-decode) and the promise rejects. `0`,
   * `undefined`, or a non-finite value disables the timeout.
   */
  timeoutMs?: number;
  /** Error message used when the timeout fires. */
  timeoutMessage?: string;
}

interface SpawnAndCollectResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `command` and settle exactly once, on whichever of these happens
 * first: process close, spawn error, or timeout.
 *
 * The `settled` guard is load-bearing: the SIGKILL issued on timeout makes the
 * child emit its own 'close' (and potentially 'error') afterwards, and that
 * late event must be a harmless no-op rather than a second settle or an
 * unhandled rejection.
 */
function spawnAndCollect(
  command: string,
  args: readonly string[],
  opts: RunOptions,
  onTimeoutMessage: () => string,
): Promise<SpawnAndCollectResult> {
  return new Promise<SpawnAndCollectResult>((resolve, reject) => {
    const stderrRing = makeLineRing(STDERR_MAX_LINES);
    const stdoutChunks: string[] = [];

    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const settle = (err: Error | null, value?: SpawnAndCollectResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(value as SpawnAndCollectResult);
    };

    let child: ChildProcess;
    try {
      child = spawnImpl(command, args, { windowsHide: true });
    } catch (err) {
      settle(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => stdoutChunks.push(chunk));
    child.stdout?.on('error', () => {});

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => stderrRing.append(chunk));
    child.stderr?.on('error', () => {});

    // ffmpeg polls stdin for interactive keyboard commands; nothing is ever
    // written to it here. Swallow EPIPE/ECONNRESET so an exiting child cannot
    // crash the process (fluent-ffmpeg did the same for its stdin pipe).
    child.stdin?.on('error', () => {});

    child.on('error', (err: Error) => settle(err));

    // 'close' (not 'exit') — it fires only once the stdio streams have also
    // closed, so stderr is complete by the time the error message is built.
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      settle(null, {
        code,
        signal,
        stdout: stdoutChunks.join(''),
        stderr: stderrRing.get(),
      });
    });

    const timeoutMs = opts.timeoutMs;
    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        // SIGKILL — ffmpeg can ignore the default SIGTERM mid-decode.
        try {
          child.kill('SIGKILL');
        } catch {
          // Process already gone.
        }
        settle(new Error(onTimeoutMessage()));
      }, timeoutMs);
    }
  });
}

/**
 * Run ffmpeg with the given argv, resolving on a clean exit and rejecting
 * otherwise.
 *
 * Failure messages mirror fluent-ffmpeg's:
 *   `ffmpeg exited with code <n>: <extractFfmpegError(stderr)>`
 *   `ffmpeg was killed with signal <sig>`
 */
export async function runFfmpeg(args: readonly string[], opts: RunOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs;
  const result = await spawnAndCollect(
    resolveFfmpegPath(),
    args,
    opts,
    () => opts.timeoutMessage ?? `ffmpeg timed out after ${timeoutMs}ms`,
  );

  if (result.code) {
    const detail = extractFfmpegError(result.stderr);
    throw new Error(
      `ffmpeg exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
    );
  }
  if (result.signal) {
    throw new Error(`ffmpeg was killed with signal ${result.signal}`);
  }
}

// ---------------------------------------------------------------------------
// ffprobe
// ---------------------------------------------------------------------------

/** One `[STREAM]` / `[FORMAT]` / `[CHAPTER]` block of ffprobe's default output. */
export interface FfprobeBlock {
  [key: string]: unknown;
  tags?: Record<string, unknown>;
  disposition?: Record<string, unknown>;
}

export interface FfprobeOutput {
  streams: FfprobeBlock[];
  format: FfprobeBlock;
  chapters: FfprobeBlock[];
}

/**
 * Parse ffprobe's DEFAULT (INI-ish) `-show_streams -show_format` output.
 *
 * Verbatim port of fluent-ffmpeg `lib/ffprobe.js`'s `parseFfprobeOutput`
 * (blocks + key/value coercion) plus its legacy `TAG:` / `DISPOSITION:` key
 * folding. Behaviour that must not drift:
 *   - Zero-length lines are dropped before parsing.
 *   - A value is coerced with `Number()` ONLY when its key does not start with
 *     `TAG:` AND it matches /^[0-9]+(\.[0-9]+)?$/ (unsigned, no exponent).
 *     Everything else stays a raw string.
 *   - Inside a block, a line starting with `[` that is not the block's closing
 *     tag is skipped.
 */
export function parseFfprobeOutput(out: string): FfprobeOutput {
  let lines = out.split(NEWLINE_RE);

  lines = lines.filter((line) => line.length > 0);

  const data: FfprobeOutput = {
    streams: [],
    format: {},
    chapters: [],
  };

  function parseBlock(name: string): FfprobeBlock {
    const block: FfprobeBlock = {};

    let line = lines.shift();
    while (typeof line !== 'undefined') {
      if (line.toLowerCase() === '[/' + name + ']') {
        return block;
      } else if (line.match(/^\[/)) {
        line = lines.shift();
        continue;
      }

      const kv = line.match(/^([^=]+)=(.*)$/);
      if (kv) {
        if (!kv[1].match(/^TAG:/) && kv[2].match(/^[0-9]+(\.[0-9]+)?$/)) {
          block[kv[1]] = Number(kv[2]);
        } else {
          block[kv[1]] = kv[2];
        }
      }

      line = lines.shift();
    }

    return block;
  }

  let line = lines.shift();
  while (typeof line !== 'undefined') {
    if (line.match(/^\[stream/i)) {
      data.streams.push(parseBlock('stream'));
    } else if (line.match(/^\[chapter/i)) {
      data.chapters.push(parseBlock('chapter'));
    } else if (line.toLowerCase() === '[format]') {
      data.format = parseBlock('format');
    }

    line = lines.shift();
  }

  // Handle legacy output with "TAG:x" and "DISPOSITION:x" keys.
  for (const target of [data.format, ...data.streams]) {
    if (!target) continue;

    const legacyTagKeys = Object.keys(target).filter((k) => k.match(/^TAG:/));
    if (legacyTagKeys.length) {
      target.tags = target.tags ?? {};
      for (const tagKey of legacyTagKeys) {
        target.tags[tagKey.substr(4)] = target[tagKey];
        delete target[tagKey];
      }
    }

    const legacyDispositionKeys = Object.keys(target).filter((k) => k.match(/^DISPOSITION:/));
    if (legacyDispositionKeys.length) {
      target.disposition = target.disposition ?? {};
      for (const dispositionKey of legacyDispositionKeys) {
        target.disposition[dispositionKey.substr(12)] = target[dispositionKey];
        delete target[dispositionKey];
      }
    }
  }

  return data;
}

export interface RunFfprobeOptions {
  /**
   * Hard timeout in ms; the ffprobe child is SIGKILLed when it elapses.
   *
   * This is a genuine improvement over the fluent-ffmpeg implementation, whose
   * callback-only `ffprobe()` API exposed no process handle — the old code
   * could only race a timer and leave the hung probe orphaned.
   */
  timeoutMs?: number;
  /** Error message used when the timeout fires. */
  timeoutMessage?: string;
}

/**
 * Run ffprobe against a seekable file path and return its parsed output.
 *
 * On a non-zero exit the stderr text is appended to the error message, exactly
 * as fluent-ffmpeg did (`exitError.message += '\n' + stderr`).
 */
export async function runFfprobe(
  input: string,
  opts: RunFfprobeOptions = {},
): Promise<FfprobeOutput> {
  const timeoutMs = opts.timeoutMs;
  const result = await spawnAndCollect(
    resolveFfprobePath(),
    buildFfprobeArgs(input),
    { timeoutMs },
    () => opts.timeoutMessage ?? `ffprobe timed out after ${timeoutMs}ms`,
  );

  let exitError: Error | null = null;
  if (result.code) {
    exitError = new Error(`ffprobe exited with code ${result.code}`);
  } else if (result.signal) {
    exitError = new Error(`ffprobe was killed with signal ${result.signal}`);
  }

  if (exitError) {
    if (result.stderr) {
      exitError.message += '\n' + result.stderr;
    }
    throw exitError;
  }

  return parseFfprobeOutput(result.stdout);
}
