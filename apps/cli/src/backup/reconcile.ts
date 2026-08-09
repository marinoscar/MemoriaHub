/**
 * backup/reconcile.ts — Full reconcile pass + quarantine management
 * (issue #320, epic #308).
 *
 * A reconcile run (BackupEngine `kind: 'reconcile'`) FIRST executes a normal
 * incremental pass (so the catalog is current), THEN streams the server's
 * reconcile manifest (GET /api/nodes/:id/backup/manifest, id-keyset pages)
 * to completion, building the server id-set in a TEMP SQLite table
 * `reconcile_ids(id TEXT PRIMARY KEY)` inside the catalog DB connection —
 * memory-safe for millions of ids — and diffs it against the catalog:
 *
 *  - catalog rows (status present/trashed/failed) ABSENT from the manifest →
 *    QUARANTINE: the file + sidecar move to `_quarantine/<original subtree>`
 *    (cross-device-safe move), status='quarantined', and the reconcile run id
 *    + date are recorded in last_error. NOTHING is ever deleted here — only
 *    `backup prune --yes` removes quarantined bytes.
 *  - manifest rows whose contentHash DIFFERS from the catalog's → marked for
 *    re-download: content_hash cleared, status='failed', so the next
 *    incremental pass re-fetches the bytes (the engine's classification
 *    re-downloads failed rows).
 *
 * The temp table is connection-scoped and dropped on finish, so a crash can
 * never leave reconcile state behind. The diff runs ONLY when the manifest
 * streamed to completion — a cancelled/partial stream must not quarantine
 * everything it did not get to see.
 *
 * Auto-cadence: `backup run` upgrades to `kind:'reconcile'` when the server
 * config's lastReconcileAt is older than RECONCILE_EVERY_DAYS (or null);
 * `backup run --reconcile` forces it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { ApiClient } from '../api.js';
import { CatalogRepo, type CatalogItem } from './catalog-repo.js';
import {
  QUARANTINE_DIR,
  absPathFor,
  renameWithFallback,
  sidecarRelPathFor,
} from './layout.js';

/** A reconcile pass is auto-scheduled when the last one is older than this. */
export const RECONCILE_EVERY_DAYS = 30;

/** Manifest page size streamed during a reconcile pass. */
export const RECONCILE_MANIFEST_PAGE_SIZE = 1000;

export type BackupRunKind = 'incremental' | 'reconcile';

// ---------------------------------------------------------------------------
// Auto-cadence
// ---------------------------------------------------------------------------

/**
 * True when the server-recorded lastReconcileAt is null/unparsable or at
 * least RECONCILE_EVERY_DAYS old — the "upgrade this run to a reconcile"
 * decision `backup run` makes.
 */
export function shouldAutoReconcile(
  lastReconcileAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (lastReconcileAt === null || lastReconcileAt === undefined) return true;
  const t = Date.parse(lastReconcileAt);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t >= RECONCILE_EVERY_DAYS * 86_400_000;
}

export interface ResolvedRunKind {
  kind: BackupRunKind;
  /** Why a reconcile was chosen; null for a plain incremental. */
  reason: 'forced' | 'auto' | null;
}

/**
 * Decide the run kind for `backup run`: `--reconcile` forces it; otherwise
 * the server config's lastReconcileAt drives the 30-day auto-cadence. A
 * config fetch failure degrades to a plain incremental (never blocks a run).
 */
export async function resolveRunKind(
  api: Pick<ApiClient, 'getNodeBackupConfig'>,
  nodeId: string,
  forceReconcile: boolean,
  now: Date = new Date(),
): Promise<ResolvedRunKind> {
  if (forceReconcile) return { kind: 'reconcile', reason: 'forced' };
  try {
    const { config } = await api.getNodeBackupConfig(nodeId);
    const lastReconcileAt =
      typeof config?.lastReconcileAt === 'string' ? config.lastReconcileAt : null;
    if (shouldAutoReconcile(lastReconcileAt, now)) {
      return { kind: 'reconcile', reason: 'auto' };
    }
  } catch {
    // Best-effort: an unreachable config check never blocks the run.
  }
  return { kind: 'incremental', reason: null };
}

// ---------------------------------------------------------------------------
// Reconcile pass (manifest stream → temp-table diff → quarantine/drift)
// ---------------------------------------------------------------------------

export interface ReconcileSummary {
  /** Ids streamed from the server manifest. */
  manifestIds: number;
  /** Catalog rows quarantined (absent from the manifest). */
  quarantined: number;
  /** Catalog rows marked for re-download (contentHash drift). */
  driftMarked: number;
  /** True when the stream was cancelled before completion (no diff ran). */
  cancelled: boolean;
}

export interface PerformReconcileOpts {
  root: string;
  nodeId: string;
  runId: string;
  pageSize?: number;
}

export interface PerformReconcileDeps {
  api: Pick<ApiClient, 'getNodeBackupManifest'>;
  db: BetterSqlite3.Database;
  now?: () => Date;
  isCancelled?: () => boolean;
}

/** Quarantine rel path: the original subtree prefixed with `_quarantine/`. */
export function quarantineRelPathFor(relPath: string): string {
  return `${QUARANTINE_DIR}/${relPath}`;
}

/**
 * Move an item's file + sidecar into `_quarantine/` (preserving the subtree)
 * and update the catalog row. Tolerates a missing media file (a 'failed' row
 * may never have downloaded bytes) — the catalog row is quarantined either
 * way so prune can reap it later. Cross-device-safe via renameWithFallback.
 */
export function quarantineItem(
  root: string,
  repo: CatalogRepo,
  item: CatalogItem,
  lastError: string,
): void {
  const toRel = quarantineRelPathFor(item.relPath);
  const fromAbs = absPathFor(root, item.relPath);
  const toAbs = absPathFor(root, toRel);

  if (fs.existsSync(fromAbs)) {
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    renameWithFallback(fromAbs, toAbs);
  }
  const fromSidecar = absPathFor(root, sidecarRelPathFor(item.relPath));
  if (fs.existsSync(fromSidecar)) {
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    renameWithFallback(fromSidecar, absPathFor(root, sidecarRelPathFor(toRel)));
  }

  repo.transaction(() => {
    repo.setRelPath(item.mediaItemId, toRel, sidecarRelPathFor(toRel));
    repo.setStatus(item.mediaItemId, 'quarantined', lastError);
  });
}

/**
 * Stream the reconcile manifest into a temp id table and diff it against the
 * catalog (see the module header for the full contract). Files are moved
 * BEFORE their catalog rows are updated — the same files-then-catalog order
 * the engine's page commit uses — so a crash mid-quarantine leaves a moved
 * file with a stale row, which the next reconcile re-heals (the move is a
 * no-op for a missing source file).
 */
export async function performReconcile(
  opts: PerformReconcileOpts,
  deps: PerformReconcileDeps,
): Promise<ReconcileSummary> {
  const { db } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const isCancelled = deps.isCancelled ?? ((): boolean => false);
  const repo = new CatalogRepo(db);
  const pageSize = Math.max(1, opts.pageSize ?? RECONCILE_MANIFEST_PAGE_SIZE);

  const summary: ReconcileSummary = {
    manifestIds: 0,
    quarantined: 0,
    driftMarked: 0,
    cancelled: false,
  };

  db.exec('CREATE TEMP TABLE IF NOT EXISTS reconcile_ids(id TEXT PRIMARY KEY)');
  db.exec('DELETE FROM reconcile_ids');
  const insertId = db.prepare('INSERT OR REPLACE INTO reconcile_ids (id) VALUES (?)');

  try {
    // --- 1. Stream the manifest to completion, id-keyset pages. -------------
    let afterId: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (isCancelled()) {
        summary.cancelled = true;
        return summary;
      }

      const page = await deps.api.getNodeBackupManifest(opts.nodeId, {
        runId: opts.runId,
        ...(afterId !== undefined ? { afterId } : {}),
        limit: pageSize,
      });

      db.transaction(() => {
        for (const item of page.items) {
          insertId.run(item.id);
          summary.manifestIds++;

          // Hash drift: the server's contentHash no longer matches what the
          // catalog recorded → clear the hash and fail the row so the next
          // incremental pass re-downloads the bytes.
          if (item.contentHash === null) continue;
          const existing = repo.getById(item.id);
          if (
            existing &&
            existing.status === 'present' &&
            existing.contentHash !== null &&
            existing.contentHash.toLowerCase() !== item.contentHash.toLowerCase()
          ) {
            repo.markForRedownload(
              item.id,
              `reconcile run ${opts.runId} at ${now().toISOString()}: server contentHash drift`,
            );
            summary.driftMarked++;
          }
        }
      })();

      if (!page.hasMore || page.nextAfterId === null) break;
      afterId = page.nextAfterId;
    }

    if (isCancelled()) {
      summary.cancelled = true;
      return summary;
    }

    // --- 2. Diff: cataloged but absent from the manifest → quarantine. -------
    // The manifest includes trashed (soft-deleted) items; absence means the
    // item was HARD-deleted server-side or left the backup scope.
    const absentRows = db
      .prepare<[], { media_item_id: string }>(
        `SELECT media_item_id FROM items
         WHERE status IN ('present','trashed','failed')
           AND media_item_id NOT IN (SELECT id FROM reconcile_ids)
         ORDER BY media_item_id`,
      )
      .all();

    for (const row of absentRows) {
      const item = repo.getById(row.media_item_id);
      if (!item) continue;
      quarantineItem(
        opts.root,
        repo,
        item,
        `quarantined by reconcile run ${opts.runId} at ${now().toISOString()}: absent from server manifest`,
      );
      summary.quarantined++;
    }

    return summary;
  } finally {
    db.exec('DROP TABLE IF EXISTS reconcile_ids');
  }
}

// ---------------------------------------------------------------------------
// Quarantine listing + prune (`memoriahub backup prune`)
// ---------------------------------------------------------------------------

export interface QuarantineEntry {
  mediaItemId: string;
  relPath: string;
  sidecarRelPath: string;
  /** Catalog-recorded byte size (null when unknown). */
  size: number | null;
  /** Quarantine timestamp — the row's updated_at (set when it was moved). */
  quarantinedAt: string;
  lastError: string | null;
}

/**
 * List quarantined catalog rows, optionally only those quarantined more than
 * `olderThanDays` ago (based on the row's updated_at — the quarantine write
 * is the last mutation a quarantined row ever sees).
 */
export function listQuarantined(
  db: BetterSqlite3.Database,
  olderThanDays?: number,
  now: Date = new Date(),
): QuarantineEntry[] {
  const repo = new CatalogRepo(db);
  const rows = repo.listByStatus('quarantined');
  const cutoff =
    olderThanDays !== undefined ? now.getTime() - olderThanDays * 86_400_000 : null;
  return rows
    .filter((r) => {
      if (cutoff === null) return true;
      const t = Date.parse(r.updatedAt);
      return Number.isFinite(t) && t < cutoff;
    })
    .map((r) => ({
      mediaItemId: r.mediaItemId,
      relPath: r.relPath,
      sidecarRelPath: r.sidecarRelPath,
      size: r.size,
      quarantinedAt: r.updatedAt,
      lastError: r.lastError,
    }));
}

export interface PruneResult {
  deleted: QuarantineEntry[];
  bytesFreed: number;
}

/**
 * PERMANENTLY delete quarantined entries: file + sidecar + catalog row (and
 * its dimension rows). This is the ONLY code path that unlinks quarantined
 * bytes — reconcile itself never deletes. Callers gate it behind `--yes`.
 */
export function pruneQuarantine(
  root: string,
  db: BetterSqlite3.Database,
  entries: QuarantineEntry[],
): PruneResult {
  const repo = new CatalogRepo(db);
  const deleted: QuarantineEntry[] = [];
  let bytesFreed = 0;

  for (const entry of entries) {
    try {
      fs.rmSync(absPathFor(root, entry.relPath), { force: true });
      fs.rmSync(absPathFor(root, entry.sidecarRelPath), { force: true });
    } catch {
      // Best-effort file removal; the catalog row still goes.
    }
    repo.deleteItem(entry.mediaItemId);
    deleted.push(entry);
    bytesFreed += entry.size ?? 0;
  }

  return { deleted, bytesFreed };
}
