/**
 * test/backup/headless-backup.spec.ts — `backup run` presentation layer
 * (issue #316): human start/progress/summary output, `--json` NDJSON event
 * stream, and the `--strict` exit-code policy.
 */

import { jest } from '@jest/globals';
import { BackupTypedEmitter, BACKUP_EV, emptyStats } from '../../src/backup/events.js';
import type { BackupEngine } from '../../src/backup/backup-engine.js';
import { renderBackupHeadless, formatBytes } from '../../src/render/headless-backup.js';
import { resolveBackupExitCode } from '../../src/backup/execute-run.js';

/** The renderer only uses `.on`; a bare typed emitter stands in for the engine. */
function fakeEngine(): BackupTypedEmitter {
  return new BackupTypedEmitter();
}

function emitTypicalRun(engine: BackupTypedEmitter, errors = 0): void {
  engine.emit(BACKUP_EV.RUN_STARTED, { runId: 'run-1', kind: 'incremental', trigger: 'manual' });
  engine.emit(BACKUP_EV.PAGE_FETCHED, { pageIndex: 0, items: 2, hasMore: false });
  engine.emit(BACKUP_EV.ITEM_STARTED, { id: 'a' });
  engine.emit(BACKUP_EV.ITEM_DONE, { id: 'a', outcome: 'downloaded', bytes: 1500 });
  engine.emit(BACKUP_EV.ITEM_DONE, { id: 'b', outcome: 'sidecar-only', bytes: 0 });
  if (errors > 0) {
    engine.emit(BACKUP_EV.ITEM_DONE, { id: 'c', outcome: 'failed', bytes: 0, error: 'boom' });
  }
  engine.emit(BACKUP_EV.PAGE_COMMITTED, {
    cursor: { updatedAt: '2024-01-05T00:00:01.000Z', id: 'b' },
    stats: { ...emptyStats(), itemsDownloaded: 1, itemsSkipped: 1, bytesDownloaded: 1500, errors },
  });
  engine.emit(BACKUP_EV.THROTTLE, { delayMs: 2000 });
  engine.emit(BACKUP_EV.RUN_FINISHED, {
    status: 'completed',
    stats: { ...emptyStats(), itemsDownloaded: 1, itemsSkipped: 1, sidecarsWritten: 2, bytesDownloaded: 1500, errors },
  });
}

describe('renderBackupHeadless (human mode)', () => {
  let out: string[];
  let spy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    out = [];
    spy = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as never);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('prints start, progress, throttle notice, and a summary', () => {
    const engine = fakeEngine();
    renderBackupHeadless(engine as unknown as BackupEngine, { json: false, now: () => 1000 });
    emitTypicalRun(engine);

    const text = out.join('');
    expect(text).toContain('Starting backup run run-1');
    expect(text).toContain('1 downloaded');
    expect(text).toContain('Rate limited');
    expect(text).toContain('Status');
    expect(text).toContain('completed');
    expect(text).toContain('1.5 kB'); // bytes in the summary
    expect(text).toContain('Errors       : 0');
  });

  it('lists failed items in the summary', () => {
    const engine = fakeEngine();
    renderBackupHeadless(engine as unknown as BackupEngine, { json: false, now: () => 1000 });
    emitTypicalRun(engine, 1);

    const text = out.join('');
    expect(text).toContain('1 item(s) failed');
    expect(text).toContain('boom');
  });
});

describe('renderBackupHeadless (--json NDJSON mode)', () => {
  it('emits one parseable JSON line per event and nothing else', () => {
    const lines: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    try {
      const engine = fakeEngine();
      renderBackupHeadless(engine as unknown as BackupEngine, {
        json: true,
        write: (line) => lines.push(line),
      });
      emitTypicalRun(engine);
    } finally {
      spy.mockRestore();
    }

    // stdout untouched — everything went through the injected sink.
    expect(spy).not.toHaveBeenCalled();

    const parsed = lines.map((l) => {
      expect(l.endsWith('\n')).toBe(true);
      return JSON.parse(l) as Record<string, unknown>;
    });
    expect(parsed.map((p) => p['event'])).toEqual([
      'run-started',
      'page-fetched',
      'item-started',
      'item-done',
      'item-done',
      'page-committed',
      'throttle',
      'run-finished',
    ]);
    const done = parsed.find((p) => p['event'] === 'item-done');
    expect(done).toMatchObject({ id: 'a', outcome: 'downloaded', bytes: 1500 });
    const finished = parsed[parsed.length - 1];
    expect(finished).toMatchObject({ event: 'run-finished', status: 'completed' });
  });
});

describe('resolveBackupExitCode (--strict policy)', () => {
  const stats = (errors: number): ReturnType<typeof emptyStats> => ({ ...emptyStats(), errors });

  it('exits 0 on a clean completed run, strict or not', () => {
    expect(resolveBackupExitCode({ runId: 'r', status: 'completed', stats: stats(0) }, false)).toBe(0);
    expect(resolveBackupExitCode({ runId: 'r', status: 'completed', stats: stats(0) }, true)).toBe(0);
  });

  it('exits 0 on item errors without --strict, 1 with --strict', () => {
    expect(resolveBackupExitCode({ runId: 'r', status: 'completed', stats: stats(3) }, false)).toBe(0);
    expect(resolveBackupExitCode({ runId: 'r', status: 'completed', stats: stats(3) }, true)).toBe(1);
  });

  it('always exits non-zero on a failed run', () => {
    expect(resolveBackupExitCode({ runId: 'r', status: 'failed', stats: stats(0) }, false)).toBe(1);
    expect(resolveBackupExitCode({ runId: 'r', status: 'failed', stats: stats(0) }, true)).toBe(1);
  });
});

describe('formatBytes', () => {
  it('formats decimal units', () => {
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1500)).toBe('1.5 kB');
    expect(formatBytes(2_500_000)).toBe('2.5 MB');
    expect(formatBytes(3_200_000_000)).toBe('3.2 GB');
  });
});
