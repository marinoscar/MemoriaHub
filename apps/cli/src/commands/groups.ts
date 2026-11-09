/**
 * commands/groups.ts — `memoriahub groups` command group (RETRO-I6, #588; formerly
 * `memoriahub circles`, kept as a hidden alias for one release).
 *
 * Subcommands:
 *   groups list            — "My library" and your groups; marks the active one
 *   groups use <id|me>     — set the library uploads go to (validated against the server)
 *
 * Shared libraries are platform groups; a group's id is the former circle's id, and
 * `activeCircleId` in the config keeps holding the scope id, so a folder synced before
 * this release keeps uploading to the same owner. Both subcommands require login.
 */

import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import { requireConfig, saveConfig } from '../config.js';
import { ApiClient, type Circle } from '../api.js';
import { ui, isTTY } from '../ui.js';

/** `me` names the personal library; anything else is an exact library id. */
export function resolveOwnerScopeArg(scopes: readonly Circle[], id: string): Circle | undefined {
  return id === 'me' ? scopes.find((c) => c.isPersonal) : scopes.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// groups list
// ---------------------------------------------------------------------------

function listCmd(): Command {
  const cmd = new Command('list');
  cmd.description('List your libraries: "My library" and your groups');

  cmd.action(async () => {
    const cfg = requireConfig();
    const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });

    let circles;
    try {
      circles = await api.listCircles();
    } catch (err) {
      ui.error(`Failed to fetch libraries: ${(err as Error).message}`);
      process.exit(1);
    }

    if (circles.length === 0) {
      ui.info('No libraries found. Create a group on the web app (Settings > Groups) first.');
      return;
    }

    const table = new Table({
      head: [
        chalk.bold('ID'),
        chalk.bold('Name'),
        chalk.bold('Library'),
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
        c.isPersonal ? chalk.cyan('me') : chalk.dim('group'),
        isActive ? chalk.green('*') : '',
      ]);
    }

    ui.blank();
    process.stdout.write(table.toString() + '\n');
    ui.blank();

    if (!cfg.activeCircleId) {
      ui.info('No active library set. Run `memoriahub groups use <id|me>` to set one.');
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
    .description('Set the library uploads go to')
    .argument('<id>', 'A group id, or "me" for your personal library');

  cmd.action(async (id: string) => {
    const cfg = requireConfig();
    const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });

    let circles;
    try {
      circles = await api.listCircles();
    } catch (err) {
      ui.error(`Failed to fetch libraries: ${(err as Error).message}`);
      process.exit(1);
    }

    const found = resolveOwnerScopeArg(circles, id);
    if (!found) {
      ui.error('Library not found. Run `memoriahub groups list` to see your libraries.');
      process.exit(1);
    }

    saveConfig({ ...cfg, activeCircleId: found.id });
    ui.success(`Active library set to: ${found.name} (${found.id})`);
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// The top-level `groups` command group, and the deprecated `circles` alias
// ---------------------------------------------------------------------------

export function groupsCommand(): Command {
  const cmd = new Command('groups');
  cmd.description('Choose the library uploads go to: "My library" or one of your groups');

  cmd.addCommand(listCmd());
  cmd.addCommand(useCmd());

  return cmd;
}

/** The deprecation notice the hidden `circles` alias prints (on stderr). */
export const CIRCLES_DEPRECATION_NOTICE =
  '`memoriahub circles` is deprecated and will be removed in a future release: use `memoriahub groups`.';

/**
 * `memoriahub circles list|use` — the pre-RETRO-I6 name, hidden from `--help`,
 * kept for one release. Same subcommands; prints {@link CIRCLES_DEPRECATION_NOTICE}.
 */
export function circlesAliasCommand(): Command {
  const cmd = new Command('circles');
  cmd.description('Deprecated: use `memoriahub groups`');
  cmd.hook('preAction', () => {
    process.stderr.write(`${chalk.yellow('warning:')} ${CIRCLES_DEPRECATION_NOTICE}\n`);
  });
  cmd.addCommand(listCmd());
  cmd.addCommand(useCmd());
  return cmd;
}
