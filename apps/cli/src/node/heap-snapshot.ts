/**
 * node/heap-snapshot.ts — On-demand V8 heap snapshots from a live worker.
 *
 * WHY THIS EXISTS (issue #156). The worker leaks slowly under sustained import
 * load and the only way to name the retainer is a heap snapshot taken from a
 * process that is ALREADY leaking. Two shipped mechanisms were supposed to
 * provide one, and neither can:
 *
 *  1. `--heapsnapshot-near-heap-limit=1` (see runtime-tuning.ts) only fires
 *     from V8's near-heap-limit callback — i.e. essentially at OOM time.
 *  2. The pre-OOM safety valve drains and exits at ~90% of the ceiling
 *     (`MEMORIAHUB_HEAP_RESTART_FRACTION`), which is BELOW where V8 would ever
 *     invoke that callback.
 *
 * So on a correctly-hardened worker the valve always wins: the process recycles
 * cleanly forever and the snapshot is never written. The mitigation that keeps
 * imports alive is exactly what prevents the diagnosis. This module closes that
 * gap by writing the snapshot ourselves — at the valve's threshold, and on
 * demand over the daemon IPC socket (`memoriahub node heap-snapshot`), which is
 * strictly better anyway: a snapshot taken at 90% of an 8 GB ceiling shows the
 * retainer with hours of accumulation behind it, without waiting for a crash.
 *
 * Safety properties (a diagnostic must never be the thing that takes the worker
 * down):
 *   - Never throws. Every failure is returned as a value and logged by callers.
 *   - Disk pre-flight: refuses when free space on the target filesystem is less
 *     than the current heap × `DISK_HEADROOM` (a snapshot is roughly heap-sized,
 *     so an 8 GB heap writes multiple GB). Mirrors the API's
 *     `assertDiskSpaceForDownload` headroom precedent.
 *   - Retention: keeps only the newest `keep` snapshots in the directory, so a
 *     worker that recycles repeatedly cannot fill the disk with them.
 *   - Opt-out via `MEMORIAHUB_HEAP_SNAPSHOT=0`, the same switch that already
 *     suppresses the near-OOM launch flag.
 *
 * `v8.writeHeapSnapshot()` is synchronous and stops the world for seconds on a
 * multi-GB heap. That is acceptable at both call sites: the valve is about to
 * drain and exit anyway, and the manual command is an explicit operator action.
 * In-flight job leases are renewed on a 30 s ticker and the server's lease
 * window is far wider, so a stalled tick is harmless.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import v8 from 'node:v8';
import { logsDir } from '../paths.js';

/** Set to '0' to suppress heap snapshots (shared with the near-OOM launch flag). */
const HEAP_SNAPSHOT_ENV = 'MEMORIAHUB_HEAP_SNAPSHOT';

/** Prefix + extension of snapshots this module writes (also the prune filter). */
export const HEAP_SNAPSHOT_PREFIX = 'heap-';
export const HEAP_SNAPSHOT_EXT = '.heapsnapshot';

/** Snapshots retained in the target directory, newest first. */
export const DEFAULT_SNAPSHOT_KEEP = 2;

/**
 * Free bytes required, as a multiple of the current heap size, before writing.
 * A snapshot serializes the live object graph, so it lands in the same order of
 * magnitude as `heapTotal`; 1.5× leaves room for the file plus normal operation.
 */
export const DISK_HEADROOM = 1.5;

/** Why a snapshot did not produce a file. */
export type HeapSnapshotSkipReason = 'disabled' | 'insufficient-disk';

export interface HeapSnapshotResult {
  ok: boolean;
  /** Absolute path of the written snapshot (only when `ok`). */
  path?: string;
  /** Size of the written snapshot in bytes (only when `ok`). */
  bytes?: number;
  /** Wall-clock cost of the write in ms (only when `ok`). */
  durationMs?: number;
  /** Set when the snapshot was deliberately not taken. */
  skipped?: HeapSnapshotSkipReason;
  /** Set when the snapshot was attempted and failed. */
  error?: string;
  /** Number of older snapshots deleted by retention. */
  pruned?: number;
  /** Free bytes observed on the target filesystem, when measurable. */
  freeBytes?: number;
  /** Bytes the pre-flight required (heap × DISK_HEADROOM), when measurable. */
  requiredBytes?: number;
}

export interface HeapSnapshotOptions {
  /** Target directory (default: the worker log directory). */
  dir?: string;
  /** Short tag folded into the filename, e.g. 'critical' or 'manual'. */
  reason?: string;
  /** Snapshots to retain, including the new one (default DEFAULT_SNAPSHOT_KEEP). */
  keep?: number;
  /** Injectable for tests — defaults to `v8.writeHeapSnapshot`. */
  writeFn?: (filename: string) => string;
  /** Injectable for tests — free bytes on the filesystem holding `dir`, or null when unmeasurable. */
  freeBytesFn?: (dir: string) => number | null;
  /** Injectable for tests — current heap size in bytes. */
  heapBytesFn?: () => number;
}

/** True unless the operator suppressed snapshots via `MEMORIAHUB_HEAP_SNAPSHOT=0`. */
export function heapSnapshotsEnabled(): boolean {
  return process.env[HEAP_SNAPSHOT_ENV] !== '0';
}

/**
 * Free bytes on the filesystem holding `dir`, or `null` when it cannot be
 * measured (older Node, unsupported platform). `null` means "proceed": a
 * missing measurement must not permanently disable the diagnostic — retention
 * still bounds how much space snapshots can occupy.
 */
function defaultFreeBytes(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/** Filesystem-safe, sortable timestamp: 2026-08-08T14-03-11-284Z. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** Snapshot filename for a pid/reason/time — exported for tests and callers that log it. */
export function heapSnapshotFilename(reason: string, pid: number, now: Date): string {
  const tag = reason.replace(/[^a-z0-9_-]/gi, '') || 'manual';
  return `${HEAP_SNAPSHOT_PREFIX}${tag}-${pid}-${stamp(now)}${HEAP_SNAPSHOT_EXT}`;
}

/**
 * Delete the oldest snapshots in `dir` until at most `keep` remain. Ordering is
 * by filename, which sorts chronologically because the timestamp is ISO-8601.
 * Best-effort: an unreadable directory or an undeletable file is ignored.
 * Returns the number of files actually removed.
 */
export function pruneHeapSnapshots(dir: string, keep: number): number {
  if (keep < 0) return 0;
  let entries: string[];
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(HEAP_SNAPSHOT_PREFIX) && f.endsWith(HEAP_SNAPSHOT_EXT))
      .sort();
  } catch {
    return 0;
  }
  const excess = entries.length - keep;
  if (excess <= 0) return 0;
  let pruned = 0;
  for (const name of entries.slice(0, excess)) {
    try {
      fs.unlinkSync(path.join(dir, name));
      pruned += 1;
    } catch {
      /* best-effort */
    }
  }
  return pruned;
}

/**
 * Write a heap snapshot of THIS process, applying the opt-out, disk pre-flight
 * and retention described in the module header. Never throws — inspect the
 * returned `HeapSnapshotResult`.
 */
export function writeWorkerHeapSnapshot(opts: HeapSnapshotOptions = {}): HeapSnapshotResult {
  if (!heapSnapshotsEnabled()) return { ok: false, skipped: 'disabled' };

  const keep = Math.max(1, opts.keep ?? DEFAULT_SNAPSHOT_KEEP);
  const heapBytes = (opts.heapBytesFn ?? (() => v8.getHeapStatistics().total_heap_size))();
  const freeBytesFn = opts.freeBytesFn ?? defaultFreeBytes;
  const writeFn = opts.writeFn ?? ((filename: string) => v8.writeHeapSnapshot(filename));

  let dir: string;
  try {
    dir = opts.dir ?? logsDir();
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Prune to keep-1 BEFORE writing so the new snapshot has room and the
  // directory never transiently holds keep+1 multi-GB files.
  const pruned = pruneHeapSnapshots(dir, keep - 1);

  const requiredBytes = Math.round(heapBytes * DISK_HEADROOM);
  const freeBytes = freeBytesFn(dir);
  if (freeBytes !== null && freeBytes < requiredBytes) {
    return { ok: false, skipped: 'insufficient-disk', pruned, freeBytes, requiredBytes };
  }

  const target = path.join(dir, heapSnapshotFilename(opts.reason ?? 'manual', process.pid, new Date()));
  const startedAt = Date.now();
  let written: string;
  try {
    written = writeFn(target) || target;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), pruned };
  }

  let bytes = 0;
  try {
    bytes = fs.statSync(written).size;
  } catch {
    /* the file was written but is not stat-able — report 0 rather than fail */
  }

  return {
    ok: true,
    path: written,
    bytes,
    durationMs: Date.now() - startedAt,
    pruned,
    ...(freeBytes !== null && { freeBytes, requiredBytes }),
  };
}

/** One-line human summary of a result, used by the CLI and the worker log. */
export function describeHeapSnapshotResult(res: HeapSnapshotResult): string {
  if (res.ok) {
    const mb = Math.round((res.bytes ?? 0) / (1024 * 1024));
    return `wrote ${res.path} (${mb} MB in ${res.durationMs ?? 0}ms)`;
  }
  if (res.skipped === 'disabled') {
    return 'heap snapshots are disabled (MEMORIAHUB_HEAP_SNAPSHOT=0)';
  }
  if (res.skipped === 'insufficient-disk') {
    const freeMb = Math.round((res.freeBytes ?? 0) / (1024 * 1024));
    const needMb = Math.round((res.requiredBytes ?? 0) / (1024 * 1024));
    return `not enough free disk for a heap snapshot (${freeMb} MB free, ~${needMb} MB required)`;
  }
  return `heap snapshot failed: ${res.error ?? 'unknown error'}`;
}
