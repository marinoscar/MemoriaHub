import {
  applyStorageSettingsPlan,
  planStorageSettings,
  s3FamilySettingsOf,
  type LegacyStorageCredentialRow,
} from './legacy-storage-settings-migration';

const row = (overrides: Partial<LegacyStorageCredentialRow> & { provider: string }): LegacyStorageCredentialRow => ({
  accessKeyId: 'AKIAEXAMPLE0001',
  region: 'us-east-1',
  bucket: 'bucket-alpha',
  endpoint: null,
  enabled: true,
  hasSecret: true,
  ...overrides,
});

describe('planStorageSettings (RETRO-D1 storage carry-over)', () => {
  it('copies activeProvider to provider and a credential row to drivers.<id>, keeping insights and trash', () => {
    const stored = { activeProvider: 's3', insights: { refreshIntervalHours: 6 }, trash: { retentionDays: 10 } };
    const plan = planStorageSettings({ stored, rows: [row({ provider: 's3' })], env: {}, objectCounts: { s3: 5 } });
    expect(plan.provider).toBe('s3');
    expect(plan.writeProvider).toBe(true);
    expect(plan.drivers['s3']).toEqual({ bucket: 'bucket-alpha', region: 'us-east-1', accessKeyId: 'AKIAEXAMPLE0001' });
    const next = applyStorageSettingsPlan(stored, plan);
    expect(next).toMatchObject({
      provider: 's3',
      activeProvider: 's3',
      insights: { refreshIntervalHours: 6 },
      trash: { retentionDays: 10 },
      drivers: { s3: { bucket: 'bucket-alpha' } },
    });
  });

  it('is set-if-absent: a value saved after the cutover is never overwritten, and a re-run changes nothing', () => {
    const stored = { provider: 'r2', drivers: { r2: { bucket: 'saved-by-admin', accessKeyId: '' } } };
    const plan = planStorageSettings({
      stored,
      rows: [row({ provider: 'r2', bucket: 'legacy-bucket', endpoint: 'https://acct0001.r2.cloudflarestorage.com' })],
      env: {},
      objectCounts: {},
    });
    expect(plan.writeProvider).toBe(false);
    expect(plan.drivers['r2']).toEqual({
      endpoint: 'https://acct0001.r2.cloudflarestorage.com',
      accessKeyId: 'AKIAEXAMPLE0001',
      forcePathStyle: true,
      accountId: 'acct0001',
    });
    const next = applyStorageSettingsPlan(stored, plan);
    expect((next['drivers'] as Record<string, Record<string, unknown>>)['r2']!['bucket']).toBe('saved-by-admin');
    const again = planStorageSettings({ stored: next, rows: [row({ provider: 'r2', bucket: 'legacy-bucket', endpoint: 'https://acct0001.r2.cloudflarestorage.com' })], env: {}, objectCounts: {} });
    expect(again.changed).toBe(false);
  });

  it('falls back to the S3_* variables for a provider with no credential row, and to BACKUP_LOCAL_PATH for local', () => {
    const plan = planStorageSettings({
      stored: {},
      rows: [],
      env: { STORAGE_PROVIDER: 's3', S3_BUCKET: 'env-bucket', S3_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'AKIAENV', BACKUP_LOCAL_PATH: '/srv/media' },
      objectCounts: { s3: 2, local: 3 },
    });
    expect(plan.provider).toBe('s3');
    expect(plan.drivers['s3']).toMatchObject({ bucket: 'env-bucket', region: 'eu-west-1', accessKeyId: 'AKIAENV' });
    expect(plan.drivers['local']).toEqual({ rootDir: '/srv/media' });
  });

  it('warns when objects live on two S3-family providers with different access keys (one shared secret)', () => {
    const plan = planStorageSettings({
      stored: { activeProvider: 'r2' },
      rows: [row({ provider: 's3', accessKeyId: 'AKIA-ONE' }), row({ provider: 'r2', accessKeyId: 'R2-TWO' })],
      env: {},
      objectCounts: { s3: 10, r2: 20 },
    });
    expect(plan.warnings.join('\n')).toMatch(/share one secret/);
  });

  it('warns about a provider id no driver serves and about a missing secret', () => {
    const plan = planStorageSettings({ stored: { activeProvider: 's3' }, rows: [], env: {}, objectCounts: { gcs: 1 } });
    expect(plan.warnings.join('\n')).toMatch(/"gcs", which no driver serves/);
    expect(plan.warnings.join('\n')).toMatch(/no legacy secret/);
  });

  it('maps the legacy R2 default region away (R2 signs with "auto")', () => {
    expect(s3FamilySettingsOf('r2', { region: 'us-east-1', endpoint: '' })['region']).toBe('');
  });
});
