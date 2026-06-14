/**
 * commands/backup.ts — `memoriahub backup` command.
 *
 * Pulls media blobs from the server to a local destination directory.
 * Requires an admin PAT. Uses GET /api/admin/backup/objects to enumerate
 * items with signed download URLs, then downloads each to --dest.
 *
 * Usage:
 *   memoriahub backup --circle <id> --dest <path>
 *   memoriahub backup --all --dest <path>
 */
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { requireConfig } from '../config.js';
import { ApiClient } from '../api.js';
import { ui } from '../ui.js';

export function backupCommand(): Command {
  const cmd = new Command('backup');
  cmd
    .description('Pull media blobs from the server to a local directory')
    .option('--circle <id>', 'Circle ID to back up')
    .option('--all', 'Back up all circles')
    .requiredOption('--dest <path>', 'Destination directory for backup')
    .action(async (options: { circle?: string; all?: boolean; dest: string }) => {
      // 1. Validate options
      if (!options.circle && !options.all) {
        ui.error('Provide either --circle <id> or --all');
        process.exit(1);
      }

      // 2. Get config (exits with error message if not logged in)
      const config = requireConfig();
      const api = new ApiClient({ serverUrl: config.serverUrl, pat: config.pat });

      // 3. Fetch object list
      let result: Awaited<ReturnType<typeof api.listBackupObjects>>;
      try {
        result = await api.listBackupObjects(options.circle);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ui.error(`Failed to list backup objects: ${msg}`);
        process.exit(1);
      }

      const items = result.items;
      ui.info(`Found ${items.length} item(s) to back up`);

      if (items.length === 0) {
        ui.success('Nothing to back up.');
        process.exit(0);
      }

      let downloaded = 0;
      let skipped = 0;
      let failed = 0;

      // 4. Download each item
      for (const item of items) {
        const localFile = path.join(options.dest, item.circleId, item.storageKey);
        const localDir = path.dirname(localFile);

        fs.mkdirSync(localDir, { recursive: true });

        // Skip if already exists at the correct size
        if (fs.existsSync(localFile)) {
          const stat = fs.statSync(localFile);
          if (stat.size === item.size) {
            skipped++;
            ui.dim(`Skipped (already exists): ${item.originalFilename}`);
            continue;
          }
        }

        // Download via signed URL
        try {
          const res = await fetch(item.downloadUrl);
          if (!res.ok || !res.body) {
            throw new Error(`HTTP ${res.status}`);
          }

          const writeStream = fs.createWriteStream(localFile);
          const reader = res.body.getReader();

          await new Promise<void>((resolve, reject) => {
            const pump = async (): Promise<void> => {
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) {
                    writeStream.end();
                    break;
                  }
                  if (!writeStream.write(value)) {
                    await new Promise<void>((r) => writeStream.once('drain', r));
                  }
                }
                writeStream.once('finish', resolve);
                writeStream.once('error', reject);
              } catch (e) {
                reject(e);
              }
            };
            pump().catch(reject);
          });

          downloaded++;
          ui.success(`Downloaded: ${item.originalFilename} → ${localFile}`);
        } catch (err) {
          failed++;
          const msg = err instanceof Error ? err.message : String(err);
          ui.error(`Failed: ${item.originalFilename}: ${msg}`);
        }
      }

      ui.blank();
      ui.step(`Backup complete: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`);

      if (failed > 0) {
        process.exit(1);
      }
    });

  return cmd;
}
