// =============================================================================
// Keep an exporting deployment exporting after RETRO-T2 (#625)
// =============================================================================
//
//   npm run settings:migrate-telemetry --workspace=api            # dry run: prints the plan
//   npm run settings:migrate-telemetry --workspace=api -- --apply # writes it
//
// When `OTEL_ENABLED=true` and the `global` row has no `telemetry` namespace yet,
// writes the platform defaults with `enabled: true`, so the export gate opens
// again (once a GreptimeDB store is configured). Idempotent: a second run, or a
// run after an administrator saved /admin/settings/telemetry, reports `keep`.
// Rollback: turn telemetry off at /admin/settings/telemetry.
// =============================================================================

import { config } from 'dotenv';
import { resolve } from 'path';
import { Client } from 'pg';

import { buildBaseDatabaseUrl } from '../src/config/database-url.util';
import { planTelemetrySettingsCarryOver } from '../src/platform/telemetry/telemetry-settings.migration';

config({ path: resolve(__dirname, '..', '.env') });
config({ path: resolve(__dirname, '..', '..', '..', 'infra', 'compose', '.env') });

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const otelEnabled = process.env['OTEL_ENABLED'] === 'true';
  const client = new Client({ connectionString: process.env['DATABASE_URL'] ?? buildBaseDatabaseUrl() });
  await client.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query<{ value: unknown }>(
      `SELECT value FROM system_settings WHERE key = 'global' FOR UPDATE`,
    );
    if (row.rows.length === 0) {
      console.log('system_settings.global: no row; telemetry reads as its defaults (off). Nothing to do.');
      await client.query('ROLLBACK');
      return;
    }
    const { change, next } = planTelemetrySettingsCarryOver(row.rows[0]!.value, otelEnabled);
    console.log(`${change.action.padEnd(5)} telemetry  (${change.reason})`);
    if (!apply || change.action !== 'write') {
      await client.query('ROLLBACK');
      console.log(apply || change.action !== 'write' ? 'Nothing to write.' : 'Dry run. Re-run with --apply to write it.');
      return;
    }
    await client.query(
      `UPDATE system_settings SET value = $1::jsonb, version = version + 1, updated_at = now() WHERE key = 'global'`,
      [JSON.stringify(next)],
    );
    await client.query('COMMIT');
    console.log('Wrote telemetry.enabled = true.');
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
