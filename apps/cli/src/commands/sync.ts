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
import { ScanRepo } from '../repo/scans.js';
import { SyncEngine } from '../sync/sync-engine.js';
import { SyncReportCollector, writeSyncReport } from '../sync/sync-report.js';
import { EV } from '../sync/events.js';
import { renderSyncHeadless } from '../render/headless-sync.js';
import { runPatPreflight } from '../preflight.js';
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
    .option('--circle <id>', 'Target circle ID (overrides active circle in config)')
    .option('--scan <id>', 'Reconcile against a prior scan (id or "latest") and report changes since then');

  cmd.action(async (
    folderArgs: string[],
    options: { all: boolean; dryRun: boolean; recursive: boolean; concurrency?: number; circle?: string; scan?: string },
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
    const scanRepo     = new ScanRepo(db);

    // Resolve --scan <id|latest> to a numeric scan id for drift reconciliation.
    let scanId: number | undefined;
    if (options.scan) {
      if (options.scan === 'latest') {
        const latest = scanRepo.latestComplete();
        if (!latest) {
          ui.error('No completed scan found. Run `memoriahub scan --all` first.');
          process.exit(1);
        }
        scanId = latest.id;
      } else {
        const parsed = parseInt(options.scan, 10);
        if (isNaN(parsed) || !scanRepo.getScan(parsed)) {
          ui.error(`Scan not found: ${options.scan}. Run \`memoriahub scan list\` to see available scans.`);
          process.exit(1);
        }
        scanId = parsed;
      }
    }

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

    // Pre-flight: validate the PAT and warn about near-expiry before we start
    // doing any real work.  A 401 exits immediately with an actionable message.
    await runPatPreflight(api, cfg);

    const engine = new SyncEngine({
      api,
      folders: folderRepo,
      files:   fileRepo,
      runs:    runRepo,
      settings: settingsRepo,
      scans:   scanRepo,
    });
    engineRef = engine;

    // Collect per-file outcomes so we can write an Excel report for the run.
    const collector = new SyncReportCollector(fileRepo, folderRepo, runRepo);
    collector.attach(engine);

    renderSyncHeadless(engine);

    try {
      await engine.run({
        folderIds,
        all:         options.all,
        dryRun:      options.dryRun,
        concurrency: options.concurrency,
        circleId:    options.circle ?? cfg.activeCircleId,
        scanId,
        trigger:     'cli',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ui.error(msg);
      process.exit(1);
    }

    // Auto-write the Excel run report and print its location.
    const report = await writeSyncReport(collector);
    if (report.ok) {
      ui.success(`Excel report: ${report.path}`);
    } else {
      ui.warn(`Excel report not created: ${report.error}`);
    }
  });

  return cmd;
}
