/**
 * commands/import.ts — `memoriahub import` back-compat alias.
 *
 * Registers the given folder (auto-adds if absent) then runs a one-shot
 * sync of just that folder via the SyncEngine.  Functionally identical
 * to `memoriahub sync <folder>` but kept for script / muscle-memory compat.
 */

import * as path from 'node:path';
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
import { ui } from '../ui.js';

export function importCommand(): Command {
  const cmd = new Command('import');
  cmd
    .description('One-shot import: register a folder and sync it immediately (alias for sync <folder>)')
    .argument('<folder>', 'Path to the folder to import')
    .option('-r, --recursive', 'Descend into sub-directories', false)
    .option('--dry-run', 'Show what would be uploaded without actually uploading', false);

  cmd.action(async (folder: string, options: { recursive: boolean; dryRun: boolean }) => {
    const cfg = requireConfig();
    const api  = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });
    const db   = getDb();
    const folderRepo   = new FolderRepo(db);
    const fileRepo     = new FileRepo(db);
    const runRepo      = new RunRepo(db);
    const settingsRepo = new SettingsRepo(db);

    const absPath = path.resolve(folder);

    // Register the folder if not already known
    let f = folderRepo.getByPath(absPath);
    if (!f) {
      f = folderRepo.add({ path: absPath, recursive: options.recursive, enabled: true });
      ui.info(`Registered folder: ${absPath} (id=${f.id})`);
    } else if (options.recursive && !f.recursive) {
      // Update recursive flag if caller explicitly passed -r
      f = folderRepo.setRecursive(f.id, true) ?? f;
    }

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
        folderIds: [f.id],
        dryRun:    options.dryRun,
        trigger:   'cli',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ui.error(msg);
      process.exit(1);
    }
  });

  return cmd;
}
