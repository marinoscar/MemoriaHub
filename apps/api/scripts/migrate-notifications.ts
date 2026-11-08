// =============================================================================
// Move MemoriaHub's notification state onto the platform slice (RETRO-D3, #576)
// =============================================================================
//
//   npm run notifications:migrate-legacy --workspace=api                # dry run (the default)
//   npm run notifications:migrate-legacy --workspace=api -- --dry-run   # same, explicit
//   npm run notifications:migrate-legacy --workspace=api -- --apply
//
// Copies push subscriptions, broadcasts, the inbox and the delivery log from the
// `mh_legacy_*` tables into the platform's, and rewrites the notification policy
// and every user's preferences into the platform's shape (src/legacy/legacy-notifications-migration.ts).
// `--apply` refuses until the platform inbox has the fold columns (platform migration
// 0041, i.e. the release that mounts the platform notifications slice is deployed) and
// while a legacy broadcast is scheduled or sending. One transaction; re-running copies
// nothing twice; the legacy tables are never modified. The VAPID private key moves with
// `npm run credentials:migrate-legacy --workspace=api -- --purpose push_vapid --apply`.
// Runbook: docs/runbooks/notifications-cutover.md. Needs the API's database settings (POSTGRES_*).
// =============================================================================

import { config } from 'dotenv';
import { resolve } from 'path';
import { Client } from 'pg';

import { buildBaseDatabaseUrl } from '../src/config/database-url.util';
import {
  LEGACY_NOTIFICATIONS_SETTINGS_KEY,
  LEGACY_PREFERENCES_ROW_KEY,
  applyNotificationsCarryOver,
  planNotificationsCarryOver,
} from '../src/legacy/legacy-notifications-migration';

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
  const client = new Client({ connectionString: process.env['DATABASE_URL'] ?? buildBaseDatabaseUrl() });
  await client.connect();
  try {
    console.log(apply ? 'APPLY' : 'DRY RUN');
    const plan = await planNotificationsCarryOver(client);
    console.log(`platform inbox fold columns (0041): ${plan.foldColumns ? 'present' : 'MISSING (apply refused)'}`);
    const line = (name: string, c: { legacy: number; alreadyCopied: number }) =>
      console.log(`${name}: ${c.legacy} legacy, ${c.alreadyCopied} already copied, ${c.legacy - c.alreadyCopied} to copy`);
    line('push_subscriptions', plan.pushSubscriptions);
    line('broadcasts', plan.broadcasts);
    line('deliveries', plan.deliveries);
    line('inbox', plan.inbox);
    for (const t of plan.inbox.byType) {
      console.log(`  ${t.type.padEnd(34)} -> ${t.eventKey.padEnd(28)} total ${t.total}, live ${t.live}, unread ${t.unread}`);
    }
    console.log(`policy: ${plan.system.changed ? 'needs rewrite' : 'already in the platform shape'}`);
    for (const c of plan.system.changes) console.log(`  change  ${c}`);
    for (const w of plan.system.warnings) console.log(`  WARNING ${w}`);
    console.log(
      `preferences: ${plan.users.legacyShape} users in the legacy shape, ${plan.users.withMutes} with a mute, ` +
        `${plan.users.withWorkflowMicroRuns} with workflowMicroRuns`,
    );
    if (plan.broadcasts.inFlight.length > 0) {
      console.error(`ERROR: legacy broadcasts in flight: ${plan.broadcasts.inFlight.map((b) => `${b.id}:${b.status}`).join(', ')}`);
      process.exitCode = 1;
      return;
    }
    if (!apply) {
      console.log('Dry run only. Re-run with --apply in the cutover window to write.');
      return;
    }
    const r = await applyNotificationsCarryOver(client);
    console.log(
      `copied: push_subscriptions ${r.pushSubscriptions}, broadcasts ${r.broadcasts}, inbox ${r.inbox} ` +
        `(${r.inboxRetiredKeys} older live windows retired), deliveries ${r.deliveries}`,
    );
    console.log(
      `settings: policy ${r.systemSettingsWritten ? `rewritten (original under "${LEGACY_NOTIFICATIONS_SETTINGS_KEY}")` : 'unchanged'}, ` +
        `${r.usersRewritten} users' preferences rewritten (originals in system_settings "${LEGACY_PREFERENCES_ROW_KEY}")`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
