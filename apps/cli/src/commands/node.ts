/**
 * commands/node.ts — `memoriahub node` command group.
 *
 * A worker node is a long-lived process that registers with the API, claims
 * enrichment jobs, runs the compute locally, and submits results — so home
 * laptops process the queue alongside the server.
 *
 * Subcommands:
 *   node register   — register this machine as a worker node
 *   node start      — run the claim/compute loop (headless event printer)
 *   node stop       — best-effort signal a running node to drain/stop
 *   node status     — show local config + a one-shot capability table
 *   node list       — list the user's registered nodes (best-effort)
 *   node doctor     — capability + connectivity + model health report
 */

import { createRequire } from 'node:module';
import * as os from 'node:os';
import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { requireConfig, saveConfig, type NodeConfig } from '../config.js';
import { ApiClient, ApiError, type ModelManifestEntry } from '../api.js';
import { ui, isTTY } from '../ui.js';
import {
  detectCapabilities,
  missingRequirements,
  NODE_JOB_TYPES,
  isNodeJobType,
  ComputeDispatcher,
  type CapabilityStatus,
  type NodeJobType,
} from '../node/capabilities.js';
import { ensureModels } from '../node/models.js';
import { NodeEngine, type NodeEngineOptions } from '../node/node-engine.js';
import { NODE_EV } from '../node/node-events.js';

const require = createRequire(import.meta.url);

/** CLI version read from package.json at runtime. */
function cliVersion(): string {
  try {
    const pkg = require('../../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/** Default poll interval when neither flag nor config supplies one. */
const DEFAULT_POLL_MS = 5000;
/** Default worker concurrency. */
const DEFAULT_CONCURRENCY = 1;

/** Parse a comma-separated list of job types, validating each against the set. */
function parseTypes(csv?: string): string[] {
  if (!csv) return [];
  const parts = csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = parts.filter((t) => !isNodeJobType(t));
  if (invalid.length > 0) {
    ui.error(
      `Unknown job type(s): ${invalid.join(', ')}. ` +
        `Valid types: ${NODE_JOB_TYPES.join(', ')}`,
    );
    process.exit(1);
  }
  return parts;
}

/** Job types whose required capabilities are all satisfied by `caps`. */
function supportedTypes(caps: Record<string, CapabilityStatus>): NodeJobType[] {
  return NODE_JOB_TYPES.filter((t) => missingRequirements(t, caps).length === 0);
}

/** Render a capability table to stdout. */
function printCapabilityTable(caps: Record<string, CapabilityStatus>): void {
  const table = new Table({
    head: [chalk.bold('Capability'), chalk.bold('Available'), chalk.bold('Detail')],
    style: { head: [], border: isTTY ? ['dim'] : [] },
  });
  for (const [key, status] of Object.entries(caps)) {
    table.push([
      key,
      status.available ? chalk.green('yes') : chalk.red('no'),
      status.detail ?? '',
    ]);
  }
  process.stdout.write(table.toString() + '\n');
}

// ---------------------------------------------------------------------------
// node register
// ---------------------------------------------------------------------------

function registerCmd(): Command {
  const cmd = new Command('register');
  cmd
    .description('Register this machine as a worker node')
    .option('--name <name>', 'Human-friendly node name (default: hostname)')
    .option('--concurrency <n>', 'Simultaneous jobs to process', String(DEFAULT_CONCURRENCY))
    .option('--types <csv>', 'Comma-separated job types (default: all supported)')
    .action(async (opts: { name?: string; concurrency?: string; types?: string }) => {
      const cfg = requireConfig();
      const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });

      const hostname = os.hostname();
      const name = opts.name ?? hostname;
      const concurrency = Math.max(1, parseInt(opts.concurrency ?? String(DEFAULT_CONCURRENCY), 10) || DEFAULT_CONCURRENCY);

      const caps = await detectCapabilities();
      const requested = parseTypes(opts.types);
      const eligibleTypes = requested.length > 0 ? requested : supportedTypes(caps);

      if (eligibleTypes.length === 0) {
        ui.warn(
          'No job types are supported on this machine (missing native libraries / ffmpeg). ' +
            'Registering with an empty type list — install dependencies and re-register.',
        );
      }

      let res;
      try {
        res = await api.registerNode({
          name,
          hostname,
          platform: os.platform(),
          cliVersion: cliVersion(),
          eligibleTypes,
          concurrency,
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          ui.error('This command requires a token permitted to register worker nodes.');
          process.exit(1);
        }
        ui.error(`Failed to register node: ${(err as Error).message}`);
        process.exit(1);
      }

      const node: NodeConfig = {
        name,
        concurrency,
        eligibleTypes,
        pollIntervalMs: cfg.node?.pollIntervalMs ?? DEFAULT_POLL_MS,
      };
      saveConfig({ ...cfg, nodeId: res.nodeId, node });

      ui.success(`Registered as worker node: ${name} (${res.nodeId})`);
      ui.dim(`Eligible types: ${eligibleTypes.join(', ') || '(none)'}`);
      ui.dim('Run `memoriahub node start` to begin processing jobs.');
    });

  return cmd;
}

// ---------------------------------------------------------------------------
// node start
// ---------------------------------------------------------------------------

function startCmd(): Command {
  const cmd = new Command('start');
  cmd
    .description('Run the worker-node loop (claim → compute → submit)')
    .option('--concurrency <n>', 'Override configured concurrency')
    .option('--types <csv>', 'Override configured job types')
    .option('--poll <ms>', 'Override poll interval (ms) when idle')
    .action(async (opts: { concurrency?: string; types?: string; poll?: string }) => {
      const cfg = requireConfig();
      if (!cfg.nodeId) {
        ui.error('This machine is not registered. Run `memoriahub node register` first.');
        process.exit(1);
      }
      const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });

      const concurrency = Math.max(
        1,
        parseInt(opts.concurrency ?? String(cfg.node?.concurrency ?? DEFAULT_CONCURRENCY), 10) ||
          DEFAULT_CONCURRENCY,
      );
      const requested = parseTypes(opts.types);
      const eligibleTypes =
        requested.length > 0 ? requested : cfg.node?.eligibleTypes ?? [...NODE_JOB_TYPES];
      const pollIntervalMs =
        parseInt(opts.poll ?? String(cfg.node?.pollIntervalMs ?? DEFAULT_POLL_MS), 10) ||
        DEFAULT_POLL_MS;

      // 1. Ensure models are present before processing.
      try {
        const manifest = await api.getModelManifest();
        if (manifest.length > 0) {
          ui.step(`Ensuring ${manifest.length} model file(s)…`);
          const modelRes = await ensureModels(manifest);
          ui.success(
            `Models ready in ${modelRes.targetDir} ` +
              `(${modelRes.downloaded.length} downloaded, ${modelRes.present.length} present` +
              `${modelRes.failed.length > 0 ? `, ${modelRes.failed.length} failed` : ''})`,
          );
          for (const f of modelRes.failed) {
            ui.warn(`Model ${f.name} failed: ${f.error}`);
          }
        }
      } catch (err) {
        ui.warn(
          `Could not fetch/ensure model manifest: ${(err as Error).message}. ` +
            'Continuing — jobs needing local models may fail.',
        );
      }

      // 2. Build and run the engine.
      const options: NodeEngineOptions = { concurrency, eligibleTypes, pollIntervalMs };
      const engine = new NodeEngine({
        api,
        dispatcher: new ComputeDispatcher(),
        nodeId: cfg.nodeId,
        options,
      });

      attachHeadlessPrinter(engine);

      let stopping = false;
      const onSignal = (): void => {
        if (stopping) return;
        stopping = true;
        ui.blank();
        ui.info('Draining — finishing in-flight jobs, then deregistering…');
        void engine.stop('signal');
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);

      ui.step(
        `Worker node online — concurrency ${concurrency}, ` +
          `types [${eligibleTypes.join(', ')}], poll ${pollIntervalMs}ms. Ctrl-C to stop.`,
      );

      await engine.start();
    });

  return cmd;
}

/** Subscribe a plain structured-line printer to engine events (headless mode). */
function attachHeadlessPrinter(engine: NodeEngine): void {
  engine.on(NODE_EV.CLAIMED, (p) => ui.info(`claimed ${p.count} job(s)`));
  engine.on(NODE_EV.JOB_START, (p) =>
    ui.step(`job ${p.jobId} (${p.type}) started`),
  );
  engine.on(NODE_EV.JOB_PROGRESS, (p) =>
    ui.dim(`job ${p.jobId} progress ${(p.fraction * 100).toFixed(0)}%`),
  );
  engine.on(NODE_EV.JOB_DONE, (p) =>
    ui.success(
      `job ${p.jobId} (${p.type}) done in ${p.durationMs}ms` +
        (p.submitted ? '' : ' [result endpoint not yet available]'),
    ),
  );
  engine.on(NODE_EV.JOB_ERROR, (p) =>
    ui.error(`job ${p.jobId} (${p.type}) failed: ${p.error}`),
  );
  engine.on(NODE_EV.IDLE, (p) => ui.dim(`idle — next poll in ${p.pollIntervalMs}ms`));
  engine.on(NODE_EV.HEARTBEAT_OK, (p) => ui.dim(`heartbeat ok @ ${p.at}`));
  engine.on(NODE_EV.HEARTBEAT_FAIL, (p) => ui.warn(p.error));
  engine.on(NODE_EV.LEASE_RENEW, (p) => ui.dim(`lease renewed for ${p.jobId}`));
  engine.on(NODE_EV.MODEL_LOADED, (p) =>
    ui.info(`models loaded from ${p.targetDir} (${p.downloaded} downloaded, ${p.present} present)`),
  );
  engine.on(NODE_EV.STOPPED, (p) => ui.info(`node stopped (${p.reason})`));
}

// ---------------------------------------------------------------------------
// node stop
// ---------------------------------------------------------------------------

function stopCmd(): Command {
  const cmd = new Command('stop');
  cmd
    .description('Best-effort signal a running worker node to drain and stop')
    .action(async () => {
      const cfg = requireConfig();
      if (!cfg.nodeId) {
        ui.error('This machine is not registered as a worker node.');
        process.exit(1);
      }
      const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });

      // Single-process model: there is no local IPC to a running `start`. We
      // deregister server-side so no new jobs are dispatched to this node; the
      // running `start` process must be stopped with Ctrl-C to drain in-flight
      // work and deregister cleanly.
      try {
        await api.deregisterNode(cfg.nodeId);
        ui.success('Node deregistered server-side (no new jobs will be dispatched).');
      } catch (err) {
        ui.warn(`Could not deregister node server-side: ${(err as Error).message}`);
      }
      ui.info('If a `memoriahub node start` process is running here, press Ctrl-C to stop it.');
    });

  return cmd;
}

// ---------------------------------------------------------------------------
// node status
// ---------------------------------------------------------------------------

function statusCmd(): Command {
  const cmd = new Command('status');
  cmd
    .description('Show this machine\'s node config and current capabilities')
    .action(async () => {
      const cfg = requireConfig();

      ui.blank();
      ui.step('Worker node configuration');
      ui.line(`  Node ID       : ${cfg.nodeId ?? chalk.dim('(not registered)')}`);
      ui.line(`  Name          : ${cfg.node?.name ?? chalk.dim('(unset)')}`);
      ui.line(`  Concurrency   : ${cfg.node?.concurrency ?? DEFAULT_CONCURRENCY}`);
      ui.line(`  Poll interval : ${cfg.node?.pollIntervalMs ?? DEFAULT_POLL_MS}ms`);
      ui.line(`  Eligible types: ${cfg.node?.eligibleTypes?.join(', ') ?? chalk.dim('(all)')}`);
      ui.blank();

      ui.step('Detected capabilities');
      const caps = await detectCapabilities();
      printCapabilityTable(caps);

      // Best-effort: fetch last-known server-side status if the API exposes it.
      if (cfg.nodeId) {
        const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });
        try {
          const server = await api.get<unknown>(
            `/api/nodes/${encodeURIComponent(cfg.nodeId)}`,
          );
          ui.blank();
          ui.step('Server-side status');
          ui.line(JSON.stringify(server, null, 2));
        } catch {
          // No per-node GET, insufficient permission, or offline — local config only.
        }
      }
    });

  return cmd;
}

// ---------------------------------------------------------------------------
// node list
// ---------------------------------------------------------------------------

function listCmd(): Command {
  const cmd = new Command('list');
  cmd.description('List registered worker nodes (best-effort)').action(async () => {
    const cfg = requireConfig();
    const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });

    try {
      const res = await api.get<unknown>('/api/nodes');
      const nodes = Array.isArray(res)
        ? (res as Array<Record<string, unknown>>)
        : ((res as { items?: Array<Record<string, unknown>> })?.items ?? []);

      if (nodes.length === 0) {
        ui.info('No worker nodes registered.');
        return;
      }

      const table = new Table({
        head: [chalk.bold('ID'), chalk.bold('Name'), chalk.bold('Status'), chalk.bold('Platform')],
        style: { head: [], border: isTTY ? ['dim'] : [] },
      });
      for (const n of nodes) {
        table.push([
          String(n['id'] ?? n['nodeId'] ?? ''),
          String(n['name'] ?? ''),
          String(n['status'] ?? ''),
          String(n['platform'] ?? ''),
        ]);
      }
      ui.blank();
      process.stdout.write(table.toString() + '\n');
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        ui.warn(
          'Listing worker nodes is not available with this token (or the endpoint is not exposed). ' +
            'Showing local config only.',
        );
        ui.line(`  This node: ${cfg.nodeId ?? '(not registered)'} — ${cfg.node?.name ?? ''}`);
        return;
      }
      ui.error(`Failed to list nodes: ${(err as Error).message}`);
      process.exit(1);
    }
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// node doctor
// ---------------------------------------------------------------------------

function doctorCmd(): Command {
  const cmd = new Command('doctor');
  cmd
    .description('Diagnose worker-node capabilities, connectivity, and models')
    .action(async () => {
      const cfg = requireConfig();
      const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });
      let hasError = false;

      // 1. Connectivity
      ui.step('Connectivity');
      try {
        await api.get<unknown>('/api/auth/me');
        ui.success(`Connected to ${cfg.serverUrl} (token valid).`);
      } catch (err) {
        hasError = true;
        ui.error(`Cannot reach API / token invalid: ${(err as Error).message}`);
      }
      ui.blank();

      // 2. Capabilities
      ui.step('Capabilities');
      const caps = await detectCapabilities();
      printCapabilityTable(caps);
      ui.blank();

      // 3. Required-capability check for eligible types
      ui.step('Job-type readiness');
      const eligibleTypes =
        cfg.node?.eligibleTypes && cfg.node.eligibleTypes.length > 0
          ? cfg.node.eligibleTypes.filter(isNodeJobType)
          : supportedTypes(caps);
      if (eligibleTypes.length === 0) {
        ui.warn('No eligible job types configured/supported on this machine.');
      }
      for (const t of eligibleTypes) {
        const missing = missingRequirements(t, caps);
        if (missing.length === 0) {
          ui.success(`${t}: ready`);
        } else {
          hasError = true;
          ui.error(`${t}: missing required capability → ${missing.join(', ')}`);
        }
      }
      ui.blank();

      // 4. Model presence
      ui.step('Models');
      try {
        const manifest = await api.getModelManifest();
        if (manifest.length === 0) {
          ui.info('Server manifest lists no model files.');
        } else {
          const res = await ensureModels(manifest);
          if (res.failed.length > 0) {
            hasError = true;
            for (const f of res.failed) ui.error(`Model ${f.name}: ${f.error}`);
          } else {
            ui.success(
              `All ${manifest.length} model file(s) present/downloaded in ${res.targetDir}.`,
            );
          }
        }
      } catch (err) {
        ui.warn(`Could not verify models: ${(err as Error).message}`);
      }
      ui.blank();

      if (hasError) {
        ui.error('Doctor found problems — this node cannot fully process its eligible types.');
        process.exit(1);
      }
      ui.success('Doctor: all checks passed.');
    });

  return cmd;
}

// ---------------------------------------------------------------------------
// Top-level `node` command group
// ---------------------------------------------------------------------------

export function nodeCommand(): Command {
  const cmd = new Command('node');
  cmd.description('Run this machine as a worker node that processes the enrichment queue');

  cmd.addCommand(registerCmd());
  cmd.addCommand(startCmd());
  cmd.addCommand(stopCmd());
  cmd.addCommand(statusCmd());
  cmd.addCommand(listCmd());
  cmd.addCommand(doctorCmd());

  return cmd;
}
