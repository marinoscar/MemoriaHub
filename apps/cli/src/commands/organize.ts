/**
 * commands/organize.ts — `memoriahub organize` command.
 *
 * Walk one or more folders, read each photo's EXIF capture date (reading the
 * FULL file), and MOVE each file into `YEAR/MM - Month/` sub-folders created
 * inside that same folder.  Files with no EXIF capture date — including every
 * video, since the CLI never probes video metadata — move into a top-level
 * `NODATE/` folder.  Fully offline: no PAT, no network, no DB writes beyond
 * auto-registering any unknown folder path (mirrors `scan`, not `sync`).
 *
 *   memoriahub organize [folder...] [--all] [--dry-run] [-r] [--concurrency <n>] [--json]
 */

import * as path from 'node:path';
import { Command } from 'commander';
import { getDb } from '../db/database.js';
import { FolderRepo } from '../repo/folders.js';
import { SettingsRepo } from '../repo/settings.js';
import { OrganizeEngine } from '../organize/organize-engine.js';
import { ORGANIZE_EV } from '../organize/events.js';
import { renderOrganizeSummary } from '../render/headless-organize.js';
import { ui, createSpinner } from '../ui.js';

interface OrganizeActionOptions {
  all: boolean;
  json: boolean;
  dryRun: boolean;
  recursive: boolean;
  concurrency?: number;
}

async function runOrganize(
  folderArgs: string[],
  options: OrganizeActionOptions,
): Promise<void> {
  if (folderArgs.length === 0 && !options.all) {
    ui.warn('No folders specified.');
    ui.info(
      'Use `memoriahub organize --all` to organize all registered folders, or pass folder paths.',
    );
    process.exit(1);
  }

  const db = getDb();
  const folderRepo = new FolderRepo(db);
  const settingsRepo = new SettingsRepo(db);

  // Resolve folder paths → IDs (auto-register unknown paths, like scan/sync).
  let folderIds: number[] | undefined;
  if (folderArgs.length > 0) {
    folderIds = [];
    for (const rawPath of folderArgs) {
      const absPath = path.resolve(rawPath);
      let folder = folderRepo.getByPath(absPath);
      if (!folder) {
        ui.info(`Auto-registering folder: ${absPath}`);
        folder = folderRepo.add({ path: absPath, recursive: options.recursive, enabled: true });
        ui.success(`Registered as folder #${folder.id}`);
      }
      folderIds.push(folder.id);
    }
  }

  const engine = new OrganizeEngine({
    folders: folderRepo,
    settings: settingsRepo,
  });

  // Live progress while organizing (skip when emitting JSON so stdout stays clean).
  const spinner = !options.json ? createSpinner('Organizing…') : null;
  spinner?.start();
  const verb = options.dryRun ? 'Planning' : 'Organizing';
  engine.on(ORGANIZE_EV.ORGANIZE_PROGRESS, ({ processed, total }) => {
    if (spinner) spinner.text = `${verb}… ${processed}/${total} file(s)`;
  });

  try {
    const result = await engine.run({
      folderIds,
      all: options.all,
      recursive: options.recursive,
      dryRun: options.dryRun,
      concurrency: options.concurrency,
    });

    const { totals } = result;
    const summaryVerb = options.dryRun ? 'Would move' : 'Moved';
    spinner?.succeed(
      `${summaryVerb} ${totals.moved} file(s)` +
        (totals.skipped > 0 ? `, ${totals.skipped} already in place` : '') +
        (totals.errors > 0 ? `, ${totals.errors} error(s)` : ''),
    );

    if (options.json) {
      process.stdout.write(JSON.stringify(totals, null, 2) + '\n');
    } else {
      renderOrganizeSummary(totals, { dryRun: options.dryRun });
    }
  } catch (err) {
    spinner?.fail('Organize failed');
    const msg = err instanceof Error ? err.message : String(err);
    ui.error(msg);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

export function organizeCommand(): Command {
  const cmd = new Command('organize');
  cmd
    .description(
      'Move files into YEAR/MM - Month/ folders by EXIF capture date (undated → NODATE/)',
    )
    .argument('[folder...]', 'Paths to folders to organize (omit to use --all)')
    .option('--all', 'Organize all registered enabled folders', false)
    .option('--dry-run', 'Preview the moves without touching any files', false)
    .option('-r, --recursive', 'Descend into sub-directories (when auto-registering a folder)', false)
    .option('--concurrency <n>', 'Number of concurrent workers', parseInt)
    .option('--json', 'Emit the summary as JSON instead of a table', false)
    .action(runOrganize);

  return cmd;
}
