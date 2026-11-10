/**
 * extensions/node-list.ts - `memoriahub node list` (RETRO-C10, #616).
 *
 * The platform `node` group has no `list`; the platform API does serve `GET /api/nodes` (the nodes
 * the caller owns). This subcommand is attached to the platform's `node` command after the
 * built-ins are registered, with the 1.3 output. A server or token that cannot list falls back to
 * what this machine knows.
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { ApiClient, ApiError } from '../api.js';
import { requireConfig } from '../config.js';
import { isTTY, ui } from '../ui.js';

/** Pulls the node rows out of either envelope the API has answered with. */
export function nodeRows(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  const items = (res as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
}

export const APP_NODE_LIST_COMMAND: CliCommandRegistration = (program: Command) => {
  const node = program.commands.find((c) => c.name() === 'node');
  if (node === undefined) return;
  node
    .command('list')
    .description('List the worker nodes you own')
    .action(async () => {
      const cfg = requireConfig();
      const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });
      try {
        const nodes = nodeRows(await api.get<unknown>('/api/nodes'));
        if (nodes.length === 0) {
          ui.info('No worker nodes registered.');
          return;
        }
        const table = new Table({
          head: [chalk.bold('ID'), chalk.bold('Name'), chalk.bold('Status'), chalk.bold('Platform')],
          style: { head: [], border: isTTY ? ['dim'] : [] },
        });
        for (const n of nodes) {
          table.push([String(n['id'] ?? n['nodeId'] ?? ''), String(n['name'] ?? ''), String(n['status'] ?? ''), String(n['platform'] ?? '')]);
        }
        ui.blank();
        process.stdout.write(`${table.toString()}\n`);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          ui.warn('Listing worker nodes is not available with this token. Showing local config only.');
          ui.line(`  This node: ${cfg.nodeId ?? '(not registered)'} - ${cfg.node?.name ?? ''}`);
          return;
        }
        ui.error(`Failed to list nodes: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
};
