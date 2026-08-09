/**
 * test/backup/backup-host.spec.ts — BackupHost run ownership (issue #318).
 *
 * The engine-run seam is injected, so these tests exercise the HOST contract
 * without a real BackupEngine: single-run serialization (busy rejection),
 * 'backup-event' re-broadcast frame shape, LIVE set-rate application (the
 * mutable engineOpts holder + TokenBucket.setRate — the next page/chunk uses
 * the new values), cooperative cancel (including a cancel racing engine
 * construction), and the status snapshot.
 */

import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BackupHost,
  BackupBusyError,
  BACKUP_HOST_EVENT,
  type BackupHostDeps,
  type BackupHostEventFrame,
  type BackupRunContext,
} from '../../src/backup/backup-host.js';
import type { BackupRunOutcome } from '../../src/backup/backup-engine.js';
import { BACKUP_EV, BackupTypedEmitter, emptyStats } from '../../src/backup/events.js';
import { openCatalogDb } from '../../src/backup/catalog-db.js';
import { CatalogRepo } from '../../src/backup/catalog-repo.js';
import { CHECKPOINT_CURSOR_KEY } from '../../src/backup/backup-engine.js';
import type { NodeLogger } from '../../src/node/logger.js';
import type { SettingsRepo } from '../../src/repo/settings.js';

function stubLogger(): NodeLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logPath: '(stub)',
    log: (level, fields) => lines.push(JSON.stringify({ level, ...fields })),
    info: (msg, payload) => lines.push(`info: ${msg} ${JSON.stringify(payload ?? {})}`),
    warn: (msg, payload) => lines.push(`warn: ${msg} ${JSON.stringify(payload ?? {})}`),
    error: (msg, payload) => lines.push(`error: ${msg} ${JSON.stringify(payload ?? {})}`),
    tail: (n) => lines.slice(-n),
  };
}

/** In-memory stand-in for the settings KV throttle knobs. */
function stubSettings(): SettingsRepo & { values: Map<string, number> } {
  const values = new Map<string, number>([
    ['backup.concurrency', 2],
    ['backup.maxMbps', 0],
    ['backup.pageSize', 100],
    ['backup.pacingMs', 0],
  ]);
  return {
    values,
    backupConcurrency: () => values.get('backup.concurrency')!,
    backupMaxMbps: () => values.get('backup.maxMbps')!,
    backupPageSize: () => values.get('backup.pageSize')!,
    backupPacingMs: () => values.get('backup.pacingMs')!,
    setBackupConcurrency: (n: number) => void values.set('backup.concurrency', n),
    setBackupMaxMbps: (m: number) => void values.set('backup.maxMbps', m),
  } as unknown as SettingsRepo & { values: Map<string, number> };
}

/** A fake attachable engine: typed emitter + cancel spy. */
class FakeEngine extends BackupTypedEmitter {
  cancelled = false;
  cancel(): void {
    this.cancelled = true;
  }
}

interface Harness {
  host: BackupHost;
  settings: ReturnType<typeof stubSettings>;
  logger: ReturnType<typeof stubLogger>;
  contexts: BackupRunContext[];
  engines: FakeEngine[];
  /** Resolve the currently-pending injected run. */
  finishRun: (outcome?: Partial<BackupRunOutcome>) => void;
}

function makeHost(depsOver: Partial<BackupHostDeps> = {}, root = '/tmp/backup-root'): Harness {
  const settings = stubSettings();
  const logger = stubLogger();
  const contexts: BackupRunContext[] = [];
  const engines: FakeEngine[] = [];
  let resolveRun: ((o: BackupRunOutcome) => void) | null = null;

  const runBackupFn = jest.fn<(ctx: BackupRunContext) => Promise<BackupRunOutcome>>((ctx) => {
    contexts.push(ctx);
    const engine = new FakeEngine();
    engines.push(engine);
    ctx.attachEngine(engine);
    return new Promise<BackupRunOutcome>((resolve) => {
      resolveRun = resolve;
    });
  });

  const host = new BackupHost(
    {
      serverUrl: 'http://server.test',
      pat: 'nod_test',
      root,
      nodeId: 'node-1',
      cliVersion: '1.2.22',
    },
    {
      settings,
      logger,
      api: { getNodeBackupConfig: async () => ({ config: null }) } as never,
      runBackupFn,
      ...depsOver,
    },
  );

  return {
    host,
    settings,
    logger,
    contexts,
    engines,
    finishRun: (outcome = {}) =>
      resolveRun?.({
        runId: 'run-1',
        status: 'completed',
        stats: emptyStats(),
        ...outcome,
      }),
  };
}

describe('BackupHost', () => {
  it('serializes runs: a second trigger while one is active is rejected busy', async () => {
    const h = makeHost();
    h.host.startRun('manual');
    expect(h.host.isRunning()).toBe(true);

    expect(() => h.host.startRun('manual')).toThrow(BackupBusyError);
    expect(() => h.host.startRun('scheduled')).toThrow(BackupBusyError);

    h.finishRun();
    await h.host.waitForIdle();
    expect(h.host.isRunning()).toBe(false);

    // A fresh run is accepted once the previous one settled.
    expect(() => h.host.startRun('scheduled')).not.toThrow();
    h.finishRun();
    await h.host.waitForIdle();
  });

  it('re-broadcasts every engine event as a { ev, payload } backup-event frame', async () => {
    const h = makeHost();
    const frames: BackupHostEventFrame[] = [];
    h.host.on(BACKUP_HOST_EVENT, (frame: BackupHostEventFrame) => frames.push(frame));

    h.host.startRun('manual');
    const engine = h.engines[0]!;
    engine.emit(BACKUP_EV.RUN_STARTED, { runId: 'r1', kind: 'incremental', trigger: 'manual' });
    engine.emit(BACKUP_EV.ITEM_DONE, { id: 'item-1', outcome: 'downloaded', bytes: 42 });
    engine.emit(BACKUP_EV.RUN_FINISHED, { status: 'completed', stats: emptyStats() });

    expect(frames).toEqual([
      { ev: 'run-started', payload: { runId: 'r1', kind: 'incremental', trigger: 'manual' } },
      { ev: 'item-done', payload: { id: 'item-1', outcome: 'downloaded', bytes: 42 } },
      { ev: 'run-finished', payload: { status: 'completed', stats: emptyStats() } },
    ]);

    h.finishRun();
    await h.host.waitForIdle();
  });

  it('set-rate persists to the settings KV and applies LIVE to the active run', async () => {
    const h = makeHost();
    h.host.startRun('manual');
    const ctx = h.contexts[0]!;
    expect(ctx.engineOpts.concurrency).toBe(2);
    expect(ctx.bucket.maxMbps).toBe(0);
    const setRateSpy = jest.spyOn(ctx.bucket, 'setRate');

    const effective = h.host.setRate({ concurrency: 6, maxMbps: 12.5 });

    // Persisted for future runs…
    expect(effective).toEqual({ concurrency: 6, maxMbps: 12.5 });
    expect(h.settings.values.get('backup.concurrency')).toBe(6);
    expect(h.settings.values.get('backup.maxMbps')).toBe(12.5);
    // …AND applied to the live holders the engine re-reads per page/chunk.
    expect(ctx.engineOpts.concurrency).toBe(6);
    expect(setRateSpy).toHaveBeenCalledWith(12.5);
    expect(ctx.bucket.maxMbps).toBe(12.5);

    h.finishRun();
    await h.host.waitForIdle();
  });

  it('set-rate with no active run persists only (next run picks it up)', () => {
    const h = makeHost();
    const effective = h.host.setRate({ concurrency: 3 });
    expect(effective.concurrency).toBe(3);
    expect(h.settings.values.get('backup.concurrency')).toBe(3);
    // A later run reads the new value from settings.
    h.host.startRun('manual');
    expect(h.contexts[0]!.engineOpts.concurrency).toBe(3);
    h.finishRun();
  });

  it('cancel is cooperative and reports whether a run was active', async () => {
    const h = makeHost();
    expect(h.host.cancel()).toBe(false);

    h.host.startRun('manual');
    expect(h.host.cancel()).toBe(true);
    expect(h.engines[0]!.cancelled).toBe(true);

    h.finishRun({ status: 'aborted' });
    await h.host.waitForIdle();
  });

  it('a cancel racing engine construction still lands via attachEngine', async () => {
    // Run seam that attaches the engine only AFTER cancel was requested.
    let attach: (() => void) | null = null;
    const engine = new FakeEngine();
    const h = makeHost({
      runBackupFn: (ctx) => {
        attach = () => ctx.attachEngine(engine);
        return new Promise<BackupRunOutcome>(() => {});
      },
    });
    h.host.startRun('manual');
    expect(h.host.cancel()).toBe(true);
    expect(engine.cancelled).toBe(false);
    attach!();
    expect(engine.cancelled).toBe(true);
  });

  it('a rejected run (e.g. server 409) is logged and frees the slot', async () => {
    const h = makeHost({
      runBackupFn: async () => {
        throw new Error('A backup run is already active for this node');
      },
    });
    h.host.startRun('manual');
    await h.host.waitForIdle();
    expect(h.host.isRunning()).toBe(false);
    expect(h.logger.lines.some((l) => l.includes('backup run failed'))).toBe(true);
  });

  it('getSnapshot reads catalog counters/checkpoint/lastRun and reflects run state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-backup-host-'));
    // Seed a real catalog: one run + a checkpoint.
    const db = openCatalogDb(root);
    const repo = new CatalogRepo(db);
    repo.recordRun({
      id: 'run-9',
      kind: 'incremental',
      status: 'completed',
      startedAt: '2026-08-01T00:00:00.000Z',
      finishedAt: '2026-08-01T00:01:00.000Z',
      itemsDownloaded: 7,
      errorCount: 1,
    });
    repo.setCheckpoint(
      CHECKPOINT_CURSOR_KEY,
      JSON.stringify({ updatedAt: '2026-08-01T00:00:59.000Z', id: 'item-x' }),
    );
    db.close();

    const h = makeHost({}, root);
    const idle = h.host.getSnapshot();
    expect(idle.configured).toBe(true);
    expect(idle.running).toBeNull();
    expect(idle.lastRun?.id).toBe('run-9');
    expect(idle.checkpoint).toEqual({ updatedAt: '2026-08-01T00:00:59.000Z', id: 'item-x' });
    expect(idle.counters?.totalItems).toBe(0);
    expect(idle.rate).toEqual({ concurrency: 2, maxMbps: 0 });

    h.host.startRun('scheduled');
    const busy = h.host.getSnapshot();
    expect(busy.running?.trigger).toBe('scheduled');
    h.finishRun();
    await h.host.waitForIdle();

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('getSnapshot degrades to null sections when the catalog is unreadable', () => {
    const h = makeHost({
      openDb: () => {
        throw new Error('disk unplugged');
      },
    });
    const snap = h.host.getSnapshot();
    expect(snap.configured).toBe(true);
    expect(snap.counters).toBeNull();
    expect(snap.checkpoint).toBeNull();
    expect(snap.lastRun).toBeNull();
    expect(h.logger.lines.some((l) => l.includes('backup status catalog read failed'))).toBe(true);
  });
});
