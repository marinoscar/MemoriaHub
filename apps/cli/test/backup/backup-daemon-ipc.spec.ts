/**
 * test/backup/backup-daemon-ipc.spec.ts — Backup IPC verbs over a REAL daemon
 * host + unix socket (issue #318). Mirrors test/node/daemon-heap-snapshot.spec.ts.
 *
 * Covers: backup-status snapshot round-trip (and the configured:false answer
 * when no BackupHost is attached), backup-run-now with busy rejection,
 * backup-cancel cooperative stop, backup-set-rate validation + live apply,
 * and the { kind:'backup-event', ev, payload, ts } re-broadcast frames.
 */

import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { startDaemonHost, type DaemonHost } from '../../src/node/daemon.js';
import { NodeEngine } from '../../src/node/node-engine.js';
import { connectToDaemon, type DaemonClient, type DaemonMessage } from '../../src/node/ipc-client.js';
import type { ApiClient, ClaimedNodeJob } from '../../src/api.js';
import type { ComputeDispatcher } from '../../src/node/capabilities.js';
import type { NodeLogger } from '../../src/node/logger.js';
import {
  BackupHost,
  type BackupRunContext,
} from '../../src/backup/backup-host.js';
import type { BackupRunOutcome } from '../../src/backup/backup-engine.js';
import { BACKUP_EV, BackupTypedEmitter, emptyStats } from '../../src/backup/events.js';
import type { SettingsRepo } from '../../src/repo/settings.js';

function stubApi(): ApiClient {
  return {
    claimNodeJobs: async () => ({ jobs: [] as ClaimedNodeJob[] }),
    heartbeatNode: async () => ({}),
    deregisterNode: async () => ({}),
    renewLease: async () => ({}),
    submitJobResult: async () => ({}),
    reportJobFailure: async () => ({}),
  } as unknown as ApiClient;
}

function stubDispatcher(): ComputeDispatcher {
  return { compute: async () => ({ ok: true }) } as unknown as ComputeDispatcher;
}

function stubLogger(): NodeLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logPath: '(stub)',
    log: (level, fields) => lines.push(JSON.stringify({ level, ...fields })),
    info: (msg) => lines.push(`info: ${msg}`),
    warn: (msg) => lines.push(`warn: ${msg}`),
    error: (msg) => lines.push(`error: ${msg}`),
    tail: (n) => lines.slice(-n),
  };
}

function stubSettings(): SettingsRepo {
  const values = new Map<string, number>([
    ['backup.concurrency', 2],
    ['backup.maxMbps', 0],
    ['backup.pageSize', 100],
    ['backup.pacingMs', 0],
  ]);
  return {
    backupConcurrency: () => values.get('backup.concurrency')!,
    backupMaxMbps: () => values.get('backup.maxMbps')!,
    backupPageSize: () => values.get('backup.pageSize')!,
    backupPacingMs: () => values.get('backup.pacingMs')!,
    setBackupConcurrency: (n: number) => void values.set('backup.concurrency', n),
    setBackupMaxMbps: (m: number) => void values.set('backup.maxMbps', m),
  } as unknown as SettingsRepo;
}

class FakeEngine extends BackupTypedEmitter {
  cancelled = false;
  cancel(): void {
    this.cancelled = true;
  }
}

function tmpDirPath(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mh-backup-ipc-')), name);
}

async function sendCommand(client: DaemonClient, cmd: Record<string, unknown>): Promise<DaemonMessage> {
  client.send(cmd);
  return client.waitFor(
    (m) =>
      (m.kind === 'ack' || m.kind === 'error' || m.kind === 'backup-status') &&
      (m.kind === 'backup-status' || m['cmd'] === cmd['cmd']),
    3000,
  );
}

describe('daemon backup IPC verbs', () => {
  let engine: NodeEngine;
  let host: DaemonHost;
  let socketPath: string;
  let backupHost: BackupHost | undefined;
  let engines: FakeEngine[];
  let resolveRun: ((o: BackupRunOutcome) => void) | null;

  async function startHost(withBackup: boolean): Promise<void> {
    socketPath = tmpDirPath('node.sock');
    engines = [];
    resolveRun = null;

    engine = new NodeEngine({
      api: stubApi(),
      dispatcher: stubDispatcher(),
      nodeId: 'node-ipc-1',
      options: {
        concurrency: 1,
        eligibleTypes: ['face_detection'],
        pollIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
      },
      detectFn: async () => ({}),
      downloadFn: async () => {
        throw new Error('no downloads expected');
      },
    });

    backupHost = withBackup
      ? new BackupHost(
          {
            serverUrl: 'http://server.test',
            pat: 'nod_test',
            root: '/tmp/backup-root',
            nodeId: 'backup-node-1',
            cliVersion: '1.2.22',
          },
          {
            settings: stubSettings(),
            logger: stubLogger(),
            api: { getNodeBackupConfig: async () => ({ config: null }) } as never,
            runBackupFn: jest.fn<(ctx: BackupRunContext) => Promise<BackupRunOutcome>>((ctx) => {
              const fake = new FakeEngine();
              engines.push(fake);
              ctx.attachEngine(fake);
              return new Promise<BackupRunOutcome>((resolve) => {
                resolveRun = resolve;
              });
            }),
            openDb: () => {
              throw new Error('no catalog in this test');
            },
          },
        )
      : undefined;

    host = await startDaemonHost(engine, stubLogger(), {
      socketPath,
      pidPath: tmpDirPath('node.pid'),
      persistConcurrency: () => {},
      exit: () => {},
      ...(backupHost ? { backupHost } : {}),
    });
  }

  afterEach(async () => {
    resolveRun?.({ runId: 'r', status: 'aborted', stats: emptyStats() });
    await backupHost?.waitForIdle();
    await host.close();
    try {
      await engine.stop('test-cleanup');
    } catch {
      /* engine never started */
    }
  });

  it('backup-status answers configured:false when no BackupHost is attached', async () => {
    await startHost(false);
    const client = await connectToDaemon(socketPath);
    try {
      const reply = await sendCommand(client, { cmd: 'backup-status' });
      expect(reply.kind).toBe('backup-status');
      expect(reply['configured']).toBe(false);
      expect(reply['running']).toBeNull();
      expect(reply['rate']).toBeNull();
    } finally {
      client.close();
    }
  });

  it('backup-run-now without a BackupHost replies not-configured', async () => {
    await startHost(false);
    const client = await connectToDaemon(socketPath);
    try {
      const reply = await sendCommand(client, { cmd: 'backup-run-now' });
      expect(reply.kind).toBe('error');
      expect(reply['code']).toBe('not-configured');
    } finally {
      client.close();
    }
  });

  it('backup-status round-trips the host snapshot', async () => {
    await startHost(true);
    const client = await connectToDaemon(socketPath);
    try {
      const reply = await sendCommand(client, { cmd: 'backup-status' });
      expect(reply.kind).toBe('backup-status');
      expect(reply['configured']).toBe(true);
      expect(reply['running']).toBeNull();
      expect(reply['rate']).toEqual({ concurrency: 2, maxMbps: 0 });
      // Unreadable catalog degrades to nulls, never an error frame.
      expect(reply['counters']).toBeNull();
      expect(reply['checkpoint']).toBeNull();
      expect(reply['lastRun']).toBeNull();
    } finally {
      client.close();
    }
  });

  it('backup-run-now starts a run; a second request is rejected busy; cancel stops it', async () => {
    await startHost(true);
    const client = await connectToDaemon(socketPath);
    try {
      const first = await sendCommand(client, { cmd: 'backup-run-now' });
      expect(first.kind).toBe('ack');

      const status = await sendCommand(client, { cmd: 'backup-status' });
      expect((status['running'] as { trigger: string }).trigger).toBe('manual');

      const second = await sendCommand(client, { cmd: 'backup-run-now' });
      expect(second.kind).toBe('error');
      expect(second['code']).toBe('busy');

      const cancel = await sendCommand(client, { cmd: 'backup-cancel' });
      expect(cancel.kind).toBe('ack');
      expect(cancel['cancelled']).toBe(true);
      expect(engines[0]!.cancelled).toBe(true);
    } finally {
      client.close();
    }
  });

  it('backup-set-rate validates input, persists, and applies live', async () => {
    await startHost(true);
    const client = await connectToDaemon(socketPath);
    try {
      // Run active so the live-apply path is exercised.
      await sendCommand(client, { cmd: 'backup-run-now' });

      const bad = await sendCommand(client, { cmd: 'backup-set-rate', concurrency: 0 });
      expect(bad.kind).toBe('error');

      const empty = await sendCommand(client, { cmd: 'backup-set-rate' });
      expect(empty.kind).toBe('error');

      const ok = await sendCommand(client, { cmd: 'backup-set-rate', concurrency: 4, maxMbps: 8 });
      expect(ok.kind).toBe('ack');
      expect(ok['concurrency']).toBe(4);
      expect(ok['maxMbps']).toBe(8);

      const status = await sendCommand(client, { cmd: 'backup-status' });
      expect(status['rate']).toEqual({ concurrency: 4, maxMbps: 8 });
    } finally {
      client.close();
    }
  });

  it('re-broadcasts engine events as { kind: backup-event, ev, payload, ts } frames', async () => {
    await startHost(true);
    const client = await connectToDaemon(socketPath);
    try {
      const frames: DaemonMessage[] = [];
      client.onMessage((m) => {
        if (m.kind === 'backup-event') frames.push(m);
      });

      await sendCommand(client, { cmd: 'backup-run-now' });
      engines[0]!.emit(BACKUP_EV.ITEM_DONE, { id: 'item-1', outcome: 'downloaded', bytes: 7 });

      const frame = await client.waitFor((m) => m.kind === 'backup-event', 3000);
      expect(frame['ev']).toBe('item-done');
      expect(frame['payload']).toEqual({ id: 'item-1', outcome: 'downloaded', bytes: 7 });
      expect(typeof frame['ts']).toBe('string');
      expect(Number.isFinite(Date.parse(frame['ts'] as string))).toBe(true);
    } finally {
      client.close();
    }
  });
});
