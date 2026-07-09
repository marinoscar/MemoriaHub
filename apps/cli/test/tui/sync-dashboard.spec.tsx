/**
 * test/tui/sync-dashboard.spec.tsx
 *
 * Tests for SyncDashboard using an injected stub engine (TypedEmitter subclass)
 * so we can emit events without a real DB or network.
 *
 * We inject the engine via the `_engineForTesting` prop added for testability.
 * The prop is optional and minimal — the normal code path is unchanged.
 *
 * Note on async rendering: Ink re-renders asynchronously in response to
 * setState calls. After emitting events we wait a tick with a short
 * setTimeout so React can flush state updates before asserting.
 */

import { jest } from '@jest/globals';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { TypedEmitter, EV } from '../../src/sync/events.js';
import { SyncDashboard } from '../../src/tui/SyncDashboard.js';
import { SyncEngine } from '../../src/sync/sync-engine.js';
import { openDb } from '../../src/db/database.js';
import type { SyncOptions, SyncRunResult, SyncEngine as SyncEngineType } from '../../src/sync/sync-engine.js';
import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Strip ANSI escape codes for readable assertions.
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/** Wait a tick for React/Ink to flush state updates. */
function flushAsync(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A minimal stub SyncEngine that extends TypedEmitter so the dashboard can
 * subscribe to its events.  We expose an `emit` helper and a no-op `run()`.
 */
class StubEngine extends TypedEmitter {
  async run(_opts: SyncOptions): Promise<SyncRunResult> {
    // no-op — tests emit events manually
    return { runId: 0, stats: { uploaded: 0, skipped: 0, failed: 0 }, durationMs: 0 };
  }
}

const FAKE_CONFIG = { serverUrl: 'http://test.local', pat: 'tok-test' };

function makeDb(): BetterSqlite3.Database {
  return openDb(':memory:');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SyncDashboard', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    cleanup();
    db.close();
  });

  // -------------------------------------------------------------------------
  // Initial render
  // -------------------------------------------------------------------------

  it('renders the progress section on initial mount', () => {
    const engine = new StubEngine();
    const { lastFrame } = render(
      <SyncDashboard
        config={FAKE_CONFIG}
        db={db}
        onHome={() => {}}
        _engineForTesting={engine as unknown as SyncEngineType}
      />,
    );
    const plain = stripAnsi(lastFrame()!);
    // Dashboard shows "Progress" header in the meter section
    expect(plain).toContain('Progress');
  });

  it('shows 0 counts before any events are emitted', () => {
    const engine = new StubEngine();
    const { lastFrame } = render(
      <SyncDashboard
        config={FAKE_CONFIG}
        db={db}
        onHome={() => {}}
        _engineForTesting={engine as unknown as SyncEngineType}
      />,
    );
    const plain = stripAnsi(lastFrame()!);
    // Initial state has all zeroes
    expect(plain).toContain('0%');
  });

  // -------------------------------------------------------------------------
  // run:start event
  // -------------------------------------------------------------------------

  it('updates total when run:start is emitted', async () => {
    const engine = new StubEngine();
    const { lastFrame } = render(
      <SyncDashboard
        config={FAKE_CONFIG}
        db={db}
        onHome={() => {}}
        _engineForTesting={engine as unknown as SyncEngineType}
      />,
    );

    engine.emit(EV.RUN_START, {
      runId: 1,
      folderIds: [1],
      total: 10,
      dryRun: false,
    });

    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    // total=10 should appear somewhere in the output
    expect(plain).toContain('10');
  });

  // -------------------------------------------------------------------------
  // run:progress event
  // -------------------------------------------------------------------------

  it('updates progress counts when run:progress is emitted', async () => {
    const engine = new StubEngine();
    const { lastFrame } = render(
      <SyncDashboard
        config={FAKE_CONFIG}
        db={db}
        onHome={() => {}}
        _engineForTesting={engine as unknown as SyncEngineType}
      />,
    );

    engine.emit(EV.RUN_PROGRESS, {
      counts: { uploaded: 5, uploading: 2, queued: 3, skipped: 0, failed: 0 },
      total: 10,
    });

    // run:progress is throttled by 100ms — wait for it to flush
    await flushAsync(150);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('5');
    expect(plain).toContain('50%');
  });

  // -------------------------------------------------------------------------
  // file:done event adds to log
  // -------------------------------------------------------------------------

  it('adds a log entry when file:done is emitted', async () => {
    const engine = new StubEngine();
    const { lastFrame } = render(
      <SyncDashboard
        config={FAKE_CONFIG}
        db={db}
        onHome={() => {}}
        _engineForTesting={engine as unknown as SyncEngineType}
      />,
    );

    engine.emit(EV.FILE_DONE, {
      fileId: 42,
      path: '/tmp/photos/sunset.jpg',
      mediaItemId: 'media-42',
      storageObjectId: 'obj-42',
    });

    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('sunset.jpg');
  });

  // -------------------------------------------------------------------------
  // run:done event shows summary
  // -------------------------------------------------------------------------

  it('transitions to summary when run:done is emitted', async () => {
    const engine = new StubEngine();
    const { lastFrame } = render(
      <SyncDashboard
        config={FAKE_CONFIG}
        db={db}
        onHome={() => {}}
        _engineForTesting={engine as unknown as SyncEngineType}
      />,
    );

    engine.emit(EV.RUN_DONE, {
      runId: 1,
      stats: { uploaded: 8, skipped: 1, failed: 1 },
      durationMs: 1234,
    });

    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    // Summary should show the uploaded count
    expect(plain).toContain('8');
  });

  // -------------------------------------------------------------------------
  // error event
  // -------------------------------------------------------------------------

  it('shows error message when error event is emitted', async () => {
    const engine = new StubEngine();
    const { lastFrame } = render(
      <SyncDashboard
        config={FAKE_CONFIG}
        db={db}
        onHome={() => {}}
        _engineForTesting={engine as unknown as SyncEngineType}
      />,
    );

    engine.emit(EV.ERROR, { message: 'No folders configured' });

    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('No folders configured');
  });

  // -------------------------------------------------------------------------
  // file:failed event adds to log
  // -------------------------------------------------------------------------

  it('adds failure to log when file:failed is emitted', async () => {
    const engine = new StubEngine();
    const { lastFrame } = render(
      <SyncDashboard
        config={FAKE_CONFIG}
        db={db}
        onHome={() => {}}
        _engineForTesting={engine as unknown as SyncEngineType}
      />,
    );

    engine.emit(EV.FILE_FAILED, {
      fileId: 99,
      path: '/tmp/photos/broken.jpg',
      error: 'Network timeout',
      attempt: 1,
      willRetry: true,
    });

    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('broken.jpg');
  });

  // -------------------------------------------------------------------------
  // retryFailedOnly prop wires correct run options
  // -------------------------------------------------------------------------

  describe('retryFailedOnly prop', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let runSpy: ReturnType<typeof jest.spyOn<any, any>>;

    beforeEach(() => {
      // Spy on SyncEngine.prototype.run so we can capture options without
      // a real DB, network, or file system.  The spy immediately emits
      // EV.RUN_DONE so the dashboard reaches a terminal state cleanly.
      runSpy = jest
        .spyOn(SyncEngine.prototype, 'run')
        .mockImplementation(async function (this: SyncEngine, _opts: SyncOptions) {
          this.emit(EV.RUN_DONE, {
            runId: 1,
            stats: { uploaded: 0, skipped: 0, failed: 0 },
            durationMs: 0,
          });
          return { runId: 1, stats: { uploaded: 0, skipped: 0, failed: 0 }, durationMs: 0 };
        });
    });

    afterEach(() => {
      runSpy.mockRestore();
    });

    it('calls engine.run with retryFailedOnly=true and trigger="retry" when retryFailedOnly prop is set', async () => {
      render(
        <SyncDashboard
          config={FAKE_CONFIG}
          db={db}
          all={true}
          retryFailedOnly={true}
          onHome={() => {}}
        />,
      );

      await flushAsync(200);

      expect(runSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          retryFailedOnly: true,
          trigger: 'retry',
          all: true,
        }),
      );
    });

    it('calls engine.run with retryFailedOnly=false and trigger="menu" when retryFailedOnly prop is absent', async () => {
      render(
        <SyncDashboard
          config={FAKE_CONFIG}
          db={db}
          all={true}
          onHome={() => {}}
        />,
      );

      await flushAsync(200);

      expect(runSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          retryFailedOnly: false,
          trigger: 'menu',
          all: true,
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // In-place retry from the summary ('r' / 'f')
  // -------------------------------------------------------------------------

  describe('summary retry keys', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let runSpy: ReturnType<typeof jest.spyOn<any, any>>;

    beforeEach(() => {
      // Each run() emits one failed file then RUN_DONE with failed:1, so the
      // summary renders with the [r]/[f] hints active.
      runSpy = jest
        .spyOn(SyncEngine.prototype, 'run')
        .mockImplementation(async function (this: SyncEngine, _opts: SyncOptions) {
          this.emit(EV.FILE_FAILED, {
            fileId: 7,
            path: '/tmp/broken.jpg',
            error: 'boom',
            willRetry: false,
          });
          this.emit(EV.RUN_DONE, {
            runId: 1,
            stats: { uploaded: 0, skipped: 0, failed: 1 },
            durationMs: 0,
          });
          return { runId: 1, stats: { uploaded: 0, skipped: 0, failed: 1 }, durationMs: 0 };
        });
    });

    afterEach(() => {
      runSpy.mockRestore();
    });

    it('pressing "r" re-runs the engine in retry mode (retryFailedOnly, force:false) for the same scope', async () => {
      const { stdin, lastFrame } = render(
        <SyncDashboard config={FAKE_CONFIG} db={db} all={true} onHome={() => {}} />,
      );

      await flushAsync(200);
      // Summary shows the retry hint.
      expect(stripAnsi(lastFrame()!)).toContain('[r] retry failed');
      expect(runSpy).toHaveBeenCalledTimes(1);

      stdin.write('r');
      await flushAsync(200);

      expect(runSpy).toHaveBeenCalledTimes(2);
      expect(runSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          retryFailedOnly: true,
          trigger: 'retry',
          force: false,
          all: true,
        }),
      );
    });

    it('pressing "f" re-runs the engine in retry mode with force:true (reset attempt cap)', async () => {
      const { stdin } = render(
        <SyncDashboard config={FAKE_CONFIG} db={db} all={true} onHome={() => {}} />,
      );

      await flushAsync(200);
      expect(runSpy).toHaveBeenCalledTimes(1);

      stdin.write('f');
      await flushAsync(200);

      expect(runSpy).toHaveBeenCalledTimes(2);
      expect(runSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          retryFailedOnly: true,
          trigger: 'retry',
          force: true,
        }),
      );
    });
  });
});
