/**
 * ui.ts — Centralized terminal UI theme for MemoriaHub CLI.
 *
 * All presentation (color, icons, spinners, banners, tables, boxes) lives here.
 * Business logic stays in the other modules; this file is pure presentation.
 *
 * Color discipline:
 *   - chalk honors NO_COLOR env automatically.
 *   - Spinners and banners are disabled when stdout is not a TTY.
 *   - A global --no-color option sets NO_COLOR=1 before this module is loaded.
 */

import chalk from 'chalk';
import ora, { Ora } from 'ora';
import boxen from 'boxen';
import Table from 'cli-table3';

// ---------------------------------------------------------------------------
// TTY / color detection
// ---------------------------------------------------------------------------

/** True when output is a real terminal (not piped/redirected). */
export const isTTY = Boolean(process.stdout.isTTY);

/** True when colors are enabled (chalk handles NO_COLOR internally). */
export const isColor = isTTY && !process.env['NO_COLOR'];

// Align chalk's color level with our explicit gating so behavior is identical
// to the previous picocolors setup: if !isColor, force chalk to plain text.
if (!isColor) {
  chalk.level = 0;
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

const BANNER_ART = [
  '  __  __                            _       _   _       _     ',
  ' |  \\/  | ___ _ __ ___   ___  _ __(_) __ _| | | |_   _| |__  ',
  " | |\\/| |/ _ \\ '_ ` _ \\ / _ \\| '__| |/ _` | |_| | | | | '_ \\ ",
  ' | |  | |  __/ | | | | | (_) | |  | | (_| |  _  | |_| | |_) |',
  ' |_|  |_|\\___|_| |_| |_|\\___/|_|  |_|\\__,_|_| |_|\\__,_|_.__/ ',
];

const TAGLINE = 'Import and sync photos/videos to your MemoriaHub server';

/**
 * Print the branded banner. Reads version from package.json at call time
 * so it always reflects the installed package version.
 */
export function printBanner(version: string): void {
  if (!isTTY) {
    process.stdout.write(`MemoriaHub CLI v${version}\n`);
    return;
  }

  const art = BANNER_ART.map((line) => chalk.cyan(line)).join('\n');
  const versionBadge = chalk.dim(`v${version}`);
  const tagline = chalk.dim(TAGLINE);

  process.stdout.write('\n');
  process.stdout.write(art + '\n');
  process.stdout.write(`  ${tagline}  ${versionBadge}\n`);
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Semantic message helpers
// ---------------------------------------------------------------------------

const ICONS = {
  success: isTTY ? '✔' : '[OK]',
  error: isTTY ? '✖' : '[ERR]',
  warn: isTTY ? '⚠' : '[WARN]',
  info: isTTY ? 'ℹ' : '[INFO]',
  step: isTTY ? '→' : '-->',
  dim: isTTY ? '·' : '-',
};

export const ui = {
  /** Green check — operation succeeded. */
  success(msg: string): void {
    process.stdout.write(chalk.green(`${ICONS.success} ${msg}`) + '\n');
  },

  /** Red X — operation failed. */
  error(msg: string): void {
    process.stderr.write(chalk.red(`${ICONS.error} ${msg}`) + '\n');
  },

  /** Yellow warning — non-fatal issue. */
  warn(msg: string): void {
    process.stdout.write(chalk.yellow(`${ICONS.warn} ${msg}`) + '\n');
  },

  /** Cyan info — neutral informational message. */
  info(msg: string): void {
    process.stdout.write(chalk.cyan(`${ICONS.info} ${msg}`) + '\n');
  },

  /** Gray dim — secondary/supporting detail. */
  dim(msg: string): void {
    process.stdout.write(chalk.dim(`${ICONS.dim} ${msg}`) + '\n');
  },

  /** Bold arrow — major step/action heading. */
  step(msg: string): void {
    process.stdout.write(chalk.bold(`${ICONS.step} ${msg}`) + '\n');
  },

  /** Plain line — unstyled. */
  line(msg: string): void {
    process.stdout.write(msg + '\n');
  },

  /** Blank line. */
  blank(): void {
    process.stdout.write('\n');
  },
};

// ---------------------------------------------------------------------------
// Spinner factory
// ---------------------------------------------------------------------------

/**
 * Create a spinner for TTY or a no-op for non-TTY contexts.
 * The spinner text is printed even in non-TTY mode as plain lines.
 */
export function createSpinner(text: string): Ora {
  if (!isTTY) {
    // Non-TTY: return a minimal shim so callers don't need to branch.
    process.stdout.write(`${ICONS.step} ${text}\n`);
    return {
      start: () => shim,
      succeed: (t?: string) => { if (t) process.stdout.write(`${ICONS.success} ${t}\n`); return shim; },
      fail: (t?: string) => { if (t) process.stderr.write(`${ICONS.error} ${t}\n`); return shim; },
      warn: (t?: string) => { if (t) process.stdout.write(`${ICONS.warn} ${t}\n`); return shim; },
      info: (t?: string) => { if (t) process.stdout.write(`${ICONS.info} ${t}\n`); return shim; },
      stop: () => shim,
      // Needed by Ora interface but no-op here
      text: text,
      color: 'cyan',
      isSpinning: false,
    } as unknown as Ora;
  }

  return ora({ text, color: 'cyan', spinner: 'dots' });
}

// Self-referencing shim for the no-op spinner
const shim: Ora = {
  start: () => shim,
  succeed: (t?: string) => { if (t) process.stdout.write(`${ICONS.success} ${t}\n`); return shim; },
  fail: (t?: string) => { if (t) process.stderr.write(`${ICONS.error} ${t}\n`); return shim; },
  warn: (t?: string) => { if (t) process.stdout.write(`${ICONS.warn} ${t}\n`); return shim; },
  info: (t?: string) => { if (t) process.stdout.write(`${ICONS.info} ${t}\n`); return shim; },
  stop: () => shim,
  text: '',
  color: 'cyan',
  isSpinning: false,
} as unknown as Ora;

// ---------------------------------------------------------------------------
// Boxed message
// ---------------------------------------------------------------------------

/**
 * Print a boxed message block to stdout.
 * Falls back to plain text with dashes for non-TTY.
 */
export function printBox(lines: string[], title?: string): void {
  if (!isTTY) {
    const bar = '─'.repeat(40);
    if (title) process.stdout.write(`${bar}\n${title}\n${bar}\n`);
    else process.stdout.write(`${bar}\n`);
    for (const l of lines) process.stdout.write(`  ${l}\n`);
    if (!title) process.stdout.write(`${bar}\n`);
    return;
  }

  const content = lines.join('\n');
  const box = boxen(content, {
    padding: 1,
    margin: { top: 1, bottom: 1, left: 0, right: 0 },
    borderStyle: 'round',
    borderColor: 'cyan',
    title: title ? chalk.bold(chalk.cyan(title)) : undefined,
    titleAlignment: 'center',
  });
  process.stdout.write(box + '\n');
}

// ---------------------------------------------------------------------------
// Summary tables
// ---------------------------------------------------------------------------

export interface FileSummaryRow {
  file: string;
  status: 'uploaded' | 'skipped' | 'failed' | 'dry-run';
  detail?: string; // size, mediaItemId, or note
}

/**
 * Print an import/sync per-file summary table.
 * Caps at maxRows to avoid flooding the terminal on large batches.
 */
export function printFileSummaryTable(rows: FileSummaryRow[], maxRows = 50): void {
  if (rows.length === 0) return;

  const table = new Table({
    head: [
      chalk.bold('File'),
      chalk.bold('Status'),
      chalk.bold('Detail'),
    ],
    colWidths: [40, 12, 30],
    wordWrap: true,
    style: { head: [], border: isTTY ? ['dim'] : [] },
  });

  const display = rows.slice(0, maxRows);

  for (const row of display) {
    const statusLabel = formatStatus(row.status);
    const fileName = truncate(row.file.split('/').pop() ?? row.file, 38);
    table.push([fileName, statusLabel, row.detail ?? '']);
  }

  process.stdout.write(table.toString() + '\n');

  if (rows.length > maxRows) {
    ui.dim(`... and ${rows.length - maxRows} more file(s) not shown`);
  }
}

function formatStatus(status: FileSummaryRow['status']): string {
  switch (status) {
    case 'uploaded': return chalk.green('uploaded');
    case 'skipped':  return chalk.dim('skipped');
    case 'failed':   return chalk.red('failed');
    case 'dry-run':  return chalk.yellow('dry-run');
  }
}

// ---------------------------------------------------------------------------
// Status table (per-folder overview)
// ---------------------------------------------------------------------------

export interface FolderStatusRow {
  folder: string;
  lastSync: string;
  uploaded: number;
  pending: number;
  failed: number;
  total: number;
}

/** Print the folder-level status overview table. */
export function printFolderStatusTable(rows: FolderStatusRow[]): void {
  if (rows.length === 0) return;

  const table = new Table({
    head: [
      chalk.bold('Folder'),
      chalk.bold('Last Sync'),
      chalk.bold('Total'),
      chalk.bold('Uploaded'),
      chalk.bold('Pending'),
      chalk.bold('Failed'),
    ],
    colWidths: [35, 22, 7, 10, 9, 8],
    wordWrap: true,
    style: { head: [], border: isTTY ? ['dim'] : [] },
  });

  for (const row of rows) {
    table.push([
      truncate(row.folder, 33),
      row.lastSync,
      String(row.total),
      chalk.green(String(row.uploaded)),
      row.pending > 0 ? chalk.yellow(String(row.pending)) : String(row.pending),
      row.failed > 0  ? chalk.red(String(row.failed))    : String(row.failed),
    ]);
  }

  process.stdout.write(table.toString() + '\n');
}

// ---------------------------------------------------------------------------
// Totals summary box
// ---------------------------------------------------------------------------

export interface ImportTotals {
  uploaded: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  dryRunWouldUpload: number;
  dryRunDedups: number;
}

/** Print a boxed summary after an import or sync run. */
export function printImportSummaryBox(totals: ImportTotals): void {
  const total = totals.uploaded + totals.skipped + totals.failed;

  if (totals.dryRun) {
    printBox([
      chalk.bold('Dry-run complete — nothing was uploaded'),
      '',
      `  Would upload : ${chalk.green(String(totals.dryRunWouldUpload))} file(s)`,
      `  Dedup match  : ${chalk.dim(String(totals.dryRunDedups))} file(s) (already on server)`,
    ], 'Dry-Run Summary');
    return;
  }

  const failedLine =
    totals.failed > 0
      ? `  ${chalk.red('Failed')}   : ${chalk.red(String(totals.failed))}`
      : `  Failed   : 0`;

  printBox([
    `  Total     : ${total}`,
    `  ${chalk.green('Uploaded')} : ${chalk.green(String(totals.uploaded))}`,
    `  ${chalk.dim('Skipped')}  : ${chalk.dim(String(totals.skipped))} (already on server)`,
    failedLine,
  ], 'Import Summary');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
