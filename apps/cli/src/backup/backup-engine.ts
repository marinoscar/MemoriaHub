/**
 * backup/backup-engine.ts — Incremental backup run loop (issue #316, epic #308).
 *
 * UI-free and event-emitting (see events.ts) — the engine NEVER prints; all
 * terminal output belongs to render/headless-backup.ts and the command layer.
 *
 * One runBackup() per invocation:
 *   1. POST /runs (kind 'incremental'); 409 → RunAlreadyActiveError.
 *   2. Page loop over GET /changes, cursor = the LOCAL mirrored checkpoint
 *      (initially the server's cursorStart). Items are classified against the
 *      catalog (tombstone / download / sidecar-only / archived-flip move /
 *      null-URL failure) and processed through a bounded worker pool.
 *   3. Crash-safe page commit ORDER: all page files renamed into final place →
 *      ONE catalog transaction (item+dims upserts, statuses, checkpoint
 *      mirror) → POST /ack with the page's nextCursor + stats. A crash before
 *      ack re-fetches and re-processes the same page next run — idempotent
 *      (temp+rename downloads, upserts). The engine NEVER acks ahead of the
 *      local commit.
 *   4. Inter-page pacing, then the next page until hasMore is false.
 *   5. GET /dimensions → catalog/{albums,people,tags,manifest}.json →
 *      POST /runs/:id/finish. Unrecoverable errors finish the run 'failed'
 *      (best-effort) and surface through the returned outcome, never a throw.
 *
 * Presigned URLs are minted per page and expire: a PresignExpiredError makes
 * the engine re-fetch the SAME page (cursor unmoved ⇒ idempotent) to re-mint
 * URLs, capped at MAX_PAGE_REMINTS per page before the remaining items fail.
 *
 * Reconcile runs (issue #320): `kind: 'reconcile'` executes the SAME
 * incremental page loop first (catalog current), then streams the server's
 * reconcile manifest and quarantines/marks-for-redownload via
 * backup/reconcile.ts before the dimension catalogs are written.
 *
 * MULTI-NODE CONTRACT: each machine binds exactly ONE backup root, and nodes
 * never coordinate with each other. Every node keeps its own local catalog +
 * mirrored checkpoint and its own server-side checkpoint row (keyed by
 * nodeId), so node A acking a page can never move node B's cursor. Two nodes
 * backing up the same circles independently converge on identical local
 * content purely by each replaying the same server change feed.
 */

import * as fs from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  ApiClient,
  BackupChangeItem,
  BackupChangesPage,
  BackupFeedCursor,
  BackupRunStatsBody,
} from '../api.js';
import { ApiError } from '../api.js';
import { runPool } from '../sync/worker-pool.js';
import { CatalogRepo, type CatalogItem, type CatalogItemStatus, type SidecarDims } from './catalog-repo.js';
import {
  BACKUP_EV,
  BackupTypedEmitter,
  addStats,
  emptyStats,
  type BackupCursor,
  type BackupEngineStats,
  type BackupItemOutcome,
  type BackupRunStatus,
} from './events.js';
import {
  TMP_DIR,
  CATALOG_DIR,
  absPathFor,
  moveItemFiles,
  planRelPath,
  planTreeTransition,
  sidecarRelPathFor,
  writeSidecar,
} from './layout.js';
import { CATALOG_SCHEMA_VERSION } from './catalog-db.js';
import { TokenBucket } from './rate-limiter.js';
import { downloadVerified, HashMismatchError, PresignExpiredError } from './download.js';
import { performReconcile, type BackupRunKind, type ReconcileSummary } from './reconcile.js';

/** Catalog checkpoint key holding the JSON-encoded mirrored server cursor. */
export const CHECKPOINT_CURSOR_KEY = 'cursor';

/** Maximum same-page re-fetches to re-mint expired presigned URLs. */
export const MAX_PAGE_REMINTS = 3;

/** Thrown by runBackup when the server reports an already-active run (409). */
export class RunAlreadyActiveError extends Error {
  constructor(public readonly activeRunId: string | null) {
    super(
      'A backup run is already active for this node' +
        (activeRunId ? ` (run ${activeRunId})` : '') +
        '. Wait for it to finish or go stale before starting another.',
    );
    this.name = 'RunAlreadyActiveError';
  }
}

export interface BackupEngineOpts {
  /** Absolute backup root. */
  root: string;
  nodeId: string;
  nodeName?: string;
  serverUrl: string;
  /** Run kind; 'reconcile' adds the manifest-diff phase (default 'incremental'). */
  kind?: BackupRunKind;
  trigger: 'manual' | 'scheduled';
  cliVersion: string;
  /** Concurrent download workers. */
  concurrency: number;
  /** Aggregate bandwidth cap in Mbps; 0 = unlimited. */
  maxMbps: number;
  /** Change-feed page size. */
  pageSize: number;
  /** Inter-page pacing delay in ms. */
  pacingMs: number;
}

/** The slice of ApiClient the engine uses — mockable in tests. */
export type BackupApi = Pick<
  ApiClient,
  | 'startNodeBackupRun'
  | 'getNodeBackupChanges'
  | 'ackNodeBackup'
  | 'finishNodeBackupRun'
  | 'getNodeBackupDimensions'
  | 'getNodeBackupManifest'
  | 'getRaw'
>;

export interface BackupEngineDeps {
  api: BackupApi;
  /** Open catalog DB for the backup root (caller owns open/close). */
  db: BetterSqlite3.Database;
  /** Injectable shared token bucket (defaults to one built from maxMbps). */
  bucket?: TokenBucket;
  /** Injectable inter-page sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface BackupRunOutcome {
  runId: string;
  status: BackupRunStatus;
  stats: BackupEngineStats;
  /** Present for reconcile runs whose manifest-diff phase ran (issue #320). */
  reconcile?: ReconcileSummary;
  error?: string;
}

/** Internal per-item processing record. */
interface ItemResult {
  id: string;
  /** 'remint' is transient — resolved by a page re-fetch or the re-mint cap. */
  outcome: BackupItemOutcome | 'remint';
  bytes: number;
  error?: string;
  sidecarWritten: boolean;
  /** Catalog mutation, executed inside the single page-commit transaction. */
  op?: () => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function toWireStats(stats: BackupEngineStats): BackupRunStatsBody {
  return {
    itemsDownloaded: stats.itemsDownloaded,
    itemsSkipped: stats.itemsSkipped,
    sidecarsWritten: stats.sidecarsWritten,
    bytesDownloaded: String(stats.bytesDownloaded),
    errors: stats.errors,
  };
}

function statsFromResults(results: ItemResult[]): BackupEngineStats {
  const stats = emptyStats();
  for (const r of results) {
    switch (r.outcome) {
      case 'downloaded':
        stats.itemsDownloaded++;
        stats.bytesDownloaded += r.bytes;
        break;
      case 'sidecar-only':
      case 'tombstone':
      case 'moved':
        stats.itemsSkipped++;
        break;
      case 'failed':
        stats.errors++;
        break;
      case 'remint':
        // Transient — never reaches stats (resolved before the page commits).
        break;
    }
    if (r.sidecarWritten) stats.sidecarsWritten++;
  }
  return stats;
}

export class BackupEngine extends BackupTypedEmitter {
  private readonly opts: BackupEngineOpts;
  private readonly api: BackupApi;
  private readonly db: BetterSqlite3.Database;
  private readonly repo: CatalogRepo;
  private readonly bucket: TokenBucket;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly kind: BackupRunKind;

  private cancelled = false;

  constructor(opts: BackupEngineOpts, deps: BackupEngineDeps) {
    super();
    this.opts = opts;
    this.kind = opts.kind ?? 'incremental';
    this.api = deps.api;
    this.db = deps.db;
    this.repo = new CatalogRepo(deps.db);
    this.bucket = deps.bucket ?? new TokenBucket(opts.maxMbps);
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? ((): Date => new Date());
  }

  /** Cooperative cancel: in-flight items finish, no further items start, the
   * current page is ABANDONED uncommitted (re-processed next run), and the
   * server run is finished as 'aborted'. */
  cancel(): void {
    this.cancelled = true;
  }

  /** Surface a cooldown-gate trip as a typed event (wired by the caller). */
  emitThrottle(delayMs: number): void {
    this.emit(BACKUP_EV.THROTTLE, { delayMs });
  }

  // ---------------------------------------------------------------------------
  // Run loop
  // ---------------------------------------------------------------------------

  async runBackup(): Promise<BackupRunOutcome> {
    const { nodeId, trigger, cliVersion } = this.opts;

    // 1. Start the server-side run (409 → typed RunAlreadyActiveError).
    let runId: string;
    let cursorStart: { updatedAt: string | null; id: string | null };
    try {
      const res = await this.api.startNodeBackupRun(nodeId, {
        kind: this.kind,
        trigger,
        cliVersion,
      });
      runId = res.run.id;
      cursorStart = res.run.cursorStart;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { activeRunId?: string } | undefined;
        throw new RunAlreadyActiveError(body?.activeRunId ?? null);
      }
      throw err;
    }

    const startedAt = this.now().toISOString();
    this.emit(BACKUP_EV.RUN_STARTED, { runId, kind: this.kind, trigger });

    // 2. Cursor: local mirrored checkpoint wins (it may be AHEAD of the server
    //    after a committed-but-unacked page); fall back to the server snapshot.
    let cursor = this.readLocalCursor();
    if (!cursor && cursorStart.updatedAt !== null && cursorStart.id !== null) {
      cursor = { updatedAt: cursorStart.updatedAt, id: cursorStart.id };
    }

    const totals = emptyStats();

    try {
      let pageIndex = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (this.cancelled) {
          return await this.finishRun(runId, 'aborted', totals, startedAt);
        }

        const page = await this.api.getNodeBackupChanges(nodeId, {
          runId,
          cursor,
          limit: this.opts.pageSize,
        });
        this.emit(BACKUP_EV.PAGE_FETCHED, {
          pageIndex,
          items: page.items.length,
          hasMore: page.hasMore,
        });

        if (page.items.length > 0) {
          const results = await this.processPage(runId, cursor, page);
          if (this.cancelled) {
            // A partially-processed page is NEVER committed or acked — the
            // whole page is re-fetched and re-processed next run (idempotent).
            return await this.finishRun(runId, 'aborted', totals, startedAt);
          }

          const nextCursor = page.nextCursor as BackupFeedCursor;
          const pageStats = statsFromResults(results);

          // 3. Crash-safe commit order: files are already in final place →
          //    ONE catalog transaction → ack. Never ack ahead of the commit.
          this.repo.transaction(() => {
            for (const r of results) r.op?.();
            this.repo.setCheckpoint(CHECKPOINT_CURSOR_KEY, JSON.stringify(nextCursor));
          });

          await this.api.ackNodeBackup(nodeId, {
            runId,
            cursor: nextCursor,
            stats: toWireStats(pageStats),
          });

          addStats(totals, pageStats);
          this.emit(BACKUP_EV.PAGE_COMMITTED, { cursor: nextCursor, stats: pageStats });
          cursor = nextCursor;
        }

        if (!page.hasMore) break;
        await this.sleep(this.opts.pacingMs);
        pageIndex++;
      }

      // 4. Reconcile phase (kind 'reconcile' only, issue #320): the catalog
      //    is now current, so stream the server manifest and diff it. A
      //    cancel mid-stream aborts the run without running the diff.
      let reconcile: ReconcileSummary | undefined;
      if (this.kind === 'reconcile') {
        this.emit(BACKUP_EV.RECONCILE_STARTED, { runId });
        reconcile = await performReconcile(
          { root: this.opts.root, nodeId, runId },
          {
            api: this.api,
            db: this.db,
            now: this.now,
            isCancelled: () => this.cancelled,
          },
        );
        this.emit(BACKUP_EV.RECONCILE_DONE, reconcile);
        if (reconcile.cancelled) {
          return await this.finishRun(runId, 'aborted', totals, startedAt, undefined, reconcile);
        }
      }

      // 5. Dimension catalogs + manifest (completed runs only).
      await this.writeDimensionCatalogs(cursor, runId, startedAt, totals);

      return await this.finishRun(runId, 'completed', totals, startedAt, undefined, reconcile);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.listenerCount(BACKUP_EV.ERROR) > 0) {
        this.emit(BACKUP_EV.ERROR, { message });
      }
      return await this.finishRun(runId, 'failed', totals, startedAt, message);
    }
  }

  // ---------------------------------------------------------------------------
  // Page processing (worker pool + expired-URL re-mint)
  // ---------------------------------------------------------------------------

  private async processPage(
    runId: string,
    cursor: BackupCursor | null,
    page: BackupChangesPage,
  ): Promise<ItemResult[]> {
    // In-page rel_path claims: two NEW items with the same filename+bucket
    // would otherwise both plan the plain path (neither is in the catalog
    // yet), collide on the rel_path UNIQUE constraint, and roll the whole
    // page commit back.
    const pageClaims = new Map<string, string>();

    let results = await this.processItems(page.items, pageClaims);

    // Expired presigned URLs → re-fetch the SAME page (cursor unmoved ⇒
    // idempotent; URLs are minted per page), cap MAX_PAGE_REMINTS.
    let remints = 0;
    while (results.some((r) => r.outcome === 'remint') && !this.cancelled) {
      if (remints >= MAX_PAGE_REMINTS) {
        results = results.map((r) => {
          if (r.outcome !== 'remint') return r;
          const item = page.items.find((i) => i.id === r.id);
          const failed = this.failedResult(
            item,
            r.id,
            'presigned download URL expired (page re-mint cap reached)',
            pageClaims,
          );
          this.emit(BACKUP_EV.ITEM_DONE, {
            id: r.id,
            outcome: 'failed',
            bytes: 0,
            error: failed.error,
          });
          return failed;
        });
        break;
      }
      remints++;

      const fresh = await this.api.getNodeBackupChanges(this.opts.nodeId, {
        runId,
        cursor,
        limit: this.opts.pageSize,
      });
      const freshById = new Map(fresh.items.map((i) => [i.id, i]));

      const redoIds = results.filter((r) => r.outcome === 'remint').map((r) => r.id);
      const redoItems = redoIds
        .map((id) => freshById.get(id))
        .filter((i): i is BackupChangeItem => i !== undefined);

      const redoResults = await this.processItems(redoItems, pageClaims);
      const redoById = new Map(redoResults.map((r) => [r.id, r]));

      results = results.flatMap((r) => {
        if (r.outcome !== 'remint') return [r];
        const redone = redoById.get(r.id);
        if (redone) return [redone];
        // The item vanished from the re-fetched page: its updatedAt moved past
        // this cursor window, so the feed will serve it again at its new
        // position — drop it from this page entirely (no stats, no op).
        return [];
      });
    }

    return results;
  }

  private async processItems(
    items: BackupChangeItem[],
    pageClaims: Map<string, string>,
  ): Promise<ItemResult[]> {
    const results: ItemResult[] = [];

    await runPool(
      items,
      Math.max(1, this.opts.concurrency),
      async (item) => {
        this.emit(BACKUP_EV.ITEM_STARTED, { id: item.id });
        let result: ItemResult;
        try {
          result = await this.processItem(item, pageClaims);
        } catch (err) {
          if (err instanceof PresignExpiredError) {
            results.push({ id: item.id, outcome: 'remint', bytes: 0, sidecarWritten: false });
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          result = this.failedResult(item, item.id, message, pageClaims);
        }
        results.push(result);
        this.emit(BACKUP_EV.ITEM_DONE, {
          id: result.id,
          outcome: result.outcome as BackupItemOutcome,
          bytes: result.bytes,
          ...(result.error !== undefined ? { error: result.error } : {}),
        });
      },
      () => this.cancelled,
    );

    return results;
  }

  // ---------------------------------------------------------------------------
  // Per-item classification + processing
  // ---------------------------------------------------------------------------

  private async processItem(
    item: BackupChangeItem,
    pageClaims: Map<string, string>,
  ): Promise<ItemResult> {
    const { root } = this.opts;
    const existing = this.repo.getById(item.id);
    const archived = item.archivedAt !== null;

    // --- Tombstone: mark trashed, rewrite sidecar, file stays in place. -----
    if (item.deletedAt !== null) {
      const relPath = existing?.relPath ?? this.planPath(item, pageClaims);
      const sidecarRel = writeSidecar(root, relPath, item.sidecar);
      const op = (): void =>
        this.repo.upsertItemWithDims(
          this.catalogFields(item, relPath, sidecarRel, 'trashed', {
            downloadedAt: existing?.downloadedAt ?? null,
            verifiedAt: existing?.verifiedAt ?? null,
          }),
          item.sidecar as SidecarDims,
        );
      return { id: item.id, outcome: 'tombstone', bytes: 0, sidecarWritten: true, op };
    }

    // --- Does this item need its bytes (re-)downloaded? ---------------------
    const expectedSize = item.storage ? Number(item.storage.size) : null;
    let needsDownload = false;
    if (!existing) {
      needsDownload = true;
    } else if (existing.contentHash !== item.contentHash) {
      needsDownload = true;
    } else if (existing.status === 'failed') {
      needsDownload = true;
    } else {
      const abs = absPathFor(root, existing.relPath);
      let st: fs.Stats | null = null;
      try {
        st = fs.statSync(abs);
      } catch {
        st = null;
      }
      if (!st || !st.isFile()) {
        needsDownload = true;
      } else if (expectedSize !== null && st.size !== expectedSize) {
        needsDownload = true;
      }
    }

    if (needsDownload) {
      // Null URL on an item whose bytes we need: record the failure and move
      // on — never block the run (the next run retries via status='failed').
      if (!item.downloadUrl) {
        return this.failedResult(item, item.id, 'no download URL available for this item', pageClaims);
      }

      // Download lands directly in the item's CURRENT tree (an archived-flip
      // and a content change in one update collapse into one download).
      const relPath = existing
        ? planTreeTransition(existing.relPath, item.archivedAt).toRelPath
        : this.planPath(item, pageClaims);
      const destAbs = absPathFor(root, relPath);
      const partAbs = absPathFor(root, `${TMP_DIR}/${item.id}.part`);

      let bytes: number;
      try {
        const res = await downloadVerified(
          { url: item.downloadUrl, destAbsPath: destAbs, partAbsPath: partAbs, contentHash: item.contentHash },
          { api: this.api, bucket: this.bucket },
        );
        bytes = res.bytes;
      } catch (err) {
        if (err instanceof PresignExpiredError) throw err;
        const message =
          err instanceof HashMismatchError
            ? err.message
            : `download failed: ${err instanceof Error ? err.message : String(err)}`;
        return this.failedResult(item, item.id, message, pageClaims);
      }

      // Tree flip + fresh download: remove the stale copy from the old tree.
      if (existing && existing.relPath !== relPath) {
        this.rmSafe(absPathFor(root, existing.relPath));
        this.rmSafe(absPathFor(root, sidecarRelPathFor(existing.relPath)));
      }

      const nowIso = this.now().toISOString();
      const sidecarRel = writeSidecar(root, relPath, item.sidecar);
      const op = (): void =>
        this.repo.upsertItemWithDims(
          this.catalogFields(item, relPath, sidecarRel, 'present', {
            downloadedAt: nowIso,
            verifiedAt: item.contentHash !== null ? nowIso : null,
          }),
          item.sidecar as SidecarDims,
        );
      return { id: item.id, outcome: 'downloaded', bytes, sidecarWritten: true, op };
    }

    // --- Metadata-only: sidecar rewrite, possibly a tree move. --------------
    const row = existing as CatalogItem;
    // Quarantined files are owned by the (later) verify/reconcile child — a
    // metadata refresh must not resurrect them to 'present'.
    const keepStatus: CatalogItemStatus = row.status === 'quarantined' ? 'quarantined' : 'present';
    const transition = planTreeTransition(row.relPath, item.archivedAt);

    if (transition.changed) {
      const fromAbs = absPathFor(root, transition.fromRelPath);
      if (fs.existsSync(fromAbs)) {
        moveItemFiles(root, transition.fromRelPath, transition.toRelPath);
      }
      const sidecarRel = writeSidecar(root, transition.toRelPath, item.sidecar);
      const op = (): void =>
        this.repo.upsertItemWithDims(
          this.catalogFields(item, transition.toRelPath, sidecarRel, keepStatus, {
            downloadedAt: row.downloadedAt,
            verifiedAt: row.verifiedAt,
          }),
          item.sidecar as SidecarDims,
        );
      return { id: item.id, outcome: 'moved', bytes: 0, sidecarWritten: true, op };
    }

    const sidecarRel = writeSidecar(root, row.relPath, item.sidecar);
    const op = (): void =>
      this.repo.upsertItemWithDims(
        this.catalogFields(item, row.relPath, sidecarRel, keepStatus, {
          downloadedAt: row.downloadedAt,
          verifiedAt: row.verifiedAt,
        }),
        item.sidecar as SidecarDims,
      );
    return { id: item.id, outcome: 'sidecar-only', bytes: 0, sidecarWritten: true, op };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Plan (and claim, within this page) a rel_path for an uncataloged item. */
  private planPath(item: BackupChangeItem, pageClaims: Map<string, string>): string {
    const relPath = planRelPath(
      {
        mediaItemId: item.id,
        originalFilename: item.originalFilename,
        capturedAt: item.capturedAt,
        capturedAtOffset: item.capturedAtOffset,
        archivedAt: item.archivedAt,
      },
      (rel) => pageClaims.get(rel) ?? this.repo.ownerOfPath(rel),
    );
    pageClaims.set(relPath, item.id);
    return relPath;
  }

  /** Common catalog row fields derived from a feed item. */
  private catalogFields(
    item: BackupChangeItem,
    relPath: string,
    sidecarRelPath: string,
    status: CatalogItemStatus,
    extra: { downloadedAt: string | null; verifiedAt: string | null; lastError?: string | null },
  ): Omit<CatalogItem, 'updatedAt'> {
    return {
      mediaItemId: item.id,
      circleId: item.circleId,
      relPath,
      sidecarRelPath,
      capturedAt: item.capturedAt,
      contentHash: item.contentHash,
      size: item.storage ? Number(item.storage.size) : null,
      mimeType: item.storage?.mimeType ?? null,
      serverUpdatedAt: item.updatedAt,
      status,
      archived: item.archivedAt !== null,
      downloadedAt: extra.downloadedAt,
      verifiedAt: extra.verifiedAt,
      lastError: extra.lastError ?? null,
    };
  }

  /** Build a 'failed' result whose op records the failure in the catalog. */
  private failedResult(
    item: BackupChangeItem | undefined,
    id: string,
    error: string,
    pageClaims: Map<string, string>,
  ): ItemResult {
    let op: (() => void) | undefined;
    if (item) {
      const existing = this.repo.getById(id);
      if (existing) {
        op = (): void => this.repo.setStatus(id, 'failed', error);
      } else {
        const relPath = this.planPath(item, pageClaims);
        op = (): void =>
          this.repo.upsertItemWithDims(
            this.catalogFields(item, relPath, sidecarRelPathFor(relPath), 'failed', {
              downloadedAt: null,
              verifiedAt: null,
              lastError: error,
            }),
            item.sidecar as SidecarDims,
          );
      }
    }
    return { id, outcome: 'failed', bytes: 0, error, sidecarWritten: false, op };
  }

  private rmSafe(absPath: string): void {
    try {
      fs.rmSync(absPath, { force: true });
    } catch {
      /* best-effort */
    }
  }

  private readLocalCursor(): BackupCursor | null {
    const raw = this.repo.getCheckpoint(CHECKPOINT_CURSOR_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<BackupCursor>;
      if (typeof parsed.updatedAt === 'string' && typeof parsed.id === 'string') {
        return { updatedAt: parsed.updatedAt, id: parsed.id };
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Dimension catalogs + manifest (completed runs only)
  // ---------------------------------------------------------------------------

  private async writeDimensionCatalogs(
    checkpoint: BackupCursor | null,
    runId: string,
    startedAt: string,
    totals: BackupEngineStats,
  ): Promise<void> {
    const dims = await this.api.getNodeBackupDimensions(this.opts.nodeId);
    this.writeCatalogJson('albums.json', dims.albums);
    this.writeCatalogJson('people.json', dims.people);
    this.writeCatalogJson('tags.json', dims.tags);

    this.writeCatalogJson('manifest.json', {
      serverUrl: this.opts.serverUrl,
      nodeId: this.opts.nodeId,
      nodeName: this.opts.nodeName ?? null,
      catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
      checkpoint,
      counts: this.repo.stats(),
      lastRun: {
        id: runId,
        kind: this.kind,
        status: 'completed',
        startedAt,
        finishedAt: this.now().toISOString(),
        stats: totals,
      },
      generatedAt: this.now().toISOString(),
    });
  }

  private writeCatalogJson(fileName: string, payload: unknown): void {
    const abs = absPathFor(this.opts.root, `${CATALOG_DIR}/${fileName}`);
    fs.mkdirSync(absPathFor(this.opts.root, CATALOG_DIR), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, abs);
  }

  // ---------------------------------------------------------------------------
  // Run finalization
  // ---------------------------------------------------------------------------

  private async finishRun(
    runId: string,
    status: BackupRunStatus,
    totals: BackupEngineStats,
    startedAt: string,
    error?: string,
    reconcile?: ReconcileSummary,
  ): Promise<BackupRunOutcome> {
    const finishedAt = this.now().toISOString();

    // Local run record first — it must survive even when the finish POST fails.
    try {
      this.repo.recordRun({
        id: runId,
        kind: this.kind,
        status,
        startedAt,
        finishedAt,
        itemsDownloaded: totals.itemsDownloaded,
        itemsSkipped: totals.itemsSkipped,
        bytesDownloaded: totals.bytesDownloaded,
        errorCount: totals.errors,
        lastError: error ?? null,
      });
    } catch {
      /* best-effort */
    }

    try {
      await this.api.finishNodeBackupRun(this.opts.nodeId, runId, {
        status,
        ...(error !== undefined ? { error: error.slice(0, 4000) } : {}),
        finalStats: toWireStats(totals),
      });
    } catch {
      // Best-effort: an unreachable server must not mask the real outcome;
      // the server's stale-run release reclaims the run later.
    }

    this.emit(BACKUP_EV.RUN_FINISHED, {
      status,
      stats: totals,
      ...(error !== undefined ? { error } : {}),
    });

    return {
      runId,
      status,
      stats: totals,
      ...(reconcile !== undefined ? { reconcile } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }
}
