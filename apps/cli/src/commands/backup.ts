/**
 * commands/backup.ts — `memoriahub backup` command.
 *
 * Pulls media blobs from the server to a local destination directory.
 * Requires an admin PAT. Uses GET /api/admin/backup/objects to enumerate
 * items with signed download URLs, then downloads each to --dest.
 *
 * The enumerate → download loop lives in the UI-agnostic `runBackup` engine
 * (src/backup/run-backup.ts); this command is a thin headless renderer over
 * its `onProgress` events, so a future Ink TUI can reuse the same core.
 *
 * Usage:
 *   memoriahub backup --circle <id> --dest <path>
 *   memoriahub backup --all --dest <path>
 */
import { Command } from 'commander';
import { requireConfig } from '../config.js';
import { ApiClient } from '../api.js';
import { runBackup, type BackupProgress, type BackupResult } from '../backup/run-backup.js';
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

      // Renderer: turn engine progress events into the same terminal output
      // the command emitted when the loop was inlined.
      const onProgress = (p: BackupProgress): void => {
        // Post-listing event: total known, no per-item detail yet.
        if (p.phase === 'downloading' && !p.item) {
          ui.info(`Found ${p.total} item(s) to back up`);
          return;
        }

        // Per-item event.
        if (p.item) {
          switch (p.item.outcome) {
            case 'skipped':
              ui.dim(`Skipped (already exists): ${p.item.originalFilename}`);
              break;
            case 'downloaded':
              ui.success(`Downloaded: ${p.item.originalFilename} → ${p.item.localFile}`);
              break;
            case 'failed':
              ui.error(`Failed: ${p.item.originalFilename}: ${p.item.error}`);
              break;
          }
        }
        // 'done' event carries no per-item output; summary printed below.
      };

      // 3. Run the backup engine. A listing failure throws.
      let result: BackupResult;
      try {
        result = await runBackup(
          api,
          { circle: options.circle, all: options.all, dest: options.dest },
          onProgress,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ui.error(`Failed to list backup objects: ${msg}`);
        process.exit(1);
      }

      // 4. Nothing-to-do path.
      if (result.total === 0) {
        ui.success('Nothing to back up.');
        process.exit(0);
      }

      ui.blank();
      ui.step(
        `Backup complete: ${result.downloaded} downloaded, ${result.skipped} skipped, ${result.failed} failed`,
      );

      if (result.failed > 0) {
        process.exit(1);
      }
    });

  return cmd;
}
