/**
 * convert/convert-engine.ts — Event-driven ConvertEngine.
 *
 * Discovers convertible video files from three sources (explicit files, ad-hoc
 * folder paths, and registered folders / --all), then transcodes each to a
 * sibling `.mp4` via ffmpeg — a fast lossless remux where possible, falling back
 * to a full H.264 re-encode.  Originals are kept by default; when
 * `deleteOriginal` is set, each source is removed only after its `.mp4` is
 * verified written.
 *
 * Mirrors OrganizeEngine's structure exactly (offline, UI-free, injected deps,
 * typed events, bounded worker pool).  The engine NEVER writes to the terminal —
 * it emits typed events consumed by renderers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ConvertTypedEmitter,
  CONVERT_EV,
  type ConvertTotals,
} from './events.js';
import {
  isConvertibleVideo,
  targetPathFor,
  resolveConvertCollision,
} from './plan.js';
import { convertFile, detectFfmpeg, FfmpegNotFoundError } from './ffmpeg.js';
import { runPool } from '../sync/worker-pool.js';
import { enumerateFiles } from '../files.js';
import type { FolderRepo } from '../repo/folders.js';
import type { SettingsRepo } from '../repo/settings.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConvertOptions {
  /** Explicit single files to convert (bypass folder enumeration). */
  files?: string[];
  /** Ad-hoc folder paths to walk (bypass the registry). */
  paths?: string[];
  /** Registered folder IDs to walk (loaded from the FolderRepo). */
  folderIds?: number[];
  /** Convert all enabled registered folders. */
  all?: boolean;
  /** Recursive walk for ad-hoc `paths` (registry folders carry their own flag). */
  recursive?: boolean;
  /** Plan only — enumerate and count but never invoke ffmpeg. */
  dryRun?: boolean;
  /** Worker pool concurrency override (falls back to settings.concurrency()). */
  concurrency?: number;
  /** Delete each original after its `.mp4` is verified written. */
  deleteOriginal?: boolean;
  /** Overwrite an existing target `.mp4` instead of skipping it. */
  overwrite?: boolean;
  /** Force the full H.264 re-encode path (skip the remux attempt). */
  reencode?: boolean;
  /** Constant rate factor for the re-encode path. */
  crf?: number;
  /** Restrict conversion to this set of lowercased extensions (from --formats). */
  formats?: ReadonlySet<string>;
}

export interface ConvertRunResult {
  totals: ConvertTotals;
}

// ---------------------------------------------------------------------------
// Injected dependency types
// ---------------------------------------------------------------------------

export interface ConvertEngineDeps {
  folders: FolderRepo;
  settings: SettingsRepo;
  /** Injectable for testing — defaults to the real convertFile. */
  convertFn?: typeof convertFile;
  /** Injectable for testing — defaults to the real detectFfmpeg. */
  detectFn?: typeof detectFfmpeg;
}

// ---------------------------------------------------------------------------
// Internal work item
// ---------------------------------------------------------------------------

interface WorkItem {
  filePath: string;
}

// How often (in files) to emit a progress event during the pool run.
const PROGRESS_EVERY = 1;

// ---------------------------------------------------------------------------
// ConvertEngine
// ---------------------------------------------------------------------------

export class ConvertEngine extends ConvertTypedEmitter {
  private readonly deps: Required<ConvertEngineDeps>;

  constructor(deps: ConvertEngineDeps) {
    super();
    this.deps = {
      ...deps,
      convertFn: deps.convertFn ?? convertFile,
      detectFn: deps.detectFn ?? detectFfmpeg,
    };
  }

  /**
   * Execute a convert run according to `opts`.
   *
   * Resolves when every discovered file has been processed (converted, skipped,
   * or errored).  Rejects when no sources can be resolved, or when ffmpeg is
   * required (non-dry-run) but not installed.
   */
  async run(opts: ConvertOptions): Promise<ConvertRunResult> {
    const { folders, settings } = this.deps;

    // ------------------------------------------------------------------
    // 1. ffmpeg preflight — skipped for a dry-run, which only plans.
    // ------------------------------------------------------------------
    if (!opts.dryRun) {
      const info = await this.deps.detectFn();
      if (!info.available) {
        const err = new FfmpegNotFoundError();
        this.emit(CONVERT_EV.ERROR, { message: `${err.message} ${err.hint}` });
        return Promise.reject(err);
      }
    }

    // ------------------------------------------------------------------
    // 2. Build the work set from the three source kinds.
    // ------------------------------------------------------------------
    const workList: WorkItem[] = [];
    const seen = new Set<string>();

    const pushFile = (filePath: string): void => {
      const abs = path.resolve(filePath);
      if (seen.has(abs)) return;
      seen.add(abs);
      workList.push({ filePath: abs });
    };

    // 2a. Explicit files.
    if (opts.files && opts.files.length > 0) {
      for (const f of opts.files) {
        const abs = path.resolve(f);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          this.emit(CONVERT_EV.ERROR, { message: `File not found: ${abs}` });
          return Promise.reject(new Error(`File not found: ${abs}`));
        }
        if (!isConvertibleVideo(abs, opts.formats)) {
          this.emit(CONVERT_EV.ERROR, {
            message: `Not a convertible video file: ${abs}`,
          });
          return Promise.reject(new Error(`Not a convertible video file: ${abs}`));
        }
        pushFile(abs);
      }
    }

    // 2b. Folder roots (ad-hoc paths / --all / folderIds).
    const roots: Array<{ root: string; recursive: boolean }> = [];
    if (opts.paths && opts.paths.length > 0) {
      for (const p of opts.paths) {
        roots.push({ root: path.resolve(p), recursive: Boolean(opts.recursive) });
      }
    }
    if (opts.all) {
      for (const f of folders.list({ enabledOnly: true })) {
        roots.push({ root: f.path, recursive: f.recursive });
      }
    } else if (opts.folderIds && opts.folderIds.length > 0) {
      for (const id of opts.folderIds) {
        const folder = folders.getById(id);
        if (folder) roots.push({ root: folder.path, recursive: folder.recursive });
      }
    }

    for (const { root, recursive } of roots) {
      const { supported } = enumerateFiles(root, recursive);
      for (const { filePath } of supported) {
        if (isConvertibleVideo(filePath, opts.formats)) pushFile(filePath);
      }
    }

    // Nothing to target at all (no files, no roots) is a hard error.
    if (workList.length === 0 && roots.length === 0 && (!opts.files || opts.files.length === 0)) {
      const msg = 'No sources specified. Pass a file, folder path, folder IDs, or --all.';
      this.emit(CONVERT_EV.ERROR, { message: msg });
      return Promise.reject(new Error(msg));
    }

    const total = workList.length;

    const totals: ConvertTotals = {
      total,
      converted: 0,
      skipped: 0,
      errors: 0,
      deleted: 0,
      remuxed: 0,
      reencoded: 0,
      bytesIn: 0,
      bytesOut: 0,
    };

    // Emit an initial progress event so listeners can render a 0/total baseline.
    this.emit(CONVERT_EV.CONVERT_PROGRESS, { processed: 0, total });

    // ------------------------------------------------------------------
    // 3. Worker pool — plan target, run ffmpeg, optionally delete original.
    // ------------------------------------------------------------------
    const concurrency = opts.concurrency ?? settings.concurrency();
    let processed = 0;

    await runPool(workList, concurrency, async (item) => {
      const { filePath } = item;
      // Single-threaded JS: increments below are race-free.
      try {
        const desired = targetPathFor(filePath);

        // Idempotent skip: a target already exists and we're not overwriting.
        if (!opts.overwrite && fs.existsSync(desired)) {
          totals.skipped++;
          this.emit(CONVERT_EV.CONVERT_FILE, {
            filePath,
            action: 'skip',
            target: desired,
          });
          return;
        }

        // Resolve a collision-free name (only relevant when not overwriting).
        const finalTarget = opts.overwrite ? desired : resolveConvertCollision(desired);

        if (opts.dryRun) {
          // Plan only — count as a planned conversion, touch nothing.
          totals.converted++;
          this.emit(CONVERT_EV.CONVERT_FILE, {
            filePath,
            action: 'convert',
            target: finalTarget,
          });
          return;
        }

        const result = await this.deps.convertFn(filePath, finalTarget, {
          forceReencode: opts.reencode,
          crf: opts.crf,
        });

        totals.converted++;
        if (result.mode === 'remux') totals.remuxed++;
        else totals.reencoded++;
        totals.bytesIn += result.bytesIn;
        totals.bytesOut += result.bytesOut;

        let deletedOriginal = false;
        if (opts.deleteOriginal) {
          try {
            fs.unlinkSync(filePath);
            totals.deleted++;
            deletedOriginal = true;
          } catch {
            // A failed cleanup must not fail the conversion — the .mp4 is safe.
          }
        }

        this.emit(CONVERT_EV.CONVERT_FILE, {
          filePath,
          action: 'convert',
          target: finalTarget,
          mode: result.mode,
          deletedOriginal,
        });
      } catch (err) {
        // One bad file must never abort the pool. runPool already swallows
        // throws, but we record the error here (before it escapes) so it is
        // counted and surfaced rather than silently lost.
        totals.errors++;
        const message = err instanceof Error ? err.message : String(err);
        this.emit(CONVERT_EV.CONVERT_FILE, {
          filePath,
          action: 'error',
          error: message,
        });
      } finally {
        processed++;
        if (processed % PROGRESS_EVERY === 0 || processed === total) {
          this.emit(CONVERT_EV.CONVERT_PROGRESS, { processed, total });
        }
      }
    });

    // ------------------------------------------------------------------
    // 4. Finalize
    // ------------------------------------------------------------------
    this.emit(CONVERT_EV.CONVERT_DONE, { totals });
    return { totals };
  }
}
