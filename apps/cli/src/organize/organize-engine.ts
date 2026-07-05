/**
 * organize/organize-engine.ts — Event-driven OrganizeEngine.
 *
 * Walks one or more root folders, reads each photo's EXIF capture date (reading
 * the FULL file so a date buried deep inside is never missed), and MOVES each
 * file into a `YEAR/MM - Month/` sub-folder created inside that same root.
 * Files with no EXIF capture date — which includes every video, since the CLI
 * never probes video metadata — move into a top-level `NODATE/` folder.
 *
 * Fully offline and side-effect-free with respect to any server: it mirrors the
 * ScanEngine's structure (offline, UI-free, injected deps, typed events) rather
 * than SyncEngine's networked flow.  The engine NEVER writes to the terminal —
 * it emits typed events consumed by renderers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { OrganizeTypedEmitter, ORGANIZE_EV, type OrganizeTotals } from './events.js';
import { bucketForDate, targetPathFor, resolveCollision } from './plan.js';
import { runPool } from '../sync/worker-pool.js';
import { enumerateFiles } from '../files.js';
import { readExifCaptureDate } from '../metadata.js';
import type { FolderRepo } from '../repo/folders.js';
import type { SettingsRepo } from '../repo/settings.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OrganizeOptions {
  /** Explicit folder IDs to organize (loaded from the FolderRepo). */
  folderIds?: number[];
  /** Ad-hoc folder paths to organize (bypass the registry). */
  paths?: string[];
  /** Organize all enabled registered folders. */
  all?: boolean;
  /** Recursive walk for ad-hoc `paths` (registry folders carry their own flag). */
  recursive?: boolean;
  /** Plan only — compute buckets and targets but never touch disk. */
  dryRun?: boolean;
  /** Worker pool concurrency override (falls back to settings.concurrency()). */
  concurrency?: number;
}

export interface OrganizeRunResult {
  totals: OrganizeTotals;
}

// ---------------------------------------------------------------------------
// Injected dependency types
// ---------------------------------------------------------------------------

export interface OrganizeEngineDeps {
  folders: FolderRepo;
  settings: SettingsRepo;
  /** Injectable for testing — defaults to the real readExifCaptureDate. */
  captureDateFn?: typeof readExifCaptureDate;
}

// ---------------------------------------------------------------------------
// Internal work item
// ---------------------------------------------------------------------------

interface WorkItem {
  /** The root folder the file was discovered under (destination base). */
  root: string;
  filePath: string;
  mimeType: string;
}

// How often (in files) to emit a progress event during the pool run.
const PROGRESS_EVERY = 1;

// ---------------------------------------------------------------------------
// OrganizeEngine
// ---------------------------------------------------------------------------

export class OrganizeEngine extends OrganizeTypedEmitter {
  private readonly deps: Required<OrganizeEngineDeps>;

  constructor(deps: OrganizeEngineDeps) {
    super();
    this.deps = {
      ...deps,
      captureDateFn: deps.captureDateFn ?? readExifCaptureDate,
    };
  }

  /**
   * Execute an organize run according to `opts`.
   *
   * Resolves when every discovered file has been processed (moved, skipped, or
   * errored).  Rejects only if no target folders can be resolved.
   */
  async run(opts: OrganizeOptions): Promise<OrganizeRunResult> {
    const { folders, settings } = this.deps;

    // ------------------------------------------------------------------
    // 1. Resolve the list of root folder paths (each with a recursive flag)
    // ------------------------------------------------------------------
    const roots: Array<{ root: string; recursive: boolean }> = [];

    if (opts.paths && opts.paths.length > 0) {
      for (const p of opts.paths) {
        roots.push({ root: path.resolve(p), recursive: Boolean(opts.recursive) });
      }
    } else if (opts.all) {
      for (const f of folders.list({ enabledOnly: true })) {
        roots.push({ root: f.path, recursive: f.recursive });
      }
    } else if (opts.folderIds && opts.folderIds.length > 0) {
      for (const id of opts.folderIds) {
        const folder = folders.getById(id);
        if (folder) roots.push({ root: folder.path, recursive: folder.recursive });
      }
    }

    if (roots.length === 0) {
      const msg =
        'No target folders specified. Pass folder paths, folder IDs, or --all.';
      this.emit(ORGANIZE_EV.ERROR, { message: msg });
      return Promise.reject(new Error(msg));
    }

    // ------------------------------------------------------------------
    // 2. Build the work set (walk every root)
    // ------------------------------------------------------------------
    const workList: WorkItem[] = [];
    for (const { root, recursive } of roots) {
      const { supported } = enumerateFiles(root, recursive);
      for (const { filePath, mimeType } of supported) {
        workList.push({ root, filePath, mimeType });
      }
    }

    const total = workList.length;

    const totals: OrganizeTotals = {
      total,
      moved: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      nodate: 0,
      byBucket: {},
    };

    // Emit an initial progress event so listeners can render a 0/total baseline.
    this.emit(ORGANIZE_EV.ORGANIZE_PROGRESS, { processed: 0, total });

    // ------------------------------------------------------------------
    // 3. Worker pool — read capture date, plan target, move the file
    // ------------------------------------------------------------------
    const concurrency = opts.concurrency ?? settings.concurrency();
    let processed = 0;

    await runPool(workList, concurrency, async (item) => {
      const { root, filePath, mimeType } = item;
      // Single-threaded JS: increments below are race-free.
      try {
        const date = await this.deps.captureDateFn(filePath, mimeType, { full: true });
        const segments = bucketForDate(date);
        const bucketKey = segments.join('/');
        const desired = targetPathFor(root, segments, path.basename(filePath));

        // Already in place — keeps re-runs idempotent (no move, no rename).
        if (path.resolve(filePath) === path.resolve(desired)) {
          totals.skipped++;
          totals.byBucket[bucketKey] = (totals.byBucket[bucketKey] ?? 0) + 1;
          if (segments[0] === 'NODATE') totals.nodate++;
          this.emit(ORGANIZE_EV.ORGANIZE_FILE, {
            filePath,
            bucket: segments,
            action: 'skip',
            target: desired,
          });
          return;
        }

        const finalTarget = resolveCollision(desired, filePath);
        const conflictRenamed = finalTarget !== desired;

        if (!opts.dryRun) {
          fs.mkdirSync(path.dirname(finalTarget), { recursive: true });
          try {
            fs.renameSync(filePath, finalTarget);
          } catch (err) {
            // Cross-device moves (EXDEV) can't rename — fall back to copy+unlink.
            if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
              fs.copyFileSync(filePath, finalTarget);
              fs.unlinkSync(filePath);
            } else {
              throw err;
            }
          }
        }

        totals.moved++;
        if (conflictRenamed) totals.conflicts++;
        totals.byBucket[bucketKey] = (totals.byBucket[bucketKey] ?? 0) + 1;
        if (segments[0] === 'NODATE') totals.nodate++;

        this.emit(ORGANIZE_EV.ORGANIZE_FILE, {
          filePath,
          bucket: segments,
          action: conflictRenamed ? 'conflict-rename' : 'move',
          target: finalTarget,
        });
      } catch (err) {
        // One bad file must never abort the pool. runPool already swallows
        // throws, but we record the error here (before it escapes) so it is
        // counted and surfaced rather than silently lost.
        totals.errors++;
        const message = err instanceof Error ? err.message : String(err);
        this.emit(ORGANIZE_EV.ORGANIZE_FILE, {
          filePath,
          bucket: [],
          action: 'error',
          error: message,
        });
      } finally {
        processed++;
        if (processed % PROGRESS_EVERY === 0 || processed === total) {
          this.emit(ORGANIZE_EV.ORGANIZE_PROGRESS, { processed, total });
        }
      }
    });

    // ------------------------------------------------------------------
    // 4. Finalize
    // ------------------------------------------------------------------
    this.emit(ORGANIZE_EV.ORGANIZE_DONE, { totals });
    return { totals };
  }
}
