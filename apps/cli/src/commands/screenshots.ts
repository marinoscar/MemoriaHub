/**
 * commands/screenshots.ts — `memoriahub screenshots` command.
 *
 * Walk one or more folders looking for files whose name contains
 * "screenshot" (case-insensitive substring match against the base filename —
 * e.g. `Screenshot 2024-01-02.png`, `img_screenshot_01.jpg`). By default the
 * matches are only LISTED. Pass `--move-to <dir>` to move them into another
 * folder, or `--delete` to permanently remove them (the two are mutually
 * exclusive). Fully offline: no PAT, no network, no DB writes beyond
 * auto-registering any unknown folder path (mirrors `organize`/`convert`).
 *
 *   memoriahub screenshots [folder...] [--all] [--dry-run] [-r] [--concurrency <n>]
 *                          [--move-to <dir> | --delete] [--json]
 */

import * as path from 'node:path';
import { Command } from 'commander';
import { getDb } from '../db/database.js';
import { FolderRepo } from '../repo/folders.js';
import { SettingsRepo } from '../repo/settings.js';
import { ScreenshotEngine, type ScreenshotMode } from '../screenshots/screenshot-engine.js';
import { SCREENSHOTS_EV } from '../screenshots/events.js';
import { renderScreenshotsSummary, renderScreenshotsJson } from '../render/headless-screenshots.js';
import { ui, createSpinner } from '../ui.js';

interface ScreenshotsActionOptions {
  all: boolean;
  json: boolean;
  dryRun: boolean;
  recursive: boolean;
  concurrency?: number;
  moveTo?: string;
  delete: boolean;
}

/** Resolve the mutually-exclusive `--move-to`/`--delete` flags into a mode. */
function resolveMode(options: ScreenshotsActionOptions): { mode: ScreenshotMode; destDir?: string } {
  if (options.moveTo && options.delete) {
    ui.error('Choose only one of --move-to or --delete.');
    process.exit(1);
  }
  if (options.moveTo) return { mode: 'move', destDir: path.resolve(options.moveTo) };
  if (options.delete) return { mode: 'delete' };
  return { mode: 'find' };
}

async function runScreenshots(
  folderArgs: string[],
  options: ScreenshotsActionOptions,
): Promise<void> {
  if (folderArgs.length === 0 && !options.all) {
    ui.warn('No folders specified.');
    ui.info(
      'Use `memoriahub screenshots --all` to scan all registered folders, or pass folder paths.',
    );
    process.exit(1);
  }

  const { mode, destDir } = resolveMode(options);

  const db = getDb();
  const folderRepo = new FolderRepo(db);
  const settingsRepo = new SettingsRepo(db);

  // Resolve folder paths → IDs (auto-register unknown paths, like scan/organize).
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

  const engine = new ScreenshotEngine({ folders: folderRepo, settings: settingsRepo });

  const verb = mode === 'move' ? 'Moving' : mode === 'delete' ? 'Deleting' : 'Scanning';
  const spinner = !options.json ? createSpinner('Scanning for screenshots…') : null;
  spinner?.start();
  engine.on(SCREENSHOTS_EV.PROGRESS, ({ phase, processed, total }) => {
    if (!spinner) return;
    spinner.text =
      phase === 'scanning'
        ? `Scanning… ${processed}/${total} folder(s)`
        : `${verb}… ${processed}/${total} file(s)`;
  });

  try {
    const result = await engine.run({
      folderIds,
      all: options.all,
      recursive: options.recursive,
      mode,
      destDir,
      dryRun: options.dryRun,
      concurrency: options.concurrency,
    });

    const { totals, matches } = result;
    const summaryVerb =
      mode === 'find'
        ? 'Found'
        : options.dryRun
          ? `Would ${mode === 'move' ? 'move' : 'delete'}`
          : mode === 'move'
            ? 'Moved'
            : 'Deleted';
    spinner?.succeed(
      `${summaryVerb} ${totals.matched} screenshot(s)` +
        (totals.skipped > 0 ? `, ${totals.skipped} already in place` : '') +
        (totals.errors > 0 ? `, ${totals.errors} error(s)` : ''),
    );

    if (options.json) {
      renderScreenshotsJson(totals, matches, { mode, dryRun: Boolean(options.dryRun), destDir });
    } else {
      renderScreenshotsSummary(totals, matches, { mode, dryRun: Boolean(options.dryRun), destDir });
    }
  } catch (err) {
    spinner?.fail('Screenshots scan failed');
    const msg = err instanceof Error ? err.message : String(err);
    ui.error(msg);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

export function screenshotsCommand(): Command {
  const cmd = new Command('screenshots');
  cmd
    .description(
      "Find files with 'screenshot' in the name (case-insensitive); list, move, or delete matches",
    )
    .argument('[folder...]', 'Paths to folders to scan (omit to use --all)')
    .option('--all', 'Scan all registered enabled folders', false)
    .option('--dry-run', 'Preview matches/moves/deletes without touching any files', false)
    .option('-r, --recursive', 'Descend into sub-directories (when auto-registering a folder)', false)
    .option('--concurrency <n>', 'Number of concurrent workers', parseInt)
    .option('--move-to <dir>', 'Move every matched screenshot into <dir>')
    .option('--delete', 'Permanently delete every matched screenshot', false)
    .option('--json', 'Emit the summary as JSON instead of a table', false)
    .addHelpText(
      'after',
      `
Examples:
  $ memoriahub screenshots ~/Photos                       # list screenshots found in a folder
  $ memoriahub screenshots ~/Photos -r                    # ...and its sub-folders
  $ memoriahub screenshots --all --move-to ~/Screenshots   # move screenshots out of every registered folder
  $ memoriahub screenshots ~/Photos --delete --dry-run     # preview what --delete would remove
  $ memoriahub screenshots ~/Photos --delete               # permanently delete matches (no prompt — dry-run first!)
`,
    )
    .action(runScreenshots);

  return cmd;
}
