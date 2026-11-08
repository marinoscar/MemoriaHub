// =============================================================================
// Move MemoriaHub's database-backup state onto the platform slice (RETRO-D4, #580)
// =============================================================================
//
//   npm run db-backup:migrate-legacy --workspace=api                # dry run (the default)
//   npm run db-backup:migrate-legacy --workspace=api -- --dry-run   # same, explicit
//   npm run db-backup:migrate-legacy --workspace=api -- --apply
//
// Two idempotent steps (src/legacy/legacy-db-backup-migration.ts):
//   1. `databaseBackup` settings rewritten into the platform's shape; the original value is kept
//      once under the top-level key `mhLegacyDatabaseBackup` of the same row.
//   2. `mh_legacy_database_backup_runs` rows that point at an archive copied into
//      `database_backup_runs` under their original ids (archives never move).
// Refuses step 2 while a legacy backup or restore is in flight. Re-running is safe: nothing is
// copied or rewritten twice. The legacy table is never modified. Needs the API's database
// settings (POSTGRES_*). See docs/runbooks/database-restore.md ("Cutover to the platform slice").
// =============================================================================

import { config } from 'dotenv';
import { resolve } from 'path';
import { Client } from 'pg';

import { buildBaseDatabaseUrl } from '../src/config/database-url.util';
import {
  LEGACY_DATABASE_BACKUP_SETTINGS_KEY,
  applyRunCopy,
  migrateDatabaseBackupSettings,
  planRunCopy,
} from '../src/legacy/legacy-db-backup-migration';

config({ path: resolve(__dirname, '..', '.env') });
config({ path: resolve(__dirname, '..', '..', '..', 'infra', 'compose', '.env') });

function parseArgs(argv: string[]): { apply: boolean } {
  let apply = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else throw new Error(`Unknown argument "${arg}" (use --dry-run or --apply)`);
  }
  return { apply };
}

async function main(): Promise<void> {
  const { apply } = parseArgs(process.argv.slice(2));
  const client = new Client({ connectionString: buildBaseDatabaseUrl() });
  await client.connect();
  try {
    console.log(apply ? 'APPLY' : 'DRY RUN');

    const settings = await migrateDatabaseBackupSettings(client, apply);
    console.log(`settings: ${settings.transform.changed ? 'needs rewrite' : 'already in the platform shape'}`);
    for (const line of settings.transform.changes) console.log(`  change  ${line}`);
    for (const line of settings.transform.warnings) console.log(`  WARNING ${line}`);
    if (settings.written) {
      console.log(`  written${settings.keptOriginal ? `; original kept under "${LEGACY_DATABASE_BACKUP_SETTINGS_KEY}"` : ''}`);
    }

    const plan = await planRunCopy(client);
    console.log(
      `runs: ${plan.total} legacy, ${plan.withArchive} with an archive, ${plan.alreadyCopied} already copied, ` +
        `${plan.toCopy} to copy, ${plan.withoutArchive} without an archive (stay in the legacy table)`,
    );
    if (plan.active.length > 0) {
      console.error(`ERROR: in flight: ${plan.active.map((r) => `${r.id}:${r.status}`).join(', ')}. Drain first.`);
      process.exitCode = 1;
      return;
    }
    if (!apply) {
      console.log('Dry run only. Re-run with --apply to write.');
      return;
    }
    const result = await applyRunCopy(client);
    console.log(`runs: copied ${result.copied}, pre-restore links set ${result.linked}`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
