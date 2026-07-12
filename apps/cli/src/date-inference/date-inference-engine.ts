/**
 * date-inference/date-inference-engine.ts — Event-driven DateInferenceEngine.
 *
 * Walks one or more root folders and, for every file with no existing capture
 * date (EXIF for photos, container metadata for videos — reusing the same
 * `readExifPlacement()` full-file read the `organize` tool uses), tries to
 * infer one from the filename via `parseDateFromFilename()`.
 *
 * `opts.mode` plays the same role as OrganizeEngine's `dryRun`:
 *   'diagnose' — read-only. Candidates are recorded but nothing is written.
 *   'apply'    — every 'diagnose' candidate is additionally written into the
 *                file via ExifTool (see exif-writer.ts).
 *
 * Mirrors OrganizeEngine's structure exactly (offline, UI-free, injected
 * deps, typed events, bounded worker pool). The engine NEVER writes to the
 * terminal — it emits typed events consumed by renderers.
 */

import * as path from 'node:path';
import {
  DateInferenceTypedEmitter,
  DATE_INFERENCE_EV,
  type DateInferenceTotals,
  type DateInferenceStatus,
} from './events.js';
import { parseDateFromFilename, type FilenameDatePattern } from './filename-date.js';
import { writeCapturedDate } from './exif-writer.js';
import { runPool } from '../sync/worker-pool.js';
import { enumerateFiles } from '../files.js';
import { readExifPlacement } from '../metadata.js';
import type { FolderRepo } from '../repo/folders.js';
import type { SettingsRepo } from '../repo/settings.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DateInferenceMode = 'diagnose' | 'apply';

export interface DateInferenceOptions {
  /** Explicit folder IDs to scan (loaded from the FolderRepo). */
  folderIds?: number[];
  /** Ad-hoc folder paths to scan (bypass the registry). */
  paths?: string[];
  /** Scan all enabled registered folders. */
  all?: boolean;
  /** Recursive walk for ad-hoc `paths` (registry folders carry their own flag). */
  recursive?: boolean;
  /** 'diagnose' only records candidates; 'apply' also writes them to disk. */
  mode: DateInferenceMode;
  /** Worker pool concurrency override (falls back to settings.concurrency()). */
  concurrency?: number;
}

export interface DateInferenceRunResult {
  totals: DateInferenceTotals;
}

// ---------------------------------------------------------------------------
// Injected dependency types
// ---------------------------------------------------------------------------

export interface DateInferenceEngineDeps {
  folders: FolderRepo;
  settings: SettingsRepo;
  /** Injectable for testing — defaults to the real readExifPlacement. */
  placementFn?: typeof readExifPlacement;
  /** Injectable for testing — defaults to the real parseDateFromFilename. */
  parseFn?: typeof parseDateFromFilename;
  /** Injectable for testing — defaults to the real writeCapturedDate. */
  writeFn?: typeof writeCapturedDate;
}

// ---------------------------------------------------------------------------
// Internal work item
// ---------------------------------------------------------------------------

interface WorkItem {
  filePath: string;
  mimeType: string;
}

const PROGRESS_EVERY = 1;

const EMPTY_BY_PATTERN: Record<FilenameDatePattern, number> = {
  whatsapp: 0,
  timestamp: 0,
  delimited: 0,
  bare: 0,
};

// ---------------------------------------------------------------------------
// DateInferenceEngine
// ---------------------------------------------------------------------------

export class DateInferenceEngine extends DateInferenceTypedEmitter {
  private readonly deps: Required<DateInferenceEngineDeps>;

  constructor(deps: DateInferenceEngineDeps) {
    super();
    this.deps = {
      ...deps,
      placementFn: deps.placementFn ?? readExifPlacement,
      parseFn: deps.parseFn ?? parseDateFromFilename,
      writeFn: deps.writeFn ?? writeCapturedDate,
    };
  }

  /**
   * Execute a date-inference run according to `opts`.
   *
   * Resolves when every discovered file has been processed. Rejects only if
   * no target folders can be resolved.
   */
  async run(opts: DateInferenceOptions): Promise<DateInferenceRunResult> {
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
      this.emit(DATE_INFERENCE_EV.ERROR, { message: msg });
      return Promise.reject(new Error(msg));
    }

    // ------------------------------------------------------------------
    // 2. Build the work set (walk every root)
    // ------------------------------------------------------------------
    const workList: WorkItem[] = [];
    for (const { root, recursive } of roots) {
      const { supported } = enumerateFiles(root, recursive);
      for (const { filePath, mimeType } of supported) {
        workList.push({ filePath, mimeType });
      }
    }

    const total = workList.length;

    const totals: DateInferenceTotals = {
      total,
      hasDate: 0,
      inferred: 0,
      noPattern: 0,
      written: 0,
      writeFailed: 0,
      errors: 0,
      byPattern: { ...EMPTY_BY_PATTERN },
    };

    this.emit(DATE_INFERENCE_EV.PROGRESS, { processed: 0, total });

    // ------------------------------------------------------------------
    // 3. Worker pool — check existing date, infer from filename, maybe write
    // ------------------------------------------------------------------
    const concurrency = opts.concurrency ?? settings.concurrency();
    let processed = 0;

    await runPool(workList, concurrency, async (item) => {
      const { filePath, mimeType } = item;
      const mediaKind: 'photo' | 'video' = mimeType.startsWith('video/') ? 'video' : 'photo';

      try {
        const { capturedAt } = await this.deps.placementFn(filePath, mimeType, { full: true });

        if (capturedAt) {
          totals.hasDate++;
          this.emit(DATE_INFERENCE_EV.FILE, {
            filePath,
            mediaKind,
            status: 'has_date' satisfies DateInferenceStatus,
            existingCapturedAt: capturedAt.toISOString(),
          });
          return;
        }

        const match = this.deps.parseFn(path.basename(filePath));

        if (!match) {
          totals.noPattern++;
          this.emit(DATE_INFERENCE_EV.FILE, {
            filePath,
            mediaKind,
            status: 'no_pattern' satisfies DateInferenceStatus,
          });
          return;
        }

        totals.byPattern[match.pattern] = (totals.byPattern[match.pattern] ?? 0) + 1;

        if (opts.mode === 'diagnose') {
          totals.inferred++;
          this.emit(DATE_INFERENCE_EV.FILE, {
            filePath,
            mediaKind,
            status: 'inferred' satisfies DateInferenceStatus,
            matchedPattern: match.pattern,
            matchedText: match.matchedText,
            inferredDate: match.iso,
          });
          return;
        }

        // mode === 'apply'
        const result = await this.deps.writeFn(filePath, match);
        if (result.ok) {
          totals.written++;
          this.emit(DATE_INFERENCE_EV.FILE, {
            filePath,
            mediaKind,
            status: 'written' satisfies DateInferenceStatus,
            matchedPattern: match.pattern,
            matchedText: match.matchedText,
            inferredDate: match.iso,
          });
        } else {
          totals.writeFailed++;
          this.emit(DATE_INFERENCE_EV.FILE, {
            filePath,
            mediaKind,
            status: 'write_failed' satisfies DateInferenceStatus,
            matchedPattern: match.pattern,
            matchedText: match.matchedText,
            inferredDate: match.iso,
            error: result.error,
          });
        }
      } catch (err) {
        // One bad file must never abort the pool.
        totals.errors++;
        const message = err instanceof Error ? err.message : String(err);
        this.emit(DATE_INFERENCE_EV.FILE, {
          filePath,
          mediaKind,
          status: 'error' satisfies DateInferenceStatus,
          error: message,
        });
      } finally {
        processed++;
        if (processed % PROGRESS_EVERY === 0 || processed === total) {
          this.emit(DATE_INFERENCE_EV.PROGRESS, { processed, total });
        }
      }
    });

    // ------------------------------------------------------------------
    // 4. Finalize
    // ------------------------------------------------------------------
    this.emit(DATE_INFERENCE_EV.DONE, { totals });
    return { totals };
  }
}
