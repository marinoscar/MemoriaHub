/**
 * test/tui/backup-dashboard-source.spec.ts
 *
 * Unit tests for the pure state helpers in tui/backup-dashboard-source.ts:
 * initial state, snapshot parsing/hydration, the shared event reducer used by
 * both the attached (daemon IPC) and embedded (in-process BackupEngine)
 * sources, and the attach-vs-embedded selection logic.
 *
 * Plain-function tests — no Ink, no sockets, no engine. Mirrors
 * test/tui/node-dashboard-source.spec.ts.
 */

import { BACKUP_EV, BackupTypedEmitter } from '../../src/backup/events.js';
import {
  MAX_LOG,
  MAX_RUNS,
  appendBackupLog,
  applyPendingLag,
  checkpointAgeMs,
  currentBytesPerSec,
  EmbeddedBackupSource,
  hydrateFromBackupSnapshot,
  initialBackupDashboardState,
  markCancelling,
  parseBackupSnapshot,
  reduceBackupEvent,
  selectBackupSource,
  type BackupDashboardSource,
  type BackupSnapshot,
} from '../../src/tui/backup-dashboard-source.js';

// ---------------------------------------------------------------------------
// Initial state + log
// ---------------------------------------------------------------------------

describe('initialBackupDashboardState', () => {
  it('starts idle with empty progress and no server-derived sections', () => {
    const state = initialBackupDashboardState();
    expect(state.runState).toBe('idle');
    expect(state.runId).toBeNull();
    expect(state.kind).toBeNull();
    expect(state.progress).toEqual({
      items: 0,
      downloaded: 0,
      skipped: 0,
      errors: 0,
      bytes: 0,
      startMs: null,
    });
    expect(state.checkpoint).toBeNull();
    expect(state.pending).toBeNull();
    expect(state.counters).toBeNull();
    expect(state.runs).toEqual([]);
    expect(state.reconcile).toBeNull();
    expect(state.log).toEqual([]);
  });
});

describe('appendBackupLog', () => {
  it('appends entries and trims to MAX_LOG', () => {
    let state = initialBackupDashboardState();
    for (let i = 0; i < MAX_LOG + 5; i++) {
      state = appendBackupLog(state, [{ level: 'info', msg: `line ${i}` }], 1000 + i);
    }
    expect(state.log).toHaveLength(MAX_LOG);
    expect(state.log[state.log.length - 1]!.msg).toBe(`line ${MAX_LOG + 4}`);
  });

  it('is a no-op for an empty entries array', () => {
    const state = initialBackupDashboardState();
    expect(appendBackupLog(state, [])).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

describe('derived values', () => {
  it('currentBytesPerSec is 0 while idle and a real rate mid-run', () => {
    const idle = initialBackupDashboardState();
    expect(currentBytesPerSec(idle, 5_000)).toBe(0);

    const running = {
      ...idle,
      progress: { ...idle.progress, bytes: 2_000, startMs: 1_000 },
    };
    // 2000 bytes over 2 seconds.
    expect(currentBytesPerSec(running, 3_000)).toBe(1_000);
  });

  it('checkpointAgeMs is null without a checkpoint and clamps at 0', () => {
    const state = initialBackupDashboardState();
    expect(checkpointAgeMs(state, 1_000)).toBeNull();

    const withCp = {
      ...state,
      checkpoint: { updatedAt: '2024-04-01T00:00:00.000Z', id: 'x' },
    };
    const t = Date.parse('2024-04-01T00:00:00.000Z');
    expect(checkpointAgeMs(withCp, t + 5_000)).toBe(5_000);
    expect(checkpointAgeMs(withCp, t - 5_000)).toBe(0);
    expect(checkpointAgeMs({ ...state, checkpoint: { updatedAt: 'junk', id: 'x' } })).toBeNull();
  });

  it('applyPendingLag coerces the wire STRING byte count to a number', () => {
    const state = initialBackupDashboardState();
    expect(applyPendingLag(state, { items: 3, bytes: '4096' }).pending).toEqual({
      items: 3,
      bytes: 4096,
    });
    expect(applyPendingLag(state, null).pending).toBeNull();
  });

  it('markCancelling only applies to a running state', () => {
    const idle = initialBackupDashboardState();
    expect(markCancelling(idle)).toBe(idle);
    const running = { ...idle, runState: 'running' as const };
    expect(markCancelling(running).runState).toBe('cancelling');
  });
});

// ---------------------------------------------------------------------------
// Snapshot parsing / hydration
// ---------------------------------------------------------------------------

describe('parseBackupSnapshot', () => {
  it('parses a full backup-status frame', () => {
    const snap = parseBackupSnapshot({
      kind: 'backup-status',
      configured: true,
      running: { trigger: 'scheduled', startedAt: '2024-04-01T00:00:00.000Z' },
      lastRun: {
        id: 'run-1',
        kind: 'reconcile',
        status: 'completed',
        startedAt: '2024-03-31T00:00:00.000Z',
        finishedAt: '2024-03-31T00:05:00.000Z',
        itemsDownloaded: 12,
        errorCount: 1,
      },
      checkpoint: { updatedAt: '2024-04-01T00:00:00.000Z', id: 'item-9' },
      counters: {
        totalItems: 20,
        totalBytes: 4096,
        byStatus: {
          present: { count: 18, bytes: 4000 },
          failed: { count: 1, bytes: 50 },
          quarantined: { count: 1, bytes: 46 },
          trashed: { count: 0, bytes: 0 },
        },
        archivedCount: 2,
      },
      rate: { concurrency: 4, maxMbps: 20 },
    });

    expect(snap.configured).toBe(true);
    expect(snap.running).toEqual({
      trigger: 'scheduled',
      startedAt: '2024-04-01T00:00:00.000Z',
    });
    expect(snap.lastRun?.kind).toBe('reconcile');
    expect(snap.checkpoint).toEqual({ updatedAt: '2024-04-01T00:00:00.000Z', id: 'item-9' });
    expect(snap.counters).toEqual({
      totalItems: 20,
      totalBytes: 4096,
      present: 18,
      failed: 1,
      quarantined: 1,
      trashed: 0,
    });
    expect(snap.rate).toEqual({ concurrency: 4, maxMbps: 20 });
  });

  it('degrades gracefully on a not-configured / empty frame', () => {
    const snap = parseBackupSnapshot({
      kind: 'backup-status',
      configured: false,
      running: null,
      lastRun: null,
      checkpoint: null,
      counters: null,
      rate: null,
    });
    expect(snap.configured).toBe(false);
    expect(snap.running).toBeNull();
    expect(snap.lastRun).toBeNull();
    expect(snap.checkpoint).toBeNull();
    expect(snap.counters).toBeNull();
    expect(snap.rate).toBeNull();
  });

  it('ignores a half-populated checkpoint and a run row with no id', () => {
    const snap = parseBackupSnapshot({
      checkpoint: { updatedAt: '2024-04-01T00:00:00.000Z' },
      lastRun: { kind: 'incremental' },
    });
    expect(snap.checkpoint).toBeNull();
    expect(snap.lastRun).toBeNull();
  });
});

describe('hydrateFromBackupSnapshot', () => {
  const baseSnap: BackupSnapshot = {
    configured: true,
    running: null,
    lastRun: {
      id: 'run-1',
      kind: 'incremental',
      status: 'completed',
      startedAt: '2024-03-31T00:00:00.000Z',
      finishedAt: '2024-03-31T00:05:00.000Z',
      itemsDownloaded: 3,
      errorCount: 0,
    },
    checkpoint: { updatedAt: '2024-04-01T00:00:00.000Z', id: 'item-9' },
    counters: {
      totalItems: 10,
      totalBytes: 100,
      present: 10,
      failed: 0,
      quarantined: 0,
      trashed: 0,
    },
    rate: { concurrency: 2, maxMbps: 0 },
  };

  it('replaces the server-derived sections and preserves the log', () => {
    const withLog = appendBackupLog(initialBackupDashboardState(), [
      { level: 'info', msg: 'keep me' },
    ]);
    const next = hydrateFromBackupSnapshot(withLog, baseSnap, 10_000);

    expect(next.checkpoint).toEqual(baseSnap.checkpoint);
    expect(next.counters).toEqual(baseSnap.counters);
    expect(next.rate).toEqual(baseSnap.rate);
    expect(next.runs.map((r) => r.id)).toEqual(['run-1']);
    expect(next.log).toHaveLength(1);
    expect(next.runState).toBe('idle');
  });

  it('picks up a run the event stream never announced (attached mid-run)', () => {
    const startedAt = '2024-04-01T00:00:00.000Z';
    const next = hydrateFromBackupSnapshot(
      initialBackupDashboardState(),
      { ...baseSnap, running: { trigger: 'scheduled', startedAt } },
      Date.parse(startedAt) + 60_000,
    );
    expect(next.runState).toBe('running');
    expect(next.trigger).toBe('scheduled');
    expect(next.progress.startMs).toBe(Date.parse(startedAt));
  });

  it('never cancels a locally-known run just because the snapshot shows none', () => {
    const running = { ...initialBackupDashboardState(), runState: 'cancelling' as const };
    const next = hydrateFromBackupSnapshot(running, baseSnap, 10_000);
    expect(next.runState).toBe('cancelling');
  });

  it('does not duplicate a run already in the list', () => {
    let state = hydrateFromBackupSnapshot(initialBackupDashboardState(), baseSnap, 1);
    state = hydrateFromBackupSnapshot(state, baseSnap, 2);
    expect(state.runs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Event reducer
// ---------------------------------------------------------------------------

describe('reduceBackupEvent', () => {
  it('run-started resets progress and logs the run', () => {
    const state = reduceBackupEvent(
      initialBackupDashboardState(),
      BACKUP_EV.RUN_STARTED,
      { runId: 'run-abcdef123', kind: 'reconcile', trigger: 'manual' },
      5_000,
    );
    expect(state.runState).toBe('running');
    expect(state.runId).toBe('run-abcdef123');
    expect(state.kind).toBe('reconcile');
    expect(state.trigger).toBe('manual');
    expect(state.progress.startMs).toBe(5_000);
    expect(state.log[0]!.msg).toMatch(/started \(reconcile\)/);
  });

  it('item-done folds outcomes into the progress counters', () => {
    let state = reduceBackupEvent(
      initialBackupDashboardState(),
      BACKUP_EV.RUN_STARTED,
      { runId: 'r', kind: 'incremental', trigger: 'manual' },
      1_000,
    );
    state = reduceBackupEvent(
      state,
      BACKUP_EV.ITEM_DONE,
      { id: 'a', outcome: 'downloaded', bytes: 500 },
      1_100,
    );
    state = reduceBackupEvent(
      state,
      BACKUP_EV.ITEM_DONE,
      { id: 'b', outcome: 'sidecar-only', bytes: 0 },
      1_200,
    );
    state = reduceBackupEvent(
      state,
      BACKUP_EV.ITEM_DONE,
      { id: 'c', outcome: 'tombstone', bytes: 0 },
      1_300,
    );
    state = reduceBackupEvent(
      state,
      BACKUP_EV.ITEM_DONE,
      { id: 'ddddddddddd', outcome: 'failed', bytes: 0, error: 'boom' },
      1_400,
    );

    expect(state.progress).toMatchObject({
      items: 4,
      downloaded: 1,
      skipped: 2,
      errors: 1,
      bytes: 500,
    });
    // Failures are logged (shortened id), successes are not.
    expect(state.log).toHaveLength(2);
    expect(state.log[1]!.level).toBe('error');
    expect(state.log[1]!.msg).toBe('dddddddd: boom');
  });

  it('page-committed advances the checkpoint and ignores a malformed cursor', () => {
    let state = reduceBackupEvent(
      initialBackupDashboardState(),
      BACKUP_EV.PAGE_COMMITTED,
      { cursor: { updatedAt: '2024-04-01T00:00:00.000Z', id: 'item-3' }, stats: {} },
    );
    expect(state.checkpoint).toEqual({ updatedAt: '2024-04-01T00:00:00.000Z', id: 'item-3' });

    const before = state;
    state = reduceBackupEvent(state, BACKUP_EV.PAGE_COMMITTED, { cursor: null });
    expect(state).toBe(before);
  });

  it('an empty first page logs "already up to date"', () => {
    const state = reduceBackupEvent(
      initialBackupDashboardState(),
      BACKUP_EV.PAGE_FETCHED,
      { pageIndex: 0, items: 0, hasMore: false },
    );
    expect(state.log[0]!.msg).toMatch(/up to date/);
  });

  it('throttle logs a warning with the delay in seconds', () => {
    const state = reduceBackupEvent(initialBackupDashboardState(), BACKUP_EV.THROTTLE, {
      delayMs: 2_500,
    });
    expect(state.log[0]!.level).toBe('warn');
    expect(state.log[0]!.msg).toMatch(/2\.5s/);
  });

  it('reconcile-done records the summary and logs it', () => {
    const state = reduceBackupEvent(initialBackupDashboardState(), BACKUP_EV.RECONCILE_DONE, {
      manifestIds: 120,
      quarantined: 3,
      driftMarked: 2,
      cancelled: false,
    });
    expect(state.reconcile).toEqual({ manifestIds: 120, quarantined: 3, driftMarked: 2 });
    expect(state.log[0]!.msg).toMatch(/120 checked, 3 quarantined, 2 to re-download/);
  });

  it('a cancelled reconcile is logged as a warning', () => {
    const state = reduceBackupEvent(initialBackupDashboardState(), BACKUP_EV.RECONCILE_DONE, {
      manifestIds: 5,
      quarantined: 0,
      driftMarked: 0,
      cancelled: true,
    });
    expect(state.log[0]!.level).toBe('warn');
    expect(state.log[0]!.msg).toMatch(/cancelled/);
  });

  it('run-finished returns to idle and pushes a run row', () => {
    let state = reduceBackupEvent(
      initialBackupDashboardState(),
      BACKUP_EV.RUN_STARTED,
      { runId: 'run-9', kind: 'incremental', trigger: 'manual' },
      1_000,
    );
    state = reduceBackupEvent(
      state,
      BACKUP_EV.RUN_FINISHED,
      { status: 'completed', stats: { itemsDownloaded: 7, errors: 0 } },
      9_000,
    );

    expect(state.runState).toBe('idle');
    expect(state.runId).toBeNull();
    expect(state.kind).toBeNull();
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ id: 'run-9', status: 'completed', itemsDownloaded: 7 });
    expect(state.log[state.log.length - 1]!.msg).toMatch(/run completed: 7 downloaded/);
  });

  it('a failed run logs at error level and carries the error text', () => {
    const state = reduceBackupEvent(
      initialBackupDashboardState(),
      BACKUP_EV.RUN_FINISHED,
      { status: 'failed', stats: { itemsDownloaded: 0, errors: 2 }, error: 'server gone' },
      1_000,
    );
    expect(state.log[0]!.level).toBe('error');
    expect(state.log[0]!.msg).toMatch(/server gone/);
  });

  it('caps the run list at MAX_RUNS', () => {
    let state = initialBackupDashboardState();
    for (let i = 0; i < MAX_RUNS + 4; i++) {
      state = reduceBackupEvent(
        state,
        BACKUP_EV.RUN_STARTED,
        { runId: `run-${i}`, kind: 'incremental', trigger: 'manual' },
        1_000 + i,
      );
      state = reduceBackupEvent(
        state,
        BACKUP_EV.RUN_FINISHED,
        { status: 'completed', stats: { itemsDownloaded: 1, errors: 0 } },
        2_000 + i,
      );
    }
    expect(state.runs).toHaveLength(MAX_RUNS);
    expect(state.runs[0]!.id).toBe(`run-${MAX_RUNS + 3}`);
  });

  it('error events land in the log', () => {
    const state = reduceBackupEvent(initialBackupDashboardState(), BACKUP_EV.ERROR, {
      message: 'catalog is locked',
    });
    expect(state.log[0]).toMatchObject({ level: 'error', msg: 'catalog is locked' });
  });

  it('ignores unknown event names', () => {
    const state = initialBackupDashboardState();
    expect(reduceBackupEvent(state, 'not-a-real-event', {})).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Source selection (attach vs. embedded)
// ---------------------------------------------------------------------------

describe('selectBackupSource', () => {
  const fakeAttached = (): BackupDashboardSource =>
    ({
      mode: 'attached',
      snapshot: null,
      onEvent: () => {},
      onDisconnect: () => {},
      refreshStatus: async () => null,
      runNow: () => {},
      cancel: () => {},
      setRate: () => {},
      close: () => {},
    }) as BackupDashboardSource;

  it('attaches when a daemon is running', async () => {
    const source = await selectBackupSource({
      isDaemonRunning: async () => true,
      createAttached: async () => fakeAttached(),
    });
    expect(source.mode).toBe('attached');
  });

  it('falls back to embedded when no daemon is running', async () => {
    let created = false;
    const source = await selectBackupSource({
      isDaemonRunning: async () => false,
      createAttached: async () => {
        created = true;
        return fakeAttached();
      },
    });
    expect(source.mode).toBe('embedded');
    expect(source).toBeInstanceOf(EmbeddedBackupSource);
    expect(created).toBe(false);
  });

  it('falls back to embedded when the daemon vanishes between probe and connect', async () => {
    const source = await selectBackupSource({
      isDaemonRunning: async () => true,
      createAttached: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(source.mode).toBe('embedded');
  });

  it('falls back to embedded when the daemon has no bound backup root', async () => {
    const source = await selectBackupSource({
      isDaemonRunning: async () => true,
      createAttached: async () => {
        throw new Error('the running daemon has no backup root bound');
      },
    });
    expect(source.mode).toBe('embedded');
  });
});

// ---------------------------------------------------------------------------
// EmbeddedBackupSource
// ---------------------------------------------------------------------------

/** Minimal stand-in for a BackupEngine: typed emitter + a cancel() flag. */
class FakeEngine extends BackupTypedEmitter {
  cancelled = false;
  cancel(): void {
    this.cancelled = true;
  }
}

describe('EmbeddedBackupSource', () => {
  it('buffers events emitted before onEvent subscribes, then flushes them', () => {
    const source = new EmbeddedBackupSource();
    const engine = new FakeEngine();
    source.attachEngine(engine);

    engine.emit(BACKUP_EV.RUN_STARTED, { runId: 'r1' });
    const seen: Array<[string, unknown]> = [];
    source.onEvent((ev, payload) => seen.push([ev, payload]));
    expect(seen).toEqual([[BACKUP_EV.RUN_STARTED, { runId: 'r1' }]]);

    engine.emit(BACKUP_EV.RUN_FINISHED, {
      status: 'completed',
      stats: { itemsDownloaded: 0, itemsSkipped: 0, sidecarsWritten: 0, bytesDownloaded: 0, errors: 0 },
    });
    expect(seen).toHaveLength(2);
  });

  it('runNow delegates to the registered starter, and only when idle', () => {
    const source = new EmbeddedBackupSource();
    const kinds: string[] = [];
    source.setStarter((kind) => kinds.push(kind));

    source.runNow();
    source.runNow('reconcile');
    expect(kinds).toEqual(['incremental', 'reconcile']);
    expect(source.hasEngine).toBe(false);
  });

  it('close() cancels the in-process run — nothing outlives the UI', () => {
    const source = new EmbeddedBackupSource();
    const engine = new FakeEngine();
    source.attachEngine(engine);
    expect(source.hasEngine).toBe(true);

    source.close();
    expect(engine.cancelled).toBe(true);
    expect(source.hasEngine).toBe(false);
  });

  it('refreshStatus resolves null (no daemon to ask)', async () => {
    await expect(new EmbeddedBackupSource().refreshStatus()).resolves.toBeNull();
  });
});
