/**
 * render/headless-convert.ts — Terminal renderer for convert-run summaries.
 *
 * Used for non-TTY output and the default headless path.  Consumes the same
 * ConvertTotals object the engine returns, so every surface agrees.
 *
 * ONLY this file and command files are allowed to print to the terminal.
 */

import chalk from 'chalk';
import { printBox } from '../ui.js';
import { formatBytes } from '../format-bytes.js';
import type { ConvertTotals } from '../convert/events.js';

/** Emit the totals as pretty-printed JSON (for scripting / jq). */
export function renderConvertJson(totals: ConvertTotals): void {
  process.stdout.write(JSON.stringify(totals, null, 2) + '\n');
}

/**
 * Render a convert-run summary to the terminal: a KPI box with the conversion
 * counts, the remux-vs-re-encode split, and the space delta.
 */
export function renderConvertSummary(
  totals: ConvertTotals,
  opts: { dryRun: boolean; movedTo?: string },
): void {
  const title = opts.dryRun ? 'Convert (dry-run)' : 'Convert Summary';

  const headline = opts.dryRun
    ? chalk.bold('Dry-run — nothing was converted')
    : chalk.bold('Convert complete');

  const convertedLabel = opts.dryRun ? 'Would convert' : 'Converted';

  const errorsLine =
    totals.errors > 0
      ? `  ${chalk.red('Errors')}     : ${chalk.red(String(totals.errors))}`
      : `  Errors     : 0`;

  const lines: string[] = [
    headline,
    '',
    `  Total      : ${chalk.cyan(String(totals.total))} video file(s)`,
    `  ${convertedLabel.padEnd(9)}  : ${chalk.green(String(totals.converted))}`,
    `  ${chalk.dim('Skipped')}    : ${chalk.dim(String(totals.skipped))} (target already exists)`,
    errorsLine,
  ];

  // Detail lines only make sense for a real run (a dry-run does no ffmpeg work).
  if (!opts.dryRun) {
    lines.push(
      `  Remuxed    : ${totals.remuxed} (lossless)   Re-encoded : ${totals.reencoded}`,
    );
    if (totals.deleted > 0) {
      lines.push(`  Originals  : ${chalk.yellow(String(totals.deleted))} deleted`);
    }
    if (totals.moved > 0) {
      const dest = opts.movedTo ? ` → ${chalk.dim(opts.movedTo)}` : '';
      lines.push(`  Originals  : ${chalk.yellow(String(totals.moved))} moved${dest}`);
    }
    if (totals.converted > 0) {
      const delta = totals.bytesIn - totals.bytesOut;
      const deltaLabel =
        delta >= 0
          ? `${formatBytes(delta)} saved`
          : `${formatBytes(-delta)} larger`;
      lines.push(
        `  Size       : ${formatBytes(totals.bytesIn)} → ${formatBytes(totals.bytesOut)} (${deltaLabel})`,
      );
    }
  }

  printBox(lines, title);
}
