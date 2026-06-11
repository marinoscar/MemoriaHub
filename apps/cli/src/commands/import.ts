import * as path from 'path';
import { Command } from 'commander';
import { requireConfig } from '../config';
import { ApiClient } from '../api';
import { enumerateFiles } from '../files';
import { loadManifest, saveManifest } from '../manifest';
import { processFiles } from '../process-files';
import { ui, printImportSummaryBox } from '../ui';

export function importCommand(): Command {
  const cmd = new Command('import');
  cmd
    .description('One-shot import of all supported files in a folder')
    .argument('<folder>', 'Path to the folder to import')
    .option('-r, --recursive', 'Descend into sub-directories', false)
    .option(
      '--dry-run',
      'Show what would be uploaded without actually uploading',
      false,
    );

  cmd.action(async (folder: string, options: { recursive: boolean; dryRun: boolean }) => {
    const cfg = requireConfig();
    const api = new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat });

    const absFolder = path.resolve(folder);

    ui.step(`Scanning folder: ${absFolder}`);
    if (options.dryRun) ui.warn('Dry-run mode — no files will be uploaded');

    const { supported, skipped } = enumerateFiles(absFolder, options.recursive);

    if (skipped.length > 0) {
      ui.warn(`Skipping ${skipped.length} unsupported file(s)`);
      for (const f of skipped) {
        ui.dim(f);
      }
    }

    if (supported.length === 0) {
      ui.info('No supported files found in the specified folder.');
      return;
    }

    ui.info(
      `Found ${supported.length} supported file(s)` +
        (options.recursive ? ' (recursive)' : ''),
    );
    ui.blank();

    const manifest = loadManifest(absFolder);
    manifest.folderPath = absFolder;

    const result = await processFiles({
      filePaths: supported,
      api,
      manifest,
      dryRun: options.dryRun,
    });

    if (!options.dryRun) {
      manifest.lastSyncAt = new Date().toISOString();
      saveManifest(absFolder, manifest);
    }

    printImportSummaryBox({
      uploaded: result.uploaded,
      skipped: result.skipped,
      failed: result.failed,
      dryRun: options.dryRun,
      dryRunWouldUpload: result.dryRunWouldUpload.length,
      dryRunDedups: result.dryRunDedups.length,
    });

    if (result.failed > 0) {
      ui.warn(
        `${result.failed} file(s) failed. Run \`memoriahub sync <folder>\` to retry.`,
      );
    }
  });

  return cmd;
}
