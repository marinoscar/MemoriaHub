/**
 * render/headless-screenshots.ts — Terminal renderer for screenshots-run summaries.
 *
 * Used for non-TTY output and the default headless path. Consumes the same
 * ScreenshotTotals/ScreenshotMatch objects the engine returns, so every
 * surface agrees.
 *
 * ONLY this file and command files are allowed to print to the terminal.
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import { isTTY, printBox } from '../ui.js';
import { formatBytes } from '../format-bytes.js';
import type { ScreenshotTotals } from '../screenshots/events.js';
import type { ScreenshotMatch } from '../screenshots/plan.js';
import type { ScreenshotMode } from '../screenshots/screenshot-engine.js';

// Cap on the number of file rows rendered, to avoid flooding the terminal on
// libraries with thousands of matches.
const MAX_FILE_ROWS = 40;

export interface ScreenshotsRenderOptions {
  mode: ScreenshotMode;
  dryRun: boolean;
  destDir?: string;
}

/** Emit the totals + matches as pretty-printed JSON (for scripting / jq). */
export function renderScreenshotsJson(
  totals: ScreenshotTotals,
  matches: ScreenshotMatch[],
  opts: ScreenshotsRenderOptions,
): void {
  process.stdout.write(
    JSON.stringify(
      {
        mode: opts.mode,
        dryRun: opts.dryRun,
        destDir: opts.destDir,
        totals,
        matches: matches.map((m) => ({ path: m.filePath, size: m.size })),
      },
      null,
      2,
    ) + '\n',
  );
}

function headlineFor(totals: ScreenshotTotals, opts: ScreenshotsRenderOptions): string {
  const n = totals.matched;
  if (opts.mode === 'find') {
    return n === 0 ? 'No screenshots found' : `Found ${n} screenshot(s)`;
  }
  if (opts.mode === 'move') {
    return opts.dryRun
      ? `Dry-run — would move ${n} screenshot(s) to ${opts.destDir}`
      : `Moved ${totals.moved} screenshot(s) to ${opts.destDir}`;
  }
  // mode === 'delete'
  return opts.dryRun
    ? `Dry-run — would delete ${n} screenshot(s)`
    : `Deleted ${totals.deleted} screenshot(s)`;
}

/**
 * Render a screenshots-run summary to the terminal: a KPI box followed by a
 * capped list of matched files.
 */
export function renderScreenshotsSummary(
  totals: ScreenshotTotals,
  matches: ScreenshotMatch[],
  opts: ScreenshotsRenderOptions,
): void {
  const title =
    opts.mode === 'find' ? 'Find Screenshots' : opts.mode === 'move' ? 'Move Screenshots' : 'Delete Screenshots';

  const lines = [
    chalk.bold(headlineFor(totals, opts)),
    '',
    `  Matched    : ${chalk.cyan(String(totals.matched))} file(s)`,
    `  Total size : ${chalk.cyan(formatBytes(totals.bytes))}`,
  ];

  if (opts.mode === 'move' && !opts.dryRun) {
    lines.push(`  Moved      : ${chalk.green(String(totals.moved))}`);
    lines.push(`  ${chalk.dim('Skipped')}    : ${chalk.dim(String(totals.skipped))} (already in place)`);
  }
  if (opts.mode === 'delete' && !opts.dryRun) {
    lines.push(`  Deleted    : ${chalk.green(String(totals.deleted))}`);
  }
  if (totals.errors > 0) {
    lines.push(`  ${chalk.red('Errors')}     : ${chalk.red(String(totals.errors))}`);
  } else if (opts.mode !== 'find') {
    lines.push(`  Errors     : 0`);
  }

  printBox(lines, title);

  if (matches.length > 0) {
    const table = new Table({
      head: [chalk.bold('File'), chalk.bold('Size')],
      colWidths: [58, 12],
      wordWrap: true,
      style: { head: [], border: isTTY ? ['dim'] : [] },
    });
    for (const m of matches.slice(0, MAX_FILE_ROWS)) {
      table.push([m.filePath, formatBytes(m.size)]);
    }
    process.stdout.write(table.toString() + '\n');
    if (matches.length > MAX_FILE_ROWS) {
      process.stdout.write(chalk.dim(`  … and ${matches.length - MAX_FILE_ROWS} more file(s) not shown\n`));
    }
  }
}
