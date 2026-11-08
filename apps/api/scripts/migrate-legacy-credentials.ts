// =============================================================================
// Move legacy encrypted secrets into the platform credential store (RETRO-B4, #617)
// =============================================================================
//
//   npm run credentials:migrate-legacy --workspace=api -- --purpose geo            # dry run
//   npm run credentials:migrate-legacy --workspace=api -- --purpose geo --apply
//   npm run credentials:migrate-legacy --workspace=api -- --purpose all            # dry run of every plan
//
// Purposes: face, geo (applicable now); storage, smtp, ses, push_vapid (dry-run plans that
// RETRO-D1/D2/D3 apply when their reader switches). Needs SECRETS_ENCRYPTION_KEY (the key that
// encrypted the legacy rows) and the database settings of the API.
//
// Prints counts, ids and last-4 hints only, NEVER a secret. Exit 1 when a row cannot be decrypted
// (the row id is named) or a round trip fails. The legacy tables are not modified.
// See docs/runbooks/credentials-migration.md.
// =============================================================================

import { config } from 'dotenv';
import { resolve } from 'path';
import { Client } from 'pg';

import { CredentialsService } from '@marinoscar/platform-api/credentials';

import { buildBaseDatabaseUrl } from '../src/config/database-url.util';
import { decryptSecret } from '../src/legacy/legacy-secret-cipher';
import {
  MIGRATION_PURPOSES,
  applyPlan,
  buildPlan,
  formatPlan,
  type MigrationPurpose,
} from '../src/legacy/legacy-credentials-migration';
import { PgLegacySource, PgSettingsStore } from '../src/legacy/legacy-credentials-pg';
import { PrismaService } from '../src/prisma/prisma.service';
// Declares the credential purposes `setSecret` checks.
import '../src/platform/credentials/credential-purposes.manifest';

config({ path: resolve(__dirname, '..', '.env') });
config({ path: resolve(__dirname, '..', '..', '..', 'infra', 'compose', '.env') });

function parseArgs(argv: string[]): { purposes: MigrationPurpose[]; apply: boolean } {
  let apply = false;
  const purposes: MigrationPurpose[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--apply') apply = true;
    else if (arg === '--purpose' || arg.startsWith('--purpose=')) {
      const value = arg.includes('=') ? arg.split('=')[1]! : argv[++i];
      if (value === 'all') purposes.push(...MIGRATION_PURPOSES);
      else if ((MIGRATION_PURPOSES as readonly string[]).includes(value ?? '')) purposes.push(value as MigrationPurpose);
      else throw new Error(`Unknown --purpose "${value}". One of: ${MIGRATION_PURPOSES.join(', ')}, all`);
    } else throw new Error(`Unknown argument "${arg}"`);
  }
  if (purposes.length === 0) throw new Error(`--purpose is required (${MIGRATION_PURPOSES.join(', ')}, all)`);
  return { purposes: [...new Set(purposes)], apply };
}

async function main(): Promise<void> {
  const { purposes, apply } = parseArgs(process.argv.slice(2));

  const client = new Client({ connectionString: buildBaseDatabaseUrl() });
  await client.connect();
  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    // PrismaService is the app's Prisma client; the store only needs its `credential` delegate.
    const credentials = new CredentialsService(prisma as never);
    const settings = new PgSettingsStore(client);
    const source = new PgLegacySource(client, settings);

    const plan = await buildPlan(purposes, source, credentials, settings, decryptSecret);
    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${purposes.join(', ')}`);
    for (const line of formatPlan(plan)) console.log(line);

    if (plan.undecryptable.length > 0) {
      console.error(`ERROR: SECRETS_ENCRYPTION_KEY cannot decrypt: ${plan.undecryptable.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    if (!apply) {
      console.log('Dry run only. Re-run with --apply to write.');
      return;
    }

    const result = await applyPlan(plan, credentials, settings, decryptSecret, (line) => console.log(line));
    console.log(
      `applied: written ${result.written}, unchanged ${result.unchanged}, no secret ${result.noSecret}, ` +
        `skipped ${result.skipped}, settings keys written ${result.settingsWritten}`,
    );
  } finally {
    await prisma.$disconnect();
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
