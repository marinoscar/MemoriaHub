/**
 * render/headless-date-infer.ts — Terminal renderer for date-inference run
 * summaries.
 *
 * Used for non-TTY output and the default headless path. Consumes the same
 * DateInferenceTotals object the engine returns, so every surface agrees.
 *
 * ONLY this file and command files are allowed to print to the terminal.
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import { isTTY, printBox } from '../ui.js';
import type { DateInferenceTotals } from '../date-inference/events.js';
import type { DateInferenceMode } from '../date-inference/date-inference-engine.js';

/** Emit the totals as pretty-printed JSON (for scripting / jq). */
export function renderDateInferenceJson(totals: DateInferenceTotals): void {
  process.stdout.write(JSON.stringify(totals, null, 2) + '\n');
}

/**
 * Render a date-inference run summary to the terminal: a KPI box followed by
 * a matched-pattern breakdown table.
 */
export function renderDateInferenceSummary(
  totals: DateInferenceTotals,
  opts: { mode: DateInferenceMode; exportPath?: string },
): void {
  const title = opts.mode === 'diagnose' ? 'Date Inference — Diagnose' : 'Date Inference — Apply';
  const headline =
    opts.mode === 'diagnose'
      ? chalk.bold('Diagnose complete — nothing was written')
      : chalk.bold('Apply complete');

  const lines = [
    headline,
    '',
    `  Total scanned      : ${chalk.cyan(String(totals.total))} file(s)`,
    `  ${chalk.dim('Already had a date')} : ${chalk.dim(String(totals.hasDate))}`,
    `  Inferred from name : ${chalk.green(String(totals.inferred))}`,
    `  No date found      : ${chalk.yellow(String(totals.noPattern))}`,
  ];

  if (opts.mode === 'apply') {
    lines.push(`  Written to file    : ${chalk.green(String(totals.written))}`);
    if (totals.writeFailed > 0) {
      lines.push(`  ${chalk.red('Write failed')}       : ${chalk.red(String(totals.writeFailed))}`);
    } else {
      lines.push(`  Write failed       : 0`);
    }
  }

  if (totals.errors > 0) {
    lines.push(`  ${chalk.red('Errors')}             : ${chalk.red(String(totals.errors))}`);
  } else {
    lines.push(`  Errors             : 0`);
  }

  if (opts.exportPath) {
    lines.push('', `  Report: ${chalk.dim(opts.exportPath)}`);
  }

  printBox(lines, title);

  const patterns = Object.entries(totals.byPattern).filter(([, n]) => n > 0);
  if (patterns.length > 0) {
    const table = new Table({
      head: [chalk.bold('Matched pattern'), chalk.bold('Files')],
      colWidths: [22, 9],
      wordWrap: true,
      style: { head: [], border: isTTY ? ['dim'] : [] },
    });
    for (const [pattern, count] of patterns.sort(([, a], [, b]) => b - a)) {
      table.push([pattern, String(count)]);
    }
    process.stdout.write(table.toString() + '\n');
  }
}
