import * as path from 'path';
import { Command } from 'commander';
import { requireConfig } from '../config';
import { ApiClient } from '../api';
import { enumerateFiles } from '../files';
import { loadManifest, saveManifest } from '../manifest';
import { processFiles } from '../process-files';
import { sha256File } from '../hash';
import { ui, createSpinner, printImportSummaryBox } from '../ui';

export function syncCommand(): Command {
  const cmd = new Command('sync');
  cmd
    .description(
      'Incremental sync: skip files already uploaded (by manifest + sha256 check), process new and failed files',
    )
    .argument('<folder>', 'Path to the folder to sync')
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

    ui.step(`Syncing folder: ${absFolder}`);
    if (options.dryRun) ui.warn('Dry-run mode — no files will be uploaded');

    const { supported, skipped } = enumerateFiles(absFolder, options.recursive);

    if (skipped.length > 0) {
      ui.warn(`Skipping ${skipped.length} unsupported file(s)`);
    }

    if (supported.length === 0) {
      ui.info('No supported files found in the specified folder.');
      return;
    }

    const manifest = loadManifest(absFolder);
    manifest.folderPath = absFolder;

    // Determine which files need processing.
    // A file is skipped only if:
    //   - manifest entry status === 'uploaded'
    //   - AND the current sha256 matches the manifest entry (file unchanged)
    const toProcess: Array<{ filePath: string; mimeType: string }> = [];
    let alreadySynced = 0;

    // Spin while computing local hashes
    const hashSpinner = createSpinner(
      `Checking ${supported.length} file(s) against local manifest…`,
    );
    hashSpinner.start();

    for (const { filePath, mimeType } of supported) {
      const entry = manifest.files[filePath];
      if (entry?.status === 'uploaded') {
        // Recompute sha256 to detect changes
        let currentHash: string;
        try {
          currentHash = await sha256File(filePath);
        } catch {
          // If we can't read the file, mark it for reprocessing
          toProcess.push({ filePath, mimeType });
          continue;
        }
        if (currentHash === entry.sha256) {
          alreadySynced++;
          continue;
        }
        // File has changed since last upload — re-upload
      }
      toProcess.push({ filePath, mimeType });
    }

    hashSpinner.succeed(
      `Manifest check complete — ${alreadySynced} already-synced, ${toProcess.length} to process`,
    );

    if (toProcess.length === 0) {
      ui.success('Nothing to sync. All files are up to date.');
      if (!options.dryRun) {
        manifest.lastSyncAt = new Date().toISOString();
        saveManifest(absFolder, manifest);
      }
      return;
    }

    ui.info(
      `Processing ${toProcess.length} file(s)` +
        (options.dryRun ? ' [dry-run]' : ''),
    );
    ui.blank();

    const result = await processFiles({
      filePaths: toProcess,
      api,
      manifest,
      dryRun: options.dryRun,
    });

    // Add the already-synced count to the "skipped" total for summary
    result.skipped += alreadySynced;

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
      ui.warn(`${result.failed} file(s) failed. Re-run \`memoriahub sync <folder>\` to retry.`);
    }
  });

  return cmd;
}
