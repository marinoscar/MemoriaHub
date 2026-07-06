/**
 * commands/convert.ts — `memoriahub convert` command.
 *
 * Convert video files to `.mp4`.  Positional arguments may be individual video
 * FILES (converted directly) or FOLDERS (every recognized non-MP4 video inside
 * is converted); `--all` sweeps every registered enabled folder.  Requires
 * ffmpeg on the PATH; when missing, exits non-zero with an install hint.
 *
 * Fully offline: no PAT, no network, no DB writes beyond auto-registering any
 * unknown folder path (mirrors `organize`, not `sync`).
 *
 *   memoriahub convert [path...] [--all] [--dry-run] [-r] [--concurrency <n>]
 *                      [--json] [--formats <list>] [--delete-original]
 *                      [--overwrite] [--reencode] [--crf <n>]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { getDb } from '../db/database.js';
import { FolderRepo } from '../repo/folders.js';
import { SettingsRepo } from '../repo/settings.js';
import { ConvertEngine } from '../convert/convert-engine.js';
import { CONVERT_EV } from '../convert/events.js';
import { parseFormats } from '../convert/plan.js';
import { FfmpegNotFoundError } from '../convert/ffmpeg.js';
import { renderConvertSummary } from '../render/headless-convert.js';
import { ui, createSpinner } from '../ui.js';

interface ConvertActionOptions {
  all: boolean;
  json: boolean;
  dryRun: boolean;
  recursive: boolean;
  concurrency?: number;
  formats?: string;
  deleteOriginal: boolean;
  overwrite: boolean;
  reencode: boolean;
  crf?: number;
}

async function runConvert(
  pathArgs: string[],
  options: ConvertActionOptions,
): Promise<void> {
  if (pathArgs.length === 0 && !options.all) {
    ui.warn('No files or folders specified.');
    ui.info(
      'Pass video files or folders to convert, or use `memoriahub convert --all` to sweep all registered folders.',
    );
    process.exit(1);
  }

  const db = getDb();
  const folderRepo = new FolderRepo(db);
  const settingsRepo = new SettingsRepo(db);

  // Classify each positional argument as a file or a folder. Folders are
  // auto-registered (like scan/organize); files are converted directly.
  const files: string[] = [];
  const folderIds: number[] = [];
  for (const rawPath of pathArgs) {
    const absPath = path.resolve(rawPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      ui.error(`Path not found: ${absPath}`);
      process.exit(1);
    }

    if (stat.isDirectory()) {
      let folder = folderRepo.getByPath(absPath);
      if (!folder) {
        ui.info(`Auto-registering folder: ${absPath}`);
        folder = folderRepo.add({ path: absPath, recursive: options.recursive, enabled: true });
        ui.success(`Registered as folder #${folder.id}`);
      }
      folderIds.push(folder.id);
    } else {
      files.push(absPath);
    }
  }

  const engine = new ConvertEngine({
    folders: folderRepo,
    settings: settingsRepo,
  });

  // Live progress while converting (skip when emitting JSON so stdout stays clean).
  const spinner = !options.json ? createSpinner('Converting…') : null;
  spinner?.start();
  const verb = options.dryRun ? 'Planning' : 'Converting';
  engine.on(CONVERT_EV.CONVERT_PROGRESS, ({ processed, total }) => {
    if (spinner) spinner.text = `${verb}… ${processed}/${total} file(s)`;
  });

  try {
    const result = await engine.run({
      files: files.length > 0 ? files : undefined,
      folderIds: folderIds.length > 0 ? folderIds : undefined,
      all: options.all,
      recursive: options.recursive,
      dryRun: options.dryRun,
      concurrency: options.concurrency,
      deleteOriginal: options.deleteOriginal,
      overwrite: options.overwrite,
      reencode: options.reencode,
      crf: options.crf,
      formats: parseFormats(options.formats),
    });

    const { totals } = result;
    const summaryVerb = options.dryRun ? 'Would convert' : 'Converted';
    spinner?.succeed(
      `${summaryVerb} ${totals.converted} file(s)` +
        (totals.skipped > 0 ? `, ${totals.skipped} skipped` : '') +
        (totals.errors > 0 ? `, ${totals.errors} error(s)` : ''),
    );

    if (options.json) {
      process.stdout.write(JSON.stringify(totals, null, 2) + '\n');
    } else {
      renderConvertSummary(totals, { dryRun: options.dryRun });
    }
  } catch (err) {
    spinner?.fail('Convert failed');
    if (err instanceof FfmpegNotFoundError) {
      ui.error(err.message);
      ui.info(err.hint);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      ui.error(msg);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

export function convertCommand(): Command {
  const cmd = new Command('convert');
  cmd
    .description(
      'Convert video files (MOV, MTS, AVI, WMV, …) to MP4 (requires ffmpeg)',
    )
    .argument('[path...]', 'Video files and/or folders to convert (omit to use --all)')
    .option('--all', 'Convert videos in all registered enabled folders', false)
    .option('--dry-run', 'Preview what would be converted without running ffmpeg', false)
    .option('-r, --recursive', 'Descend into sub-directories (when auto-registering a folder)', false)
    .option('--concurrency <n>', 'Number of concurrent conversions', parseInt)
    .option('--formats <list>', 'Comma-separated extensions to convert (default: all non-MP4 videos)')
    .option('--delete-original', 'Delete each source file after its MP4 is written', false)
    .option('--overwrite', 'Overwrite an existing target .mp4 instead of skipping it', false)
    .option('--reencode', 'Force a full H.264 re-encode (skip the lossless remux fast-path)', false)
    .option('--crf <n>', 'Quality for re-encode (lower = better, default 20)', parseInt)
    .option('--json', 'Emit the summary as JSON instead of a table', false)
    .action(runConvert);

  return cmd;
}
