/**
 * test/backup/status-report.spec.ts — `backup status` three-source report
 * (issue #318).
 *
 * Covers: all three sections populated (real temp catalog + fake daemon IPC +
 * fake server), and graceful degradation of EACH section independently —
 * unconfigured machine, unreadable catalog, no daemon, daemon IPC failure,
 * logged-out server section, and an unreachable server. collectBackupStatus
 * must never throw and must report plain error strings, not stacks.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectBackupStatus, type CollectBackupStatusDeps } from '../../src/backup/status-report.js';
import { CHECKPOINT_CURSOR_KEY } from '../../src/backup/backup-engine.js';
import { openCatalogDb } from '../../src/backup/catalog-db.js';
import { CatalogRepo } from '../../src/backup/catalog-repo.js';
import type { DaemonClient, DaemonMessage } from '../../src/node/ipc-client.js';
import type { NodeBackupConfig, NodeBackupRunSummary } from '../../src/api.js';

function settingsStub(root: string | null, nodeId: string | null): CollectBackupStatusDeps['settings'] {
  return { backupRoot: () => root, backupNodeId: () => nodeId };
}

function serverConfig(): NodeBackupConfig {
  return {
    nodeId: 'node-1',
    enabled: true,
    scheduleCron: '0 3 * * *',
    timezone: 'UTC',
    nextRunAt: '2026-08-10T03:00:00.000Z',
    circleIds: [],
    pending: { items: 12, bytes: '345678' },
  };
}

function serverRun(): NodeBackupRunSummary {
  return {
    id: 'srv-run-1',
    kind: 'incremental',
    status: 'completed',
    trigger: 'scheduled',
    startedAt: '2026-08-09T03:00:00.000Z',
    finishedAt: '2026-08-09T03:05:00.000Z',
    lastAckAt: '2026-08-09T03:04:00.000Z',
    itemsDownloaded: 10,
    itemsSkipped: 2,
    sidecarsWritten: 12,
    bytesDownloaded: '1024',
    errorCount: 0,
    lastError: null,
    cliVersion: '1.2.22',
  };
}

/** Daemon client stub answering backup-status via waitFor. */
function daemonClientStub(snapshot: Record<string, unknown>): DaemonClient {
  return {
    send: () => {},
    onMessage: () => {},
    onClose: () => {},
    waitFor: async () => ({ kind: 'backup-status', ...snapshot }) as DaemonMessage,
    close: () => {},
  };
}

describe('collectBackupStatus', () => {
  it('populates all three sections when everything is reachable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-status-'));
    const db = openCatalogDb(root);
    const repo = new CatalogRepo(db);
    repo.recordRun({
      id: 'run-local',
      kind: 'incremental',
      status: 'completed',
      startedAt: '2026-08-09T01:00:00.000Z',
      itemsDownloaded: 3,
    });
    repo.setCheckpoint(
      CHECKPOINT_CURSOR_KEY,
      JSON.stringify({ updatedAt: '2026-08-09T01:00:59.000Z', id: 'item-c' }),
    );
    db.close();

    const report = await collectBackupStatus({
      settings: settingsStub(root, 'node-1'),
      api: {
        getNodeBackupConfig: async () => ({ config: serverConfig() }),
        listNodeBackupRuns: async (_nodeId, limit) => {
          expect(limit).toBe(5);
          return { runs: [serverRun()] };
        },
      },
      isDaemonRunningFn: async () => true,
      connectFn: async () =>
        daemonClientStub({
          configured: true,
          running: { trigger: 'manual', startedAt: '2026-08-09T02:00:00.000Z' },
          rate: { concurrency: 2, maxMbps: 0 },
        }),
    });

    // Local (offline-capable) section.
    expect(report.local.source).toBe('local catalog');
    expect(report.local.configured).toBe(true);
    expect(report.local.error).toBeNull();
    expect(report.local.lastRun?.id).toBe('run-local');
    expect(report.local.checkpoint?.id).toBe('item-c');
    expect(report.local.counters?.totalItems).toBe(0);

    // Daemon section.
    expect(report.daemon.source).toBe('daemon (IPC)');
    expect(report.daemon.running).toBe(true);
    expect(report.daemon.snapshot?.['configured']).toBe(true);
    expect(report.daemon.error).toBeNull();

    // Server section.
    expect(report.server.source).toBe('server');
    expect(report.server.reachable).toBe(true);
    expect(report.server.config?.nextRunAt).toBe('2026-08-10T03:00:00.000Z');
    expect(report.server.runs).toHaveLength(1);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('degrades every section when fully offline and unconfigured', async () => {
    const report = await collectBackupStatus({
      settings: settingsStub(null, null),
      api: null,
      isDaemonRunningFn: async () => false,
      connectFn: async () => {
        throw new Error('should not connect');
      },
    });

    expect(report.local.configured).toBe(false);
    expect(report.local.error).toContain('no backup root configured');
    expect(report.daemon.running).toBe(false);
    expect(report.daemon.error).toBeNull();
    expect(report.server.reachable).toBe(false);
    expect(report.server.error).toContain('not logged in');
  });

  it('an unreachable server and a failing daemon degrade to error strings, never a throw', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-status-off-'));
    openCatalogDb(root).close();

    const report = await collectBackupStatus({
      settings: settingsStub(root, 'node-1'),
      api: {
        getNodeBackupConfig: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:3535');
        },
        listNodeBackupRuns: async () => ({ runs: [] }),
      },
      isDaemonRunningFn: async () => true,
      connectFn: async () => {
        throw new Error('socket vanished');
      },
    });

    expect(report.local.error).toBeNull();
    expect(report.daemon.error).toContain('socket vanished');
    expect(report.server.reachable).toBe(false);
    expect(report.server.error).toContain('server unreachable');
    expect(report.server.error).toContain('ECONNREFUSED');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('an unreadable catalog degrades the local section only', async () => {
    const report = await collectBackupStatus({
      settings: settingsStub('/backup/root', 'node-1'),
      api: null,
      openDb: () => {
        throw new Error('drive not mounted');
      },
    });
    expect(report.local.configured).toBe(true);
    expect(report.local.counters).toBeNull();
    expect(report.local.error).toContain('could not read the backup catalog');
    expect(report.local.error).toContain('drive not mounted');
  });

  it('omitting the daemon probes yields a quiet not-running section', async () => {
    const report = await collectBackupStatus({
      settings: settingsStub(null, null),
      api: null,
    });
    expect(report.daemon.running).toBe(false);
    expect(report.daemon.snapshot).toBeNull();
    expect(report.daemon.error).toBeNull();
  });
});
