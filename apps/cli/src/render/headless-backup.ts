/**
 * render/headless-backup.ts — Terminal renderer for `memoriahub backup run`
 * (issue #316, epic #308). Pattern: render/headless-sync.ts.
 *
 * Subscribes to BackupEngine events and drives either:
 *   - human output: a start line, a self-updating progress line (TTY) or
 *     periodic lines (non-TTY), throttle notices, and a summary on finish; or
 *   - `--json`: one NDJSON line per event on stdout, nothing else.
 *
 * ONLY this file and the command layer print; the engine is UI-free.
 */

import chalk from 'chalk';
import { ui, isTTY } from '../ui.js';
import {
  BACKUP_EV,
  type BackupEngineStats,
  type ItemDonePayload,
  type PageFetchedPayload,
  type RunFinishedPayload,
  type RunStartedPayload,
  type ThrottlePayload,
  type BackupErrorPayload,
} from '../backup/events.js';
import type { BackupEngine } from '../backup/backup-engine.js';

/** Format a byte count for humans (decimal units, one decimal place). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = '';
  for (const u of units) {
    value /= 1000;
    unit = u;
    if (value < 1000) break;
  }
  return `${value.toFixed(1)} ${unit}`;
}

export interface RenderBackupOptions {
  /** NDJSON event stream instead of human output. */
  json: boolean;
  /** Injectable sink (tests capture output; defaults to process.stdout). */
  write?: (line: string) => void;
  now?: () => number;
}

/**
 * Attach terminal-output listeners to `engine`. Must be called before
 * `engine.runBackup()`.
 */
export function renderBackupHeadless(engine: BackupEngine, opts: RenderBackupOptions): void {
  const write = opts.write ?? ((line: string): void => void process.stdout.write(line));
  const now = opts.now ?? Date.now;

  // ---------------------------------------------------------------------------
  // NDJSON mode: every event becomes one parseable line; nothing else prints.
  // ---------------------------------------------------------------------------
  if (opts.json) {
    const emitLine = (event: string, payload: unknown): void => {
      write(`${JSON.stringify({ event, ...(payload as Record<string, unknown>) })}\n`);
    };
    engine.on(BACKUP_EV.RUN_STARTED, (p) => emitLine('run-started', p));
    engine.on(BACKUP_EV.PAGE_FETCHED, (p) => emitLine('page-fetched', p));
    engine.on(BACKUP_EV.ITEM_STARTED, (p) => emitLine('item-started', p));
    engine.on(BACKUP_EV.ITEM_DONE, (p) => emitLine('item-done', p));
    engine.on(BACKUP_EV.PAGE_COMMITTED, (p) => emitLine('page-committed', p));
    engine.on(BACKUP_EV.THROTTLE, (p) => emitLine('throttle', p));
    engine.on(BACKUP_EV.RUN_FINISHED, (p) => emitLine('run-finished', p));
    engine.on(BACKUP_EV.ERROR, (p) => emitLine('error', p));
    return;
  }

  // ---------------------------------------------------------------------------
  // Human mode
  // ---------------------------------------------------------------------------
  const state = {
    startedAt: 0,
    done: 0,
    downloaded: 0,
    skipped: 0,
    errors: 0,
    bytes: 0,
    failures: [] as Array<{ id: string; error: string }>,
  };

  function progressLine(): string {
    const elapsedSec = Math.max(0.001, (now() - state.startedAt) / 1000);
    const rate = state.bytes / elapsedSec; // bytes/sec
    return (
      `  ${state.done} item(s)  ` +
      `${chalk.green(`${state.downloaded} downloaded`)}  ` +
      `${chalk.dim(`${state.skipped} up-to-date`)}  ` +
      `${state.errors > 0 ? chalk.red(`${state.errors} failed`) : '0 failed'}  ` +
      `${formatBytes(state.bytes)} @ ${formatBytes(rate)}/s`
    );
  }

  function renderProgress(): void {
    if (isTTY) {
      write(`\r\x1b[2K${progressLine()}`);
    } else if (state.done > 0 && state.done % 25 === 0) {
      write(`${progressLine()}\n`);
    }
  }

  engine.on(BACKUP_EV.RUN_STARTED, (p: RunStartedPayload) => {
    state.startedAt = now();
    ui.step(`Starting backup run ${p.runId} (${p.kind}, ${p.trigger})`);
  });

  engine.on(BACKUP_EV.PAGE_FETCHED, (p: PageFetchedPayload) => {
    if (p.items === 0 && p.pageIndex === 0) {
      ui.success('Backup is up to date — no changes since the last run.');
    }
  });

  engine.on(BACKUP_EV.ITEM_DONE, (p: ItemDonePayload) => {
    state.done++;
    switch (p.outcome) {
      case 'downloaded':
        state.downloaded++;
        state.bytes += p.bytes;
        break;
      case 'failed':
        state.errors++;
        state.failures.push({ id: p.id, error: p.error ?? 'unknown error' });
        break;
      default:
        state.skipped++;
        break;
    }
    renderProgress();
  });

  engine.on(BACKUP_EV.PAGE_COMMITTED, () => {
    // Non-TTY: one progress line per committed page keeps logs readable
    // without flooding them per item.
    if (!isTTY && state.done > 0) write(`${progressLine()}\n`);
  });

  engine.on(BACKUP_EV.THROTTLE, (p: ThrottlePayload) => {
    const secs = (p.delayMs / 1000).toFixed(1);
    if (isTTY) write('\r\x1b[2K');
    ui.dim(`  ⏳ Rate limited — slowing down for ${secs}s…`);
  });

  engine.on(BACKUP_EV.RUN_FINISHED, (p: RunFinishedPayload) => {
    if (isTTY && state.done > 0) write('\n');
    ui.blank();
    printBackupSummary(p.status, p.stats, (now() - state.startedAt) / 1000, write);

    if (state.failures.length > 0) {
      ui.blank();
      ui.warn(`${state.failures.length} item(s) failed:`);
      for (const f of state.failures.slice(0, 20)) {
        ui.line(`  ${chalk.red('✗')} ${f.id}  ${chalk.dim(f.error.slice(0, 80))}`);
      }
      if (state.failures.length > 20) {
        ui.dim(`  …and ${state.failures.length - 20} more (see the catalog's failed items).`);
      }
    }

    if (p.error) {
      ui.blank();
      ui.error(p.error);
    }
  });

  engine.on(BACKUP_EV.ERROR, (p: BackupErrorPayload) => {
    if (isTTY) write('\r\x1b[2K');
    ui.error(p.message);
  });
}

/** Summary table shared by TTY and non-TTY output. */
function printBackupSummary(
  status: string,
  stats: BackupEngineStats,
  durationSec: number,
  _write: (line: string) => void,
): void {
  const statusLabel =
    status === 'completed'
      ? chalk.green('completed')
      : status === 'aborted'
        ? chalk.yellow('aborted')
        : chalk.red('failed');

  ui.line(`  Status       : ${statusLabel}`);
  ui.line(`  Downloaded   : ${stats.itemsDownloaded} item(s), ${formatBytes(stats.bytesDownloaded)}`);
  ui.line(`  Up to date   : ${stats.itemsSkipped} item(s)`);
  ui.line(`  Sidecars     : ${stats.sidecarsWritten} written`);
  ui.line(`  Errors       : ${stats.errors}`);
  ui.line(`  Duration     : ${durationSec.toFixed(1)}s`);
}
