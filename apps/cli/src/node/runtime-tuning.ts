/**
 * node/runtime-tuning.ts — RAM/core-aware runtime hardening for the worker node.
 *
 * The worker node is a long-lived process that decodes images and streams media
 * for hours under sustained upload load. Two problems this module solves:
 *
 *  1. **V8 heap ceiling.** Node's default old-space limit (~2 GB on a 64-bit
 *     build regardless of how much RAM the box has) is far too small for a
 *     process that churns through tens of thousands of image jobs. A slow heap
 *     climb that would take *hours* to matter still eventually hits that 2 GB
 *     wall and the process dies with "Ineffective mark-compacts near heap
 *     limit — JavaScript heap out of memory". Since every machine that runs the
 *     worker is assumed to have **≥16 GB RAM and ≥8 cores**, we raise the
 *     old-space limit to a generous fraction of physical RAM so the same climb
 *     has many more hours of headroom (and, in practice, GC keeps up long
 *     before the raised ceiling is reached).
 *
 *  2. **libvips/sharp native pressure.** sharp keeps a per-process operation
 *     cache and, by default, fans each pipeline out across every CPU core. A
 *     worker processes a stream of *distinct* images, so the cache never gets a
 *     hit — it only pins native memory — and unbounded per-op parallelism ×
 *     concurrent jobs spikes peak RSS. We disable the cache and bound libvips
 *     concurrency once at startup.
 *
 * The heap limit can only be set as a `node` launch flag, not at runtime, so
 * `maybeReexecWithHeapLimit()` re-execs the process once with the computed
 * `--max-old-space-size` (plus a near-OOM heap-snapshot flag for diagnosis) the
 * first time `node start` runs. It is a no-op when the flag is already in
 * effect (e.g. a container/systemd unit that set NODE_OPTIONS, or the re-exec'd
 * child itself), so it costs at most one extra fork per worker launch.
 *
 * All three levers are overridable by env so an operator on a smaller box (or a
 * memory-limited container) can dial them down — see the constants below.
 */

import * as os from 'node:os';
import v8 from 'node:v8';
import { spawn } from 'node:child_process';

/** Set to '1' in the re-exec'd child's env so it never re-execs a second time. */
const HEAP_TUNED_ENV = 'MEMORIAHUB_HEAP_TUNED';

/**
 * Manual override for the computed `--max-old-space-size` (MB). Set to `0` to
 * disable heap re-tuning entirely (keep Node's default ceiling). Any other
 * non-negative integer forces that exact value.
 */
const HEAP_OVERRIDE_ENV = 'MEMORIAHUB_MAX_OLD_SPACE_MB';

/** Set to '0' to skip the `--heapsnapshot-near-heap-limit` diagnostic flag. */
const HEAP_SNAPSHOT_ENV = 'MEMORIAHUB_HEAP_SNAPSHOT';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Floor for the raised heap ceiling — below this, don't bother re-tuning. */
const HEAP_MIN_MB = 4096;
/** Cap so we never hand the whole machine to one V8 old space. */
const HEAP_MAX_MB = 12288;

/**
 * Compute the target V8 old-space limit (MB) from physical RAM. Gives old space
 * ~50 % of RAM, rounded down to a 256 MB step, clamped to [HEAP_MIN_MB,
 * HEAP_MAX_MB]. On the assumed ≥16 GB baseline this yields 8192 MB.
 *
 * `MEMORIAHUB_MAX_OLD_SPACE_MB` overrides: `0` disables (returns 0), any other
 * non-negative integer is used verbatim.
 */
export function resolveHeapLimitMb(totalBytes: number = os.totalmem()): number {
  const override = process.env[HEAP_OVERRIDE_ENV];
  if (override !== undefined && override.trim() !== '') {
    const n = Number.parseInt(override, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const totalMb = Math.floor(totalBytes / MB);
  const half = Math.floor((totalMb * 0.5) / 256) * 256;
  return Math.min(Math.max(half, HEAP_MIN_MB), HEAP_MAX_MB);
}

/** Current process's V8 old-space ceiling in MB. */
function currentHeapLimitMb(): number {
  return Math.floor(v8.getHeapStatistics().heap_size_limit / MB);
}

/**
 * True when the running process already has (at least ~95 % of) the target heap
 * ceiling — either because it was launched with the flag / NODE_OPTIONS, or
 * because this IS the re-exec'd child (sentinel set). Prevents a re-exec loop.
 */
export function heapAlreadyTuned(targetMb: number): boolean {
  if (process.env[HEAP_TUNED_ENV] === '1') return true;
  return currentHeapLimitMb() >= Math.floor(targetMb * 0.95);
}

/**
 * Build the `node` launch flags that harden the worker's memory posture:
 *   --max-old-space-size=<targetMb>   raise the old-space ceiling
 *   --heapsnapshot-near-heap-limit=1  on genuine near-OOM, write ONE heap
 *                                     snapshot so a recurrence yields the exact
 *                                     retainer instead of just a fatal log line
 *
 * Returns `[]` when heap tuning is disabled (`MEMORIAHUB_MAX_OLD_SPACE_MB=0`).
 * `targetMb` defaults to `resolveHeapLimitMb()`.
 */
export function heapNodeFlags(targetMb: number = resolveHeapLimitMb()): string[] {
  if (targetMb <= 0) return [];
  const flags = [`--max-old-space-size=${targetMb}`];
  if (process.env[HEAP_SNAPSHOT_ENV] !== '0') {
    flags.push('--heapsnapshot-near-heap-limit=1');
  }
  return flags;
}

/** Env for a spawned worker child that already carries the heap flags. */
export function tunedChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, [HEAP_TUNED_ENV]: '1' };
}

/**
 * Re-exec the current process once with the computed heap flags, unless it is
 * already tuned or tuning is disabled. Returns `true` when a re-exec was
 * started (the caller MUST stop all further work — this process is now just a
 * signal-forwarding shim that exits when the child does); `false` when the
 * caller should proceed normally in-process.
 *
 * Signal handling: SIGINT/SIGTERM/SIGHUP are forwarded to the child so the
 * worker's graceful drain-on-shutdown still works (container SIGTERM, systemd
 * stop, Ctrl-C). The shim exits with the child's exit code / re-raises its
 * terminating signal, so it is transparent to whatever supervises it (PID 1 in
 * a container, systemd, a shell).
 *
 * Skipped automatically under Jest (`JEST_WORKER_ID`) so unit tests never fork.
 */
export function maybeReexecWithHeapLimit(): boolean {
  if (process.env['JEST_WORKER_ID'] !== undefined) return false;

  const targetMb = resolveHeapLimitMb();
  if (targetMb <= 0) return false; // explicitly disabled
  if (heapAlreadyTuned(targetMb)) {
    // Mark tuned so any child we later spawn (detached daemon) knows the flag
    // is already in force and skips its own guard check.
    process.env[HEAP_TUNED_ENV] = '1';
    return false;
  }

  const flags = heapNodeFlags(targetMb);
  const entry = process.argv[1];
  if (!entry) return false; // no script path (e.g. REPL) — nothing to re-exec

  const child = spawn(
    process.execPath,
    [...flags, entry, ...process.argv.slice(2)],
    { stdio: 'inherit', env: tunedChildEnv() },
  );

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const forward = (sig: NodeJS.Signals): void => {
    try {
      child.kill(sig);
    } catch {
      /* child may already be gone */
    }
  };
  for (const sig of signals) process.on(sig, () => forward(sig));

  child.on('exit', (code, sig) => {
    if (sig) {
      // Re-raise the terminating signal so the supervisor observes the true
      // cause (clear our handler first so we don't loop).
      for (const s of signals) process.removeAllListeners(s);
      try {
        process.kill(process.pid, sig);
      } catch {
        process.exit(1);
      }
      return;
    }
    process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    // Could not re-exec (e.g. spawn failure) — surface and exit non-zero so a
    // supervisor restarts us rather than silently running untuned.
    process.stderr.write(
      `worker heap re-exec failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });

  return true;
}

// ---------------------------------------------------------------------------
// libvips / sharp bounding
// ---------------------------------------------------------------------------

let sharpConfigured = false;

/**
 * Bound sharp/libvips once per process: disable the (useless-for-a-worker)
 * operation cache and cap per-pipeline concurrency so peak native memory
 * doesn't scale with core count × in-flight jobs. Idempotent and best-effort —
 * sharp is an optional dependency, so a missing module is silently ignored.
 *
 * `concurrency` defaults to `resolveSharpConcurrency()`.
 */
export async function configureSharpRuntime(concurrency?: number): Promise<void> {
  if (sharpConfigured) return;
  sharpConfigured = true;
  try {
    const sharp = (await import('sharp')).default;
    // A worker sees a stream of distinct images — the op cache never hits, it
    // only pins native memory. Disable it outright.
    sharp.cache(false);
    sharp.concurrency(concurrency ?? resolveSharpConcurrency());
  } catch {
    // sharp not installed (lean CLI) — image jobs aren't served here anyway.
  }
}

/**
 * Per-pipeline libvips thread cap. Bounded to keep peak native memory in check
 * on many-core boxes: half the cores, clamped to [1, 4]. Overridable via
 * `MEMORIAHUB_SHARP_CONCURRENCY`.
 */
export function resolveSharpConcurrency(cores: number = os.cpus().length): number {
  const override = process.env['MEMORIAHUB_SHARP_CONCURRENCY'];
  if (override !== undefined && override.trim() !== '') {
    const n = Number.parseInt(override, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return Math.min(Math.max(Math.floor(cores / 2), 1), 4);
}

// ---------------------------------------------------------------------------
// Worker concurrency default
// ---------------------------------------------------------------------------

/**
 * Default number of jobs a worker processes simultaneously, tuned for the
 * assumed ≥16 GB / ≥8-core baseline: half the cores, also gated by RAM
 * (~4 GB/job of headroom), clamped to [2, 4]. Heavy CV runs in the CompreFace
 * sidecar, so the node itself mostly decodes + streams — a few parallel jobs
 * are comfortable at 16 GB with the raised heap ceiling above.
 *
 * Still fully overridable per node via `--concurrency`, `MEMORIAHUB_CONCURRENCY`,
 * or the persisted node config — this only changes the *unset* default.
 */
export function resolveDefaultConcurrency(
  cores: number = os.cpus().length,
  totalBytes: number = os.totalmem(),
): number {
  const byCore = Math.floor(cores / 2);
  const byRam = Math.floor(totalBytes / GB / 4);
  return Math.min(Math.max(Math.min(byCore, byRam), 2), 4);
}
