// =============================================================================
// Carry the notification purge settings into the platform retention settings (RETRO-C8, #608)
// =============================================================================
//
//   npm run settings:migrate-notification-retention --workspace=api            # dry run: prints the plan
//   npm run settings:migrate-notification-retention --workspace=api -- --apply # writes it
//
// notifications.retentionDays -> retention.appNotifications.days and
// notifications.purgeEnabled -> retention.appNotifications.enabled, only while the
// retention entry is absent (idempotent: a second run reports `keep`). The old
// keys stay in the row until RETRO-C11. Rollback: none needed (revert the PR;
// the old keys were never touched).
// =============================================================================

import { config } from 'dotenv';
import { resolve } from 'path';
import { Client } from 'pg';

import { buildBaseDatabaseUrl } from '../src/config/database-url.util';
import { planNotificationRetentionCarryOver } from '../src/platform/jobs/notification-retention-settings.migration';

config({ path: resolve(__dirname, '..', '.env') });
config({ path: resolve(__dirname, '..', '..', '..', 'infra', 'compose', '.env') });

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const client = new Client({ connectionString: process.env['DATABASE_URL'] ?? buildBaseDatabaseUrl() });
  await client.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query<{ value: unknown }>(
      `SELECT value FROM system_settings WHERE key = 'global' FOR UPDATE`,
    );
    if (row.rows.length === 0) {
      console.log('system_settings.global: no row; nothing to carry over (the policies read as their defaults).');
      await client.query('ROLLBACK');
      return;
    }
    const { change: c, next } = planNotificationRetentionCarryOver(row.rows[0]!.value);
    console.log(
      `${c.action.padEnd(5)} retention.${c.key}  <- notifications.retentionDays / notifications.purgeEnabled` +
        (c.days === null ? '' : ` (days ${c.days}, enabled ${String(c.enabled)})`),
    );
    const writes = c.action === 'write' ? 1 : 0;
    if (!apply || writes === 0) {
      await client.query('ROLLBACK');
      console.log(apply ? 'Nothing to write.' : `Dry run: ${writes} change(s). Re-run with --apply to write them.`);
      return;
    }
    await client.query(
      `UPDATE system_settings SET value = $1::jsonb, version = version + 1, updated_at = now() WHERE key = 'global'`,
      [JSON.stringify(next)],
    );
    await client.query('COMMIT');
    console.log(`Wrote ${writes} change(s).`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
