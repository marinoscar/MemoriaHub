/**
 * render/headless-sync.ts — Terminal renderer for headless (non-Ink) sync runs.
 *
 * Subscribes to SyncEngine events and drives:
 *   - An overall cli-progress bar (TTY) or periodic log lines (non-TTY).
 *   - A run-done summary box + failures table via ui helpers.
 *
 * ONLY this file and command files are allowed to print to the terminal.
 * The SyncEngine and repos must remain UI-free.
 */

import * as path from 'node:path';
import * as cliProgress from 'cli-progress';
import chalk from 'chalk';
import {
  ui,
  isTTY,
  printImportSummaryBox,
  printFileSummaryTable,
  type FileSummaryRow,
} from '../ui.js';
import type { SyncEngine } from '../sync/sync-engine.js';
import {
  EV,
  type RunStartPayload,
  type FileFailedPayload,
  type FileDonePayload,
  type FileSkippedPayload,
  type RunDonePayload,
  type RunProgressPayload,
} from '../sync/events.js';

// ---------------------------------------------------------------------------
// Renderer state
// ---------------------------------------------------------------------------

interface RendererState {
  total: number;
  dryRun: boolean;
  done: number;           // uploaded + skipped + failed so far
  uploaded: number;
  skipped: number;
  failed: number;
  dryRunWouldUpload: number;
  dryRunDedups: number;
  failures: Array<{ file: string; error: string }>;
  rows: FileSummaryRow[];
}

// ---------------------------------------------------------------------------
// renderSyncHeadless
// ---------------------------------------------------------------------------

/**
 * Attach terminal-output listeners to `engine`.
 * Must be called before `engine.run()`.
 *
 * Handles TTY (animated progress bar) and non-TTY (periodic log lines)
 * transparently.  On run:done, prints a summary box and a failures table.
 */
export function renderSyncHeadless(engine: SyncEngine): void {
  const state: RendererState = {
    total: 0,
    dryRun: false,
    done: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    dryRunWouldUpload: 0,
    dryRunDedups: 0,
    failures: [],
    rows: [],
  };

  // Bar is created lazily in run:start when we know the total.
  let bar: cliProgress.SingleBar | null = null;

  // ---------------------------------------------------------------------------
  // Progress bar factory
  // ---------------------------------------------------------------------------

  function createBar(total: number): cliProgress.SingleBar {
    const barFormat = isTTY
      ? `  ${chalk.cyan('{bar}')} {percentage}%  {value}/{total}  ${chalk.green('{uploaded}')} up  ${chalk.dim('{skipped}')} skip  ${chalk.red('{failed}')} fail`
      : '  [{bar}] {percentage}%  {value}/{total}  uploaded:{uploaded}  skipped:{skipped}  failed:{failed}';

    const b = new cliProgress.SingleBar(
      {
        format: barFormat,
        barCompleteChar: '█',
        barIncompleteChar: '░',
        clearOnComplete: false,
        hideCursor: isTTY,
        barsize: 30,
        etaAsynchronousUpdate: true,
        stopOnComplete: false,
      },
    );

    b.start(total, 0, {
      uploaded: 0,
      skipped: 0,
      failed: 0,
    });

    return b;
  }

  function advanceBar(): void {
    if (!bar) return;
    bar.update(state.done, {
      uploaded: state.uploaded,
      skipped:  state.skipped,
      failed:   state.failed,
    });
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  engine.on(EV.RUN_START, (payload: RunStartPayload) => {
    state.total  = payload.total;
    state.dryRun = payload.dryRun;

    if (payload.dryRun) {
      ui.warn('Dry-run mode — no files will be uploaded');
    }
    ui.step(
      `Starting sync run #${payload.runId}  ` +
      `(${payload.folderIds.length} folder(s), ${payload.total} file(s) total)`,
    );

    if (payload.total === 0) {
      ui.success('Nothing to sync — all files are up to date.');
      return;
    }

    bar = createBar(payload.total);
  });

  engine.on(EV.RUN_PROGRESS, (payload: RunProgressPayload) => {
    // Non-TTY: only print on significant milestones so we don't flood stdout
    if (!isTTY && bar) {
      // Print a line every 10 completions if not TTY
      const newDone =
        payload.counts.uploaded +
        payload.counts.skipped +
        payload.counts.failed;
      if (newDone > 0 && newDone % 10 === 0) {
        process.stdout.write(
          `  Progress: ${newDone}/${payload.total} ` +
          `(uploaded:${payload.counts.uploaded} skipped:${payload.counts.skipped} failed:${payload.counts.failed})\n`,
        );
      }
    }
  });

  engine.on(EV.FILE_DONE, (payload: FileDonePayload) => {
    const isDryRunWould = payload.dryRun === true;

    if (isDryRunWould) {
      state.dryRunWouldUpload++;
      // In dry-run we do NOT increment uploaded; count in dry summary
    } else {
      state.uploaded++;
    }
    state.done++;

    const basename = path.basename(payload.path);

    if (isDryRunWould) {
      state.rows.push({
        file: payload.path,
        status: 'dry-run',
        detail: basename,
      });
    } else {
      state.rows.push({
        file: payload.path,
        status: 'uploaded',
        detail: payload.mediaItemId.slice(0, 12),
      });
    }

    advanceBar();
  });

  engine.on(EV.FILE_SKIPPED, (payload: FileSkippedPayload) => {
    state.skipped++;
    state.done++;

    if (payload.reason === 'dedup') {
      state.dryRunDedups++;
    }

    state.rows.push({
      file: payload.path,
      status: 'skipped',
      detail: payload.reason,
    });

    advanceBar();
  });

  engine.on(EV.FILE_FAILED, (payload: FileFailedPayload) => {
    state.failed++;
    state.done++;

    const basename = path.basename(payload.path);
    state.failures.push({ file: basename, error: payload.error });

    state.rows.push({
      file: payload.path,
      status: 'failed',
      detail: payload.error.slice(0, 28),
    });

    advanceBar();
  });

  engine.on(EV.RUN_DONE, (payload: RunDonePayload) => {
    if (bar) {
      // Ensure bar reaches 100% even if unchanged-skipped files weren't counted
      bar.update(state.total, {
        uploaded: state.uploaded,
        skipped:  state.skipped,
        failed:   state.failed,
      });
      bar.stop();
    }

    ui.blank();

    // Summary box
    printImportSummaryBox({
      uploaded:          payload.stats.uploaded,
      skipped:           payload.stats.skipped,
      failed:            payload.stats.failed,
      dryRun:            state.dryRun,
      dryRunWouldUpload: state.dryRunWouldUpload,
      dryRunDedups:      state.dryRunDedups,
    });

    // Duration
    const secs = (payload.durationMs / 1000).toFixed(1);
    ui.dim(`Run #${payload.runId} completed in ${secs}s`);

    // Failures table
    if (state.failures.length > 0) {
      ui.blank();
      ui.warn(`${state.failures.length} file(s) failed:`);
      printFileSummaryTable(
        state.failures.map((f) => ({
          file: f.file,
          status: 'failed' as const,
          detail: f.error,
        })),
      );
    }

    // Re-queue hint
    if (state.failed > 0 && !state.dryRun) {
      ui.info('Run `memoriahub retry --all` to retry failed files.');
    }
  });

  engine.on(EV.ERROR, (payload) => {
    ui.error(payload.message);
  });
}
