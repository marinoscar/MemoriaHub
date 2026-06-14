/**
 * commands/circles.ts — `memoriahub circles` command group.
 *
 * Subcommands:
 *   circles list         — list the user's circles, mark active and personal ones
 *   circles use <id>     — set the active circle (validates against the server's list)
 *
 * Both subcommands require login (requireConfig).
 */

import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import { requireConfig, saveConfig } from '../config.js';
import { ApiClient } from '../api.js';
import { ui, isTTY } from '../ui.js';

// ---------------------------------------------------------------------------
// circles list
// ---------------------------------------------------------------------------

function listCmd(): Command {
  const cmd = new Command('list');
  cmd.description('List your circles on the server');

  cmd.action(async () => {
    const cfg = requireConfig();
    const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });

    let circles;
    try {
      circles = await api.listCircles();
    } catch (err) {
      ui.error(`Failed to fetch circles: ${(err as Error).message}`);
      process.exit(1);
    }

    if (circles.length === 0) {
      ui.info('No circles found. Create a circle on the web app first.');
      return;
    }

    const table = new Table({
      head: [
        chalk.bold('ID'),
        chalk.bold('Name'),
        chalk.bold('Personal'),
        chalk.bold('Active'),
      ],
      colWidths: [38, 30, 10, 8],
      wordWrap: true,
      style: { head: [], border: isTTY ? ['dim'] : [] },
    });

    for (const c of circles) {
      const isActive = c.id === cfg.activeCircleId;
      table.push([
        c.id,
        c.name,
        c.isPersonal ? chalk.cyan('yes') : chalk.dim('no'),
        isActive ? chalk.green('*') : '',
      ]);
    }

    ui.blank();
    process.stdout.write(table.toString() + '\n');
    ui.blank();

    if (!cfg.activeCircleId) {
      ui.info('No active circle set. Run `memoriahub circles use <id>` to set one.');
    }
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// circles use <id>
// ---------------------------------------------------------------------------

function useCmd(): Command {
  const cmd = new Command('use');
  cmd
    .description('Set the active circle for uploads')
    .argument('<id>', 'Circle ID to activate');

  cmd.action(async (id: string) => {
    const cfg = requireConfig();
    const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });

    let circles;
    try {
      circles = await api.listCircles();
    } catch (err) {
      ui.error(`Failed to fetch circles: ${(err as Error).message}`);
      process.exit(1);
    }

    const found = circles.find((c) => c.id === id);
    if (!found) {
      ui.error('Circle not found. Run `memoriahub circles list` to see available circles.');
      process.exit(1);
    }

    saveConfig({ ...cfg, activeCircleId: id });
    ui.success(`Active circle set to: ${found.name} (${id})`);
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// Export the top-level `circles` command group
// ---------------------------------------------------------------------------

export function circlesCommand(): Command {
  const cmd = new Command('circles');
  cmd.description('Manage the active circle for uploads');

  cmd.addCommand(listCmd());
  cmd.addCommand(useCmd());

  return cmd;
}
