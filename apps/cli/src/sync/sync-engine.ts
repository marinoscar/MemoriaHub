/**
 * sync/sync-engine.ts — Event-driven SyncEngine.
 *
 * Encapsulates all sync logic: folder resolution, file enumeration, dedup
 * checking, uploading, error handling, retry, and crash recovery.
 *
 * The engine is UI-free — it emits typed events consumed by renderers
 * (headless CLI or Ink TUI).  All deps are injected so the engine is
 * fully unit-testable without hitting the filesystem or network.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TypedEmitter, EV } from './events.js';
import { runPool } from './worker-pool.js';
import { enumerateFiles } from '../files.js';
import { sha256File } from '../hash.js';
import { uploadFile } from '../upload.js';
import type { ApiClient } from '../api.js';
import type { FolderRepo } from '../repo/folders.js';
import type { FileRepo } from '../repo/files.js';
import type { RunRepo } from '../repo/runs.js';
import type { SettingsRepo } from '../repo/settings.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SyncOptions {
  /** Explicit folder IDs to sync (ignored when all=true). */
  folderIds?: number[];
  /** Sync all enabled folders. */
  all?: boolean;
  /** Preview only — do not upload or persist uploaded status. */
  dryRun?: boolean;
  /** Worker pool concurrency override (falls back to settings.concurrency()). */
  concurrency?: number;
  /** Whether new folders default to recursive scan. */
  recursiveDefault?: boolean;
  /**
   * Only re-queue failed files (up to attemptsCap).
   * --force additionally includes blocked files (attempt_count >= cap).
   */
  retryFailedOnly?: boolean;
  /** When retryFailedOnly=true, also reset and retry blocked files. */
  force?: boolean;
  /** Source trigger label recorded in the sync_runs table. */
  trigger: 'cli' | 'menu' | 'retry';
}

export interface SyncRunResult {
  runId: number;
  stats: { uploaded: number; skipped: number; failed: number };
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Injected dependency types (subset of each repo's interface)
// ---------------------------------------------------------------------------

export interface SyncEngineDeps {
  api: ApiClient;
  folders: FolderRepo;
  files: FileRepo;
  runs: RunRepo;
  settings: SettingsRepo;
  /** Injectable for testing — defaults to the real uploadFile. */
  uploadFn?: typeof uploadFile;
  /** Injectable for testing — defaults to the real sha256File. */
  hashFn?: typeof sha256File;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface MediaListResponse {
  items: Array<{ id: string; contentHash: string }>;
}

interface MediaItem {
  id: string;
}

function mimeToMediaType(mimeType: string): 'photo' | 'video' {
  return mimeType.startsWith('video/') ? 'video' : 'photo';
}

// ---------------------------------------------------------------------------
// SyncEngine
// ---------------------------------------------------------------------------

export class SyncEngine extends TypedEmitter {
  private readonly deps: Required<SyncEngineDeps>;

  constructor(deps: SyncEngineDeps) {
    super();
    this.deps = {
      ...deps,
      uploadFn: deps.uploadFn ?? uploadFile,
      hashFn:   deps.hashFn   ?? sha256File,
    };
  }

  /**
   * Execute a sync run according to `opts`.
   *
   * Resolves when the run completes (all files processed or errored).
   * Rejects only if no target folders can be resolved (fatal config error).
   */
  async run(opts: SyncOptions): Promise<SyncRunResult> {
    const startMs = Date.now();
    const { api, folders, files, runs, settings } = this.deps;

    // ------------------------------------------------------------------
    // 1. Resolve target folders
    // ------------------------------------------------------------------
    let targetFolderIds: number[];

    if (opts.retryFailedOnly) {
      // Retry path: derive folders from failed file records, optionally scoped
      const cap = settings.attemptsCap();
      const failed = files.listFailed({ folderIds: opts.folderIds, cap });
      const blocked = opts.force
        ? files.listBlocked({ folderIds: opts.folderIds, cap })
        : [];

      const folderSet = new Set<number>([
        ...failed.map((f) => f.folder_id),
        ...blocked.map((f) => f.folder_id),
      ]);

      // Further scope to provided folderIds if given
      if (opts.folderIds && opts.folderIds.length > 0) {
        targetFolderIds = opts.folderIds.filter((id) => folderSet.has(id));
        // If no overlap, keep the explicit folderIds anyway so we have valid folders
        if (targetFolderIds.length === 0) {
          targetFolderIds = opts.folderIds;
        }
      } else {
        targetFolderIds = [...folderSet];
      }

      if (targetFolderIds.length === 0 && opts.folderIds && opts.folderIds.length > 0) {
        targetFolderIds = opts.folderIds;
      }
    } else if (opts.all) {
      const all = folders.list({ enabledOnly: true });
      targetFolderIds = all.map((f) => f.id);
    } else if (opts.folderIds && opts.folderIds.length > 0) {
      targetFolderIds = opts.folderIds;
    } else {
      const msg = 'No target folders specified. Pass --all, folder IDs, or folder paths.';
      this.emit(EV.ERROR, { message: msg });
      return Promise.reject(new Error(msg));
    }

    if (targetFolderIds.length === 0) {
      const msg = 'No enabled folders found. Register a folder first with `memoriahub folders add`.';
      this.emit(EV.ERROR, { message: msg });
      return Promise.reject(new Error(msg));
    }

    // ------------------------------------------------------------------
    // 2. Crash recovery: reset stale uploading→queued
    // ------------------------------------------------------------------
    files.resetStaleUploading(targetFolderIds);

    // ------------------------------------------------------------------
    // 3. Build the work set
    // ------------------------------------------------------------------
    const workList: Array<{ fileId: number; filePath: string; mimeType: string; folderId: number }> = [];
    let unchangedSkippedCount = 0;

    if (opts.retryFailedOnly) {
      // Retry path: collect failed (and optionally blocked) file records
      const cap = settings.attemptsCap();
      const retryable = files.listFailed({ folderIds: targetFolderIds, cap });

      for (const rec of retryable) {
        files.setStatus(rec.id, 'queued');
        workList.push({
          fileId: rec.id,
          filePath: rec.file_path,
          mimeType: rec.mime_type ?? 'application/octet-stream',
          folderId: rec.folder_id,
        });
        this.emit(EV.FILE_QUEUED, { fileId: rec.id, path: rec.file_path });
      }

      if (opts.force) {
        const blocked = files.listBlocked({ folderIds: targetFolderIds, cap });
        for (const rec of blocked) {
          // Reset attempt_count so the worker can try again
          files.setStatus(rec.id, 'queued', { attempt_count: 0 });
          workList.push({
            fileId: rec.id,
            filePath: rec.file_path,
            mimeType: rec.mime_type ?? 'application/octet-stream',
            folderId: rec.folder_id,
          });
          this.emit(EV.FILE_QUEUED, { fileId: rec.id, path: rec.file_path });
        }
      }
    } else {
      // Normal sync path: enumerate filesystem, upsert records
      for (const folderId of targetFolderIds) {
        const folder = folders.getById(folderId);
        if (!folder) continue;

        const { supported } = enumerateFiles(folder.path, folder.recursive);

        // Emit folder:start so renderers can show per-folder progress
        this.emit(EV.FOLDER_START, {
          folderId,
          path: folder.path,
          fileCount: supported.length,
        });

        for (const { filePath, mimeType } of supported) {
          // Stat for size
          let sizeBytes: number | null = null;
          try {
            sizeBytes = fs.statSync(filePath).size;
          } catch {
            // File might have disappeared; let the worker handle it
          }

          // Upsert into the DB
          const rec = files.upsert(folderId, filePath, {
            size_bytes: sizeBytes,
            mime_type: mimeType,
          });

          // Fast unchanged-skip: if already uploaded AND size matches, skip entirely
          if (rec.status === 'uploaded' && rec.size_bytes === sizeBytes) {
            unchangedSkippedCount++;
            this.emit(EV.FILE_SKIPPED, {
              fileId: rec.id,
              path: filePath,
              reason: 'unchanged',
            });
            continue;
          }

          // Queue it
          files.setStatus(rec.id, 'queued');
          workList.push({ fileId: rec.id, filePath, mimeType, folderId });
          this.emit(EV.FILE_QUEUED, { fileId: rec.id, path: filePath });
        }
      }
    }

    // ------------------------------------------------------------------
    // 4. Start the run record
    // ------------------------------------------------------------------
    const total = workList.length + unchangedSkippedCount;
    const runId = runs.startRun({
      trigger: opts.trigger,
      folderIds: targetFolderIds,
      total,
      dryRun: opts.dryRun ?? false,
    });

    this.emit(EV.RUN_START, {
      runId,
      folderIds: targetFolderIds,
      total,
      dryRun: opts.dryRun ?? false,
    });

    // Emit initial progress
    {
      const c = files.counts(targetFolderIds);
      this.emit(EV.RUN_PROGRESS, {
        counts: {
          queued:    c.queued,
          uploading: c.uploading,
          uploaded:  c.uploaded,
          skipped:   c.skipped,
          failed:    c.failed,
        },
        total,
      });
    }

    // ------------------------------------------------------------------
    // 5. Worker pool — process queued files with bounded concurrency
    // ------------------------------------------------------------------
    const concurrency = opts.concurrency ?? settings.concurrency();
    const cap = settings.attemptsCap();
    const isDryRun = opts.dryRun ?? false;

    await runPool(workList, concurrency, async (item) => {
      const { fileId, filePath, mimeType, folderId: _folderId } = item;

      // Fetch current attempt_count before incrementing
      let currentAttempt = 0;

      // Read size for the event
      let sizeBytes: number | null = null;
      try {
        sizeBytes = fs.statSync(filePath).size;
      } catch {
        // continue without size
      }

      this.emit(EV.FILE_START, { fileId, path: filePath, sizeBytes });
      files.setStatus(fileId, 'uploading');
      files.incrementAttempt(fileId);

      // Re-read attempt_count after increment
      try {
        const row = files.listByFolder(
          item.folderId,
          { status: 'uploading' },
        ).find((r) => r.id === fileId);
        if (row) currentAttempt = row.attempt_count;
      } catch {
        currentAttempt = 1;
      }

      try {
        // --- Hash ---
        const sha256 = await this.deps.hashFn(filePath);

        // --- Dedup check ---
        let dedupMediaId: string | null = null;
        {
          const mediaList = await api.get<MediaListResponse>(
            `/api/media?contentHash=${encodeURIComponent(sha256)}&pageSize=1`,
          );
          if (mediaList.items.length > 0) {
            dedupMediaId = mediaList.items[0].id;
          }
        }

        if (dedupMediaId !== null) {
          // Already on server — skip
          if (!isDryRun) {
            files.setStatus(fileId, 'skipped', { sha256, media_item_id: dedupMediaId });
          } else {
            // dry-run: revert status to queued (keep side-effect-free on file rows)
            files.setStatus(fileId, 'queued', { sha256 });
          }
          this.emit(EV.FILE_SKIPPED, { fileId, path: filePath, reason: 'dedup' });

          this._emitProgress(files, targetFolderIds, total);
          return;
        }

        // --- Dry-run: do not upload, revert to queued ---
        if (isDryRun) {
          // Store the hash but do not persist 'uploaded'.
          // Status stays 'queued' so a real run will pick it up.
          files.setStatus(fileId, 'queued', { sha256 });
          // Emit a file:done with dryRun=true so renderers can show
          // "would upload" rather than "skipped".
          this.emit(EV.FILE_DONE, {
            fileId,
            path: filePath,
            mediaItemId: '',
            storageObjectId: '',
            dryRun: true,
          });
          this._emitProgress(files, targetFolderIds, total);
          return;
        }

        // --- Real upload ---
        const uploadResult = await this.deps.uploadFn(
          api,
          filePath,
          mimeType,
          (fraction) => {
            this.emit(EV.FILE_PROGRESS, { fileId, fraction });
          },
        );
        const { objectId } = uploadResult;

        // --- Register as MediaItem ---
        const basename = path.basename(filePath);
        const type = mimeToMediaType(mimeType);
        const mediaItem = await api.post<MediaItem>('/api/media', {
          storageObjectId: objectId,
          type,
          source: 'cli',
          originalFilename: basename,
        });

        // Persist uploaded status
        files.setStatus(fileId, 'uploaded', {
          sha256,
          media_item_id: mediaItem.id,
          storage_object_id: objectId,
          uploaded_at: new Date().toISOString(),
        });

        this.emit(EV.FILE_DONE, {
          fileId,
          path: filePath,
          mediaItemId: mediaItem.id,
          storageObjectId: objectId,
        });

        this._emitProgress(files, targetFolderIds, total);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        files.setError(fileId, errorMsg);
        files.setStatus(fileId, 'failed');

        this.emit(EV.FILE_FAILED, {
          fileId,
          path: filePath,
          error: errorMsg,
          attempt: currentAttempt,
          willRetry: currentAttempt < cap,
        });

        this._emitProgress(files, targetFolderIds, total);
        // Per-file failure intentionally does NOT propagate — the pool continues.
      }
    });

    // ------------------------------------------------------------------
    // 6. Post-run: touch last_sync, finish run, emit run:done
    // ------------------------------------------------------------------
    const now = new Date().toISOString();
    if (!isDryRun) {
      for (const folderId of targetFolderIds) {
        folders.touchLastSync(folderId, now);

        // Emit folder:done with per-folder stats
        const fc = files.counts([folderId]);
        this.emit(EV.FOLDER_DONE, {
          folderId,
          stats: {
            uploaded: fc.uploaded,
            skipped:  fc.skipped,
            failed:   fc.failed,
          },
        });
      }
    }

    const totalCounts = files.counts(targetFolderIds);
    const stats = {
      uploaded: totalCounts.uploaded,
      skipped:  totalCounts.skipped + unchangedSkippedCount,
      failed:   totalCounts.failed,
    };

    // For dry-run: file:done with dryRun=true are "would-upload" — count them
    // as uploaded in the stats for the run record so the summary is meaningful.
    runs.finishRun(runId, {
      uploaded: stats.uploaded,
      skipped:  stats.skipped,
      failed:   stats.failed,
    });

    const durationMs = Date.now() - startMs;

    this.emit(EV.RUN_DONE, { runId, stats, durationMs });

    return { runId, stats, durationMs };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _emitProgress(
    files: FileRepo,
    folderIds: number[],
    total: number,
  ): void {
    const c = files.counts(folderIds);
    this.emit(EV.RUN_PROGRESS, {
      counts: {
        queued:    c.queued,
        uploading: c.uploading,
        uploaded:  c.uploaded,
        skipped:   c.skipped,
        failed:    c.failed,
      },
      total,
    });
  }
}
