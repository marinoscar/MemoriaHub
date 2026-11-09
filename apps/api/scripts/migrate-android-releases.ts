// =============================================================================
// Copy the pre-slice Android APK releases onto the android-app slice (RETRO-D5, #586)
// =============================================================================
//
//   npm run android:migrate-legacy-releases --workspace=api                # dry run (the default)
//   npm run android:migrate-legacy-releases --workspace=api -- --dry-run   # same, explicit
//   npm run android:migrate-legacy-releases --workspace=api -- --apply
//
// Copies `mh_legacy_android_app_releases` rows into `android_app_releases` under their
// original ids (APK objects never move) and, when the platform table has no current
// release yet, makes the legacy current release current. Idempotent: re-running copies
// nothing twice. The legacy table is never modified. Needs the API's database settings
// (POSTGRES_*). Logic: src/legacy/legacy-android-releases-migration.ts; procedure:
// docs/runbooks/android-release.md ("Cutover to the platform slice").
// =============================================================================

import { config } from 'dotenv';
import { resolve } from 'path';
import { Client } from 'pg';

import { buildBaseDatabaseUrl } from '../src/config/database-url.util';
import { applyReleaseCopy, planReleaseCopy } from '../src/legacy/legacy-android-releases-migration';

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
    const plan = await planReleaseCopy(client);
    if (!plan) {
      console.log('mh_legacy_android_app_releases does not exist: nothing to copy.');
      return;
    }
    console.log(
      `releases: ${plan.legacyTotal} legacy, ${plan.alreadyCopied} already copied, ${plan.toCopy} to copy, ` +
        `${plan.conflicts.length} conflicting`,
    );
    for (const c of plan.conflicts) {
      console.log(
        `  CONFLICT ${c.id} (${c.packageName} ${c.versionCode}): that version is already release ${c.platformId}; kept`,
      );
    }
    console.log(`  legacy current: ${plan.legacyCurrentId ?? '(none)'}; platform current: ${plan.platformCurrentId ?? '(none)'}`);
    if (plan.platformCurrentId && plan.legacyCurrentId && plan.platformCurrentId !== plan.legacyCurrentId) {
      console.log('  NOTE the platform already has a current release; it is kept (make-current to change it).');
    }
    for (const row of plan.byStorageProvider) console.log(`  stored on ${row.provider}: ${row.count}`);
    if (!apply) {
      console.log('Dry run only. Re-run with --apply to write.');
      return;
    }
    const result = await applyReleaseCopy(client);
    console.log(
      `copied ${result.copied}; ${result.promotedCurrent ? 'legacy current release made current' : 'current flag unchanged'}; ` +
        `current is ${result.currentId ?? '(none)'}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
