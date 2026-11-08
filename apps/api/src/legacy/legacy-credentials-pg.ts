// =============================================================================
// Postgres adapters for the legacy credential migration (RETRO-B4, #617)
// =============================================================================
//
// The reading side (`PgLegacySource`) and the settings writer (`PgSettingsStore`) over a plain `pg`
// client, so the CLI needs no Nest context. Ciphertext is returned to the caller in memory only.
// =============================================================================

import type { Client } from 'pg';

import type { LegacyItem, LegacySource, MigrationPurpose, SettingsStore } from './legacy-credentials-migration';

const GLOBAL_KEY = 'global';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function walk(root: unknown, path: string[]): unknown {
  let node = root;
  for (const key of path) {
    if (!isPlainObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

export class PgSettingsStore implements SettingsStore {
  constructor(private readonly client: Client) {}

  async get(path: string[]): Promise<unknown> {
    const res = await this.client.query<{ value: unknown }>(`SELECT value FROM system_settings WHERE key = $1`, [GLOBAL_KEY]);
    return walk(res.rows[0]?.value, path);
  }

  async setIfAbsent(path: string[], value: Record<string, unknown>): Promise<string[]> {
    await this.client.query('BEGIN');
    try {
      const res = await this.client.query<{ value: unknown }>(
        `SELECT value FROM system_settings WHERE key = $1 FOR UPDATE`,
        [GLOBAL_KEY],
      );
      if (res.rows.length === 0) {
        throw new Error('The system_settings "global" row does not exist yet; start the API once, then re-run.');
      }
      const doc: Record<string, unknown> = isPlainObject(res.rows[0]!.value) ? { ...res.rows[0]!.value } : {};
      let node = doc;
      for (const key of path) {
        const next = isPlainObject(node[key]) ? { ...(node[key] as Record<string, unknown>) } : {};
        node[key] = next;
        node = next;
      }
      const written: string[] = [];
      for (const [key, v] of Object.entries(value)) {
        if (node[key] === undefined) {
          node[key] = v;
          written.push(key);
        }
      }
      if (written.length > 0) {
        await this.client.query(
          `UPDATE system_settings SET value = $2::jsonb, version = version + 1, updated_at = now() WHERE key = $1`,
          [GLOBAL_KEY, JSON.stringify(doc)],
        );
      }
      await this.client.query('COMMIT');
      return written;
    } catch (err) {
      await this.client.query('ROLLBACK');
      throw err;
    }
  }
}

export class PgLegacySource implements LegacySource {
  constructor(
    private readonly client: Client,
    private readonly settings: SettingsStore,
  ) {}

  async load(purpose: MigrationPurpose): Promise<LegacyItem[]> {
    switch (purpose) {
      case 'face':
        return this.faceOrGeo('face', 'face_provider_credentials', 'face_provider', (p) =>
          p === 'compreface' ? ['face', 'providers', p] : null,
        );
      case 'geo':
        return this.faceOrGeo('geo', 'geo_provider_credentials', 'geo_provider', (p) => (p === 'google' ? ['geo', 'google'] : null));
      case 'storage':
        return this.storage();
      case 'ses':
        return this.ses();
      case 'smtp':
        return this.smtp();
      case 'push_vapid':
        return this.pushVapid();
    }
  }

  private async faceOrGeo(
    purpose: 'face' | 'geo',
    table: string,
    credentialPurpose: string,
    settingsPath: (provider: string) => string[] | null,
  ): Promise<LegacyItem[]> {
    const res = await this.client.query<{
      id: string;
      provider: string;
      encrypted_key: string;
      base_url: string | null;
      enabled: boolean;
    }>(`SELECT id::text AS id, provider, encrypted_key, base_url, enabled FROM ${table} ORDER BY provider`);
    return res.rows.map((row) => {
      const path = settingsPath(row.provider);
      return {
        purpose,
        rowId: row.id,
        label: `${table}/${row.provider}`,
        ciphertext: row.encrypted_key,
        target: { purpose: credentialPurpose, name: row.provider },
        ...(path
          ? { settings: { path, value: { baseUrl: row.base_url, enabled: row.enabled } } }
          : { note: 'no settings slot for this provider; secret only' }),
      };
    });
  }

  private async storage(): Promise<LegacyItem[]> {
    // The platform's `storage.provider` once RETRO-D1's settings carry-over wrote it, else the legacy one.
    const active = String(
      (await this.settings.get(['storage', 'provider'])) ??
        (await this.settings.get(['storage', 'activeProvider'])) ??
        process.env['STORAGE_PROVIDER'] ??
        's3',
    );
    const res = await this.client.query<{ id: string; provider: string; encrypted_key: string }>(
      `SELECT id::text AS id, provider, encrypted_key FROM storage_provider_credentials ORDER BY provider`,
    );
    return res.rows.map((row) => {
      const isActive = row.provider === active;
      return {
        purpose: 'storage' as const,
        rowId: row.id,
        label: `storage_provider_credentials/${row.provider}`,
        ciphertext: row.encrypted_key,
        target: isActive ? { purpose: 'storage', name: 'default' } : null,
        ...(isActive
          ? {}
          : { note: `not the active provider (${active}); the platform's S3 drivers share one secret (storage/default)` }),
      };
    });
  }

  private async ses(): Promise<LegacyItem[]> {
    // SES reuses the S3 provider's AWS key pair; the secret half becomes `email_ses/default`.
    const res = await this.client.query<{ id: string; encrypted_key: string }>(
      `SELECT id::text AS id, encrypted_key FROM storage_provider_credentials WHERE provider = 's3'`,
    );
    return res.rows.map((row) => ({
      purpose: 'ses' as const,
      rowId: row.id,
      label: 'storage_provider_credentials/s3 (SES reuse)',
      ciphertext: row.encrypted_key,
      target: { purpose: 'email_ses', name: 'default' },
    }));
  }

  private async smtp(): Promise<LegacyItem[]> {
    const value = await this.settings.get(['email', 'smtpPassword']);
    return typeof value === 'string' && value
      ? [
          {
            purpose: 'smtp' as const,
            rowId: 'system_settings.global#email.smtpPassword',
            label: 'system_settings.global email.smtpPassword',
            ciphertext: value,
            target: { purpose: 'smtp', name: 'default' },
          },
        ]
      : [];
  }

  private async pushVapid(): Promise<LegacyItem[]> {
    const res = await this.client.query<{ value: unknown }>(`SELECT value FROM system_settings WHERE key = 'webPush'`);
    const value = isPlainObject(res.rows[0]?.value) ? (res.rows[0]!.value as Record<string, unknown>)['privateKeyEncrypted'] : undefined;
    return typeof value === 'string' && value
      ? [
          {
            purpose: 'push_vapid' as const,
            rowId: 'system_settings.webPush#privateKeyEncrypted',
            label: 'system_settings webPush privateKeyEncrypted',
            ciphertext: value,
            target: { purpose: 'push_vapid', name: 'default' },
          },
        ]
      : [];
  }
}
