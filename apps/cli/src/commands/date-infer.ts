/**
 * commands/date-infer.ts — `memoriahub date-infer diagnose|apply` commands.
 *
 * Walk one or more folders and, for every photo/video with no existing
 * capture date (EXIF for photos, container metadata for videos), try to
 * infer one from the filename (e.g. `20151107_135151000_iOS.jpg`,
 * `IMG-20151228-WA0007.jpg`).
 *
 *   memoriahub date-infer diagnose [folder...] [--all] [-r] [--concurrency <n>] [--json] [--format xlsx|csv]
 *   memoriahub date-infer apply    [folder...] [--all] [-r] [--concurrency <n>] [--json] [--format xlsx|csv]
 *
 * `diagnose` is fully read-only (mirrors `scan`): no PAT, no network, no
 * writes — it only reports what would be inferred. `apply` additionally
 * writes each inferred date into the file itself via ExifTool (see
 * date-inference/exif-writer.ts), which is an OPTIONAL dependency; `apply`
 * checks for it up front and exits with an install hint if unavailable.
 * Like `organize`/`convert`, an unknown folder path is auto-registered, and
 * there is no interactive confirmation in headless mode — run `diagnose`
 * first to preview.
 */

import * as path from 'node:path';
import { Command } from 'commander';
import { getDb } from '../db/database.js';
import { FolderRepo } from '../repo/folders.js';
import { SettingsRepo } from '../repo/settings.js';
import { DateInferenceEngine, type DateInferenceMode } from '../date-inference/date-inference-engine.js';
import { DATE_INFERENCE_EV, type DateInferenceFilePayload } from '../date-inference/events.js';
import { detectExiftool, exiftoolInstallHint, endExiftool } from '../date-inference/exif-writer.js';
import { exportDateInference, type ExportFormat } from '../export/date-inference-export.js';
import { renderDateInferenceJson, renderDateInferenceSummary } from '../render/headless-date-infer.js';
import { exportsDir } from '../paths.js';
import { ui, createSpinner } from '../ui.js';
import * as fs from 'node:fs';

interface DateInferActionOptions {
  all: boolean;
  json: boolean;
  recursive: boolean;
  concurrency?: number;
  format?: string;
}

async function runDateInfer(
  mode: DateInferenceMode,
  folderArgs: string[],
  options: DateInferActionOptions,
): Promise<void> {
  if (folderArgs.length === 0 && !options.all) {
    ui.warn('No folders specified.');
    ui.info(
      `Use \`memoriahub date-infer ${mode} --all\` to scan all registered folders, or pass folder paths.`,
    );
    process.exit(1);
  }

  if (mode === 'apply') {
    const info = await detectExiftool();
    if (!info.available) {
      ui.error('ExifTool is not available — cannot write dates.');
      ui.info(exiftoolInstallHint());
      process.exit(1);
    }
  }

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

  const engine = new DateInferenceEngine({ folders: folderRepo, settings: settingsRepo });
  const fileRecords: DateInferenceFilePayload[] = [];
  engine.on(DATE_INFERENCE_EV.FILE, (payload) => fileRecords.push(payload));

  const spinner = !options.json ? createSpinner('Scanning…') : null;
  spinner?.start();
  const verb = mode === 'diagnose' ? 'Diagnosing' : 'Applying';
  engine.on(DATE_INFERENCE_EV.PROGRESS, ({ processed, total }) => {
    if (spinner) spinner.text = `${verb}… ${processed}/${total} file(s)`;
  });

  try {
    const result = await engine.run({
      folderIds,
      all: options.all,
      recursive: options.recursive,
      mode,
      concurrency: options.concurrency,
    });

    const { totals } = result;
    spinner?.succeed(
      mode === 'diagnose'
        ? `Scanned ${totals.total} file(s), ${totals.inferred} candidate(s) found`
        : `Scanned ${totals.total} file(s), ${totals.written} date(s) written`,
    );

    const format: ExportFormat = options.format === 'csv' ? 'csv' : 'xlsx';
    const dir = exportsDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(dir, `date-infer-${mode}-${stamp}.${format}`);
    await exportDateInference(totals, mode, fileRecords, outPath, format);

    if (options.json) {
      process.stdout.write(JSON.stringify({ ...totals, reportPath: outPath }, null, 2) + '\n');
    } else {
      renderDateInferenceSummary(totals, { mode, exportPath: outPath });
    }
  } catch (err) {
    spinner?.fail(mode === 'diagnose' ? 'Diagnose failed' : 'Apply failed');
    const msg = err instanceof Error ? err.message : String(err);
    ui.error(msg);
    process.exit(1);
  } finally {
    if (mode === 'apply') {
      await endExiftool();
    }
  }
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

function addSharedOptions(cmd: Command): Command {
  return cmd
    .argument('[folder...]', 'Paths to folders to scan (omit to use --all)')
    .option('--all', 'Scan all registered enabled folders', false)
    .option('-r, --recursive', 'Descend into sub-directories (when auto-registering a folder)', false)
    .option('--concurrency <n>', 'Number of concurrent workers', parseInt)
    .option('--json', 'Emit the summary as JSON instead of a table', false)
    .option('--format <fmt>', 'Report format: xlsx or csv', 'xlsx');
}

export function dateInferCommand(): Command {
  const cmd = new Command('date-infer');
  cmd.description('Infer missing capture dates from filenames (diagnose report or write via ExifTool)');

  addSharedOptions(
    cmd
      .command('diagnose')
      .description('Report-only: show which files have no capture date and what would be inferred'),
  ).action((folderArgs: string[], options: DateInferActionOptions) =>
    runDateInfer('diagnose', folderArgs, options),
  );

  addSharedOptions(
    cmd
      .command('apply')
      .description('Infer AND write missing capture dates into each file via ExifTool'),
  ).action((folderArgs: string[], options: DateInferActionOptions) =>
    runDateInfer('apply', folderArgs, options),
  );

  return cmd;
}
