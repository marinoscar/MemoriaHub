// =============================================================================
// Import the pre-platform public shares as link grants (RETRO-I4, #578)
// =============================================================================
//
//   npm run sharing:import-media-shares --workspace=api                # dry run (the default): counts, zero writes
//   npm run sharing:import-media-shares --workspace=api -- --dry-run   # same, explicit
//   npm run sharing:import-media-shares --workspace=api -- --apply
//
// Every `media_shares` row becomes a link grant through the sharing slice's
// `importLegacyToken` (token stored as `lnk_<old token>`, hashed and encrypted;
// needs SECRETS_ENCRYPTION_KEY and the API's database settings, POSTGRES_*). One
// transaction on the system client (reason `migration-tooling`); idempotent.
// Logic: src/legacy/media-shares-import.ts. Procedure and release order (deploy,
// THIS import, then `npm run prisma:migrate` drops the table):
// docs/runbooks/circles-to-groups.md, "Public shares to link grants".
// =============================================================================

import { config } from 'dotenv';
import { resolve } from 'path';

import { assertEncryptionKeyConfigured } from '@marinoscar/platform-api/core';
import { importLegacyToken } from '@marinoscar/platform-api/sharing';

import '../src/app-registrations/sharing';
import { applyMediaSharesImport, planMediaSharesImport } from '../src/legacy/media-shares-import';
import { PrismaSystemService } from '../src/prisma/prisma-system.service';

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
  const prisma = new PrismaSystemService();
  await prisma.$connect();
  try {
    console.log(apply ? 'APPLY' : 'DRY RUN');
    await prisma.runAsSystem(
      'migration-tooling',
      async (tx) => {
        const plan = await planMediaSharesImport(tx);
        if (!plan) {
          console.log('media_shares does not exist (already dropped): nothing to import.');
          return;
        }
        console.log(
          `media_shares: ${plan.total} (active ${plan.byState.active}, expired ${plan.byState.expired}, ` +
            `revoked ${plan.byState.revoked}; media_item ${plan.byTargetType.media_item}, album ${plan.byTargetType.album})`,
        );
        console.log(`  already imported ${plan.alreadyImported.size}, to import ${plan.toImport.length}, invalid ${plan.invalid.length}`);
        for (const bad of plan.invalid) console.log(`  INVALID ${bad.id}: ${bad.reason} (not imported; the contract migration will refuse until it is resolved)`);
        if (!apply) {
          console.log('Dry run only. Re-run with --apply to write.');
          return;
        }
        assertEncryptionKeyConfigured();
        const result = await applyMediaSharesImport(tx, plan, importLegacyToken);
        console.log(
          `imported ${result.imported}, already there ${result.skipped}, invalid ${result.invalid}, ` +
            `share_expiring notifications re-keyed ${result.rekeyedNotifications}`,
        );
      },
      { timeout: 10 * 60 * 1000 },
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
