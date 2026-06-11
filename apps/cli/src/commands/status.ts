/**
 * commands/status.ts — `memoriahub status` command.
 *
 * Reads the DB to show per-folder and per-run summaries.
 *
 * Usage:
 *   memoriahub status           # folder table (default)
 *   memoriahub status --runs    # recent sync runs table
 *   memoriahub status --json    # structured JSON output
 */

import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import { getDb } from '../db/database.js';
import { FolderRepo } from '../repo/folders.js';
import { FileRepo } from '../repo/files.js';
import { RunRepo } from '../repo/runs.js';
import { ui, isTTY, printFolderStatusTable, type FolderStatusRow } from '../ui.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string | null): string {
  if (!iso) return 'never';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function fmtDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return 'running…';
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function statusCommand(): Command {
  const cmd = new Command('status');
  cmd
    .description('Show sync status: folder overview or recent run history')
    .option('--runs', 'Show recent sync run history instead of folder overview', false)
    .option('--json', 'Output structured JSON', false);

  cmd.action((opts: { runs: boolean; json: boolean }) => {
    const db = getDb();
    const folderRepo = new FolderRepo(db);
    const fileRepo   = new FileRepo(db);
    const runRepo    = new RunRepo(db);

    // ------------------------------------------------------------------
    // --runs mode: recent run history
    // ------------------------------------------------------------------
    if (opts.runs) {
      const runs = runRepo.listRuns(20);

      if (opts.json) {
        process.stdout.write(JSON.stringify(runs, null, 2) + '\n');
        return;
      }

      if (runs.length === 0) {
        ui.info('No sync runs recorded yet. Run `memoriahub sync --all` to start.');
        return;
      }

      const table = new Table({
        head: [
          chalk.bold('ID'),
          chalk.bold('Trigger'),
          chalk.bold('Started'),
          chalk.bold('Duration'),
          chalk.bold('Total'),
          chalk.bold('Uploaded'),
          chalk.bold('Skipped'),
          chalk.bold('Failed'),
          chalk.bold('Dry?'),
        ],
        colWidths: [5, 9, 22, 10, 7, 10, 9, 8, 5],
        wordWrap: true,
        style: { head: [], border: isTTY ? ['dim'] : [] },
      });

      for (const run of runs) {
        table.push([
          String(run.id),
          run.trigger,
          fmtDate(run.started_at),
          fmtDuration(run.started_at, run.finished_at),
          String(run.total),
          chalk.green(String(run.uploaded)),
          chalk.dim(String(run.skipped)),
          run.failed > 0 ? chalk.red(String(run.failed)) : '0',
          run.dry_run ? chalk.yellow('yes') : chalk.dim('no'),
        ]);
      }

      ui.blank();
      ui.step('Recent Sync Runs');
      ui.blank();
      process.stdout.write(table.toString() + '\n');
      ui.blank();
      return;
    }

    // ------------------------------------------------------------------
    // Default mode: folder overview
    // ------------------------------------------------------------------
    const folders = folderRepo.list();

    if (opts.json) {
      const out = folders.map((f) => {
        const counts = fileRepo.counts([f.id]);
        return {
          id: f.id,
          path: f.path,
          enabled: f.enabled,
          recursive: f.recursive,
          last_sync_at: f.last_sync_at,
          counts,
        };
      });
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return;
    }

    if (folders.length === 0) {
      ui.info('No folders registered yet. Run `memoriahub folders add <path>` to get started.');
      return;
    }

    const rows: FolderStatusRow[] = folders.map((f) => {
      const counts = fileRepo.counts([f.id]);
      return {
        folder:   f.path,
        lastSync: fmtDate(f.last_sync_at),
        uploaded: counts.uploaded,
        pending:  counts.queued + counts.uploading,
        failed:   counts.failed,
        total:    counts.total,
      };
    });

    ui.blank();
    ui.step('Sync Status');
    ui.blank();
    printFolderStatusTable(rows);
    ui.blank();

    // Summary line
    const totals = runRepo.totals();
    if (totals.runs > 0) {
      ui.dim(
        `Lifetime: ${totals.runs} run(s) — ` +
        `${totals.uploaded} uploaded, ` +
        `${totals.skipped} skipped, ` +
        `${totals.failed} failed`,
      );
    }
  });

  return cmd;
}
