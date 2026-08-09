/**
 * backup/status-report.ts — Merged three-source status for `backup status`
 * (issue #318, epic #308).
 *
 * Three independently-sourced sections, each clearly labeled and each
 * degrading GRACEFULLY (a human-readable `error` string, never a stack
 * trace, never a throw):
 *
 *   local  — the backup root's SQLite catalog: item counters, the mirrored
 *            checkpoint cursor, and the last locally-recorded run. Fully
 *            offline-capable — this section works with no daemon and no
 *            server.
 *   daemon — the running daemon's live snapshot over IPC (is a run active,
 *            live rate knobs). Absent daemon → `running: false`, no error.
 *   server — GET /backup/config (enabled, schedule, nextRunAt, pending lag)
 *            plus the 5 most recent server-side runs. Unreachable server →
 *            `reachable: false` with the reason.
 *
 * Every I/O dependency is injectable so tests can exercise degradation
 * without sockets, catalogs, or HTTP.
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { NodeBackupConfig, NodeBackupRunSummary } from '../api.js';
import { ApiError } from '../api.js';
import type { DaemonClient } from '../node/ipc-client.js';
import { openCatalogDb } from './catalog-db.js';
import { CatalogRepo, type CatalogRun, type CatalogStats } from './catalog-repo.js';
import { CHECKPOINT_CURSOR_KEY } from './backup-engine.js';
import type { BackupCursor } from './events.js';

export interface BackupStatusLocalSection {
  source: 'local catalog';
  configured: boolean;
  root: string | null;
  nodeId: string | null;
  counters: CatalogStats | null;
  checkpoint: BackupCursor | null;
  lastRun: CatalogRun | null;
  error: string | null;
}

export interface BackupStatusDaemonSection {
  source: 'daemon (IPC)';
  running: boolean;
  /** The daemon's backup-status frame minus the kind tag; null when down. */
  snapshot: Record<string, unknown> | null;
  error: string | null;
}

export interface BackupStatusServerSection {
  source: 'server';
  reachable: boolean;
  config: NodeBackupConfig | null;
  runs: NodeBackupRunSummary[];
  error: string | null;
}

export interface BackupStatusReport {
  local: BackupStatusLocalSection;
  daemon: BackupStatusDaemonSection;
  server: BackupStatusServerSection;
}

export interface CollectBackupStatusDeps {
  settings: {
    backupRoot(): string | null;
    backupNodeId(): string | null;
  };
  /** Null when no credentials are stored — the server section degrades. */
  api: {
    getNodeBackupConfig(nodeId: string): Promise<{ config: NodeBackupConfig | null }>;
    listNodeBackupRuns(nodeId: string, limit?: number): Promise<{ runs: NodeBackupRunSummary[] }>;
  } | null;
  openDb?: (root: string) => BetterSqlite3.Database;
  isDaemonRunningFn?: () => Promise<boolean>;
  connectFn?: () => Promise<DaemonClient>;
  /** IPC reply budget in ms (default 3000). */
  ipcTimeoutMs?: number;
}

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return `HTTP ${err.status}: ${err.serverMessage}`;
  return err instanceof Error ? err.message : String(err);
}

async function collectLocal(deps: CollectBackupStatusDeps): Promise<BackupStatusLocalSection> {
  const root = deps.settings.backupRoot();
  const nodeId = deps.settings.backupNodeId();
  const section: BackupStatusLocalSection = {
    source: 'local catalog',
    configured: Boolean(root && nodeId),
    root,
    nodeId,
    counters: null,
    checkpoint: null,
    lastRun: null,
    error: null,
  };
  if (!root || !nodeId) {
    section.error = 'no backup root configured (run `memoriahub backup init --dest <dir>`)';
    return section;
  }
  try {
    const db = (deps.openDb ?? openCatalogDb)(root);
    try {
      const repo = new CatalogRepo(db);
      section.counters = repo.stats();
      section.lastRun = repo.latestRun();
      const raw = repo.getCheckpoint(CHECKPOINT_CURSOR_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<BackupCursor>;
        if (typeof parsed.updatedAt === 'string' && typeof parsed.id === 'string') {
          section.checkpoint = { updatedAt: parsed.updatedAt, id: parsed.id };
        }
      }
    } finally {
      db.close();
    }
  } catch (err) {
    section.error = `could not read the backup catalog: ${errMessage(err)}`;
  }
  return section;
}

async function collectDaemon(deps: CollectBackupStatusDeps): Promise<BackupStatusDaemonSection> {
  const section: BackupStatusDaemonSection = {
    source: 'daemon (IPC)',
    running: false,
    snapshot: null,
    error: null,
  };
  if (!deps.isDaemonRunningFn || !deps.connectFn) return section;
  try {
    if (!(await deps.isDaemonRunningFn())) return section;
    const client = await deps.connectFn();
    try {
      client.send({ cmd: 'backup-status' });
      const reply = await client.waitFor(
        (m) => m.kind === 'backup-status',
        deps.ipcTimeoutMs ?? 3000,
      );
      const { kind: _kind, ...snapshot } = reply;
      section.running = true;
      section.snapshot = snapshot;
    } finally {
      client.close();
    }
  } catch (err) {
    section.error = `daemon did not answer: ${errMessage(err)}`;
  }
  return section;
}

async function collectServer(deps: CollectBackupStatusDeps): Promise<BackupStatusServerSection> {
  const section: BackupStatusServerSection = {
    source: 'server',
    reachable: false,
    config: null,
    runs: [],
    error: null,
  };
  const nodeId = deps.settings.backupNodeId();
  if (!deps.api) {
    section.error = 'not logged in (run `memoriahub login`)';
    return section;
  }
  if (!nodeId) {
    section.error = 'no backup node bound on this machine';
    return section;
  }
  try {
    const [cfgRes, runsRes] = await Promise.all([
      deps.api.getNodeBackupConfig(nodeId),
      deps.api.listNodeBackupRuns(nodeId, 5),
    ]);
    section.reachable = true;
    section.config = cfgRes.config;
    section.runs = runsRes.runs;
  } catch (err) {
    section.error = `server unreachable: ${errMessage(err)}`;
  }
  return section;
}

/** Collect all three sections; each degrades independently, never throws. */
export async function collectBackupStatus(
  deps: CollectBackupStatusDeps,
): Promise<BackupStatusReport> {
  const [local, daemon, server] = await Promise.all([
    collectLocal(deps),
    collectDaemon(deps),
    collectServer(deps),
  ]);
  return { local, daemon, server };
}
