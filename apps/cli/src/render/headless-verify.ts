/**
 * render/headless-verify.ts — Terminal renderer for `memoriahub backup verify`
 * and `memoriahub backup prune` (issue #320, epic #308).
 *
 * Same split as render/headless-backup.ts: the verify/prune engines are
 * UI-free and emit typed events (or return typed results); ONLY this file and
 * the command layer print. `--json` emits NDJSON, one line per event.
 */

import chalk from 'chalk';
import { ui, isTTY } from '../ui.js';
import { formatBytes } from './headless-backup.js';
import {
  VERIFY_EV,
  isVerifyFailure,
  type VerifyEmitter,
  type VerifyFinishedPayload,
  type VerifyItemResult,
  type VerifyStartedPayload,
  type VerifySummary,
} from '../backup/verify.js';
import type { QuarantineEntry } from '../backup/reconcile.js';

export interface RenderVerifyOptions {
  /** NDJSON event stream instead of human output. */
  json: boolean;
  /** Injectable sink (tests capture output; defaults to process.stdout). */
  write?: (line: string) => void;
}

/**
 * Attach terminal-output listeners to a verify emitter. Must be called before
 * runVerify() so the started event is not missed.
 */
export function renderVerifyHeadless(emitter: VerifyEmitter, opts: RenderVerifyOptions): void {
  const write = opts.write ?? ((line: string): void => void process.stdout.write(line));

  if (opts.json) {
    const emitLine = (event: string, payload: unknown): void => {
      write(`${JSON.stringify({ event, ...(payload as Record<string, unknown>) })}\n`);
    };
    emitter.on(VERIFY_EV.STARTED, (p: VerifyStartedPayload) => emitLine('verify-started', p));
    emitter.on(VERIFY_EV.ITEM_DONE, (p: VerifyItemResult) => emitLine('verify-item-done', p));
    emitter.on(VERIFY_EV.FINISHED, (p: VerifyFinishedPayload) => emitLine('verify-finished', p));
    return;
  }

  const state = { total: 0, done: 0, failed: 0 };

  function progressLine(): string {
    const pct = state.total > 0 ? Math.floor((state.done / state.total) * 100) : 0;
    return (
      `  ${state.done}/${state.total} (${pct}%)  ` +
      `${state.failed > 0 ? chalk.red(`${state.failed} failed`) : '0 failed'}`
    );
  }

  emitter.on(VERIFY_EV.STARTED, (p: VerifyStartedPayload) => {
    state.total = p.total;
    ui.step(
      `Verifying ${p.total} item(s)${p.deep ? ' (deep — hashing every file)' : ''} ` +
        `with ${p.concurrency} worker(s)…`,
    );
  });

  emitter.on(VERIFY_EV.ITEM_DONE, (p: VerifyItemResult) => {
    state.done++;
    if (isVerifyFailure(p.outcome)) state.failed++;
    if (isTTY) {
      write(`\r\x1b[2K${progressLine()}`);
    } else if (state.done % 100 === 0) {
      write(`${progressLine()}\n`);
    }
  });

  emitter.on(VERIFY_EV.FINISHED, (p: VerifyFinishedPayload) => {
    if (isTTY && state.done > 0) write('\n');
    ui.blank();
    printVerifySummary(p.summary);
  });
}

/** Summary block shared by TTY and non-TTY output. */
export function printVerifySummary(summary: VerifySummary): void {
  ui.line(`  Mode         : ${summary.deep ? 'deep (every file hashed)' : 'standard'}`);
  ui.line(`  Checked      : ${summary.checked} item(s)`);
  ui.line(`  Hashed       : ${summary.hashed} item(s), ${formatBytes(summary.bytesHashed)}`);
  ui.line(`  Verified OK  : ${summary.ok}`);
  ui.line(
    `  Failed       : ${summary.failed > 0 ? chalk.red(String(summary.failed)) : '0'}`,
  );
  ui.line(`  Duration     : ${(summary.durationMs / 1000).toFixed(1)}s`);

  if (summary.failures.length > 0) {
    ui.blank();
    ui.warn(`${summary.failures.length} item(s) failed verification:`);
    for (const f of summary.failures.slice(0, 20)) {
      ui.line(
        `  ${chalk.red('✗')} ${f.relPath}  ${chalk.dim(`${f.outcome}: ${f.error ?? ''}`.slice(0, 90))}`,
      );
    }
    if (summary.failures.length > 20) {
      ui.dim(`  …and ${summary.failures.length - 20} more.`);
    }
    ui.blank();
    ui.info(
      'Failed items were marked for re-download — the next `memoriahub backup run` re-fetches them.',
    );
  }
}

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

/** Human listing of the quarantine contents (the dry-run default). */
export function printQuarantineListing(
  entries: QuarantineEntry[],
  opts: { deleted: boolean; olderThanDays?: number },
): void {
  const totalBytes = entries.reduce((sum, e) => sum + (e.size ?? 0), 0);

  if (entries.length === 0) {
    ui.success(
      opts.olderThanDays !== undefined
        ? `Nothing in _quarantine/ older than ${opts.olderThanDays} day(s).`
        : 'Nothing is quarantined — the backup root is clean.',
    );
    return;
  }

  ui.line(
    `${opts.deleted ? 'Deleted' : 'Quarantined'} ${entries.length} item(s), ${formatBytes(totalBytes)}` +
      `${opts.olderThanDays !== undefined ? ` (quarantined more than ${opts.olderThanDays} day(s) ago)` : ''}:`,
  );
  for (const entry of entries.slice(0, 50)) {
    ui.line(
      `  ${entry.relPath}  ${chalk.dim(
        `${formatBytes(entry.size ?? 0)} · quarantined ${entry.quarantinedAt}`,
      )}`,
    );
  }
  if (entries.length > 50) {
    ui.dim(`  …and ${entries.length - 50} more.`);
  }

  if (!opts.deleted) {
    ui.blank();
    ui.warn('Dry run — nothing was deleted. Re-run with --yes to permanently delete these files.');
  }
}
