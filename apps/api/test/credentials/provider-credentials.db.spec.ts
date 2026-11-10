/**
 * Real-Postgres tier (RETRO-B4, #617). A mocked Prisma cannot prove that a secret saved through the
 * admin services lands ENCRYPTED in the platform `credentials` table, leaves the legacy tables alone,
 * and comes back only as a masked hint.
 *
 * Needs a database migrated to the latest schema (`npm run prisma:migrate`) and SECRETS_ENCRYPTION_KEY.
 * Skips (reported as skipped, never passed) when nothing listens on the port.
 */
import { Logger } from '@nestjs/common';
import { CredentialsService } from '@marinoscar/platform-api/credentials';
import { PrismaService } from '../../src/prisma/prisma.service';
import { GeoSettingsService } from '../../src/geo/geo-settings.service';
import { FaceSettingsService, FaceSystemSettings } from '@marinoscar/memoriahub-api/face';
import { PlatformMemoriahubSecretsAdapter } from '../../src/platform-memoriahub/secrets/platform-memoriahub-secrets.adapter';
import { GeoGoogleCredentialResolver } from '../../src/media/geo/geo-google-credential.resolver';
import '../../src/platform/credentials/credential-purposes.manifest';
import { isDatabaseReachable } from '../helpers/db-probe.helper';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const GEO_KEY = 'AIza-db-spec-geo-key-4321';
const FACE_KEY = 'cf-db-spec-face-key-8765';

describeMaybeDb('Provider credentials (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
  let credentials: CredentialsService;
  let settingsDoc: Record<string, any>;
  let geo: GeoSettingsService;
  let face: FaceSettingsService;
  let resolver: GeoGoogleCredentialResolver;
  let savedKey: string | undefined;
  const logged: string[] = [];

  beforeAll(async () => {
    savedKey = process.env['SECRETS_ENCRYPTION_KEY'];
    process.env['SECRETS_ENCRYPTION_KEY'] ??= 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';
    prisma = new PrismaService();
    await prisma.$connect();
    credentials = new CredentialsService(prisma as never);
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
  });

  beforeEach(async () => {
    await prisma.credential.deleteMany({ where: { purpose: { in: ['geo_provider', 'face_provider'] } } });
    settingsDoc = { geo: {}, face: {} };
    const systemSettings = {
      getSettings: jest.fn(async () => settingsDoc),
      // A deep merge of a PATCH (null clears), standing in for the settings slice.
      patchSettings: jest.fn(async (patch: Record<string, any>) => {
        const merge = (into: Record<string, any>, from: Record<string, any>) => {
          for (const [k, v] of Object.entries(from)) {
            if (v && typeof v === 'object' && !Array.isArray(v)) merge((into[k] ??= {}), v);
            else into[k] = v;
          }
        };
        merge(settingsDoc, patch);
      }),
    };
    resolver = new GeoGoogleCredentialResolver(credentials, systemSettings as never);
    geo = new GeoSettingsService(credentials, resolver, systemSettings as never, {} as never, {} as never, {} as never);
    const registry = {
      keys: () => ['compreface'],
      get: () => ({ capabilities: { detect: true }, requiresCredentials: false }),
    };
    // The face slice reaches the credential store and the settings through the memoriahub ports (RETRO-J6).
    const settingsPort = {
      readSystem: async (name: string) => ({ value: settingsDoc[name], version: 1 }),
      patchSystem: async (name: string, patch: Record<string, unknown>) => {
        await systemSettings.patchSettings({ [name]: patch });
        return { value: settingsDoc[name], version: 1 };
      },
    };
    face = new FaceSettingsService(
      new PlatformMemoriahubSecretsAdapter(credentials),
      registry as never,
      new FaceSystemSettings(settingsPort as never),
    );
  });

  afterAll(async () => {
    await prisma.credential.deleteMany({ where: { purpose: { in: ['geo_provider', 'face_provider'] } } });
    jest.restoreAllMocks();
    if (savedKey === undefined) delete process.env['SECRETS_ENCRYPTION_KEY'];
    else process.env['SECRETS_ENCRYPTION_KEY'] = savedKey;
    await prisma.$disconnect();
  });

  it('PUT geo key: an encrypted credentials row exists, the legacy table is untouched, the response carries last4 only', async () => {
    const legacyBefore = await prisma.geoProviderCredential.count();

    const response = await geo.upsertCredential('google', { apiKey: GEO_KEY, enabled: true }, undefined as never);

    const row = await prisma.credential.findUnique({ where: { purpose_name: { purpose: 'geo_provider', name: 'google' } } });
    expect(row).not.toBeNull();
    expect(row!.secret).not.toContain(GEO_KEY);
    expect(row!.hint).toBe('••••4321');
    expect(await prisma.geoProviderCredential.count()).toBe(legacyBefore);

    expect(response).toMatchObject({ provider: 'google', configured: true, last4: '4321' });
    const wire = JSON.stringify([response, await geo.getSettings()]);
    expect(wire).not.toContain(GEO_KEY);
    expect(wire).toContain('"last4":"4321"');
  });

  it('the geocode path still resolves the key; switching the provider off falls back; delete removes it', async () => {
    await geo.upsertCredential('google', { apiKey: GEO_KEY }, undefined as never);
    expect(await resolver.resolveApiKey()).toBe(GEO_KEY);

    settingsDoc.geo.google.enabled = false;
    expect(await resolver.resolveApiKey()).toBeNull();

    settingsDoc.geo.google.enabled = true;
    await geo.deleteCredential('google', undefined as never);
    expect(await resolver.resolveApiKey()).toBeNull();
    expect(await prisma.credential.count({ where: { purpose: 'geo_provider' } })).toBe(0);
  });

  it('face: an optional key is stored encrypted; baseUrl and enabled live in settings, not in the credential', async () => {
    await face.upsertCredential('compreface', { apiKey: FACE_KEY, baseUrl: 'http://cf.example.test:8000' }, undefined as never);

    const row = await prisma.credential.findUnique({ where: { purpose_name: { purpose: 'face_provider', name: 'compreface' } } });
    expect(row!.secret).not.toContain(FACE_KEY);
    expect(settingsDoc.face.providers.compreface).toEqual({ baseUrl: 'http://cf.example.test:8000' });
    expect(await face.resolveCredentials('compreface')).toEqual({});

    const wire = JSON.stringify(await face.getSettings());
    expect(wire).not.toContain(FACE_KEY);
    expect(wire).toContain('"last4":"8765"');
  });

  it('no log line from any of the above carries a secret', () => {
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(GEO_KEY);
      expect(line).not.toContain(FACE_KEY);
    }
  });
});
