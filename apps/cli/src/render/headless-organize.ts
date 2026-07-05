/**
 * render/headless-organize.ts — Terminal renderer for organize-run summaries.
 *
 * Used for non-TTY output and the default headless path.  Consumes the same
 * OrganizeTotals object the engine returns, so every surface agrees.
 *
 * ONLY this file and command files are allowed to print to the terminal.
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import { isTTY, printBox } from '../ui.js';
import type { OrganizeTotals } from '../organize/events.js';

// Cap on the number of bucket rows rendered, to avoid flooding the terminal on
// libraries that span many years/months.
const MAX_BUCKET_ROWS = 40;

/** Emit the totals as pretty-printed JSON (for scripting / jq). */
export function renderOrganizeJson(totals: OrganizeTotals): void {
  process.stdout.write(JSON.stringify(totals, null, 2) + '\n');
}

/**
 * Render an organize-run summary to the terminal: a KPI box followed by a
 * per-bucket breakdown table.
 */
export function renderOrganizeSummary(
  totals: OrganizeTotals,
  opts: { dryRun: boolean },
): void {
  const title = opts.dryRun ? 'Organize (dry-run)' : 'Organize Summary';

  const headline = opts.dryRun
    ? chalk.bold('Dry-run — nothing was moved')
    : chalk.bold('Organize complete');

  const movedLabel = opts.dryRun ? 'Would move' : 'Moved';
  const conflictsLine =
    totals.conflicts > 0
      ? `  Renamed    : ${chalk.yellow(String(totals.conflicts))} (name collisions)`
      : `  Renamed    : ${totals.conflicts}`;
  const errorsLine =
    totals.errors > 0
      ? `  ${chalk.red('Errors')}     : ${chalk.red(String(totals.errors))}`
      : `  Errors     : 0`;

  printBox(
    [
      headline,
      '',
      `  Total      : ${chalk.cyan(String(totals.total))} file(s)`,
      `  ${movedLabel.padEnd(9)}  : ${chalk.green(String(totals.moved))}`,
      `  ${chalk.dim('Skipped')}    : ${chalk.dim(String(totals.skipped))} (already in place)`,
      conflictsLine,
      errorsLine,
      `  No date    : ${totals.nodate} → NODATE/`,
    ],
    title,
  );

  const buckets = Object.entries(totals.byBucket).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (buckets.length > 0) {
    const table = new Table({
      head: [chalk.bold('Destination'), chalk.bold('Files')],
      colWidths: [40, 9],
      wordWrap: true,
      style: { head: [], border: isTTY ? ['dim'] : [] },
    });
    for (const [bucket, count] of buckets.slice(0, MAX_BUCKET_ROWS)) {
      table.push([bucket, String(count)]);
    }
    process.stdout.write(table.toString() + '\n');
    if (buckets.length > MAX_BUCKET_ROWS) {
      process.stdout.write(
        chalk.dim(`  … and ${buckets.length - MAX_BUCKET_ROWS} more destination(s)\n`),
      );
    }
  }
}
