/**
 * commands/sync.ts — `memoriahub sync` command.
 *
 * Incremental sync: skips files already uploaded (size-based fast-path),
 * processes new/changed/failed files via the SyncEngine.
 *
 * Usage:
 *   memoriahub sync [folder...] [--all] [--dry-run] [-r|--recursive] [--concurrency <n>]
 */

import * as path from 'node:path';
import { Command } from 'commander';
import { requireConfig } from '../config.js';
import { ApiClient } from '../api.js';
import { CooldownGate } from '../http/cooldown-gate.js';
import { getDb } from '../db/database.js';
import { FolderRepo } from '../repo/folders.js';
import { FileRepo } from '../repo/files.js';
import { RunRepo } from '../repo/runs.js';
import { SettingsRepo } from '../repo/settings.js';
import { SyncEngine } from '../sync/sync-engine.js';
import { EV } from '../sync/events.js';
import { renderSyncHeadless } from '../render/headless-sync.js';
import { ui, isTTY } from '../ui.js';

export function syncCommand(): Command {
  const cmd = new Command('sync');
  cmd
    .description(
      'Incremental sync: skip already-uploaded files, process new/changed files',
    )
    .argument('[folder...]', 'Paths to folders to sync (omit to use --all)')
    .option('--all', 'Sync all registered enabled folders', false)
    .option('--dry-run', 'Show what would be uploaded without actually uploading', false)
    .option('-r, --recursive', 'Descend into sub-directories (when auto-registering a folder)', false)
    .option('--concurrency <n>', 'Number of concurrent upload workers', parseInt)
    .option('--circle <id>', 'Target circle ID (overrides active circle in config)');

  cmd.action(async (
    folderArgs: string[],
    options: { all: boolean; dryRun: boolean; recursive: boolean; concurrency?: number; circle?: string },
  ) => {
    // Validate invocation
    if (folderArgs.length === 0 && !options.all) {
      if (isTTY) {
        ui.warn('No folders specified.');
        ui.info('Use `memoriahub sync --all` to sync all registered folders,');
        ui.info('or pass one or more folder paths.');
        // TODO(ink-step): bare invocation + menu command
        process.exit(1);
      } else {
        ui.error('Non-TTY: specify --all or provide folder paths.');
        process.exit(1);
      }
    }

    const cfg = requireConfig();
    const db   = getDb();
    const folderRepo   = new FolderRepo(db);
    const fileRepo     = new FileRepo(db);
    const runRepo      = new RunRepo(db);
    const settingsRepo = new SettingsRepo(db);

    // A single cooldown gate shared by all upload workers: a 429/503 seen by
    // one worker pauses the others. The onTrip callback forwards a UI event
    // through the engine (assigned just below, before engine.run()).
    let engineRef: SyncEngine | undefined;
    const gate = new CooldownGate(settingsRepo.cooldownConfig(), {
      onTrip: (delayMs) => engineRef?.emit(EV.RATE_LIMITED, { delayMs }),
    });
    const api = new ApiClient({
      serverUrl: cfg.serverUrl,
      pat: cfg.pat,
      retry: settingsRepo.retryConfig(),
      cooldownGate: gate,
    });

    // Resolve folder paths → IDs (auto-register unknown paths)
    let folderIds: number[] | undefined;
    if (folderArgs.length > 0) {
      folderIds = [];
      for (const rawPath of folderArgs) {
        const absPath = path.resolve(rawPath);
        let folder = folderRepo.getByPath(absPath);
        if (!folder) {
          // Auto-register the folder
          ui.info(`Auto-registering folder: ${absPath}`);
          folder = folderRepo.add({
            path: absPath,
            recursive: options.recursive,
            enabled: true,
          });
          ui.success(`Registered as folder #${folder.id}`);
        }
        folderIds.push(folder.id);
      }
    }

    const engine = new SyncEngine({
      api,
      folders: folderRepo,
      files:   fileRepo,
      runs:    runRepo,
      settings: settingsRepo,
    });
    engineRef = engine;

    renderSyncHeadless(engine);

    try {
      await engine.run({
        folderIds,
        all:         options.all,
        dryRun:      options.dryRun,
        concurrency: options.concurrency,
        circleId:    options.circle ?? cfg.activeCircleId,
        trigger:     'cli',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ui.error(msg);
      process.exit(1);
    }
  });

  return cmd;
}
