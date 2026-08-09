/**
 * commands/backup.ts — `memoriahub backup` command family (issue #314, epic #308).
 *
 * v1 of the node-based local backup replaces the old admin-PAT blob puller
 * (the v0 `backup --dest` command and its run-backup engine were removed):
 *
 *   memoriahub backup init --dest <dir> [--node-name <name>] [--circles <ids>]
 *       Bind this machine to a backup root: register a worker node if needed,
 *       enable backup server-side, create the root skeleton + SQLite catalog,
 *       and persist the binding locally. Engine: src/backup/init-backup.ts.
 *
 *   memoriahub backup run [--concurrency N] [--max-mbps X] [--page-size N]
 *                         [--json] [--strict]
 *       Run one incremental backup sync (issue #316). The invocation goes
 *       through the executeRun() seam (src/backup/execute-run.ts) so a later
 *       child can reroute it over the daemon IPC channel. Rendering:
 *       src/render/headless-backup.ts (human progress or --json NDJSON).
 *
 * All terminal output lives here; the engines never print.
 */

import * as os from 'node:os';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { loadConfig, requireConfig, saveConfig, type CliConfig } from '../config.js';
import { ApiClient, ApiError } from '../api.js';
import { getDb } from '../db/database.js';
import { SettingsRepo } from '../repo/settings.js';
import { registerWorkerNode } from '../node/register.js';
import {
  enrollNode,
  defaultNodeCredentialName,
  NodeEnrollmentUnsupportedError,
} from '../node/enroll.js';
import { runDeviceLogin } from '../device-login.js';
import { runBackupInit, BackupRootConflictError } from '../backup/init-backup.js';
import { RunAlreadyActiveError } from '../backup/backup-engine.js';
import { CatalogOpenError } from '../backup/catalog-db.js';
import { executeRun, resolveBackupExitCode } from '../backup/execute-run.js';
import {
  runViaDaemon,
  shouldDelegateToDaemon,
  DaemonBackupBusyError,
  DaemonBackupUnavailableError,
} from '../backup/run-via-daemon.js';
import { collectBackupStatus, type BackupStatusReport } from '../backup/status-report.js';
import { CATALOG_DB_REL_PATH } from '../backup/layout.js';
import { connectToDaemon, isDaemonRunning } from '../node/ipc-client.js';
import { renderBackupHeadless, formatBytes } from '../render/headless-backup.js';
import { ui, isTTY } from '../ui.js';

const require = createRequire(import.meta.url);

/** CLI version read from package.json at runtime (same pattern as commands/node.ts). */
function cliVersion(): string {
  try {
    const pkg = require('../../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/** Parse the --circles csv into a trimmed, de-duplicated id list. */
function parseCircleIds(csv: string | undefined): string[] {
  if (!csv) return [];
  return [...new Set(csv.split(',').map((s) => s.trim()).filter((s) => s.length > 0))];
}

/**
 * When the stored token is NOT a durable node credential (`nod_`) and stdin is
 * interactive, offer the `node enroll` flow so the backup node runs on a
 * least-privilege, never-expiring credential instead of a PAT that will
 * expire. Returns the (possibly refreshed) config.
 */
async function maybeOfferEnroll(cfg: CliConfig): Promise<CliConfig> {
  if (cfg.pat.startsWith('nod_') || !isTTY || !process.stdin.isTTY) return cfg;

  ui.info(
    'Your stored token is a personal access token (PAT). Backups run unattended, ' +
      'so a durable node credential is recommended.',
  );
  const rl = readline.createInterface({ input, output });
  let answer: string;
  try {
    answer = (await rl.question('Mint a node credential now (opens browser login)? [y/N] ')).trim();
  } finally {
    rl.close();
  }
  if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
    ui.dim('Keeping the existing PAT.');
    return cfg;
  }

  try {
    const result = await enrollNode(
      { serverUrl: cfg.serverUrl, name: defaultNodeCredentialName(), cfg },
      {
        deviceLogin: (url) => runDeviceLogin(url, 'MemoriaHub Backup Enrollment'),
        makeApi: (o) => new ApiClient(o),
        saveConfigFn: saveConfig,
      },
    );
    ui.success(`Node credential minted: ${result.credential.name}`);
  } catch (err) {
    if (err instanceof NodeEnrollmentUnsupportedError) {
      ui.warn(err.message);
      ui.dim('Continuing with the existing PAT.');
      return cfg;
    }
    throw err;
  }

  // enrollNode persisted the new token — re-read the config.
  const refreshed = loadConfig();
  return refreshed ?? cfg;
}

function initCmd(): Command {
  return new Command('init')
    .description('Initialize a local backup root on this machine')
    .requiredOption('--dest <dir>', 'Backup root directory (created if missing)')
    .option('--node-name <name>', 'Worker-node name when registering (default: backup-<hostname>)')
    .option('--circles <ids>', 'Comma-separated circle IDs to back up (default: all your circles)')
    .addHelpText(
      'after',
      '\nThe backup catalog is written to <dest>/' +
        CATALOG_DB_REL_PATH +
        ' — a plain SQLite\nfile you can inspect directly with any sqlite3 client ' +
        '(e.g. `sqlite3 <dest>/' +
        CATALOG_DB_REL_PATH +
        ' "SELECT count(*) FROM items"`).\n\n' +
        'Re-running init against the same --dest re-binds and refreshes the root without\n' +
        'touching the existing catalog. Only one backup root per machine is supported.',
    )
    .action(async (opts: { dest: string; nodeName?: string; circles?: string }) => {
      let cfg = requireConfig();

      // Offer the least-privilege enroll flow before any API call.
      try {
        cfg = await maybeOfferEnroll(cfg);
      } catch (err) {
        ui.error(`Enrollment failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });
      const settings = new SettingsRepo(getDb());
      const nodeName = opts.nodeName ?? cfg.node?.name ?? `backup-${os.hostname()}`;
      const circleIds = parseCircleIds(opts.circles);

      let result;
      try {
        result = await runBackupInit(
          {
            destDir: opts.dest,
            existingNodeId: cfg.nodeId ?? null,
            nodeName,
            circleIds,
            serverUrl: cfg.serverUrl,
          },
          {
            api,
            settings,
            registerNode: async (name) => {
              ui.step(`Registering this machine as worker node "${name}"…`);
              const reg = await registerWorkerNode({
                cfg,
                api,
                name,
                concurrency: cfg.node?.concurrency ?? 1,
                requestedTypes: cfg.node?.eligibleTypes ?? [],
                faceProvider: cfg.node?.faceProvider ?? 'compreface',
                comprefaceUrl: cfg.node?.comprefaceUrl,
                cliVersion: cliVersion(),
              });
              return { nodeId: reg.nodeId, reattached: reg.reattached };
            },
          },
        );
      } catch (err) {
        if (err instanceof BackupRootConflictError) {
          ui.error(err.message);
          process.exit(1);
        }
        if (err instanceof ApiError) {
          if (err.status === 403) {
            ui.error(
              'This token is not permitted to manage worker-node backups ' +
                '(jobs:write required).',
            );
          } else {
            ui.error(`Backup init failed (HTTP ${err.status}): ${err.serverMessage}`);
          }
          process.exit(1);
        }
        ui.error(`Backup init failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      ui.blank();
      if (result.registeredNode) {
        ui.success(
          result.reattached
            ? `Re-attached to existing worker node (${result.nodeId})`
            : `Registered worker node (${result.nodeId})`,
        );
      }
      ui.success(
        result.reinitialized
          ? `Backup root re-bound: ${result.root}`
          : `Backup root initialized: ${result.root}`,
      );
      ui.dim(`  Node        : ${result.nodeId}`);
      ui.dim(
        `  Circles     : ${result.config.circleIds.length > 0 ? result.config.circleIds.join(', ') : 'all your circles'}`,
      );
      ui.dim(`  Catalog     : ${result.root}/${CATALOG_DB_REL_PATH} (plain SQLite — query it directly)`);
      ui.blank();
      ui.info('Run `memoriahub backup run` to start the first backup sync.');
    });
}

/** Parse a numeric flag, exiting with a clear message on garbage input. */
function parseNumberFlag(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    ui.error(`Invalid value for ${flag}: ${value} (expected a non-negative number)`);
    process.exit(1);
  }
  return n;
}

interface RunCmdOpts {
  concurrency?: string;
  maxMbps?: string;
  pageSize?: string;
  json?: boolean;
  strict?: boolean;
  reconcile?: boolean;
  embedded?: boolean;
}

function runCmd(): Command {
  return new Command('run')
    .description('Run an incremental backup sync into the configured backup root')
    .option('--concurrency <n>', 'Concurrent download workers (default: backup.concurrency setting, 2)')
    .option('--max-mbps <x>', 'Aggregate bandwidth cap in Mbps; 0 = unlimited (default: backup.maxMbps setting, 0)')
    .option('--page-size <n>', 'Change-feed page size (default: backup.pageSize setting, 100)')
    .option('--json', 'Emit NDJSON events instead of human output')
    .option('--strict', 'Exit non-zero when any item failed')
    .option('--reconcile', 'Full reconcile pass (not available yet)')
    .option('--embedded', 'Force the in-process engine even when a daemon is running')
    .action(async (opts: RunCmdOpts) => {
      const cfg = requireConfig();

      if (opts.reconcile) {
        ui.error('`backup run --reconcile` arrives with verify/reconcile in a later release.');
        process.exit(1);
      }

      const settings = new SettingsRepo(getDb());
      const root = settings.backupRoot();
      const nodeId = settings.backupNodeId();
      if (!root || !nodeId) {
        ui.error(
          'No backup root is configured on this machine. Run ' +
            '`memoriahub backup init --dest <dir>` first.',
        );
        process.exit(1);
      }

      // Delegate to a running daemon (issue #318): the daemon owns the run
      // lock and the scheduler, so an embedded engine next to it would only
      // race the 409 guard. Events stream back over IPC into the SAME
      // renderer; --embedded forces the in-process engine.
      if (shouldDelegateToDaemon(opts.embedded === true, await isDaemonRunning())) {
        try {
          const client = await connectToDaemon();
          try {
            if (!opts.json) ui.dim('Worker-node daemon detected — delegating the run over IPC.');
            const outcome = await runViaDaemon(client, {
              attachRenderer: (emitter) =>
                renderBackupHeadless(emitter, { json: opts.json === true }),
            });
            process.exit(resolveBackupExitCode(outcome, opts.strict === true));
          } finally {
            client.close();
          }
        } catch (err) {
          if (err instanceof DaemonBackupBusyError) {
            ui.error(err.message);
            process.exit(1);
          }
          if (err instanceof DaemonBackupUnavailableError) {
            // Daemon started before this machine's backup root was bound —
            // fall through to the embedded engine.
            ui.warn(`${err.message} — running the embedded engine instead.`);
          } else {
            ui.warn(
              `Daemon delegation failed (${err instanceof Error ? err.message : String(err)}) ` +
                '— running the embedded engine instead.',
            );
          }
        }
      }

      const concurrency =
        parseNumberFlag(opts.concurrency, '--concurrency') ?? settings.backupConcurrency();
      const maxMbps = parseNumberFlag(opts.maxMbps, '--max-mbps') ?? settings.backupMaxMbps();
      const pageSize = parseNumberFlag(opts.pageSize, '--page-size') ?? settings.backupPageSize();

      let outcome;
      try {
        outcome = await executeRun({
          serverUrl: cfg.serverUrl,
          pat: cfg.pat,
          root,
          nodeId,
          trigger: 'manual',
          cliVersion: cliVersion(),
          concurrency: Math.max(1, Math.floor(concurrency)),
          maxMbps,
          pageSize: Math.max(1, Math.floor(pageSize)),
          pacingMs: settings.backupPacingMs(),
          retry: settings.retryConfig(),
          cooldown: settings.cooldownConfig(),
          attachRenderer: (engine) =>
            renderBackupHeadless(engine, { json: opts.json === true }),
        });
      } catch (err) {
        if (err instanceof RunAlreadyActiveError || err instanceof CatalogOpenError) {
          ui.error(err.message);
          process.exit(1);
        }
        if (err instanceof ApiError) {
          if (err.status === 403) {
            ui.error(
              'This token is not permitted to run worker-node backups (jobs:write required).',
            );
          } else {
            ui.error(`Backup run failed (HTTP ${err.status}): ${err.serverMessage}`);
          }
          process.exit(1);
        }
        ui.error(`Backup run failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      process.exit(resolveBackupExitCode(outcome, opts.strict === true));
    });
}

// ---------------------------------------------------------------------------
// backup status (issue #318)
// ---------------------------------------------------------------------------

function renderStatusReport(report: BackupStatusReport): void {
  const { local, daemon, server } = report;

  // --- Local catalog (offline-capable) --------------------------------------
  ui.line(`Local catalog${local.root ? ` (${local.root})` : ''}  [${local.source}]`);
  if (!local.configured) {
    ui.dim(`  ${local.error ?? 'not configured'}`);
  } else if (local.error) {
    ui.dim(`  ${local.error}`);
  } else {
    const c = local.counters;
    if (c) {
      ui.line(
        `  Items      : ${c.totalItems} (${formatBytes(c.totalBytes)}) — ` +
          `${c.byStatus.present.count} present, ${c.byStatus.failed.count} failed, ` +
          `${c.byStatus.trashed.count} trashed, ${c.archivedCount} archived`,
      );
    }
    ui.line(`  Checkpoint : ${local.checkpoint ? local.checkpoint.updatedAt : '(none — never synced)'}`);
    if (local.lastRun) {
      ui.line(
        `  Last run   : ${local.lastRun.status} at ${local.lastRun.startedAt} — ` +
          `${local.lastRun.itemsDownloaded ?? 0} downloaded, ${local.lastRun.errorCount ?? 0} error(s)`,
      );
    } else {
      ui.line('  Last run   : (none recorded)');
    }
  }
  ui.blank();

  // --- Daemon (live, via IPC) ------------------------------------------------
  ui.line(`Daemon  [${daemon.source}]`);
  if (daemon.error) {
    ui.dim(`  ${daemon.error}`);
  } else if (!daemon.running) {
    ui.dim('  not running (runs execute embedded; schedules fire only while a daemon is up)');
  } else if (daemon.snapshot) {
    const snap = daemon.snapshot as {
      configured?: boolean;
      running?: { trigger?: string; startedAt?: string } | null;
      rate?: { concurrency?: number; maxMbps?: number } | null;
    };
    if (snap.configured === false) {
      ui.dim('  running, but backup hosting is not active (daemon started before `backup init`)');
    } else if (snap.running) {
      ui.line(
        `  Run active : ${snap.running.trigger ?? 'manual'} (since ${snap.running.startedAt ?? '?'})`,
      );
    } else {
      ui.line('  Run active : no (idle)');
    }
    if (snap.rate) {
      ui.line(
        `  Rate       : concurrency ${snap.rate.concurrency ?? '?'}, ` +
          `max ${snap.rate.maxMbps && snap.rate.maxMbps > 0 ? `${snap.rate.maxMbps} Mbps` : 'unlimited'}`,
      );
    }
  }
  ui.blank();

  // --- Server ---------------------------------------------------------------
  ui.line(`Server  [${server.source}]`);
  if (!server.reachable) {
    ui.dim(`  ${server.error ?? 'unreachable'}`);
    return;
  }
  const cfg = server.config;
  if (!cfg) {
    ui.dim('  backup has never been configured for this node server-side');
    return;
  }
  ui.line(`  Enabled    : ${cfg.enabled ? 'yes' : 'no'}`);
  ui.line(
    `  Schedule   : ${cfg.scheduleCron ?? '(none)'}${cfg.timezone ? ` (${cfg.timezone})` : ''}`,
  );
  ui.line(`  Next run   : ${cfg.nextRunAt ?? '(not scheduled)'}`);
  if (cfg.pending) {
    ui.line(
      `  Pending    : ${cfg.pending.items} item(s), ${formatBytes(Number(cfg.pending.bytes))} behind the checkpoint`,
    );
  }
  if (server.runs.length > 0) {
    ui.line('  Recent runs:');
    for (const run of server.runs) {
      ui.line(
        `    ${run.startedAt}  ${run.status.padEnd(9)} (${run.trigger}) — ` +
          `${run.itemsDownloaded} downloaded, ${run.errorCount} error(s)`,
      );
    }
  }
}

function statusCmd(): Command {
  return new Command('status')
    .description('Show backup status: local catalog, running daemon, and server')
    .option('--json', 'Emit the merged status report as JSON')
    .action(async (opts: { json?: boolean }) => {
      const settings = new SettingsRepo(getDb());
      const cfg = loadConfig();
      const report = await collectBackupStatus({
        settings,
        api: cfg ? new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat }) : null,
        isDaemonRunningFn: isDaemonRunning,
        connectFn: () => connectToDaemon(),
      });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      renderStatusReport(report);
    });
}

// ---------------------------------------------------------------------------
// backup schedule (issue #318 — the SERVER computes cron/nextRunAt)
// ---------------------------------------------------------------------------

function requireBackupNodeId(settings: SettingsRepo): string {
  const nodeId = settings.backupNodeId();
  if (!nodeId) {
    ui.error(
      'No backup root is configured on this machine. Run ' +
        '`memoriahub backup init --dest <dir>` first.',
    );
    process.exit(1);
  }
  return nodeId;
}

function scheduleCmd(): Command {
  return new Command('schedule')
    .description('Manage the automatic backup schedule (cron is computed server-side)')
    .argument('[cron]', '5-field cron expression, e.g. "0 3 * * *"')
    .option('--tz <iana>', 'IANA timezone for the schedule (e.g. America/Costa_Rica)')
    .option('--show', 'Show the current schedule')
    .option('--disable', 'Clear the schedule (no more scheduled runs)')
    .addHelpText(
      'after',
      '\nScheduled runs fire from a RUNNING worker-node daemon (`memoriahub node start`),\n' +
        'which polls the server every minute and starts a run when the server-computed\n' +
        'nextRunAt is due. A machine offline at the scheduled time self-heals: the run\n' +
        'fires on the first poll after the daemon is back up.',
    )
    .action(async (cron: string | undefined, opts: { tz?: string; show?: boolean; disable?: boolean }) => {
      const cfg = requireConfig();
      const settings = new SettingsRepo(getDb());
      const nodeId = requireBackupNodeId(settings);
      const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });

      try {
        if (opts.show) {
          const { config } = await api.getNodeBackupConfig(nodeId);
          if (!config) {
            ui.info('Backup has never been configured for this node server-side.');
            return;
          }
          ui.line(`Schedule : ${config.scheduleCron ?? '(none)'}`);
          ui.line(`Timezone : ${config.timezone ?? '(server default, UTC)'}`);
          ui.line(`Enabled  : ${config.enabled ? 'yes' : 'no'}`);
          ui.line(`Next run : ${config.nextRunAt ?? '(not scheduled)'}`);
          return;
        }

        if (opts.disable) {
          await api.putNodeBackupConfig(nodeId, { scheduleCron: null });
          ui.success('Backup schedule cleared — no more scheduled runs.');
          return;
        }

        if (!cron) {
          ui.error('Provide a cron expression, or use --show / --disable.');
          process.exit(1);
        }

        const res = await api.putNodeBackupConfig(nodeId, {
          scheduleCron: cron,
          ...(opts.tz !== undefined ? { timezone: opts.tz } : {}),
        });
        ui.success(`Backup schedule set: ${cron}${opts.tz ? ` (${opts.tz})` : ''}`);
        ui.line(`Next run : ${res.config?.nextRunAt ?? '(unknown)'}`);
        if (!res.config?.enabled) {
          ui.warn('Backup is currently DISABLED server-side — the schedule will not fire.');
        }
        ui.dim('Scheduled runs fire from a running daemon (`memoriahub node start`).');
      } catch (err) {
        if (err instanceof ApiError) {
          // Surface server validation (bad cron / bad timezone) verbatim.
          ui.error(err.serverMessage);
          process.exit(1);
        }
        ui.error(`Schedule update failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

// ---------------------------------------------------------------------------
// backup set-rate (issue #318 — persists to settings KV + live IPC push)
// ---------------------------------------------------------------------------

function setRateCmd(): Command {
  return new Command('set-rate')
    .description('Set backup throttle knobs (persisted; applied live to a running daemon)')
    .option('--concurrency <n>', 'Concurrent download workers (1-32)')
    .option('--max-mbps <x>', 'Aggregate bandwidth cap in Mbps; 0 = unlimited')
    .action(async (opts: { concurrency?: string; maxMbps?: string }) => {
      if (opts.concurrency === undefined && opts.maxMbps === undefined) {
        ui.error('Provide --concurrency and/or --max-mbps.');
        process.exit(1);
      }

      let concurrency: number | undefined;
      if (opts.concurrency !== undefined) {
        const n = Number(opts.concurrency);
        if (!Number.isInteger(n) || n < 1 || n > 32) {
          ui.error(`Invalid --concurrency: ${opts.concurrency} (expected an integer 1-32)`);
          process.exit(1);
        }
        concurrency = n;
      }
      const maxMbps = parseNumberFlag(opts.maxMbps, '--max-mbps');

      const settings = new SettingsRepo(getDb());
      requireBackupNodeId(settings);
      if (concurrency !== undefined) settings.setBackupConcurrency(concurrency);
      if (maxMbps !== undefined) settings.setBackupMaxMbps(maxMbps);
      ui.success(
        `Backup rate saved: concurrency ${settings.backupConcurrency()}, ` +
          `max ${settings.backupMaxMbps() > 0 ? `${settings.backupMaxMbps()} Mbps` : 'unlimited'}`,
      );

      // Live push: a running daemon applies the change on its next page/chunk.
      if (await isDaemonRunning()) {
        try {
          const client = await connectToDaemon();
          try {
            client.send({
              cmd: 'backup-set-rate',
              ...(concurrency !== undefined ? { concurrency } : {}),
              ...(maxMbps !== undefined ? { maxMbps } : {}),
            });
            const reply = await client.waitFor(
              (m) => (m.kind === 'ack' || m.kind === 'error') && m['cmd'] === 'backup-set-rate',
              5000,
            );
            if (reply.kind === 'ack') {
              ui.success('Applied live to the running daemon (next page uses the new rate).');
            } else {
              ui.warn(`Daemon did not apply the rate: ${String(reply['message'])}`);
            }
          } finally {
            client.close();
          }
        } catch (err) {
          ui.warn(
            `Could not push the rate to the running daemon: ` +
              `${err instanceof Error ? err.message : String(err)} (it will pick it up next run).`,
          );
        }
      } else {
        ui.dim('No daemon running — the new rate applies from the next run.');
      }
    });
}

export function backupCommand(): Command {
  const cmd = new Command('backup');
  cmd
    .description('Local media backup to a folder on this machine (node-based)')
    .addCommand(initCmd())
    .addCommand(runCmd())
    .addCommand(statusCmd())
    .addCommand(scheduleCmd())
    .addCommand(setRateCmd());
  return cmd;
}
