// =============================================================================
// Two S3-family providers with different keys survive the carry-over (RETRO-D1, #563)
// =============================================================================
//
// The reason PR #660 was held: MemoriaHub deployments keep objects on several
// providers at once (old rows on S3, new ones on R2), each with its OWN key pair.
// On platform 0.1.0-next.27 the S3-family drivers shared one secret
// (`storage/default`), so the rows of the provider that was not active became
// unreadable after the upgrade. Platform 0.1.0-next.28 (EAB #1124) gives each
// driver its own address `storage/<driverId>`, and `storage:migrate-settings`
// now writes each legacy provider's secret there.
//
// This spec runs the REAL carry-over (planner + per-driver secret plan, with the
// legacy cipher), then the REAL platform `StorageConfigService` and
// `StorageProviderRouter` behind MemoriaHub's `StorageProviderResolver`, and
// proves each provider's rows are signed with that provider's own key, whichever
// one is active.
// =============================================================================

import {
  STORAGE_SYSTEM_SETTINGS,
  S3StorageProvider,
  StorageConfigService,
  StorageProviderRouter,
  type StorageProvider,
} from '@marinoscar/platform-api/storage';

import { applyPlan, buildPlan, type CredentialStore, type SettingsStore } from '../../src/legacy/legacy-credentials-migration';
import { PgLegacySource } from '../../src/legacy/legacy-credentials-pg';
import { decryptSecret, encryptSecret } from '../../src/legacy/legacy-secret-cipher';
import {
  applyStorageSettingsPlan,
  planStorageSettings,
  type LegacyStorageCredentialRow,
} from '../../src/legacy/legacy-storage-settings-migration';
import { StorageProviderResolver } from '../../src/platform/storage/storage-provider.resolver';

const KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

const S3_SECRET = 's3-secret-access-key-1111';
const R2_SECRET = 'r2-secret-access-key-2222';

/** The two legacy `storage_provider_credentials` rows (synthetic keys). */
const LEGACY_ROWS = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    provider: 's3',
    access_key_id: 'AKIAS3EXAMPLE0001',
    region: 'us-east-1',
    bucket: 'photos-s3',
    endpoint: null,
    enabled: true,
    secret: S3_SECRET,
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    provider: 'r2',
    access_key_id: 'R2ACCESSKEY0002',
    region: null,
    bucket: 'photos-r2',
    endpoint: 'https://acct0002.r2.cloudflarestorage.com',
    enabled: true,
    secret: R2_SECRET,
  },
];

class MemCredentials implements CredentialStore {
  readonly rows = new Map<string, string>();
  async getSecret(purpose: string, name: string): Promise<string | null> {
    return this.rows.get(`${purpose}/${name}`) ?? null;
  }
  async setSecret(purpose: string, name: string, secret: string | null | undefined): Promise<void> {
    if (secret) this.rows.set(`${purpose}/${name}`, secret);
  }
}

class MemSettings implements SettingsStore {
  constructor(public doc: Record<string, any>) {}
  async get(path: string[]): Promise<unknown> {
    return path.reduce<any>((node, key) => (node && typeof node === 'object' ? node[key] : undefined), this.doc);
  }
  async setIfAbsent(): Promise<string[]> {
    return [];
  }
}

/** A `pg` client answering only the legacy credential-row query `PgLegacySource` sends. */
function legacyClient(rows: Array<{ id: string; provider: string; encrypted_key: string }>) {
  return {
    query: jest.fn(async (sql: string) => {
      if (!/FROM storage_provider_credentials/.test(sql)) throw new Error(`unexpected query: ${sql}`);
      return { rows };
    }),
  };
}

function expected(provider: 's3' | 'r2', secret: string): S3StorageProvider {
  return provider === 's3'
    ? new S3StorageProvider({
        provider: 's3',
        bucket: 'photos-s3',
        region: 'us-east-1',
        accessKeyId: 'AKIAS3EXAMPLE0001',
        secretAccessKey: secret,
        forcePathStyle: false,
        partSize: 10 * 1024 * 1024,
      })
    : new S3StorageProvider({
        provider: 'r2',
        bucket: 'photos-r2',
        region: 'auto',
        endpoint: 'https://acct0002.r2.cloudflarestorage.com',
        accessKeyId: 'R2ACCESSKEY0002',
        secretAccessKey: secret,
        forcePathStyle: true,
        partSize: 10 * 1024 * 1024,
      });
}

const signatureOf = (url: string): string | null => new URL(url).searchParams.get('X-Amz-Signature');
const credentialOf = (url: string): string | null => new URL(url).searchParams.get('X-Amz-Credential');

describe('storage carry-over: two S3-family providers with different keys (RETRO-D1, platform next.28)', () => {
  let savedKey: string | undefined;

  beforeAll(() => {
    savedKey = process.env.SECRETS_ENCRYPTION_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
  });
  beforeEach(() => {
    // Only Date is frozen, so two presigned URLs signed a moment apart are comparable.
    jest.useFakeTimers({
      now: FIXED_NOW,
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'],
    });
  });
  afterEach(() => jest.useRealTimers());

  /** Runs the carry-over exactly as `scripts/migrate-storage-settings.ts --apply` does, in memory. */
  async function carryOver(activeProvider: 's3' | 'r2') {
    const stored = { activeProvider, trash: { retentionDays: 30 } };
    const rows: LegacyStorageCredentialRow[] = LEGACY_ROWS.map((row) => ({
      provider: row.provider,
      accessKeyId: row.access_key_id,
      region: row.region,
      bucket: row.bucket,
      endpoint: row.endpoint,
      enabled: row.enabled,
      hasSecret: true,
    }));
    const plan = planStorageSettings({ stored, rows, env: {}, objectCounts: { s3: 120, r2: 340 } });
    expect(plan.warnings).toEqual([]);
    const storage = applyStorageSettingsPlan(stored, plan);

    const credentials = new MemCredentials();
    const settings = new MemSettings({ storage });
    const source = new PgLegacySource(
      legacyClient(LEGACY_ROWS.map((row) => ({ id: row.id, provider: row.provider, encrypted_key: encryptSecret(row.secret) }))) as never,
      settings,
    );
    const secretPlan = await buildPlan(['storage'], source, credentials, settings, decryptSecret, { onlyIfAbsent: true });
    const result = await applyPlan(secretPlan, credentials, settings, decryptSecret);
    expect(result).toMatchObject({ written: 2, unchanged: 0 });
    return { storage, credentials };
  }

  /** The real platform config service and router, behind MemoriaHub's resolver. */
  function mount(storage: Record<string, unknown>, credentials: MemCredentials) {
    const policy = STORAGE_SYSTEM_SETTINGS.read(storage, {
      asPlainObject: (value: unknown) =>
        typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined,
    } as never);
    const systemSettings = { getStoragePolicy: jest.fn(async () => policy) };
    const storageConfig = new StorageConfigService(systemSettings as never, credentials as never);
    // The active provider resolves the driver in force per call (`resolveCurrent`), like the slice's.
    const active = {
      kind: String(storage['provider']),
      resolveCurrent: async () => active,
    } as unknown as StorageProvider;
    const config = { get: <T>(_key: string, fallback?: T) => fallback as T };
    const router = new StorageProviderRouter(active, storageConfig, config as never);
    return { resolver: new StorageProviderResolver(active, router, {} as never, config as never), storageConfig };
  }

  it('writes each legacy provider secret to its own driver address, never to storage/default', async () => {
    const { storage, credentials } = await carryOver('r2');
    expect(storage).toMatchObject({ provider: 'r2', trash: { retentionDays: 30 } });
    expect(await credentials.getSecret('storage', 's3')).toBe(S3_SECRET);
    expect(await credentials.getSecret('storage', 'r2')).toBe(R2_SECRET);
    expect(await credentials.getSecret('storage', 'default')).toBeNull();
  });

  it.each(['s3', 'r2'] as const)('serves each provider\'s rows with its own key while %s is active', async (activeId) => {
    const { storage, credentials } = await carryOver(activeId);
    const { resolver, storageConfig } = mount(storage, credentials);
    const otherId = activeId === 's3' ? 'r2' : 's3';
    const secretOf = (id: 's3' | 'r2') => (id === 's3' ? S3_SECRET : R2_SECRET);

    // The active driver resolves its own secret.
    const activeDriver = await storageConfig.resolveDriver(activeId);
    expect(activeDriver.configured && activeDriver.config.secrets['secretAccessKey']).toBe(secretOf(activeId));

    // The other driver's rows are served by a client the router builds from THAT driver's settings and secret.
    const provider = await resolver.getProviderFor(otherId, `photos-${otherId}`);
    expect(provider.kind).toBe(otherId);
    const url = await provider.getSignedDownloadUrl('media/photo.jpg');
    const own = await expected(otherId, secretOf(otherId)).getSignedDownloadUrl('media/photo.jpg');
    const wrong = await expected(otherId, secretOf(activeId)).getSignedDownloadUrl('media/photo.jpg');

    expect(credentialOf(url)).toContain(otherId === 's3' ? 'AKIAS3EXAMPLE0001' : 'R2ACCESSKEY0002');
    expect(signatureOf(url)).toBe(signatureOf(own));
    expect(signatureOf(url)).not.toBe(signatureOf(wrong));
  });
});
