/**
 * commands/workflow.ts — `memoriahub workflow` command group (issue #144).
 *
 * A THIN, PAT-authed, circle-scoped convenience surface for headless operation.
 * The web UI is the primary way to author and manage Media Workflow Automation;
 * these subcommands only cover the three most useful headless actions:
 *
 *   workflow list            — list workflows in the active (or --circle) circle
 *   workflow run <id>        — start a run for a workflow
 *   workflow runs <id>       — list recent runs for a workflow
 *
 * All subcommands require login (requireConfig).
 */

import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import { requireConfig } from '../config.js';
import { ApiClient } from '../api.js';
import { ui, isTTY } from '../ui.js';

/** Resolve the circle to scope to: explicit --circle wins, else the active one. */
function resolveCircleId(explicit: string | undefined): string {
  const cfg = requireConfig();
  const circleId = explicit ?? cfg.activeCircleId;
  if (!circleId) {
    ui.error(
      'No circle specified. Pass --circle <id> or set an active circle with `memoriahub circles use <id>`.',
    );
    process.exit(1);
  }
  return circleId;
}

// ---------------------------------------------------------------------------
// workflow list
// ---------------------------------------------------------------------------

function listCmd(): Command {
  const cmd = new Command('list');
  cmd
    .description('List workflows in a circle')
    .option('-c, --circle <id>', 'Circle ID (defaults to the active circle)');

  cmd.action(async (opts: { circle?: string }) => {
    const circleId = resolveCircleId(opts.circle);
    const cfg = requireConfig();
    const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });

    let workflows;
    try {
      workflows = await api.listWorkflows(circleId);
    } catch (err) {
      ui.error(`Failed to fetch workflows: ${(err as Error).message}`);
      process.exit(1);
    }

    if (workflows.length === 0) {
      ui.info('No workflows found in this circle. Create one on the web app first.');
      return;
    }

    const table = new Table({
      head: [
        chalk.bold('ID'),
        chalk.bold('Name'),
        chalk.bold('Subject'),
        chalk.bold('Trigger'),
        chalk.bold('Enabled'),
      ],
      colWidths: [38, 28, 12, 16, 9],
      wordWrap: true,
      style: { head: [], border: isTTY ? ['dim'] : [] },
    });

    for (const w of workflows) {
      table.push([
        w.id,
        w.name,
        w.subjectType,
        w.trigger,
        w.enabled ? chalk.green('yes') : chalk.dim('no'),
      ]);
    }

    ui.blank();
    process.stdout.write(table.toString() + '\n');
    ui.blank();
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// workflow run <id>
// ---------------------------------------------------------------------------

function runCmd(): Command {
  const cmd = new Command('run');
  cmd
    .description('Start a run for a workflow')
    .argument('<id>', 'Workflow ID to run')
    .option('--max-items <n>', 'Optional cap on the number of items processed', (v) =>
      parseInt(v, 10),
    );

  cmd.action(async (id: string, opts: { maxItems?: number }) => {
    const cfg = requireConfig();
    const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });

    const body: { maxItems?: number } = {};
    if (typeof opts.maxItems === 'number' && !Number.isNaN(opts.maxItems)) {
      body.maxItems = opts.maxItems;
    }

    let result;
    try {
      result = await api.runWorkflow(id, body);
    } catch (err) {
      ui.error(`Failed to start run: ${(err as Error).message}`);
      process.exit(1);
    }

    ui.success(`Run started: ${result.runId} (status: ${result.status})`);
    ui.info('Track progress with `memoriahub workflow runs ' + id + '` or in the web app.');
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// workflow runs <id>
// ---------------------------------------------------------------------------

function runsCmd(): Command {
  const cmd = new Command('runs');
  cmd
    .description('List recent runs for a workflow')
    .argument('<id>', 'Workflow ID');

  cmd.action(async (id: string) => {
    const cfg = requireConfig();
    const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });

    let runs;
    try {
      runs = await api.listWorkflowRuns(id);
    } catch (err) {
      ui.error(`Failed to fetch runs: ${(err as Error).message}`);
      process.exit(1);
    }

    if (runs.length === 0) {
      ui.info('No runs found for this workflow.');
      return;
    }

    const table = new Table({
      head: [
        chalk.bold('Run ID'),
        chalk.bold('Status'),
        chalk.bold('Trigger'),
        chalk.bold('Matched'),
        chalk.bold('OK'),
        chalk.bold('Fail'),
        chalk.bold('Skip'),
        chalk.bold('Created'),
      ],
      colWidths: [38, 22, 12, 9, 6, 6, 6, 22],
      wordWrap: true,
      style: { head: [], border: isTTY ? ['dim'] : [] },
    });

    for (const r of runs) {
      table.push([
        r.id,
        r.status,
        r.triggerType,
        String(r.matchedCount),
        String(r.succeededCount),
        String(r.failedCount),
        String(r.skippedCount),
        new Date(r.createdAt).toLocaleString(),
      ]);
    }

    ui.blank();
    process.stdout.write(table.toString() + '\n');
    ui.blank();
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// Export the top-level `workflow` command group
// ---------------------------------------------------------------------------

export function workflowCommand(): Command {
  const cmd = new Command('workflow');
  cmd.description('List and run Media Workflow Automation workflows');

  cmd.addCommand(listCmd());
  cmd.addCommand(runCmd());
  cmd.addCommand(runsCmd());

  return cmd;
}
