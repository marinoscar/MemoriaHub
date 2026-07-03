/**
 * commands/reports.ts — `memoriahub reports` command group.
 *
 * Subcommands:
 *   reports list [--json]        List available reports (id, label, description)
 *   reports show <id> [--json]   Run one report and print it as a table or JSON
 *
 * Reports are defined in the shared registry (`src/reports/`) so the headless
 * CLI and the interactive TUI render exactly the same data.
 */

import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import { getDb } from '../db/database.js';
import { ui, isTTY } from '../ui.js';
import { REPORTS, getReport } from '../reports/registry.js';

// ---------------------------------------------------------------------------
// reports list
// ---------------------------------------------------------------------------

function listCmd(): Command {
  const cmd = new Command('list');
  cmd
    .description('List the available reports')
    .option('--json', 'Output structured JSON', false);

  cmd.action((opts: { json: boolean }) => {
    if (opts.json) {
      const out = REPORTS.map((r) => ({
        id: r.id,
        label: r.label,
        description: r.description,
      }));
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return;
    }

    const table = new Table({
      head: [chalk.bold('ID'), chalk.bold('Label'), chalk.bold('Description')],
      wordWrap: true,
      style: { head: [], border: isTTY ? ['dim'] : [] },
    });

    for (const r of REPORTS) {
      table.push([r.id, r.label, r.description]);
    }

    ui.blank();
    ui.step('Available Reports');
    ui.blank();
    process.stdout.write(table.toString() + '\n');
    ui.blank();
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// reports show <id>
// ---------------------------------------------------------------------------

function showCmd(): Command {
  const cmd = new Command('show');
  cmd
    .description('Run a single report and print its results')
    .argument('<id>', 'Report id (see `memoriahub reports list`)')
    .option('--json', 'Output structured JSON', false);

  cmd.action((id: string, opts: { json: boolean }) => {
    const report = getReport(id);
    if (!report) {
      ui.error(`Unknown report: ${id}. Run \`memoriahub reports list\`.`);
      process.exit(1);
    }

    const db = getDb();
    const result = report.compute({ db });

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            id: report.id,
            label: report.label,
            columns: result.columns,
            rows: result.rows,
            summary: result.summary,
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }

    ui.blank();
    ui.step(report.label);
    ui.blank();

    const table = new Table({
      head: result.columns.map((c) => chalk.bold(c)),
      wordWrap: true,
      style: { head: [], border: isTTY ? ['dim'] : [] },
    });
    for (const row of result.rows) {
      table.push(row.map((cell) => String(cell)));
    }
    process.stdout.write(table.toString() + '\n');

    if (result.summary) {
      ui.blank();
      ui.dim(result.summary);
    }
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// Export the top-level `reports` command group
// ---------------------------------------------------------------------------

export function reportsCommand(): Command {
  const cmd = new Command('reports');
  cmd.description('Run extensible sync/storage reports from local state');

  cmd.addCommand(listCmd());
  cmd.addCommand(showCmd());

  cmd.addHelpText(
    'after',
    `
Examples:
  $ memoriahub reports list
  $ memoriahub reports show overview
  $ memoriahub reports show storage --json
  $ memoriahub reports show duplicates
`,
  );

  return cmd;
}
