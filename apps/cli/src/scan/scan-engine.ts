/**
 * scan/scan-engine.ts — Event-driven ScanEngine (pre-sync dry-run).
 *
 * Mirrors SyncEngine structurally, but is fully offline and side-effect-free
 * with respect to the sync ledger: it walks the target folders, stats each
 * supported file, extracts lightweight metadata (EXIF-presence + location),
 * and writes an immutable snapshot into the scans / scan_files tables.  It does
 * NOT hash file contents, NOT talk to the server, and NOT touch the `files`
 * sync ledger.
 *
 * The engine is UI-free — it emits typed events consumed by renderers.  All
 * deps are injected so it is unit-testable without touching the network.
 */

import * as fs from 'node:fs';
import { ScanTypedEmitter, SCAN_EV } from './events.js';
import { runPool } from '../sync/worker-pool.js';
import { enumerateFiles } from '../files.js';
import { readMediaMetadata, resolveCapturedAt } from '../metadata.js';
import type { ScanRepo } from '../repo/scans.js';
import type { FolderRepo } from '../repo/folders.js';
import type { SettingsRepo } from '../repo/settings.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScanOptions {
  /** Explicit folder IDs to scan (ignored when all=true). */
  folderIds?: number[];
  /** Scan all enabled folders. */
  all?: boolean;
  /** Worker pool concurrency override (falls back to settings.concurrency()). */
  concurrency?: number;
  /** Source trigger label recorded in the scans table. */
  trigger: 'cli' | 'menu';
}

export interface ScanRunResult {
  scanId: number;
  totals: {
    totalFiles: number;
    totalBytes: number;
    photoCount: number;
    videoCount: number;
    exifCount: number;
    gpsCount: number;
  };
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Injected dependency types
// ---------------------------------------------------------------------------

export interface ScanEngineDeps {
  scans: ScanRepo;
  folders: FolderRepo;
  settings: SettingsRepo;
  /** Injectable for testing — defaults to the real readMediaMetadata. */
  metadataFn?: typeof readMediaMetadata;
}

// ---------------------------------------------------------------------------
// ScanEngine
// ---------------------------------------------------------------------------

export class ScanEngine extends ScanTypedEmitter {
  private readonly deps: Required<ScanEngineDeps>;

  constructor(deps: ScanEngineDeps) {
    super();
    this.deps = {
      ...deps,
      metadataFn: deps.metadataFn ?? readMediaMetadata,
    };
  }

  /**
   * Execute a scan according to `opts`.
   *
   * Resolves when the scan completes (all files snapshotted).
   * Rejects only if no target folders can be resolved (fatal config error).
   */
  async run(opts: ScanOptions): Promise<ScanRunResult> {
    const startMs = Date.now();
    const { scans, folders, settings } = this.deps;

    // ------------------------------------------------------------------
    // 1. Resolve target folders
    // ------------------------------------------------------------------
    let targetFolderIds: number[];

    if (opts.all) {
      targetFolderIds = folders.list({ enabledOnly: true }).map((f) => f.id);
    } else if (opts.folderIds && opts.folderIds.length > 0) {
      targetFolderIds = opts.folderIds;
    } else {
      const msg = 'No target folders specified. Pass --all, folder IDs, or folder paths.';
      this.emit(SCAN_EV.ERROR, { message: msg });
      return Promise.reject(new Error(msg));
    }

    if (targetFolderIds.length === 0) {
      const msg = 'No enabled folders found. Register a folder first with `memoriahub folders add`.';
      this.emit(SCAN_EV.ERROR, { message: msg });
      return Promise.reject(new Error(msg));
    }

    // ------------------------------------------------------------------
    // 2. Start the scan record
    // ------------------------------------------------------------------
    const scanId = scans.startScan({ trigger: opts.trigger, folderIds: targetFolderIds });
    this.emit(SCAN_EV.SCAN_START, { scanId, folderIds: targetFolderIds });

    // ------------------------------------------------------------------
    // 3. Build the work set (walk + stat)
    // ------------------------------------------------------------------
    const workList: Array<{
      folderId: number;
      filePath: string;
      mimeType: string;
      sizeBytes: number | null;
      mtimeMs: number | null;
    }> = [];

    for (const folderId of targetFolderIds) {
      const folder = folders.getById(folderId);
      if (!folder) continue;

      const { supported } = enumerateFiles(folder.path, folder.recursive);

      this.emit(SCAN_EV.FOLDER_START, {
        folderId,
        path: folder.path,
        fileCount: supported.length,
      });

      for (const { filePath, mimeType } of supported) {
        let sizeBytes: number | null = null;
        let mtimeMs: number | null = null;
        try {
          const st = fs.statSync(filePath);
          sizeBytes = st.size;
          mtimeMs = Math.round(st.mtimeMs);
        } catch {
          // File might have disappeared between enumerate and stat; snapshot it
          // with null size/mtime rather than dropping it.
        }
        workList.push({ folderId, filePath, mimeType, sizeBytes, mtimeMs });
      }
    }

    const total = workList.length;

    // ------------------------------------------------------------------
    // 4. Worker pool — extract metadata + persist snapshot rows
    // ------------------------------------------------------------------
    const concurrency = opts.concurrency ?? settings.concurrency();
    let scanned = 0;

    await runPool(workList, concurrency, async (item) => {
      const { folderId, filePath, mimeType, sizeBytes, mtimeMs } = item;

      const meta = await this.deps.metadataFn(filePath, mimeType);

      // Resolve the capture date the same way sync will: EXIF when present,
      // otherwise the oldest of the file's created/modified/accessed stamps.
      // Pass meta.capturedAt so we don't parse EXIF a second time. Storing the
      // source keeps the preview honest — guessed dates are labelled, not
      // presented as real EXIF.
      const cap = await resolveCapturedAt(filePath, mimeType, meta.capturedAt);

      scans.insertScanFile(scanId, {
        folderId,
        filePath,
        sizeBytes,
        mtimeMs,
        mimeType,
        mediaKind: meta.mediaKind,
        hasExif: meta.hasExif,
        hasGps: meta.hasGps,
        capturedAt: cap.capturedAt,
        width: meta.width,
        height: meta.height,
        cameraMake: meta.cameraMake,
        cameraModel: meta.cameraModel,
        takenLat: meta.takenLat,
        takenLng: meta.takenLng,
        capturedAtSource: cap.source,
        metaError: meta.error,
      });

      scanned++;
      this.emit(SCAN_EV.FILE_SCANNED, {
        folderId,
        path: filePath,
        mediaKind: meta.mediaKind,
        sizeBytes,
        hasExif: meta.hasExif,
        hasGps: meta.hasGps,
        error: meta.error,
      });
      this.emit(SCAN_EV.SCAN_PROGRESS, { scanned, total });
    });

    // ------------------------------------------------------------------
    // 5. Finalize: roll up totals and mark complete
    // ------------------------------------------------------------------
    const totals = scans.computeTotals(scanId);
    scans.finishScan(scanId, totals, 'complete');

    const durationMs = Date.now() - startMs;
    this.emit(SCAN_EV.SCAN_DONE, { scanId, totals, durationMs });

    return { scanId, totals, durationMs };
  }
}
