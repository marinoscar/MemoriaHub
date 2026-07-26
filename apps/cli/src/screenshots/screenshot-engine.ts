/**
 * screenshots/screenshot-engine.ts — Event-driven ScreenshotEngine.
 *
 * Walks one or more root folders looking for files whose name contains
 * "screenshot" (case-insensitive — see plan.ts's `isScreenshotFile`), then
 * performs one of three modes:
 *   'find'   — list matches only; never touches the filesystem.
 *   'move'   — move every match into `destDir` (collision-safe rename).
 *   'delete' — permanently delete every match (`fs.unlinkSync`).
 *
 * Structurally mirrors OrganizeEngine: offline, side-effect-free with respect
 * to any server, injected deps, typed events. The engine NEVER writes to the
 * terminal — it emits typed events consumed by renderers (headless CLI or the
 * Ink TUI).
 *
 * `dryRun: true` runs the full scan (and, for 'move'/'delete', validates
 * `destDir`) but skips every `fs.renameSync`/`fs.unlinkSync` call — `matched`/
 * `bytes` in the returned totals always reflect what WOULD move/delete;
 * `moved`/`deleted` only increment on a real (non-dry-run) pass.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ScreenshotsTypedEmitter, SCREENSHOTS_EV, type ScreenshotTotals } from './events.js';
import { findScreenshotFiles, resolveCollision, type ScreenshotMatch } from './plan.js';
import { runPool } from '../sync/worker-pool.js';
import type { FolderRepo } from '../repo/folders.js';
import type { SettingsRepo } from '../repo/settings.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ScreenshotMode = 'find' | 'move' | 'delete';

export interface ScreenshotOptions {
  /** Explicit folder IDs to scan (loaded from the FolderRepo). */
  folderIds?: number[];
  /** Ad-hoc folder paths to scan (bypass the registry). */
  paths?: string[];
  /** Scan all enabled registered folders. */
  all?: boolean;
  /** Recursive walk for ad-hoc `paths` (registry folders carry their own flag). */
  recursive?: boolean;
  /** What to do with matches. */
  mode: ScreenshotMode;
  /** Destination folder for 'move' mode. Required (and validated) when mode === 'move'. */
  destDir?: string;
  /** Plan only — compute matches but never move/delete anything. */
  dryRun?: boolean;
  /** Worker pool concurrency override (falls back to settings.concurrency()). */
  concurrency?: number;
}

export interface ScreenshotRunResult {
  totals: ScreenshotTotals;
  /** Every matched file (not capped — callers decide how much to display). */
  matches: ScreenshotMatch[];
}

// ---------------------------------------------------------------------------
// Injected dependency types
// ---------------------------------------------------------------------------

export interface ScreenshotEngineDeps {
  folders: FolderRepo;
  settings: SettingsRepo;
  /** Injectable for testing — defaults to the real findScreenshotFiles. */
  finderFn?: typeof findScreenshotFiles;
}

// How often (in files) to emit an acting-phase progress event.
const PROGRESS_EVERY = 1;

// ---------------------------------------------------------------------------
// ScreenshotEngine
// ---------------------------------------------------------------------------

export class ScreenshotEngine extends ScreenshotsTypedEmitter {
  private readonly deps: Required<ScreenshotEngineDeps>;

  constructor(deps: ScreenshotEngineDeps) {
    super();
    this.deps = {
      ...deps,
      finderFn: deps.finderFn ?? findScreenshotFiles,
    };
  }

  /**
   * Execute a screenshots run according to `opts`.
   *
   * Resolves once every matched file has been processed (for 'move'/'delete')
   * or once the scan is complete (for 'find'). Rejects if no target folders
   * can be resolved, or if `mode === 'move'` with no usable `destDir`.
   */
  async run(opts: ScreenshotOptions): Promise<ScreenshotRunResult> {
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
      const msg = 'No target folders specified. Pass folder paths, folder IDs, or --all.';
      this.emit(SCREENSHOTS_EV.ERROR, { message: msg });
      return Promise.reject(new Error(msg));
    }

    // ------------------------------------------------------------------
    // 2. Validate move destination up front (before any scanning work)
    // ------------------------------------------------------------------
    let destDirAbs: string | undefined;
    if (opts.mode === 'move') {
      if (!opts.destDir || opts.destDir.trim().length === 0) {
        const msg = 'A destination folder (--move-to) is required to move screenshots.';
        this.emit(SCREENSHOTS_EV.ERROR, { message: msg });
        return Promise.reject(new Error(msg));
      }
      destDirAbs = path.resolve(opts.destDir);
      if (fs.existsSync(destDirAbs) && !fs.statSync(destDirAbs).isDirectory()) {
        const msg = `Destination exists and is not a folder: ${destDirAbs}`;
        this.emit(SCREENSHOTS_EV.ERROR, { message: msg });
        return Promise.reject(new Error(msg));
      }
    }

    // ------------------------------------------------------------------
    // 3. Scan — walk every root, collecting matches
    // ------------------------------------------------------------------
    const matches: ScreenshotMatch[] = [];
    let rootsScanned = 0;
    this.emit(SCREENSHOTS_EV.PROGRESS, { phase: 'scanning', processed: 0, total: roots.length });
    for (const { root, recursive } of roots) {
      matches.push(...this.deps.finderFn(root, recursive));
      rootsScanned++;
      this.emit(SCREENSHOTS_EV.PROGRESS, {
        phase: 'scanning',
        processed: rootsScanned,
        total: roots.length,
      });
    }

    const totals: ScreenshotTotals = {
      matched: matches.length,
      bytes: matches.reduce((sum, m) => sum + m.size, 0),
      moved: 0,
      deleted: 0,
      skipped: 0,
      errors: 0,
    };

    // ------------------------------------------------------------------
    // 4. 'find' mode (or a dry-run of any mode) stops here — no fs mutation.
    // ------------------------------------------------------------------
    if (opts.mode === 'find' || opts.dryRun || matches.length === 0) {
      this.emit(SCREENSHOTS_EV.DONE, { totals, matches });
      return { totals, matches };
    }

    // ------------------------------------------------------------------
    // 5. Worker pool — move or delete every matched file
    // ------------------------------------------------------------------
    const concurrency = opts.concurrency ?? settings.concurrency();
    let processed = 0;
    const total = matches.length;

    await runPool(matches, concurrency, async (match) => {
      const { filePath, size } = match;
      try {
        if (opts.mode === 'move') {
          const desired = path.join(destDirAbs!, path.basename(filePath));

          // Already in place (e.g. re-running against a destDir nested inside
          // an already-processed source root) — count as skipped, not moved.
          if (path.resolve(filePath) === path.resolve(desired)) {
            totals.skipped++;
            this.emit(SCREENSHOTS_EV.FILE, { filePath, size, action: 'skipped', target: desired });
            return;
          }

          const finalTarget = resolveCollision(desired, filePath);
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
          totals.moved++;
          this.emit(SCREENSHOTS_EV.FILE, { filePath, size, action: 'moved', target: finalTarget });
        } else {
          // mode === 'delete'
          fs.unlinkSync(filePath);
          totals.deleted++;
          this.emit(SCREENSHOTS_EV.FILE, { filePath, size, action: 'deleted' });
        }
      } catch (err) {
        // One bad file must never abort the pool. runPool already swallows
        // throws, but we record the error here (before it escapes) so it is
        // counted and surfaced rather than silently lost.
        totals.errors++;
        const message = err instanceof Error ? err.message : String(err);
        this.emit(SCREENSHOTS_EV.FILE, { filePath, size, action: 'error', error: message });
      } finally {
        processed++;
        if (processed % PROGRESS_EVERY === 0 || processed === total) {
          this.emit(SCREENSHOTS_EV.PROGRESS, { phase: 'acting', processed, total });
        }
      }
    });

    // ------------------------------------------------------------------
    // 6. Finalize
    // ------------------------------------------------------------------
    this.emit(SCREENSHOTS_EV.DONE, { totals, matches });
    return { totals, matches };
  }
}
