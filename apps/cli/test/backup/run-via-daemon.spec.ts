/**
 * test/backup/run-via-daemon.spec.ts — `backup run` daemon delegation
 * (issue #318) against a MOCKED DaemonClient.
 *
 * Covers: shouldDelegateToDaemon (daemon present delegates; --embedded
 * bypasses), the happy path (events streamed into the renderer proxy, outcome
 * assembled from run-finished), busy + not-configured rejections, the
 * ignore-everything-before-ack discipline (a previous run's tail events must
 * not be misattributed), and the connection-closed failure.
 */

import type { DaemonClient, DaemonMessage } from '../../src/node/ipc-client.js';
import {
  runViaDaemon,
  shouldDelegateToDaemon,
  DaemonBackupBusyError,
  DaemonBackupUnavailableError,
} from '../../src/backup/run-via-daemon.js';
import { BACKUP_EV, emptyStats, type BackupTypedEmitter } from '../../src/backup/events.js';

interface FakeClientHarness {
  client: DaemonClient;
  sent: Array<Record<string, unknown>>;
  deliver: (msg: DaemonMessage) => void;
  closeConn: () => void;
}

function fakeClient(onSend?: (cmd: Record<string, unknown>) => void): FakeClientHarness {
  const sent: Array<Record<string, unknown>> = [];
  const msgCbs = new Set<(m: DaemonMessage) => void>();
  const closeCbs = new Set<() => void>();
  const client: DaemonClient = {
    send: (cmd) => {
      sent.push(cmd);
      onSend?.(cmd);
    },
    onMessage: (cb) => msgCbs.add(cb),
    onClose: (cb) => closeCbs.add(cb),
    waitFor: () => Promise.reject(new Error('unused in these tests')),
    close: () => {},
  };
  return {
    client,
    sent,
    deliver: (msg) => {
      for (const cb of msgCbs) cb(msg);
    },
    closeConn: () => {
      for (const cb of closeCbs) cb();
    },
  };
}

/** Renderer stand-in: records every event the proxy re-emits. */
function recordingRenderer(): {
  attach: (emitter: BackupTypedEmitter) => void;
  events: Array<{ ev: string; payload: unknown }>;
} {
  const events: Array<{ ev: string; payload: unknown }> = [];
  return {
    events,
    attach: (emitter) => {
      for (const ev of Object.values(BACKUP_EV)) {
        emitter.on(ev, (payload: unknown) => events.push({ ev, payload }));
      }
    },
  };
}

describe('shouldDelegateToDaemon', () => {
  it('delegates when a daemon is up and --embedded was not passed', () => {
    expect(shouldDelegateToDaemon(false, true)).toBe(true);
  });
  it('--embedded bypasses a running daemon', () => {
    expect(shouldDelegateToDaemon(true, true)).toBe(false);
  });
  it('runs embedded when no daemon is up', () => {
    expect(shouldDelegateToDaemon(false, false)).toBe(false);
    expect(shouldDelegateToDaemon(true, false)).toBe(false);
  });
});

describe('runViaDaemon', () => {
  it('sends backup-run-now and streams events into the renderer until run-finished', async () => {
    const h = fakeClient((cmd) => {
      // Ack, then the run's event stream, delivered synchronously on send.
      h.deliver({ kind: 'ack', cmd: String(cmd['cmd']) });
      h.deliver({
        kind: 'backup-event',
        ev: 'run-started',
        payload: { runId: 'r1', kind: 'incremental', trigger: 'manual' },
        ts: 't',
      });
      h.deliver({
        kind: 'backup-event',
        ev: 'item-done',
        payload: { id: 'i1', outcome: 'downloaded', bytes: 5 },
        ts: 't',
      });
      h.deliver({
        kind: 'backup-event',
        ev: 'run-finished',
        payload: { status: 'completed', stats: { ...emptyStats(), itemsDownloaded: 1 } },
        ts: 't',
      });
    });
    const renderer = recordingRenderer();

    const outcome = await runViaDaemon(h.client, { attachRenderer: renderer.attach });

    expect(h.sent).toEqual([{ cmd: 'backup-run-now' }]);
    expect(outcome.status).toBe('completed');
    expect(outcome.stats.itemsDownloaded).toBe(1);
    expect(renderer.events.map((e) => e.ev)).toEqual(['run-started', 'item-done', 'run-finished']);
  });

  it('rejects with DaemonBackupBusyError on a busy error frame', async () => {
    const h = fakeClient(() => {
      h.deliver({
        kind: 'error',
        cmd: 'backup-run-now',
        code: 'busy',
        message: 'a backup run is already active on this daemon',
      });
    });
    await expect(
      runViaDaemon(h.client, { attachRenderer: () => {} }),
    ).rejects.toBeInstanceOf(DaemonBackupBusyError);
  });

  it('rejects with DaemonBackupUnavailableError on not-configured (caller falls back embedded)', async () => {
    const h = fakeClient(() => {
      h.deliver({
        kind: 'error',
        cmd: 'backup-run-now',
        code: 'not-configured',
        message: 'backup is not configured on this daemon',
      });
    });
    await expect(
      runViaDaemon(h.client, { attachRenderer: () => {} }),
    ).rejects.toBeInstanceOf(DaemonBackupUnavailableError);
  });

  it('ignores backup-events that arrive BEFORE our ack (a previous run tail)', async () => {
    const h = fakeClient(() => {
      // Tail of a previous (e.g. scheduled) run, arriving before the ack:
      h.deliver({
        kind: 'backup-event',
        ev: 'run-finished',
        payload: { status: 'failed', stats: emptyStats(), error: 'stale' },
        ts: 't',
      });
      h.deliver({ kind: 'ack', cmd: 'backup-run-now' });
      h.deliver({
        kind: 'backup-event',
        ev: 'run-finished',
        payload: { status: 'completed', stats: emptyStats() },
        ts: 't',
      });
    });
    const renderer = recordingRenderer();

    const outcome = await runViaDaemon(h.client, { attachRenderer: renderer.attach });
    expect(outcome.status).toBe('completed');
    expect(outcome.error).toBeUndefined();
    // The stale pre-ack frame never reached the renderer.
    expect(renderer.events).toHaveLength(1);
  });

  it('rejects when the connection closes before the run finished', async () => {
    const h = fakeClient(() => {
      h.deliver({ kind: 'ack', cmd: 'backup-run-now' });
      h.closeConn();
    });
    await expect(runViaDaemon(h.client, { attachRenderer: () => {} })).rejects.toThrow(
      /connection closed/,
    );
  });
});
