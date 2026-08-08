/**
 * backup/init-backup.ts — UI-free engine behind `memoriahub backup init`
 * (issue #314, epic #308).
 *
 * Binds THIS machine to a single backup root:
 *   1. refuses a second root while one is configured (v1: one root per machine);
 *   2. registers a worker node when the CLI has none (injected — the command
 *      layer wires the real registerWorkerNode / enroll UX);
 *   3. enables backup server-side via PUT /api/nodes/:id/backup/config;
 *   4. creates the root directory skeleton + the per-root SQLite catalog and
 *      seeds its meta table;
 *   5. persists backup.root / backup.nodeId in the central CLI settings KV.
 *
 * Presentation-free: never prints, never calls process.exit. Progress/decisions
 * surface through the typed result; failures throw typed errors for the
 * command layer to render. Mirrors the registerWorkerNode / enrollNode
 * dependency-injection precedent so it is unit-testable without network or a
 * real home directory.
 */

import * as path from 'node:path';
import type { ApiClient, NodeBackupConfig } from '../api.js';
import { CatalogRepo } from './catalog-repo.js';
import { createRootSkeleton } from './layout.js';
import { openCatalogDb } from './catalog-db.js';

/** Thrown when a different backup root is already configured on this machine. */
export class BackupRootConflictError extends Error {
  constructor(
    public readonly existingRoot: string,
    public readonly requestedRoot: string,
  ) {
    super(
      `A backup root is already configured on this machine: ${existingRoot}. ` +
        `Only one backup root per machine is supported. Finish or abandon that ` +
        `root before initializing ${requestedRoot}.`,
    );
    this.name = 'BackupRootConflictError';
  }
}

/** The central-settings surface the engine needs (SettingsRepo satisfies it). */
export interface BackupSettingsStore {
  backupRoot(): string | null;
  setBackupRoot(root: string): void;
  backupNodeId(): string | null;
  setBackupNodeId(nodeId: string): void;
}

export interface BackupInitInput {
  /** Destination directory (absolute or relative; resolved against cwd). */
  destDir: string;
  /** Worker-node id already stored in CLI config, if any. */
  existingNodeId: string | null;
  /** Node name used only when a new node must be registered. */
  nodeName: string;
  /** Circle scope for the server-side config; empty = all owner circles. */
  circleIds: string[];
  /** Server URL recorded in the catalog meta table. */
  serverUrl: string;
}

export interface BackupInitDeps {
  api: Pick<ApiClient, 'putNodeBackupConfig'>;
  /**
   * Register (or re-attach) this machine as a worker node; only invoked when
   * `existingNodeId` is null. The command layer wires the real
   * registerWorkerNode flow (capability probe + config persistence).
   */
  registerNode: (name: string) => Promise<{ nodeId: string; reattached: boolean }>;
  settings: BackupSettingsStore;
  /** Injectable for tests — defaults to the real catalog opener. */
  openCatalogFn?: typeof openCatalogDb;
  /** Injectable clock for deterministic meta timestamps in tests. */
  now?: () => Date;
}

export interface BackupInitResult {
  /** Absolute backup root path. */
  root: string;
  nodeId: string;
  /** True when this call registered a worker node (none was configured). */
  registeredNode: boolean;
  /** True when registration re-attached to an existing server-side node row. */
  reattached: boolean;
  /** True when the root was already configured and was re-bound/refreshed. */
  reinitialized: boolean;
  /** The server-acknowledged backup config. */
  config: NodeBackupConfig;
}

/**
 * Run `backup init`. Idempotent against the same root: re-running re-binds and
 * refreshes meta without destroying an existing catalog (migrations are
 * version-gated no-ops). A DIFFERENT root while one is configured is a hard
 * error (BackupRootConflictError).
 */
export async function runBackupInit(
  input: BackupInitInput,
  deps: BackupInitDeps,
): Promise<BackupInitResult> {
  const openCatalogFn = deps.openCatalogFn ?? openCatalogDb;
  const now = deps.now ?? ((): Date => new Date());

  const root = path.resolve(input.destDir);

  // 1. Single-backup-root-per-machine guard (v1).
  const existingRoot = deps.settings.backupRoot();
  const reinitialized = existingRoot !== null && path.resolve(existingRoot) === root;
  if (existingRoot !== null && !reinitialized) {
    throw new BackupRootConflictError(existingRoot, root);
  }

  // 2. Ensure a worker-node identity exists.
  let nodeId = input.existingNodeId;
  let registeredNode = false;
  let reattached = false;
  if (!nodeId) {
    const reg = await deps.registerNode(input.nodeName);
    nodeId = reg.nodeId;
    registeredNode = true;
    reattached = reg.reattached;
  }

  // 3. Enable backup server-side. The controller returns { config } top-level;
  //    a PUT always yields a non-null config.
  const res = await deps.api.putNodeBackupConfig(nodeId, {
    enabled: true,
    circleIds: input.circleIds,
  });
  if (!res.config) {
    throw new Error('Server returned no backup config from PUT /backup/config');
  }

  // 4. Create the on-disk skeleton + catalog, and seed/refresh meta.
  createRootSkeleton(root);
  const db = openCatalogFn(root);
  try {
    const repo = new CatalogRepo(db);
    repo.setMeta('server_url', input.serverUrl);
    repo.setMeta('node_id', nodeId);
    repo.setMeta('node_name', input.nodeName);
    repo.setMetaIfAbsent(
      'schema_note',
      'MemoriaHub backup catalog — a plain SQLite database; inspect it with any sqlite3 client.',
    );
    // created_at records FIRST initialization; re-runs never move it.
    repo.setMetaIfAbsent('created_at', now().toISOString());
  } finally {
    db.close();
  }

  // 5. Persist the machine-level binding last, once everything else succeeded.
  deps.settings.setBackupRoot(root);
  deps.settings.setBackupNodeId(nodeId);

  return {
    root,
    nodeId,
    registeredNode,
    reattached,
    reinitialized,
    config: res.config,
  };
}
