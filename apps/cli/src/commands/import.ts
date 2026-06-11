import * as path from 'path';
import { Command } from 'commander';
import { requireConfig } from '../config';
import { ApiClient } from '../api';
import { enumerateFiles } from '../files';
import { loadManifest, saveManifest } from '../manifest';
import { processFiles, printSummary } from '../process-files';

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
    const { supported, skipped } = enumerateFiles(absFolder, options.recursive);

    if (skipped.length > 0) {
      console.log(`\nSkipping ${skipped.length} unsupported file(s):`);
      for (const f of skipped) {
        console.log(`  - ${f}`);
      }
    }

    if (supported.length === 0) {
      console.log('No supported files found in the specified folder.');
      return;
    }

    console.log(
      `\nFound ${supported.length} supported file(s) in ${absFolder}` +
        (options.dryRun ? ' [dry-run]' : ''),
    );

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

    printSummary(result, options.dryRun);
  });

  return cmd;
}
