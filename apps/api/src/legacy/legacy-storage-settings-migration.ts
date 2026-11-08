// =============================================================================
// Storage configuration carry-over onto the platform storage slice (RETRO-D1, #563)
// =============================================================================
//
// Before RETRO-D1 MemoriaHub configured object storage in three places:
//
//   storage.activeProvider            the provider of new uploads (`s3`, `r2`, `local`)
//   storage_provider_credentials      one row per provider: access key id, region, bucket,
//                                     endpoint (plaintext) and the secret (legacy cipher)
//   S3_* / AWS_* / STORAGE_PROVIDER /  the bootstrap defaults, used for a provider without a
//   BACKUP_LOCAL_PATH                 credential row, and the local provider's root
//
// The platform reads `storage.provider`, `storage.drivers.<id>` (non-secret settings, validated by
// each driver) and the credential store. Since platform 0.1.0-next.28 (EAB #1124) every S3-family
// driver keeps its secret at its OWN address `storage/<driverId>` (falling back to the shared
// `storage/default` only while its own is empty), so each legacy provider's secret is carried to its
// own driver and a deployment with objects on two providers with different key pairs keeps reading
// both. This module computes the settings half and says which drivers take
// `AWS_SECRET_ACCESS_KEY`; the secret half of the credential rows is the RETRO-B4 credential
// migration's `storage` purpose (`legacy-credentials-migration.ts`, per driver), which
// `scripts/migrate-storage-settings.ts` runs alongside.
//
// RULES (each is tested):
//   - Dry run by default; `--apply` is explicit.
//   - SET-IF-ABSENT: `provider` is written only when the row has none, and a driver field only when
//     it is absent or empty. A value an administrator saved after the cutover is never overwritten,
//     so a re-run changes nothing.
//   - The old `activeProvider` key, `insights` and `trash` are left as they are.
//   - `storage_provider_credentials` is read, never modified (rollback keeps working); it is dropped
//     in a later release.
//   - No secret is read here. The access key id is not a secret.
//   - Conflicts are WARNINGS with the counts an operator needs: a provider id no driver serves, and
//     an S3-family driver that holds objects (or is active) but has no legacy secret to carry.
// =============================================================================

import type { Client } from 'pg';

/** One `storage_provider_credentials` row, without its secret. */
export interface LegacyStorageCredentialRow {
  provider: string;
  accessKeyId: string | null;
  region: string | null;
  bucket: string | null;
  endpoint: string | null;
  enabled: boolean;
  /** Whether the row carries a non-empty encrypted secret. */
  hasSecret: boolean;
}

/** What the deployment's environment still says (the variables RETRO-D1 stops reading). */
export interface LegacyStorageEnv {
  STORAGE_PROVIDER?: string;
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ENDPOINT?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  BACKUP_LOCAL_PATH?: string;
}

/** Everything the plan is computed from. */
export interface StorageSettingsInput {
  /** The stored `storage` namespace value (any shape), or undefined. */
  stored: unknown;
  rows: LegacyStorageCredentialRow[];
  env: LegacyStorageEnv;
  /** `storage_objects` row counts per recorded provider. */
  objectCounts: Record<string, number>;
}

/** The computed change. */
export interface StorageSettingsPlan {
  /** The provider the platform will use for new uploads. */
  provider: string;
  /** Whether `provider` would be written (the row has none). */
  writeProvider: boolean;
  /** Per driver, the fields that would be written (set-if-absent). */
  drivers: Record<string, Record<string, unknown>>;
  /**
   * The S3-family drivers whose settings come from the `S3_*` / `AWS_ACCESS_KEY_ID` environment (no
   * credential row): `AWS_SECRET_ACCESS_KEY`, when set, is their secret (`storage/<driverId>`).
   */
  envSecretDrivers: string[];
  /** Human-readable lines: what changes. */
  changes: string[];
  /** Human-readable lines: what an operator must look at. */
  warnings: string[];
  /** Whether anything would be written. */
  changed: boolean;
}

/** The S3-family driver ids the platform ships (each keeps its secret at `storage/<driverId>`). */
export const S3_FAMILY_DRIVER_IDS = ['s3', 'r2', 's3compatible'] as const;
/** Every driver id this deployment registers. */
export const KNOWN_DRIVER_IDS = [...S3_FAMILY_DRIVER_IDS, 'local'] as const;

const R2_ENDPOINT = /^https?:\/\/([a-z0-9]+)\.r2\.cloudflarestorage\.com\/?$/i;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const text = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '');

/** The driver settings a legacy S3-family provider maps to. */
export function s3FamilySettingsOf(
  provider: string,
  source: { accessKeyId?: string | null; region?: string | null; bucket?: string | null; endpoint?: string | null },
): Record<string, unknown> {
  const endpoint = text(source.endpoint);
  const settings: Record<string, unknown> = {
    bucket: text(source.bucket),
    region: text(source.region),
    endpoint,
    accessKeyId: text(source.accessKeyId),
    // The legacy resolver forced path-style addressing whenever an endpoint was set.
    forcePathStyle: endpoint !== '' ? true : null,
  };
  if (provider === 'r2') {
    const match = R2_ENDPOINT.exec(endpoint);
    settings['accountId'] = match ? match[1] : '';
    // R2 signs with "auto"; a region the legacy row carried for R2 was the S3 default, never meaningful.
    if (settings['region'] === 'us-east-1') settings['region'] = '';
  }
  return settings;
}

/**
 * Computes the settings carry-over. Pure: reads nothing, writes nothing.
 */
export function planStorageSettings(input: StorageSettingsInput): StorageSettingsPlan {
  const stored = isRecord(input.stored) ? input.stored : {};
  const storedDrivers = isRecord(stored['drivers']) ? stored['drivers'] : {};
  const changes: string[] = [];
  const warnings: string[] = [];

  const legacyActive =
    text(typeof stored['activeProvider'] === 'string' ? stored['activeProvider'] : '') ||
    text(input.env.STORAGE_PROVIDER) ||
    's3';
  const hasProvider = typeof stored['provider'] === 'string' && stored['provider'] !== '';
  const provider = hasProvider ? (stored['provider'] as string) : legacyActive;
  if (!(KNOWN_DRIVER_IDS as readonly string[]).includes(provider)) {
    warnings.push(`provider "${provider}" is not a registered driver (${KNOWN_DRIVER_IDS.join(', ')}); fix it at /admin/settings/storage`);
  }
  if (!hasProvider) changes.push(`storage.provider = "${provider}" (from ${text(stored['activeProvider'] as string) ? 'storage.activeProvider' : input.env.STORAGE_PROVIDER ? 'STORAGE_PROVIDER' : 'the default'})`);

  // The desired settings per driver: the credential rows first, then the environment for an S3
  // provider with no row (what the legacy resolver fell back to), then the local root.
  const desired: Record<string, Record<string, unknown>> = {};
  for (const row of input.rows) {
    if (row.provider === 'local') continue;
    if (!(S3_FAMILY_DRIVER_IDS as readonly string[]).includes(row.provider)) {
      warnings.push(`storage_provider_credentials row "${row.provider}" names no platform driver; it is not carried over`);
      continue;
    }
    if (!row.enabled) warnings.push(`storage_provider_credentials row "${row.provider}" is disabled; its settings are carried over all the same`);
    desired[row.provider] = s3FamilySettingsOf(row.provider, row);
  }
  const rowIds = new Set(input.rows.map((row) => row.provider));
  const envS3 = {
    bucket: input.env.S3_BUCKET,
    region: input.env.S3_REGION,
    endpoint: input.env.S3_ENDPOINT,
    accessKeyId: input.env.AWS_ACCESS_KEY_ID,
  };
  const envHasS3 = [envS3.bucket, envS3.accessKeyId].some((v) => text(v) !== '');
  const envSecretDrivers: string[] = [];
  for (const id of new Set([provider, ...Object.keys(input.objectCounts)])) {
    if ((S3_FAMILY_DRIVER_IDS as readonly string[]).includes(id) && !rowIds.has(id) && envHasS3) {
      desired[id] = s3FamilySettingsOf(id, envS3);
      envSecretDrivers.push(id);
      changes.push(`drivers.${id}: from the S3_* / AWS_ACCESS_KEY_ID environment (no credential row)`);
    }
  }
  if (provider === 'local' || rowIds.has('local') || (input.objectCounts['local'] ?? 0) > 0 || text(input.env.BACKUP_LOCAL_PATH) !== '') {
    desired['local'] = { rootDir: text(input.env.BACKUP_LOCAL_PATH) };
  }

  // Set-if-absent against what is stored.
  const drivers: Record<string, Record<string, unknown>> = {};
  for (const [id, want] of Object.entries(desired)) {
    const have = isRecord(storedDrivers[id]) ? storedDrivers[id] : {};
    const write: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(want)) {
      const current = have[key];
      const empty = current === undefined || current === null || current === '';
      if (empty && value !== '' && value !== null) write[key] = value;
    }
    if (Object.keys(write).length > 0) {
      drivers[id] = write;
      changes.push(`drivers.${id}: set ${Object.keys(write).join(', ')}`);
    }
  }

  for (const [id, count] of Object.entries(input.objectCounts)) {
    if (count > 0 && !(KNOWN_DRIVER_IDS as readonly string[]).includes(id)) {
      warnings.push(`${count} storage_objects rows record provider "${id}", which no driver serves; they are read through the active driver`);
    }
  }
  // Every S3-family driver that will serve rows (it holds objects, or takes new uploads) needs its own
  // secret: a credential row with one, else AWS_SECRET_ACCESS_KEY for an environment-backed driver.
  const envSecret = text(input.env.AWS_SECRET_ACCESS_KEY) !== '';
  const serving = new Set([provider, ...Object.keys(input.objectCounts).filter((id) => (input.objectCounts[id] ?? 0) > 0)]);
  for (const id of S3_FAMILY_DRIVER_IDS) {
    if (!serving.has(id)) continue;
    const hasRowSecret = input.rows.some((r) => r.provider === id && r.hasSecret);
    if (!hasRowSecret && !(envSecretDrivers.includes(id) && envSecret)) {
      warnings.push(
        `the ${id === provider ? 'active ' : ''}provider "${id}"${(input.objectCounts[id] ?? 0) > 0 ? ` (${input.objectCounts[id]} objects)` : ''} ` +
          `has no legacy secret (no credential row with one, no AWS_SECRET_ACCESS_KEY); enter it at /admin/settings/storage`,
      );
    }
  }

  return {
    provider,
    writeProvider: !hasProvider,
    drivers,
    envSecretDrivers,
    changes,
    warnings,
    changed: !hasProvider || Object.keys(drivers).length > 0,
  };
}

/** Folds `plan` into the stored `storage` value (set-if-absent). Pure. */
export function applyStorageSettingsPlan(stored: unknown, plan: StorageSettingsPlan): Record<string, unknown> {
  const next: Record<string, unknown> = isRecord(stored) ? { ...stored } : {};
  if (plan.writeProvider) next['provider'] = plan.provider;
  const drivers: Record<string, unknown> = isRecord(next['drivers']) ? { ...next['drivers'] } : {};
  for (const [id, write] of Object.entries(plan.drivers)) {
    drivers[id] = { ...(isRecord(drivers[id]) ? drivers[id] : {}), ...write };
  }
  if (Object.keys(drivers).length > 0) next['drivers'] = drivers;
  return next;
}

// ---- Postgres ----------------------------------------------------------------------

const GLOBAL_KEY = 'global';

/** Reads the inputs from the database (and `env`). Never reads a secret. */
export async function loadStorageSettingsInput(client: Client, env: LegacyStorageEnv): Promise<StorageSettingsInput> {
  const settings = await client.query<{ value: unknown }>(`SELECT value FROM system_settings WHERE key = $1`, [GLOBAL_KEY]);
  const doc = settings.rows[0]?.value;
  const rows = await client.query<{
    provider: string;
    access_key_id: string | null;
    region: string | null;
    bucket: string | null;
    endpoint: string | null;
    enabled: boolean;
    has_secret: boolean;
  }>(
    `SELECT provider, access_key_id, region, bucket, endpoint, enabled,
            (encrypted_key IS NOT NULL AND encrypted_key <> '') AS has_secret
       FROM storage_provider_credentials ORDER BY provider`,
  );
  // A count across organizations: the API's own role is the table owner (row-level security is
  // forced), so the read sets the bypass flag transaction-locally, as every dump does.
  await client.query('BEGIN');
  let counts: Array<{ provider: string; n: string }>;
  try {
    await client.query(`SELECT set_config('app.rls_bypass', 'on', true)`);
    counts = (
      await client.query<{ provider: string; n: string }>(
        `SELECT storage_provider AS provider, count(*)::text AS n FROM storage_objects GROUP BY storage_provider`,
      )
    ).rows;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return {
    stored: isRecord(doc) ? doc['storage'] : undefined,
    rows: rows.rows.map((r) => ({
      provider: r.provider,
      accessKeyId: r.access_key_id,
      region: r.region,
      bucket: r.bucket,
      endpoint: r.endpoint,
      enabled: r.enabled,
      hasSecret: r.has_secret,
    })),
    env,
    objectCounts: Object.fromEntries(counts.map((c) => [c.provider, Number(c.n)])),
  };
}

/** Writes the plan (one transaction, the `global` row locked). Returns whether it wrote. */
export async function writeStorageSettingsPlan(client: Client, plan: StorageSettingsPlan): Promise<boolean> {
  if (!plan.changed) return false;
  await client.query('BEGIN');
  try {
    const res = await client.query<{ value: unknown }>(
      `SELECT value FROM system_settings WHERE key = $1 FOR UPDATE`,
      [GLOBAL_KEY],
    );
    if (res.rows.length === 0) {
      throw new Error('The system_settings "global" row does not exist yet; start the API once, then re-run.');
    }
    const doc: Record<string, unknown> = isRecord(res.rows[0]!.value) ? { ...res.rows[0]!.value } : {};
    doc['storage'] = applyStorageSettingsPlan(doc['storage'], plan);
    await client.query(`UPDATE system_settings SET value = $2::jsonb, version = version + 1, updated_at = now() WHERE key = $1`, [
      GLOBAL_KEY,
      JSON.stringify(doc),
    ]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
