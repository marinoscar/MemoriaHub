/**
 * commands/retry.ts — `memoriahub retry` command.
 *
 * Re-queues failed files and runs the engine for a retry pass.
 *
 * Usage:
 *   memoriahub retry [--all] [--folder <id|path>] [--force]
 *
 * --force: also re-queue files blocked at the attempts cap.
 */

import { Command } from 'commander';
import { requireConfig } from '../config.js';
import { ApiClient } from '../api.js';
import { getDb } from '../db/database.js';
import { FolderRepo } from '../repo/folders.js';
import { FileRepo } from '../repo/files.js';
import { RunRepo } from '../repo/runs.js';
import { SettingsRepo } from '../repo/settings.js';
import { SyncEngine } from '../sync/sync-engine.js';
import { renderSyncHeadless } from '../render/headless-sync.js';
import { getRetrySelection } from '../sync/retry.js';
import { ui } from '../ui.js';

export function retryCommand(): Command {
  const cmd = new Command('retry');
  cmd
    .description(
      'Retry failed uploads (up to the attempts cap). Use --force to also retry blocked files.',
    )
    .option('--all', 'Retry failed files across all folders', false)
    .option('--folder <id|path>', 'Limit retry to a specific folder (ID or path)')
    .option('--force', 'Also retry files blocked at the attempts cap (resets their attempt count)', false);

  cmd.action(async (opts: { all: boolean; folder?: string; force: boolean }) => {
    const cfg = requireConfig();
    const api  = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });
    const db   = getDb();
    const folderRepo   = new FolderRepo(db);
    const fileRepo     = new FileRepo(db);
    const runRepo      = new RunRepo(db);
    const settingsRepo = new SettingsRepo(db);

    // Resolve --folder option to a numeric ID
    let folderIds: number[] | undefined;
    if (opts.folder) {
      const f = folderRepo.resolve(opts.folder);
      if (!f) {
        ui.error(`Folder not found: ${opts.folder}`);
        process.exit(1);
      }
      folderIds = [f.id];
    } else if (!opts.all) {
      // Default: retry across all folders
      folderIds = undefined;
    }

    // Preview the retry selection before running
    const selection = getRetrySelection(fileRepo, settingsRepo, folderIds);

    if (selection.retryable.length === 0 && (!opts.force || selection.blocked.length === 0)) {
      if (selection.blocked.length > 0) {
        ui.warn(
          `${selection.blocked.length} file(s) are blocked at the attempts cap (${selection.cap}).`,
        );
        ui.info('Use `memoriahub retry --force` to reset and retry them.');
      } else {
        ui.success('No failed files to retry.');
      }
      return;
    }

    if (selection.blocked.length > 0 && !opts.force) {
      ui.warn(
        `${selection.blocked.length} file(s) are blocked at the attempts cap (${selection.cap}) ` +
        `and will be skipped. Use --force to also retry those.`,
      );
    }

    const total = selection.retryable.length + (opts.force ? selection.blocked.length : 0);
    ui.step(`Re-queuing ${total} file(s) for retry…`);

    const engine = new SyncEngine({
      api,
      folders: folderRepo,
      files:   fileRepo,
      runs:    runRepo,
      settings: settingsRepo,
    });

    renderSyncHeadless(engine);

    try {
      await engine.run({
        folderIds,
        retryFailedOnly: true,
        force: opts.force,
        trigger: 'retry',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ui.error(msg);
      process.exit(1);
    }
  });

  return cmd;
}
