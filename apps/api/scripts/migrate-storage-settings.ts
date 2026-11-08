// =============================================================================
// Move MemoriaHub's storage configuration onto the platform storage slice (RETRO-D1, #563)
// =============================================================================
//
//   npm run storage:migrate-settings --workspace=api                # dry run (the default)
//   npm run storage:migrate-settings --workspace=api -- --dry-run   # same, explicit
//   npm run storage:migrate-settings --workspace=api -- --apply
//
// Run it ONCE after deploying the release, with the SAME environment the old release had (the
// variables below are no longer read by the API, so this is where their values are kept):
//
//   STORAGE_PROVIDER, S3_BUCKET, S3_REGION, S3_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
//   BACKUP_LOCAL_PATH, SECRETS_ENCRYPTION_KEY, POSTGRES_*
//
// Three idempotent steps:
//   1. settings  `storage.provider` (from `storage.activeProvider`, else STORAGE_PROVIDER) and
//                `storage.drivers.<id>` (from the `storage_provider_credentials` rows, else the S3_*
//                variables; `drivers.local.rootDir` from BACKUP_LOCAL_PATH). Set-if-absent: a value an
//                administrator saved since is never overwritten.
//   2. secret    the active provider's secret access key into the credential store (`storage/default`):
//                the RETRO-B4 `storage` purpose (legacy cipher -> credential store, round-trip checked),
//                set-if-absent; else AWS_SECRET_ACCESS_KEY when the provider had no credential row.
//   3. report    `storage_objects` per recorded provider, and every conflict (see the warnings).
//
// The legacy table `storage_provider_credentials` and the old `activeProvider` key are read, never
// modified: reverting the release restores the old reader. Nothing is logged but counts, hints
// (last four characters) and ids. See docs/runbooks/storage-configuration.md.
// =============================================================================

import { config } from 'dotenv';
import { resolve } from 'path';
import { Client } from 'pg';

import { CredentialsService, deriveHint } from '@marinoscar/platform-api/credentials';

import { buildBaseDatabaseUrl } from '../src/config/database-url.util';
import { decryptSecret } from '../src/legacy/legacy-secret-cipher';
import { applyPlan, buildPlan, formatPlan } from '../src/legacy/legacy-credentials-migration';
import { PgLegacySource, PgSettingsStore } from '../src/legacy/legacy-credentials-pg';
import {
  S3_FAMILY_DRIVER_IDS,
  loadStorageSettingsInput,
  planStorageSettings,
  writeStorageSettingsPlan,
} from '../src/legacy/legacy-storage-settings-migration';
import { PrismaService } from '../src/prisma/prisma.service';
import '../src/platform/credentials/credential-purposes.manifest';

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
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    console.log(apply ? 'APPLY' : 'DRY RUN');

    // 1. settings
    const input = await loadStorageSettingsInput(client, process.env);
    const plan = planStorageSettings(input);
    console.log(`objects: ${Object.entries(input.objectCounts).map(([p, n]) => `${p}=${n}`).join(', ') || 'none'}`);
    console.log(`credential rows: ${input.rows.map((r) => r.provider).join(', ') || 'none'}`);
    console.log(`settings: provider "${plan.provider}"${plan.changed ? '' : ' (nothing to write)'}`);
    for (const line of plan.changes) console.log(`  change  ${line}`);
    for (const line of plan.warnings) console.log(`  WARNING ${line}`);

    // 2. secret
    const credentials = new CredentialsService(prisma as never);
    const settingsStore = new PgSettingsStore(client);
    const source = new PgLegacySource(client, settingsStore);
    const secretPlan = await buildPlan(['storage'], source, credentials, settingsStore, decryptSecret, { onlyIfAbsent: true });
    for (const line of formatPlan(secretPlan)) console.log(line);
    if (secretPlan.undecryptable.length > 0) {
      console.error(`ERROR: SECRETS_ENCRYPTION_KEY cannot decrypt: ${secretPlan.undecryptable.join(', ')}. Nothing was written.`);
      process.exitCode = 1;
      return;
    }
    const isS3Family = (S3_FAMILY_DRIVER_IDS as readonly string[]).includes(plan.provider);
    const activeRow = input.rows.find((row) => row.provider === plan.provider);
    const envSecret = (process.env['AWS_SECRET_ACCESS_KEY'] ?? '').trim();
    const useEnvSecret = isS3Family && !activeRow?.hasSecret && envSecret !== '';
    const storedSecret = await credentials.getSecret('storage', 'default');
    if (useEnvSecret) {
      console.log(
        storedSecret
          ? '  secret  storage/default already stored; AWS_SECRET_ACCESS_KEY is not used'
          : `  secret  storage/default from AWS_SECRET_ACCESS_KEY hint=${deriveHint(envSecret)}`,
      );
    }

    if (!apply) {
      console.log('Dry run only. Re-run with --apply to write.');
      return;
    }

    const wrote = await writeStorageSettingsPlan(client, plan);
    console.log(`settings: ${wrote ? 'written' : 'unchanged'}`);
    const result = await applyPlan(secretPlan, credentials, settingsStore, decryptSecret, (line) => console.log(`  ${line}`));
    console.log(`secret: written ${result.written}, unchanged ${result.unchanged}, skipped ${result.skipped}`);
    if (useEnvSecret && !storedSecret && result.written === 0) {
      await credentials.setSecret('storage', 'default', envSecret, { label: 'Storage secret access key' });
      if ((await credentials.getSecret('storage', 'default')) !== envSecret) {
        throw new Error('Round trip failed for storage/default (from AWS_SECRET_ACCESS_KEY).');
      }
      console.log(`secret: storage/default written from AWS_SECRET_ACCESS_KEY hint=${deriveHint(envSecret)}`);
    }
    console.log('Done. Check /admin/settings/storage ("Test connection") and the Doctor storage checks.');
  } finally {
    await prisma.$disconnect();
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
