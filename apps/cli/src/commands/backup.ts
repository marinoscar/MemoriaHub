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
 *   memoriahub backup run
 *       Stub — the sync engine lands in the next release.
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
import { CATALOG_DB_REL_PATH } from '../backup/layout.js';
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
      ui.info('Run `memoriahub backup run` once the sync engine ships in the next release.');
    });
}

function runCmd(): Command {
  return new Command('run')
    .description('Run a backup sync (not available yet)')
    .action(() => {
      ui.error(
        '`backup run` is not available yet — the sync engine lands in the next release. ' +
          'Use `memoriahub backup init` to prepare a backup root now.',
      );
      process.exit(1);
    });
}

export function backupCommand(): Command {
  const cmd = new Command('backup');
  cmd
    .description('Local media backup to a folder on this machine (node-based)')
    .addCommand(initCmd())
    .addCommand(runCmd());
  return cmd;
}
