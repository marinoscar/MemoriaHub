/**
 * commands/node.ts — `memoriahub node` command group.
 *
 * A worker node is a long-lived process that registers with the API, claims
 * enrichment jobs, runs the compute locally, and submits results — so home
 * laptops process the queue alongside the server.
 *
 * Subcommands:
 *   node register        — register this machine as a worker node
 *   node start           — run the claim/compute loop; always hosts the IPC
 *                          socket + file logging; --daemon detaches
 *   node stop            — stop a running node: IPC → SIGTERM → server-side
 *   node status          — live snapshot via IPC when running, else local
 *   node logs            — print/tail the JSONL worker log
 *   node set-concurrency — adjust concurrency live (IPC) or in config
 *   node service         — install/uninstall/status of the systemd user unit
 *   node list            — list the user's registered nodes (best-effort)
 *   node doctor          — capability + connectivity + model health report
 */

import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { requireConfig, saveConfig, loadConfig, type NodeConfig } from '../config.js';
import { ApiClient, ApiError, type ModelManifestEntry } from '../api.js';
import { ui, isTTY } from '../ui.js';
import { logsDir, nodePidPath } from '../paths.js';
import {
  detectCapabilities,
  missingRequirements,
  NODE_JOB_TYPES,
  isNodeJobType,
  ComputeDispatcher,
  DEFAULT_COMPREFACE_URL,
  type CapabilityStatus,
  type NodeJobType,
} from '../node/capabilities.js';
import { ensureModels } from '../node/models.js';
import { runOperationalSelfTests } from '../node/self-test.js';
import { runApiAccessChecks, checkDaemonLiveness } from '../node/doctor-checks.js';
import {
  summarizeCapabilities,
  summarizeJobReadiness,
  apiAccessLevel,
  WORKER_NODE_SETUP_GUIDE_URL,
  type CapabilityRowSummary,
} from '../node/doctor-summary.js';
import {
  NodeEngine,
  type NodeEngineOptions,
  type EngineSnapshot,
} from '../node/node-engine.js';
import { NODE_EV } from '../node/node-events.js';
import {
  createNodeLogger,
  attachEngineLogging,
  readLastLines,
  followLog,
  nodeLogPath,
} from '../node/logger.js';
import { startDaemonHost, readPidFile, isPidAlive } from '../node/daemon.js';
import { connectToDaemon, isDaemonRunning, type DaemonMessage } from '../node/ipc-client.js';
import { checkNodeAlreadyRunning } from '../node/daemon-launch.js';
import {
  detectLinuxDistro,
  ensureNpmNativeDeps,
  ensureFfmpeg,
  ensureTesseractLanguageData,
  ensureModelsIfConfigured,
  ensureDocker,
  ensureComprefaceContainer,
  verifyCompreface,
  type InstallStepResult,
  type ComprefaceContainerOptions,
} from '../node/install-deps.js';

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
function supportedTypes(
  caps: Record<string, CapabilityStatus>,
  faceProvider: 'human' | 'compreface' = 'human',
): NodeJobType[] {
  return NODE_JOB_TYPES.filter((t) => missingRequirements(t, caps, faceProvider).length === 0);
}

/** Validate --face-provider, exiting with a clear error on an unknown value. */
function parseFaceProvider(value: string | undefined): 'human' | 'compreface' | undefined {
  if (value === undefined) return undefined;
  if (value === 'human' || value === 'compreface') return value;
  ui.error(`Unknown --face-provider value: ${value}. Valid values: human, compreface`);
  process.exit(1);
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

/**
 * Render the combined installed-vs-operational capability table used by
 * `node doctor`. "Installed" is the require.resolve presence probe from
 * `detectCapabilities()`; "Operational" is the real self-test result from
 * `runOperationalSelfTests()` — a capability can be installed but not (yet)
 * operational (e.g. a model file not downloaded yet), which is not an error,
 * just not-ready-yet, so it renders yellow rather than red.
 *
 * Takes pre-classified/pre-filtered rows from `summarizeCapabilities()`
 * (`node/doctor-summary.ts`) rather than the raw capability maps, so the
 * caller decides which rows are worth a table row (e.g. issues-only) without
 * this function needing to know about that policy.
 */
function printOperationalCapabilityTable(rows: CapabilityRowSummary[]): void {
  const table = new Table({
    head: [
      chalk.bold('Capability'),
      chalk.bold('Installed'),
      chalk.bold('Operational'),
      chalk.bold('Detail'),
    ],
    style: { head: [], border: isTTY ? ['dim'] : [] },
  });
  for (const row of rows) {
    const { installed, operational } = row;
    let operationalCell: string;
    if (!installed.available) {
      operationalCell = chalk.dim('n/a');
    } else if (operational.available) {
      operationalCell = chalk.green('yes');
    } else {
      operationalCell = chalk.yellow('not yet');
    }
    table.push([
      row.key,
      installed.available ? chalk.green('yes') : chalk.red('no'),
      operationalCell,
      operational.detail ?? installed.detail ?? '',
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
    .option('--face-provider <human|compreface>', 'Face-detection provider this node uses (default: human)')
    .option(
      '--compreface-url <url>',
      'Base URL of a locally-running compreface-core sidecar (only used with --face-provider compreface)',
    )
    .action(
      async (opts: {
        name?: string;
        concurrency?: string;
        types?: string;
        faceProvider?: string;
        comprefaceUrl?: string;
      }) => {
        const cfg = requireConfig();
        const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });

        const hostname = os.hostname();
        const name = opts.name ?? hostname;
        const concurrency = Math.max(1, parseInt(opts.concurrency ?? String(DEFAULT_CONCURRENCY), 10) || DEFAULT_CONCURRENCY);
        const faceProvider = parseFaceProvider(opts.faceProvider) ?? 'human';
        const comprefaceUrl = opts.comprefaceUrl;

        const caps = await detectCapabilities({ comprefaceUrl });
        const requested = parseTypes(opts.types);
        const eligibleTypes = requested.length > 0 ? requested : supportedTypes(caps, faceProvider);

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
          faceProvider,
          comprefaceUrl,
        };
        saveConfig({ ...cfg, nodeId: res.nodeId, node });

        ui.success(`Registered as worker node: ${name} (${res.nodeId})`);
        ui.dim(`Eligible types: ${eligibleTypes.join(', ') || '(none)'}`);
        if (faceProvider === 'compreface') {
          ui.dim(`Face provider: compreface (${comprefaceUrl ?? DEFAULT_COMPREFACE_URL})`);
        }
        ui.dim('Run `memoriahub node start` to begin processing jobs.');
      },
    );

  return cmd;
}

// ---------------------------------------------------------------------------
// node start
// ---------------------------------------------------------------------------

function startCmd(): Command {
  const cmd = new Command('start');
  cmd
    .description('Run the worker-node loop (claim → compute → submit)')
    .option('--concurrency <n>', 'Set concurrency (persisted to config)')
    .option('--types <csv>', 'Override configured job types')
    .option('--poll <ms>', 'Override poll interval (ms) when idle')
    .option('--daemon', 'Detach and run in the background (logs under ~/.memoriahub/logs)')
    .option('--face-provider <human|compreface>', 'Set face-detection provider (persisted to config)')
    .option(
      '--compreface-url <url>',
      'Set the compreface-core sidecar URL (persisted to config; only used with --face-provider compreface)',
    )
    .action(
      async (opts: {
        concurrency?: string;
        types?: string;
        poll?: string;
        daemon?: boolean;
        faceProvider?: string;
        comprefaceUrl?: string;
      }) => {
        const cfg = requireConfig();
        if (!cfg.nodeId) {
          ui.error('This machine is not registered. Run `memoriahub node register` first.');
          process.exit(1);
        }

        // Refuse a second instance up front (pidfile OR live IPC socket).
        const alreadyRunning = await checkNodeAlreadyRunning();
        if (alreadyRunning.running && alreadyRunning.via === 'pidfile') {
          ui.error(
            `A worker node is already running (pid ${alreadyRunning.pid}). ` +
              'Use `memoriahub node status` or `memoriahub node stop`.',
          );
          process.exit(1);
        }
        if (alreadyRunning.running && alreadyRunning.via === 'ipc') {
          ui.error(
            'A worker node is already running (IPC socket is live). ' +
              'Use `memoriahub node status` or `memoriahub node stop`.',
          );
          process.exit(1);
        }

        const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });

        const concurrency = Math.max(
          1,
          parseInt(opts.concurrency ?? String(cfg.node?.concurrency ?? DEFAULT_CONCURRENCY), 10) ||
            DEFAULT_CONCURRENCY,
        );
        const validatedFaceProvider = parseFaceProvider(opts.faceProvider);

        // --concurrency / --face-provider / --compreface-url persist to
        // NodeConfig so restarts (and the daemon child spawned below) pick
        // them up. Only the fields actually passed on this invocation are
        // written — an omitted flag must never clobber a previously-
        // persisted value with undefined.
        if (
          opts.concurrency !== undefined ||
          validatedFaceProvider !== undefined ||
          opts.comprefaceUrl !== undefined
        ) {
          saveConfig({
            ...cfg,
            node: {
              ...cfg.node,
              ...(opts.concurrency !== undefined ? { concurrency } : {}),
              ...(validatedFaceProvider !== undefined ? { faceProvider: validatedFaceProvider } : {}),
              ...(opts.comprefaceUrl !== undefined ? { comprefaceUrl: opts.comprefaceUrl } : {}),
            },
          });
        }

        // --daemon: re-spawn ourselves detached and exit. The child runs this
        // same command minus --daemon, so it hosts the IPC socket + logging.
        if (opts.daemon) {
          const outPath = path.join(logsDir(), 'node.out.log');
          const logFd = fs.openSync(outPath, 'a');
          const args = process.argv.slice(2).filter((a) => a !== '--daemon');
          const child = spawn(process.execPath, [process.argv[1], ...args], {
            detached: true,
            stdio: ['ignore', logFd, logFd],
          });
          child.unref();
          fs.closeSync(logFd);
          ui.success(`Worker node daemon started (pid ${child.pid}).`);
          ui.dim(`Structured log : ${nodeLogPath()}`);
          ui.dim(`Process output : ${outPath}`);
          ui.dim('Manage it with `memoriahub node status|logs|set-concurrency|stop`.');
          return;
        }
        const requested = parseTypes(opts.types);
        const eligibleTypes =
          requested.length > 0 ? requested : cfg.node?.eligibleTypes ?? [...NODE_JOB_TYPES];
        const pollIntervalMs =
          parseInt(opts.poll ?? String(cfg.node?.pollIntervalMs ?? DEFAULT_POLL_MS), 10) ||
          DEFAULT_POLL_MS;

        // Resolve the effective face provider (flag > persisted config > default)
        // and, when it is CompreFace and this node claims face jobs, BLOCK until
        // the sidecar's /status reports healthy before building the engine. This
        // closes the warm-up race (issue #103): CompreFace takes ~15–30s to load
        // its model, and claiming face jobs before then would run them on the
        // wrong provider. We never silently fall back to Human — an unready
        // sidecar is a hard start failure.
        const resolvedFaceProvider: 'human' | 'compreface' =
          validatedFaceProvider ?? cfg.node?.faceProvider ?? 'human';
        const resolvedComprefaceUrl =
          opts.comprefaceUrl ?? cfg.node?.comprefaceUrl ?? DEFAULT_COMPREFACE_URL;
        const claimsFaceJobs =
          eligibleTypes.includes('face_detection') ||
          eligibleTypes.includes('video_face_detection');

        if (resolvedFaceProvider === 'compreface' && claimsFaceJobs) {
          ui.step(
            `Face provider is 'compreface' — waiting for the sidecar at ${resolvedComprefaceUrl} ` +
              'to become healthy before claiming face jobs…',
          );
          // ~40s budget (20 × 2s) to cover CompreFace's cold-start model load.
          const health = await verifyCompreface(resolvedComprefaceUrl, {
            retries: 20,
            retryDelayMs: 2000,
          });
          if (health.status !== 'installed') {
            ui.error(
              `CompreFace at ${resolvedComprefaceUrl} did not become healthy: ${health.detail}\n` +
                'Refusing to start rather than silently falling back to the Human provider. ' +
                'Start/verify the sidecar (`memoriahub node install-deps`) and retry, ' +
                'or start with `--face-provider human`.',
            );
            process.exit(1);
          }
          ui.success(`CompreFace healthy at ${resolvedComprefaceUrl}.`);
        }
        ui.info(
          `Active face provider: ${resolvedFaceProvider}` +
            (resolvedFaceProvider === 'compreface' ? ` (${resolvedComprefaceUrl})` : ''),
        );

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

        // 2. Build the engine with file logging and the IPC daemon host, so
        //    every run (foreground or daemonized) is attachable by a second
        //    CLI instance.
        const options: NodeEngineOptions = {
          concurrency,
          eligibleTypes,
          pollIntervalMs,
          faceProvider: resolvedFaceProvider,
          ...(resolvedFaceProvider === 'compreface'
            ? { comprefaceUrl: resolvedComprefaceUrl }
            : {}),
        };
        const engine = new NodeEngine({
          api,
          dispatcher: new ComputeDispatcher(),
          nodeId: cfg.nodeId,
          options,
        });

        const logger = createNodeLogger();
        attachEngineLogging(logger, engine);
        attachHeadlessPrinter(engine);

        let host;
        try {
          host = await startDaemonHost(engine, logger);
        } catch (err) {
          ui.error(`Cannot start worker node: ${(err as Error).message}`);
          process.exit(1);
        }

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
        ui.dim(`Log: ${logger.logPath}`);
        ui.dim(`IPC: ${host.socketPath}`);

        await engine.start();
      },
    );

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
    .description('Stop a running worker node (IPC → SIGTERM → server-side deregister)')
    .action(async () => {
      // 1. Preferred path: graceful stop over the IPC socket — drains
      //    in-flight jobs and deregisters server-side.
      if (await isDaemonRunning()) {
        try {
          const client = await connectToDaemon();
          const closed = new Promise<void>((resolve) => client.onClose(resolve));
          client.send({ cmd: 'stop' });
          await client.waitFor((m) => m.kind === 'ack' && m['cmd'] === 'stop', 15_000);
          // Wait for the daemon to actually go away (socket close) — bounded.
          await Promise.race([
            closed,
            new Promise<void>((resolve) => setTimeout(resolve, 15_000).unref?.()),
          ]);
          client.close();
          ui.success('Worker node stopped via IPC (drained and deregistered).');
          return;
        } catch (err) {
          ui.warn(`IPC stop failed: ${(err as Error).message} — trying SIGTERM…`);
        }
      }

      // 2. Fallback: SIGTERM via the pidfile — the start command's signal
      //    handler drains and deregisters.
      const pidInfo = readPidFile(nodePidPath());
      if (pidInfo && isPidAlive(pidInfo.pid)) {
        try {
          process.kill(pidInfo.pid, 'SIGTERM');
          ui.success(
            `Sent SIGTERM to worker node (pid ${pidInfo.pid}) — it will drain and deregister.`,
          );
          return;
        } catch (err) {
          ui.warn(`Could not signal pid ${pidInfo.pid}: ${(err as Error).message}`);
        }
      }

      // 3. Last resort: no local process found — deregister server-side so no
      //    new jobs are dispatched to this node.
      ui.info('No local worker node process found — falling back to server-side deregister.');
      const cfg = requireConfig();
      if (!cfg.nodeId) {
        ui.error('This machine is not registered as a worker node.');
        process.exit(1);
      }
      const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });
      try {
        await api.deregisterNode(cfg.nodeId);
        ui.success('Node deregistered server-side (no new jobs will be dispatched).');
      } catch (err) {
        ui.warn(`Could not deregister node server-side: ${(err as Error).message}`);
      }
    });

  return cmd;
}

// ---------------------------------------------------------------------------
// node status
// ---------------------------------------------------------------------------

/** Human-friendly duration, e.g. "2h 13m" / "45s". */
function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Render a live EngineSnapshot received over IPC. */
function renderSnapshot(snap: EngineSnapshot): void {
  ui.blank();
  ui.step('Worker node — live status (via IPC)');
  const uptime = snap.startedAt ? fmtDuration(Date.now() - Date.parse(snap.startedAt)) : '?';
  const hbAge =
    snap.lastHeartbeatAt != null
      ? `${fmtDuration(Date.now() - Date.parse(snap.lastHeartbeatAt))} ago`
      : chalk.yellow('never');
  ui.line(`  Node ID       : ${snap.nodeId}`);
  ui.line(`  Uptime        : ${uptime}`);
  ui.line(`  State         : ${snap.draining ? chalk.yellow('draining') : chalk.green('online')}`);
  const inFlight = snap.activeJobs.length;
  const idle = Math.max(0, snap.concurrency - inFlight);
  ui.line(
    `  Concurrency   : ${snap.concurrency} configured cap, ` +
      `${inFlight} in-flight, ${idle} idle`,
  );
  ui.line(`  Eligible types: ${snap.eligibleTypes.join(', ') || '(none)'}`);
  ui.line(
    `  Face provider : ${snap.faceProvider}` +
      (snap.faceProvider === 'compreface' && snap.comprefaceUrl ? ` (${snap.comprefaceUrl})` : ''),
  );
  ui.line(`  Last heartbeat: ${hbAge}`);
  ui.line(
    `  Jobs          : ${snap.counters.claimed} claimed, ` +
      `${chalk.green(`${snap.counters.succeeded} succeeded`)}, ` +
      `${snap.counters.failed > 0 ? chalk.red(`${snap.counters.failed} failed`) : '0 failed'}`,
  );

  if (snap.activeJobs.length > 0) {
    ui.blank();
    ui.step(`Active jobs (${snap.activeJobs.length})`);
    for (const j of snap.activeJobs) {
      ui.line(`  ${j.jobId} (${j.type}) — running ${fmtDuration(Date.now() - Date.parse(j.startedAt))}`);
    }
  }

  const recent = snap.history.slice(-10);
  if (recent.length > 0) {
    ui.blank();
    ui.step(`Recent jobs (last ${recent.length} of ${snap.history.length})`);
    for (const h of recent) {
      const mark = h.status === 'done' ? chalk.green('✓') : chalk.red('✗');
      const dur = h.durationMs != null ? ` in ${fmtDuration(h.durationMs)}` : '';
      const err = h.error ? ` — ${h.error}` : '';
      ui.line(`  ${mark} ${h.jobId} (${h.type})${dur}${err}`);
    }
  }
}

function statusCmd(): Command {
  const cmd = new Command('status');
  cmd
    .description('Show this machine\'s node config and current capabilities')
    .action(async () => {
      // Live path: an attached daemon answers with a fresh snapshot.
      if (await isDaemonRunning()) {
        try {
          const client = await connectToDaemon();
          client.send({ cmd: 'status' });
          const msg = await client.waitFor((m) => m.kind === 'status', 5000);
          client.close();
          const snap = msg as unknown as EngineSnapshot;
          renderSnapshot(snap);
          // Best-effort: surface the server's registered concurrency alongside
          // the live configured cap so a stale-cap mismatch is visible. Never
          // let a failed server call crash `node status`.
          try {
            const cfg = requireConfig();
            if (cfg.nodeId) {
              const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });
              const server = await api.get<{ concurrency?: number }>(
                `/api/nodes/${encodeURIComponent(cfg.nodeId)}`,
              );
              const registered = server?.concurrency;
              if (typeof registered === 'number') {
                const hint =
                  registered !== snap.concurrency
                    ? chalk.yellow(' (stale — restart or wait for next heartbeat)')
                    : '';
                ui.line(`  Registered cap: ${registered}${hint}`);
              } else {
                ui.line(`  Registered cap: ${chalk.dim('(unavailable)')}`);
              }
            }
          } catch {
            ui.line(`  Registered cap: ${chalk.dim('(unavailable)')}`);
          }
          return;
        } catch (err) {
          ui.warn(`Could not query running node over IPC: ${(err as Error).message}`);
        }
      }

      const cfg = requireConfig();

      ui.blank();
      ui.step('Worker node configuration');
      ui.line(`  Node ID       : ${cfg.nodeId ?? chalk.dim('(not registered)')}`);
      ui.line(`  Name          : ${cfg.node?.name ?? chalk.dim('(unset)')}`);
      ui.line(`  Concurrency   : ${cfg.node?.concurrency ?? DEFAULT_CONCURRENCY}`);
      ui.line(`  Poll interval : ${cfg.node?.pollIntervalMs ?? DEFAULT_POLL_MS}ms`);
      ui.line(`  Eligible types: ${cfg.node?.eligibleTypes?.join(', ') ?? chalk.dim('(all)')}`);
      const cfgFaceProvider = cfg.node?.faceProvider ?? 'human';
      const cfgComprefaceUrl = cfg.node?.comprefaceUrl ?? DEFAULT_COMPREFACE_URL;
      ui.line(
        `  Face provider : ${cfgFaceProvider}` +
          (cfgFaceProvider === 'compreface' ? ` (${cfgComprefaceUrl})` : ''),
      );
      ui.blank();

      ui.step('Detected capabilities');
      // Probe the node's ACTUAL sidecar (not the localhost default) so the
      // compreface capability row reflects the configured URL.
      const caps = await detectCapabilities(
        cfgFaceProvider === 'compreface' ? { comprefaceUrl: cfgComprefaceUrl } : undefined,
      );
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
// node logs
// ---------------------------------------------------------------------------

function logsCmd(): Command {
  const cmd = new Command('logs');
  cmd
    .description('Print (or tail) the worker-node JSONL log')
    .option('-n, --lines <n>', 'Number of trailing lines to print', '50')
    .option('--follow', 'Keep tailing the log as new lines are written')
    .action((opts: { lines?: string; follow?: boolean }) => {
      const n = Math.max(0, parseInt(opts.lines ?? '50', 10) || 50);
      const lines = readLastLines(n);
      if (lines.length === 0 && !opts.follow) {
        ui.info(`No log lines yet (${nodeLogPath()}).`);
        return;
      }
      for (const line of lines) process.stdout.write(line + '\n');
      if (!opts.follow) return;

      const stopFollow = followLog((line) => process.stdout.write(line + '\n'));
      const onSignal = (): void => {
        stopFollow();
        process.exit(0);
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      // The fs.watch handle inside followLog keeps the process alive.
    });

  return cmd;
}

// ---------------------------------------------------------------------------
// node set-concurrency
// ---------------------------------------------------------------------------

function setConcurrencyCmd(): Command {
  const cmd = new Command('set-concurrency');
  cmd
    .description('Adjust worker concurrency — live via IPC when running, else saved to config')
    .argument('<n>', 'New concurrency (positive integer)')
    .action(async (nStr: string) => {
      const n = parseInt(nStr, 10);
      if (!Number.isInteger(n) || n < 1 || n > 64) {
        ui.error('Concurrency must be an integer between 1 and 64.');
        process.exit(1);
      }

      if (await isDaemonRunning()) {
        try {
          const client = await connectToDaemon();
          client.send({ cmd: 'set-concurrency', value: n });
          const msg: DaemonMessage = await client.waitFor(
            (m) => m.kind === 'ack' || m.kind === 'error',
            5000,
          );
          client.close();
          if (msg.kind === 'error') {
            ui.error(String(msg['message'] ?? 'daemon rejected the command'));
            process.exit(1);
          }
          ui.success(
            `Concurrency set to ${n} on the running node ` +
              '(applies from the next claim batch; persisted to config).',
          );
          return;
        } catch (err) {
          ui.warn(`IPC update failed: ${(err as Error).message} — saving to config only.`);
        }
      }

      const cfg = requireConfig();
      saveConfig({ ...cfg, node: { ...cfg.node, concurrency: n } });
      ui.success(`Concurrency ${n} saved to config (applies on the next \`node start\`).`);
    });

  return cmd;
}

// ---------------------------------------------------------------------------
// node service — systemd user unit management
// ---------------------------------------------------------------------------

const SERVICE_UNIT = 'memoriahub-node.service';

function systemdUserDir(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user');
}

/** True when a per-user systemd instance is reachable. */
function hasUserSystemd(): boolean {
  try {
    const res = spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

function printNoUserSystemdGuidance(): void {
  ui.error('No per-user systemd instance is available.');
  ui.info(
    'On WSL, enable systemd by adding "[boot]\\nsystemd=true" to /etc/wsl.conf and restarting ' +
      'the distro (`wsl --shutdown`), or skip systemd entirely with `memoriahub node start --daemon`.',
  );
}

/** Run systemctl --user with the given args, exiting on failure. */
function systemctlUser(args: string[]): void {
  const res = spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
  if (res.status !== 0) {
    ui.error(`systemctl --user ${args.join(' ')} failed (exit ${res.status ?? 'signal'}).`);
    process.exit(1);
  }
}

function serviceCmd(): Command {
  const cmd = new Command('service');
  cmd.description('Manage the systemd user service that keeps the worker node always on');

  cmd
    .command('install')
    .description(`Write ~/.config/systemd/user/${SERVICE_UNIT} and enable it now`)
    .action(() => {
      if (os.platform() === 'win32') {
        ui.error('systemd services are not available on Windows — use `node start --daemon`.');
        process.exit(1);
      }
      if (!hasUserSystemd()) {
        printNoUserSystemdGuidance();
        process.exit(1);
      }

      // process.argv[1] is the installed CLI entry (dist/index.js) both for a
      // global install and a repo checkout.
      const entry = path.resolve(process.argv[1]);
      const unit = [
        '[Unit]',
        'Description=MemoriaHub worker node',
        'After=network-online.target',
        '',
        '[Service]',
        `ExecStart=${process.execPath} ${entry} node start`,
        'Restart=on-failure',
        'RestartSec=5',
        'Environment=NODE_ENV=production',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n');

      const dir = systemdUserDir();
      fs.mkdirSync(dir, { recursive: true });
      const unitPath = path.join(dir, SERVICE_UNIT);
      fs.writeFileSync(unitPath, unit);
      ui.success(`Wrote ${unitPath}`);

      systemctlUser(['daemon-reload']);
      systemctlUser(['enable', '--now', SERVICE_UNIT]);
      ui.success('Service enabled and started.');
      ui.dim(`Follow logs with \`memoriahub node logs --follow\` or ` +
        `\`journalctl --user -u ${SERVICE_UNIT} -f\`.`);
      ui.dim(
        'Tip: `loginctl enable-linger $USER` keeps the service running after you log out.',
      );
    });

  cmd
    .command('uninstall')
    .description('Stop, disable, and remove the systemd user service')
    .action(() => {
      if (!hasUserSystemd()) {
        printNoUserSystemdGuidance();
        process.exit(1);
      }
      const unitPath = path.join(systemdUserDir(), SERVICE_UNIT);
      // disable --now is best-effort: the unit may already be gone.
      spawnSync('systemctl', ['--user', 'disable', '--now', SERVICE_UNIT], { stdio: 'inherit' });
      try {
        fs.unlinkSync(unitPath);
        ui.success(`Removed ${unitPath}`);
      } catch {
        ui.info(`Unit file not present (${unitPath}).`);
      }
      systemctlUser(['daemon-reload']);
      ui.success('Service uninstalled.');
    });

  cmd
    .command('status')
    .description('Show systemd status for the worker-node service')
    .action(() => {
      if (!hasUserSystemd()) {
        printNoUserSystemdGuidance();
        process.exit(1);
      }
      // Exit code 3 = unit inactive — still useful output, so don't fail hard.
      spawnSync('systemctl', ['--user', 'status', SERVICE_UNIT, '--no-pager'], {
        stdio: 'inherit',
      });
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

      // 1. API Access — auth roundtrip, node-registration validity, and
      //    model-manifest reachability. Claim permission (jobs:write) is not
      //    probed separately since it shares the same PAT scope as the auth
      //    roundtrip below and a real claim would consume a job.
      ui.step('API Access');
      const access = await runApiAccessChecks(api, cfg.nodeId);
      if (!access.authOk) hasError = true;
      const accessLevel = apiAccessLevel(access);
      if (accessLevel === 'ok') {
        ui.success(`API access ok — ${access.authDetail}`);
      } else {
        if (access.authOk) {
          ui.success(`Connected to ${cfg.serverUrl} (token valid). ${access.authDetail}`);
        } else {
          ui.error(`Cannot reach API / token invalid: ${access.authDetail}`);
        }
        if (cfg.nodeId) {
          if (access.nodeRegistrationOk === true) {
            ui.success(`Node registration: ${access.nodeRegistrationDetail}`);
          } else if (access.nodeRegistrationOk === false) {
            ui.warn(`Node registration: ${access.nodeRegistrationDetail}`);
          } else {
            ui.dim(`Node registration: ${access.nodeRegistrationDetail}`);
          }
        }
        if (access.manifestOk) {
          ui.success(`Model manifest: ${access.manifestDetail}`);
        } else {
          ui.warn(`Model manifest: ${access.manifestDetail}`);
        }
      }
      // Special case preserved regardless of level: an unregistered machine
      // is expected/informational, not a warning, so it always gets a pointer
      // to `node register` even when the rest of the access check collapses
      // to the one-line 'ok' summary above.
      if (!cfg.nodeId) {
        ui.dim('Node registration: not registered locally — run `node register` first.');
      }
      ui.blank();

      // 2. Capabilities — presence probe (require.resolve/binary detection).
      //    comprefaceUrl is threaded through so the compreface probe row (and
      //    the self-test below) checks the operator's configured sidecar URL
      //    rather than always defaulting to localhost.
      ui.step('Capabilities (installed)');
      const faceProvider = cfg.node?.faceProvider ?? 'human';
      const comprefaceUrl = cfg.node?.comprefaceUrl;
      const caps = await detectCapabilities({ comprefaceUrl });

      // 3. Operational self-tests — a real decode/embed/detect/OCR-init pass
      //    for every capability reported present above. See node/self-test.ts.
      ui.step('Running operational self-tests…');
      const operationalCaps = await runOperationalSelfTests(caps, { comprefaceUrl });
      const capsSummary = summarizeCapabilities(caps, operationalCaps);
      if (capsSummary.issues.length === 0) {
        ui.success(`All ${capsSummary.totalCount} capabilities operational.`);
      } else {
        ui.info(`${capsSummary.okCount}/${capsSummary.totalCount} capabilities fully operational`);
        printOperationalCapabilityTable(capsSummary.issues);
      }
      ui.blank();

      // 4. Required-capability check for eligible types — gated on the
      //    OPERATIONAL result, not mere presence, so a node whose sharp binary
      //    resolves but crashes on first use (or whose models aren't
      //    downloaded yet) is correctly reported as not-ready. `faceProvider`
      //    is threaded through so face_detection/video_face_detection are
      //    checked against the node's actually-configured provider instead of
      //    always assuming Human.
      ui.step('Job-type readiness');
      const eligibleTypes =
        cfg.node?.eligibleTypes && cfg.node.eligibleTypes.length > 0
          ? cfg.node.eligibleTypes.filter(isNodeJobType)
          : supportedTypes(operationalCaps, faceProvider);
      if (eligibleTypes.length === 0) {
        ui.warn('No eligible job types configured/supported on this machine.');
      }
      const jobReadinessRows = eligibleTypes.map((t) => {
        const missing = missingRequirements(t, operationalCaps, faceProvider);
        return { type: t, ready: missing.length === 0, missing };
      });
      const jobSummary = summarizeJobReadiness(jobReadinessRows);
      if (jobSummary.issues.length > 0) {
        hasError = true;
        ui.info(`${jobSummary.readyCount}/${jobSummary.totalCount} job types ready`);
        for (const row of jobSummary.issues) {
          ui.error(`${row.type}: missing required capability → ${row.missing.join(', ')}`);
        }
      } else if (jobSummary.totalCount > 0) {
        ui.success(`All ${jobSummary.totalCount} job type(s) ready.`);
      }
      ui.blank();

      // 5. Model presence (download-and-verify, as `node start` does).
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

      // 6. Daemon liveness — is a `node start` process currently running on
      //    this machine (with a quick live snapshot), or is there a stale
      //    pidfile left behind by a crash. Informational only — does not
      //    affect the exit code, since a stopped daemon isn't a "problem"
      //    with the machine's capabilities.
      ui.step('Daemon');
      const daemon = await checkDaemonLiveness();
      if (daemon.running) {
        ui.success(`Worker node daemon is running — ${daemon.detail}`);
        const snap = daemon.snapshot as
          | { startedAt?: string; concurrency?: number; eligibleTypes?: string[] }
          | null;
        if (snap) {
          if (snap.startedAt) {
            const uptime = fmtDuration(Date.now() - Date.parse(snap.startedAt));
            ui.dim(`  uptime: ${uptime}`);
          }
          if (snap.concurrency !== undefined) ui.dim(`  concurrency: ${snap.concurrency}`);
          if (snap.eligibleTypes) ui.dim(`  eligible types: ${snap.eligibleTypes.join(', ')}`);
        }
      } else if (daemon.stalePidfile) {
        ui.warn(daemon.detail);
      } else {
        ui.info(daemon.detail);
      }
      ui.blank();

      ui.dim(`Dependency setup & troubleshooting guide: ${WORKER_NODE_SETUP_GUIDE_URL}`);
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
// node install-deps
// ---------------------------------------------------------------------------

/** Default port the local compreface-core sidecar is exposed on. */
const DEFAULT_COMPREFACE_PORT = 3000;

/** Print one InstallStepResult using this file's existing ui.* conventions. */
function printStepResult(r: InstallStepResult): void {
  const line = `${r.step}: ${r.detail}`;
  switch (r.status) {
    case 'installed':
    case 'skipped':
      ui.success(line);
      break;
    case 'unsupported':
      ui.warn(line);
      break;
    case 'failed':
      ui.error(line);
      break;
  }
}

function installDepsCmd(): Command {
  const cmd = new Command('install-deps');
  cmd
    .description(
      'Install every dependency this machine needs to become a worker node ' +
        '(ffmpeg, native compute libraries, tesseract OCR data, Docker + compreface-core) — Linux only',
    )
    .option('--dry-run', 'Announce what would be installed/run without making any changes')
    .option('--skip-compreface', 'Skip Docker and the compreface-core sidecar setup')
    .option(
      '--compreface-port <port>',
      'Port to expose the compreface-core sidecar on',
      String(DEFAULT_COMPREFACE_PORT),
    )
    .option(
      '--compreface-processes <n>',
      'UWSGI_PROCESSES for the compreface-core sidecar (parallel face inference workers); ' +
        'defaults to a core-aware value (cores - 2, capped at 6)',
    )
    .option(
      '--compreface-memory <size>',
      'docker --memory cap for the compreface-core sidecar (e.g. 4g); omitted → no cap',
    )
    .option(
      '--compreface-cpus <n>',
      'docker --cpus cap for the compreface-core sidecar (e.g. 4); omitted → no cap',
    )
    .option(
      '--compreface-recreate',
      'Remove and recreate the compreface-core container even if it is already running, ' +
        'so new process/restart/resource settings take effect',
    )
    .action(
      async (opts: {
        dryRun?: boolean;
        skipCompreface?: boolean;
        comprefacePort?: string;
        comprefaceProcesses?: string;
        comprefaceMemory?: string;
        comprefaceCpus?: string;
        comprefaceRecreate?: boolean;
      }) => {
        // 1. Platform gate — this command is Linux-only for now.
        if (process.platform !== 'linux') {
          ui.error(
            'This command currently only supports Linux — see docs/worker-node-setup.md for manual per-platform setup.',
          );
          process.exit(1);
        }

        // 2. Upfront, non-blocking notice — this command must work
        //    non-interactively (e.g. in scripts/CI), so this is informational
        //    only, not a confirmation prompt.
        ui.blank();
        ui.info(
          'This command may install system packages and Docker using sudo. You will be prompted ' +
            'for your password if privileges are needed. Each such step is announced before it runs.',
        );
        ui.blank();

        const dryRun = Boolean(opts.dryRun);
        const port = Math.max(
          1,
          parseInt(opts.comprefacePort ?? String(DEFAULT_COMPREFACE_PORT), 10) ||
            DEFAULT_COMPREFACE_PORT,
        );

        // CompreFace sidecar tunables — undefined values fall back to the
        // core-aware / no-cap defaults inside ensureComprefaceContainer.
        const parsedProcesses =
          opts.comprefaceProcesses !== undefined
            ? parseInt(opts.comprefaceProcesses, 10)
            : undefined;
        const comprefaceContainerOpts: ComprefaceContainerOptions = {
          dryRun,
          ...(parsedProcesses !== undefined && Number.isFinite(parsedProcesses)
            ? { processes: Math.max(1, parsedProcesses) }
            : {}),
          ...(opts.comprefaceMemory ? { memory: opts.comprefaceMemory } : {}),
          ...(opts.comprefaceCpus ? { cpus: opts.comprefaceCpus } : {}),
          ...(opts.comprefaceRecreate ? { recreate: true } : {}),
        };

        const cfg = loadConfig();
        const comprefaceUrl = cfg?.node?.comprefaceUrl ?? `http://localhost:${port}`;

        const results: InstallStepResult[] = [];
        const report = (r: InstallStepResult): InstallStepResult => {
          printStepResult(r);
          results.push(r);
          return r;
        };

        // Resolve the CLI's own install directory (the one containing its
        // package.json) so `npm install` runs against the right workspace,
        // whether this is a repo checkout or the standalone installed CLI —
        // same resolution style as cliVersion() above.
        let cliInstallDir: string;
        try {
          cliInstallDir = path.dirname(require.resolve('../../package.json'));
        } catch {
          cliInstallDir = process.cwd();
        }

        ui.step('Detecting current capabilities…');
        let caps = await detectCapabilities({ comprefaceUrl });

        // 3–4. npm native deps + ffmpeg, then re-detect + operational self-tests.
        report(await ensureNpmNativeDeps(cliInstallDir, caps, { dryRun }));
        report(await ensureFfmpeg(caps, { dryRun }));

        caps = await detectCapabilities({ comprefaceUrl });
        let operationalCaps = await runOperationalSelfTests(caps, { comprefaceUrl });

        // 5. Tesseract OCR language data.
        report(await ensureTesseractLanguageData(operationalCaps));

        // 6. Model files (best-effort — skips gracefully if not logged in).
        report(await ensureModelsIfConfigured());

        // 7. Docker + compreface-core, unless explicitly skipped.
        if (!opts.skipCompreface) {
          const dockerResult = report(await ensureDocker({ dryRun }));
          const dockerHealthy = dockerResult.status === 'installed' || dockerResult.status === 'skipped';

          if (dockerHealthy) {
            const containerResult = report(
              await ensureComprefaceContainer(port, comprefaceContainerOpts),
            );
            const containerHealthy =
              containerResult.status === 'installed' || containerResult.status === 'skipped';
            if (containerHealthy && !dryRun) {
              report(await verifyCompreface(comprefaceUrl));
            } else if (containerHealthy && dryRun) {
              report({
                step: 'CompreFace verification',
                status: 'skipped',
                detail: 'Dry run — skipping live verification.',
              });
            } else {
              report({
                step: 'CompreFace verification',
                status: 'skipped',
                detail: 'Skipped because the compreface-core container could not be started.',
              });
            }
          } else {
            report({
              step: 'CompreFace container',
              status: 'skipped',
              detail: "Skipped because Docker isn't available.",
            });
            report({
              step: 'CompreFace verification',
              status: 'skipped',
              detail: "Skipped because Docker isn't available.",
            });
          }
        }

        // 9. Final report — fresh post-install sweep, printed with the exact
        //    same tables `node doctor` uses so the user sees a familiar
        //    before-vs-after outcome.
        ui.blank();
        ui.step('Final capability report');
        caps = await detectCapabilities({ comprefaceUrl });
        operationalCaps = await runOperationalSelfTests(caps, { comprefaceUrl });
        const capsSummary = summarizeCapabilities(caps, operationalCaps);
        if (capsSummary.issues.length === 0) {
          ui.success(`All ${capsSummary.totalCount} capabilities operational.`);
        } else {
          ui.info(`${capsSummary.okCount}/${capsSummary.totalCount} capabilities fully operational`);
          printOperationalCapabilityTable(capsSummary.issues);
        }
        ui.blank();

        const relogin = results.some((r) => r.requiresRelogin);
        if (relogin) {
          ui.warn(
            'Docker group membership was just updated for the current user — log out/in (or run ' +
              '`newgrp docker`) before plain `docker` commands or `memoriahub node doctor` reflect it. ' +
              'This run itself was not affected since every docker command in this run used sudo.',
          );
          ui.blank();
        }

        // 10. Exit code — only a real 'failed' step is a hard failure.
        const anyFailed = results.some((r) => r.status === 'failed');
        if (anyFailed) {
          ui.error('One or more steps failed — see the details above.');
          process.exit(1);
        }
        ui.success('install-deps complete — all steps succeeded, were skipped, or are unsupported on this system.');
      },
    );

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
  cmd.addCommand(logsCmd());
  cmd.addCommand(setConcurrencyCmd());
  cmd.addCommand(serviceCmd());
  cmd.addCommand(listCmd());
  cmd.addCommand(doctorCmd());
  cmd.addCommand(installDepsCmd());

  return cmd;
}
