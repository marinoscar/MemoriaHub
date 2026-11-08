// =============================================================================
// Carry MemoriaHub's email configuration over to the platform email slice (RETRO-D2, #570)
// =============================================================================
//
//   npm run email:migrate-settings --workspace=api              # dry run (also: -- --dry-run)
//   npm run email:migrate-settings --workspace=api -- --apply
//
// One operator command, run once after upgrading to the release that adopts the
// platform email slice (an existing deployment sends nothing until it has run,
// or until an admin saves /admin/settings/email):
//
//   1. the legacy `email.*` block of the `global` settings row (provider, switch,
//      sender, SMTP host/port/TLS/username, SES region) and the S3 storage
//      credential's access key id and region become the platform `email` row
//      (`provider`, `enabled`, `fromAddress`, `fromName`, `transports.smtp`,
//      `transports.ses`), SET-IF-ABSENT key by key;
//   2. the SMTP password (legacy cipher, `email.smtpPassword`) becomes the
//      credential `smtp/default`, and the S3 secret access key the SES transport
//      used to borrow becomes `email_ses/default` (decrypted with the legacy
//      cipher, re-encrypted by the credential store, read back and compared).
//
// Idempotent: a second run writes nothing. The legacy keys and rows are left
// untouched, so reverting the release restores the old readers. Prints key
// paths, counts and last-4 hints only, never a secret. Needs
// SECRETS_ENCRYPTION_KEY and the API's database settings. Exit 1 when a legacy
// secret cannot be decrypted (nothing is written) or a round trip fails.
// See docs/runbooks/email-configuration.md.
// =============================================================================

import { config } from 'dotenv';
import { resolve } from 'path';
import { Client } from 'pg';

import { CredentialsService } from '@marinoscar/platform-api/credentials';
import { EMAIL_SETTINGS_KEY } from '@marinoscar/platform-api/email';

import { buildBaseDatabaseUrl } from '../src/config/database-url.util';
import { decryptSecret } from '../src/legacy/legacy-secret-cipher';
import { applyPlan, buildPlan, formatPlan } from '../src/legacy/legacy-credentials-migration';
import { PgLegacySource, PgSettingsStore } from '../src/legacy/legacy-credentials-pg';
import {
  applyEmailSettingsPlan,
  buildEmailSettingsPlan,
  formatEmailSettingsPlan,
  type EmailRowStore,
  type EmailRowValue,
  type LegacyEmailBlock,
} from '../src/legacy/email-settings-migration';
import { PrismaService } from '../src/prisma/prisma.service';
// Declares the credential purposes `setSecret` checks (smtp, email_ses).
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

/** The platform `email` row over the app's Prisma client. */
function prismaEmailRow(prisma: PrismaService): EmailRowStore {
  return {
    async read() {
      const row = await prisma.systemSettings.findUnique({ where: { key: EMAIL_SETTINGS_KEY }, select: { value: true } });
      return row ? ((row.value ?? {}) as EmailRowValue) : null;
    },
    async write(value) {
      await prisma.systemSettings.upsert({
        where: { key: EMAIL_SETTINGS_KEY },
        update: { value: value as never, version: { increment: 1 } },
        create: { key: EMAIL_SETTINGS_KEY, value: value as never },
      });
    },
  };
}

async function main(): Promise<void> {
  const { apply } = parseArgs(process.argv.slice(2));

  const client = new Client({ connectionString: buildBaseDatabaseUrl() });
  await client.connect();
  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    const credentials = new CredentialsService(prisma as never);
    const settings = new PgSettingsStore(client);
    const source = new PgLegacySource(client, settings);
    const row = prismaEmailRow(prisma);

    const legacy = (await settings.get(['email'])) as LegacyEmailBlock | undefined;
    const s3 = await prisma.storageProviderCredential.findUnique({
      where: { provider: 's3' },
      select: { accessKeyId: true, region: true },
    });

    const settingsPlan = await buildEmailSettingsPlan(legacy, s3 ? { accessKeyId: s3.accessKeyId, region: s3.region } : null, row);
    const secretsPlan = await buildPlan(['smtp', 'ses'], source, credentials, settings, decryptSecret);

    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: email settings and secrets`);
    for (const line of formatEmailSettingsPlan(settingsPlan)) console.log(line);
    for (const line of formatPlan(secretsPlan)) console.log(line);

    if (secretsPlan.undecryptable.length > 0) {
      console.error(`ERROR: SECRETS_ENCRYPTION_KEY cannot decrypt: ${secretsPlan.undecryptable.join(', ')}. Nothing was written.`);
      process.exitCode = 1;
      return;
    }
    if (!apply) {
      console.log('Dry run only. Re-run with --apply to write.');
      return;
    }

    // Secrets first: a row that selects a transport whose secret is missing would
    // send nothing, while a stored secret with no row selecting it is inert.
    const result = await applyPlan(secretsPlan, credentials, settings, decryptSecret, (line) => console.log(line));
    const written = await applyEmailSettingsPlan(settingsPlan, row);
    console.log(
      `applied: secrets written ${result.written}, unchanged ${result.unchanged}, no secret ${result.noSecret}; ` +
        `email row keys set ${written.length}${written.length ? ` (${written.join(', ')})` : ''}`,
    );
    console.log('Verify: Send test email at /admin/settings/email (it goes to your own address).');
  } finally {
    await prisma.$disconnect();
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
