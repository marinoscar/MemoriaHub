/**
 * commands/folders.ts — `memoriahub folders` command group.
 *
 * Subcommands:
 *   folders add <path> [-r|--recursive] [--disabled]
 *   folders list [--json]
 *   folders remove <id|path>
 *   folders enable <id|path>
 *   folders disable <id|path>
 *
 * The folder registry works offline — no server connection required.
 */

import * as path from 'path';
import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import { getDb } from '../db/database.js';
import { FolderRepo } from '../repo/folders.js';
import { ui, isTTY } from '../ui.js';
import type { Folder } from '../db/types.js';

// ---------------------------------------------------------------------------
// Helper: format last sync date for display
// ---------------------------------------------------------------------------

function fmtLastSync(iso: string | null): string {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// folders add
// ---------------------------------------------------------------------------

function addCmd(): Command {
  const cmd = new Command('add');
  cmd
    .description('Add a folder to the managed registry')
    .argument('<path>', 'Path to the folder to register')
    .option('-r, --recursive', 'Watch sub-directories recursively', false)
    .option('--disabled', 'Add the folder in disabled state', false);

  cmd.action((folderPath: string, opts: { recursive: boolean; disabled: boolean }) => {
    const absPath = path.resolve(folderPath);
    const repo = new FolderRepo(getDb());

    let folder: Folder;
    try {
      folder = repo.add({
        path: absPath,
        recursive: opts.recursive,
        enabled: !opts.disabled,
      });
    } catch (err) {
      ui.error((err as Error).message);
      process.exit(1);
    }

    ui.success(`Folder registered`);
    ui.line('');
    ui.line(`  ID        : ${folder.id}`);
    ui.line(`  Path      : ${folder.path}`);
    ui.line(`  Recursive : ${folder.recursive ? 'yes' : 'no'}`);
    ui.line(`  Enabled   : ${folder.enabled ? 'yes' : 'no'}`);
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// folders list
// ---------------------------------------------------------------------------

function listCmd(): Command {
  const cmd = new Command('list');
  cmd
    .description('List all registered folders')
    .option('--json', 'Output as JSON array', false);

  cmd.action((opts: { json: boolean }) => {
    const repo = new FolderRepo(getDb());
    const folders = repo.list();

    if (opts.json) {
      process.stdout.write(JSON.stringify(folders, null, 2) + '\n');
      return;
    }

    if (folders.length === 0) {
      ui.info('No folders registered yet. Run `memoriahub folders add <path>` to add one.');
      return;
    }

    const table = new Table({
      head: [
        chalk.bold('ID'),
        chalk.bold('Path'),
        chalk.bold('Recursive'),
        chalk.bold('Enabled'),
        chalk.bold('Last Sync'),
      ],
      colWidths: [5, 45, 11, 9, 24],
      wordWrap: true,
      style: { head: [], border: isTTY ? ['dim'] : [] },
    });

    for (const f of folders) {
      table.push([
        String(f.id),
        f.path,
        f.recursive ? chalk.green('yes') : chalk.dim('no'),
        f.enabled  ? chalk.green('yes') : chalk.dim('no'),
        fmtLastSync(f.last_sync_at),
      ]);
    }

    ui.blank();
    process.stdout.write(table.toString() + '\n');
    ui.blank();
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// folders remove
// ---------------------------------------------------------------------------

function removeCmd(): Command {
  const cmd = new Command('remove');
  cmd
    .description('Remove a folder from the registry (cascade-deletes its file records)')
    .argument('<id|path>', 'Numeric ID or path of the folder to remove');

  cmd.action((idOrPath: string) => {
    const repo = new FolderRepo(getDb());
    const folder = repo.resolve(idOrPath);

    if (!folder) {
      ui.error(`Folder not found: ${idOrPath}`);
      process.exit(1);
    }

    const removed = repo.remove(idOrPath);
    if (removed) {
      ui.success(`Removed folder #${folder.id}: ${folder.path}`);
    } else {
      ui.error(`Failed to remove folder: ${idOrPath}`);
      process.exit(1);
    }
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// folders enable / disable
// ---------------------------------------------------------------------------

function enableCmd(): Command {
  const cmd = new Command('enable');
  cmd
    .description('Enable a previously disabled folder')
    .argument('<id|path>', 'Numeric ID or path of the folder to enable');

  cmd.action((idOrPath: string) => {
    const repo = new FolderRepo(getDb());
    const updated = repo.setEnabled(idOrPath, true);
    if (!updated) {
      ui.error(`Folder not found: ${idOrPath}`);
      process.exit(1);
    }
    ui.success(`Enabled folder #${updated.id}: ${updated.path}`);
  });

  return cmd;
}

function disableCmd(): Command {
  const cmd = new Command('disable');
  cmd
    .description('Disable a folder (skipped during sync)')
    .argument('<id|path>', 'Numeric ID or path of the folder to disable');

  cmd.action((idOrPath: string) => {
    const repo = new FolderRepo(getDb());
    const updated = repo.setEnabled(idOrPath, false);
    if (!updated) {
      ui.error(`Folder not found: ${idOrPath}`);
      process.exit(1);
    }
    ui.success(`Disabled folder #${updated.id}: ${updated.path}`);
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// Export the top-level `folders` command group
// ---------------------------------------------------------------------------

export function foldersCommand(): Command {
  const cmd = new Command('folders');
  cmd.description('Manage the set of folders watched by MemoriaHub');

  cmd.addCommand(addCmd());
  cmd.addCommand(listCmd());
  cmd.addCommand(removeCmd());
  cmd.addCommand(enableCmd());
  cmd.addCommand(disableCmd());

  return cmd;
}
