/**
 * test/node/heap-snapshot.spec.ts — Unit tests for src/node/heap-snapshot.ts
 * (on-demand V8 heap snapshots from a live worker, issue #156).
 *
 * The real `v8.writeHeapSnapshot` is never invoked here: it would serialize the
 * whole Jest heap to disk on every assertion. `writeFn` is injected instead, so
 * these tests exercise the surrounding policy — the opt-out, the disk
 * pre-flight, retention, and the never-throws contract — which is the part that
 * can actually go wrong in production.
 *
 * Covered:
 *   1. Writes into the target dir with a sortable, pid-tagged filename.
 *   2. MEMORIAHUB_HEAP_SNAPSHOT=0 suppresses the write entirely.
 *   3. Disk pre-flight refuses when free space < heap × DISK_HEADROOM, and
 *      proceeds when free space cannot be measured (null).
 *   4. Retention prunes oldest-first down to `keep`, counting the new file.
 *   5. A throwing writer is reported as `{ ok: false, error }`, never rethrown.
 *   6. describeHeapSnapshotResult renders each outcome.
 */

import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeWorkerHeapSnapshot,
  pruneHeapSnapshots,
  heapSnapshotFilename,
  heapSnapshotsEnabled,
  describeHeapSnapshotResult,
  DISK_HEADROOM,
  HEAP_SNAPSHOT_EXT,
} from '../../src/node/heap-snapshot.js';

/** Write a zero-byte placeholder so retention has real files to sort/delete. */
function touch(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '');
  return p;
}

describe('heap-snapshot', () => {
  let dir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-heapsnap-'));
    savedEnv = process.env['MEMORIAHUB_HEAP_SNAPSHOT'];
    delete process.env['MEMORIAHUB_HEAP_SNAPSHOT'];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env['MEMORIAHUB_HEAP_SNAPSHOT'];
    else process.env['MEMORIAHUB_HEAP_SNAPSHOT'] = savedEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a snapshot into the target directory with a pid-tagged name', () => {
    const res = writeWorkerHeapSnapshot({
      dir,
      reason: 'critical',
      heapBytesFn: () => 10,
      freeBytesFn: () => 1_000_000,
      writeFn: (filename) => {
        fs.writeFileSync(filename, 'x'.repeat(1234));
        return filename;
      },
    });

    expect(res.ok).toBe(true);
    expect(res.path).toBeDefined();
    expect(path.dirname(res.path!)).toBe(dir);
    expect(path.basename(res.path!)).toMatch(
      new RegExp(`^heap-critical-${process.pid}-.+\\${HEAP_SNAPSHOT_EXT}$`),
    );
    expect(res.bytes).toBe(1234);
    expect(fs.existsSync(res.path!)).toBe(true);
  });

  it('is suppressed entirely by MEMORIAHUB_HEAP_SNAPSHOT=0', () => {
    process.env['MEMORIAHUB_HEAP_SNAPSHOT'] = '0';
    const writeFn = jest.fn();

    expect(heapSnapshotsEnabled()).toBe(false);
    const res = writeWorkerHeapSnapshot({ dir, writeFn: writeFn as never });

    expect(res).toEqual({ ok: false, skipped: 'disabled' });
    expect(writeFn).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('refuses to write when free disk is below heap × DISK_HEADROOM', () => {
    const heapBytes = 1_000_000;
    const writeFn = jest.fn();

    const res = writeWorkerHeapSnapshot({
      dir,
      heapBytesFn: () => heapBytes,
      // Just under the requirement — the pre-flight must reject.
      freeBytesFn: () => Math.round(heapBytes * DISK_HEADROOM) - 1,
      writeFn: writeFn as never,
    });

    expect(res.ok).toBe(false);
    expect(res.skipped).toBe('insufficient-disk');
    expect(res.requiredBytes).toBe(Math.round(heapBytes * DISK_HEADROOM));
    expect(writeFn).not.toHaveBeenCalled();
  });

  it('proceeds when free disk cannot be measured (null) rather than disabling the diagnostic', () => {
    const res = writeWorkerHeapSnapshot({
      dir,
      heapBytesFn: () => 1_000_000,
      freeBytesFn: () => null,
      writeFn: (filename) => {
        fs.writeFileSync(filename, '');
        return filename;
      },
    });

    expect(res.ok).toBe(true);
    expect(res.freeBytes).toBeUndefined();
  });

  it('prunes oldest-first so at most `keep` snapshots remain, counting the new one', () => {
    // ISO timestamps sort chronologically as strings — these are ordered.
    touch(dir, `heap-manual-1-2026-01-01T00-00-00-000Z${HEAP_SNAPSHOT_EXT}`);
    touch(dir, `heap-manual-1-2026-01-02T00-00-00-000Z${HEAP_SNAPSHOT_EXT}`);
    touch(dir, `heap-manual-1-2026-01-03T00-00-00-000Z${HEAP_SNAPSHOT_EXT}`);
    // An unrelated file must never be touched by retention.
    touch(dir, 'node.log');

    const res = writeWorkerHeapSnapshot({
      dir,
      keep: 2,
      heapBytesFn: () => 10,
      freeBytesFn: () => 1_000_000,
      writeFn: (filename) => {
        fs.writeFileSync(filename, '');
        return filename;
      },
    });

    expect(res.ok).toBe(true);
    // keep=2 → pruned down to 1 before writing, so 2 remain after.
    expect(res.pruned).toBe(2);
    const snaps = fs.readdirSync(dir).filter((f) => f.endsWith(HEAP_SNAPSHOT_EXT)).sort();
    expect(snaps).toHaveLength(2);
    expect(snaps[0]).toBe(`heap-manual-1-2026-01-03T00-00-00-000Z${HEAP_SNAPSHOT_EXT}`);
    expect(fs.existsSync(path.join(dir, 'node.log'))).toBe(true);
  });

  it('reports a throwing writer as a result rather than throwing', () => {
    const res = writeWorkerHeapSnapshot({
      dir,
      heapBytesFn: () => 10,
      freeBytesFn: () => 1_000_000,
      writeFn: () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('ENOSPC');
    expect(res.skipped).toBeUndefined();
  });

  it('pruneHeapSnapshots tolerates a missing directory', () => {
    expect(pruneHeapSnapshots(path.join(dir, 'does-not-exist'), 1)).toBe(0);
  });

  it('heapSnapshotFilename strips unsafe characters from the reason tag', () => {
    const name = heapSnapshotFilename('../../etc/passwd', 42, new Date('2026-08-08T14:03:11.284Z'));
    expect(name).toBe(`heap-etcpasswd-42-2026-08-08T14-03-11-284Z${HEAP_SNAPSHOT_EXT}`);
    expect(name).not.toContain('/');
  });

  describe('describeHeapSnapshotResult', () => {
    it('renders success, both skip reasons, and an error', () => {
      expect(
        describeHeapSnapshotResult({ ok: true, path: '/tmp/a.heapsnapshot', bytes: 2 * 1024 * 1024, durationMs: 90 }),
      ).toBe('wrote /tmp/a.heapsnapshot (2 MB in 90ms)');
      expect(describeHeapSnapshotResult({ ok: false, skipped: 'disabled' })).toContain(
        'MEMORIAHUB_HEAP_SNAPSHOT=0',
      );
      expect(
        describeHeapSnapshotResult({
          ok: false,
          skipped: 'insufficient-disk',
          freeBytes: 1024 * 1024,
          requiredBytes: 4 * 1024 * 1024,
        }),
      ).toBe('not enough free disk for a heap snapshot (1 MB free, ~4 MB required)');
      expect(describeHeapSnapshotResult({ ok: false, error: 'boom' })).toBe(
        'heap snapshot failed: boom',
      );
    });
  });
});
