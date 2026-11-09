/**
 * Real-Postgres tier for the AI key import (RETRO-E3, #605, release N).
 *
 * Proves against the migrated schema what a mocked client cannot: the dry run writes nothing; the
 * apply copies each legacy key into the platform `credentials` table (purpose `ai`) ENCRYPTED, sets
 * the provider slot and the deployment-key policy, and leaves `ai_provider_credentials` untouched;
 * a re-run is a no-op; `--replace` overwrites; an undecryptable row is reported without aborting the
 * others; the report never carries a key; and the imported key is what `AiKeyResolver` hands out for
 * the deployment tier, and what MemoriaHub's own key reader (`AiDeploymentKeySource`) prefers.
 *
 * Needs a database migrated to the latest schema (`npm run prisma:migrate`) and the `global`
 * settings row (created here when absent). Skips (reported as skipped, never passed) when nothing
 * listens on the port.
 */
import { Logger } from '@nestjs/common';
import { AI_CREDENTIAL_PURPOSE, AiConfigService, AiKeyResolver } from '@marinoscar/platform-api/ai';
import { CredentialsService } from '@marinoscar/platform-api/credentials';

import '../../src/platform/credentials/credential-purposes.manifest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { encryptSecret } from '../../src/legacy/legacy-secret-cipher';
import { runAiKeyImport } from '../../src/ai-port/migrate/ai-legacy-migrate';
import { AiDeploymentKeySource } from '../../src/ai-port/ai-deployment-key-source';
import { isDatabaseReachable } from '../helpers/db-probe.helper';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const OPENAI_KEY = 'sk-placeholder-openai-db-spec-4321';
const ANTHROPIC_KEY = 'sk-ant-placeholder-db-spec-8765';
const OTHER_KEY = 'sk-placeholder-admin-entered-0000';

describeMaybeDb('AI key import (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
  let credentials: CredentialsService;
  let savedKey: string | undefined;
  let savedSettings: { value: unknown } | null;
  const logged: string[] = [];

  const legacySnapshot = () =>
    prisma.aiProviderCredential.findMany({
      orderBy: { provider: 'asc' },
      select: { provider: true, encryptedKey: true, last4: true, baseUrl: true, enabled: true, updatedAt: true },
    });
  const aiNamespace = async () => {
    const row = await prisma.systemSettings.findUnique({ where: { key: 'global' } });
    return ((row?.value ?? {}) as Record<string, any>)['ai'] ?? {};
  };

  beforeAll(async () => {
    savedKey = process.env['SECRETS_ENCRYPTION_KEY'];
    process.env['SECRETS_ENCRYPTION_KEY'] ??= 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';
    prisma = new PrismaService();
    await prisma.$connect();
    credentials = new CredentialsService(prisma as never);
    savedSettings = await prisma.systemSettings.findUnique({ where: { key: 'global' }, select: { value: true } });
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
  });

  beforeEach(async () => {
    await prisma.credential.deleteMany({ where: { purpose: AI_CREDENTIAL_PURPOSE } });
    await prisma.aiProviderCredential.deleteMany({});
    await prisma.auditEvent.deleteMany({ where: { targetType: 'ai_config' } });
    // A row as MemoriaHub stores it: its feature selections, no platform AI fields yet.
    const value = { ai: { features: { tagging: { provider: 'openai', model: 'model-x' } } } };
    await prisma.systemSettings.upsert({
      where: { key: 'global' },
      create: { key: 'global', value },
      update: { value },
    });
    await prisma.aiProviderCredential.createMany({
      data: [
        {
          provider: 'openai',
          encryptedKey: encryptSecret(OPENAI_KEY),
          last4: '4321',
          baseUrl: 'https://compat.example.test/v1',
          enabled: true,
        },
        { provider: 'anthropic', encryptedKey: encryptSecret(ANTHROPIC_KEY), last4: '8765', enabled: false },
      ],
    });
  });

  afterAll(async () => {
    await prisma.credential.deleteMany({ where: { purpose: AI_CREDENTIAL_PURPOSE } });
    await prisma.aiProviderCredential.deleteMany({});
    await prisma.auditEvent.deleteMany({ where: { targetType: 'ai_config' } });
    if (savedSettings) {
      await prisma.systemSettings.update({ where: { key: 'global' }, data: { value: savedSettings.value as never } });
    } else {
      await prisma.systemSettings.deleteMany({ where: { key: 'global' } });
    }
    jest.restoreAllMocks();
    if (savedKey === undefined) delete process.env['SECRETS_ENCRYPTION_KEY'];
    else process.env['SECRETS_ENCRYPTION_KEY'] = savedKey;
    await prisma.$disconnect();
  });

  it('the dry run writes nothing', async () => {
    const before = await legacySnapshot();
    const result = await runAiKeyImport({ prisma, credentials }, { apply: false, replace: false });
    expect(result.entries.map((e) => [e.provider, e.outcome])).toEqual([
      ['anthropic', 'imported'],
      ['openai', 'imported'],
    ]);
    expect(await prisma.credential.count({ where: { purpose: AI_CREDENTIAL_PURPOSE } })).toBe(0);
    expect(await aiNamespace()).toEqual({ features: { tagging: { provider: 'openai', model: 'model-x' } } });
    expect(await prisma.auditEvent.count({ where: { targetType: 'ai_config' } })).toBe(0);
    expect(await legacySnapshot()).toEqual(before);
  });

  it('apply imports encrypted keys, slots and policy; the legacy table is untouched; the key resolves', async () => {
    const before = await legacySnapshot();
    const result = await runAiKeyImport({ prisma, credentials }, { apply: true, replace: false });
    expect(result.exitCode).toBe(0);
    expect(result.entries.map((e) => [e.provider, e.outcome])).toEqual([
      ['anthropic', 'imported'],
      ['openai', 'imported'],
    ]);

    // Encrypted at rest, readable back through the store.
    const rows = await prisma.credential.findMany({ where: { purpose: AI_CREDENTIAL_PURPOSE } });
    expect(rows.map((r) => r.name).sort()).toEqual(['anthropic', 'openai']);
    for (const r of rows) {
      expect(r.secret).not.toContain(OPENAI_KEY);
      expect(r.secret).not.toContain(ANTHROPIC_KEY);
    }
    expect(await credentials.getSecret(AI_CREDENTIAL_PURPOSE, 'openai')).toBe(OPENAI_KEY);
    expect(await credentials.getSecret(AI_CREDENTIAL_PURPOSE, 'anthropic')).toBe(ANTHROPIC_KEY);

    // The slot, the policy, and MemoriaHub's own selections kept.
    const ai = await aiNamespace();
    expect(ai.providers.openai).toEqual({ enabled: true, baseUrl: 'https://compat.example.test/v1' });
    expect(ai.providers.anthropic).toEqual({ enabled: false });
    expect(ai.keyPolicy).toBe('byok_with_org_fallback');
    expect(ai.deploymentKeyServesOrgs).toBe(true);
    expect(ai.features).toEqual({ tagging: { provider: 'openai', model: 'model-x' } });

    expect(await prisma.auditEvent.count({ where: { targetType: 'ai_config', action: 'ai_config:set_key' } })).toBe(2);
    expect(await legacySnapshot()).toEqual(before);

    // The deployment tier of the platform resolver hands out the imported key.
    const policy = { ...ai, enabled: true };
    const aiConfig = new AiConfigService(
      { getAiPolicy: async () => policy } as never,
      credentials,
      {} as never,
    );
    const resolver = new AiKeyResolver(
      { getDecrypted: async () => null } as never,
      aiConfig,
      { holdsAiConfigWrite: async () => false, holdsOrgAiConfigWrite: async () => false } as never,
    );
    await expect(resolver.resolveForSystem('openai')).resolves.toMatchObject({ apiKey: OPENAI_KEY, tier: 'deployment' });
    // A user call falls back to the deployment key under byok_with_org_fallback.
    await expect(resolver.resolve('00000000-0000-4000-8000-0000000000c1', 'openai')).resolves.toMatchObject({
      apiKey: OPENAI_KEY,
      tier: 'deployment',
    });

    // MemoriaHub's legacy call sites now read the platform key and slot first.
    const reader = new AiDeploymentKeySource(prisma, credentials, {
      getSettings: async () => ({ ai: await aiNamespace() }),
    } as never);
    await expect(reader.resolve('openai')).resolves.toEqual({
      apiKey: OPENAI_KEY,
      baseUrl: 'https://compat.example.test/v1',
    });
    await expect(reader.resolve('anthropic')).rejects.toThrow(/disabled/);
    await expect(reader.status('openai')).resolves.toMatchObject({ source: 'platform', last4: '4321' });

    const text = [...result.lines, ...logged].join('\n');
    expect(text).not.toContain(OPENAI_KEY);
    expect(text).not.toContain(ANTHROPIC_KEY);
  });

  it('re-running apply changes nothing', async () => {
    await runAiKeyImport({ prisma, credentials }, { apply: true, replace: false });
    const creds = await prisma.credential.findMany({ where: { purpose: AI_CREDENTIAL_PURPOSE }, orderBy: { name: 'asc' } });
    const settings = await prisma.systemSettings.findUnique({ where: { key: 'global' } });

    const again = await runAiKeyImport({ prisma, credentials }, { apply: true, replace: false });
    expect(again.entries.map((e) => [e.provider, e.outcome])).toEqual([
      ['anthropic', 'skipped_existing'],
      ['openai', 'skipped_existing'],
    ]);
    expect(again.policy).toEqual({});
    expect(await prisma.credential.findMany({ where: { purpose: AI_CREDENTIAL_PURPOSE }, orderBy: { name: 'asc' } })).toEqual(creds);
    expect(await prisma.systemSettings.findUnique({ where: { key: 'global' } })).toEqual(settings);
    expect(await prisma.auditEvent.count({ where: { targetType: 'ai_config', action: 'ai_config:set_key' } })).toBe(2);
  });

  it('keeps a different platform key, and --replace overwrites it', async () => {
    await credentials.setSecret(AI_CREDENTIAL_PURPOSE, 'openai', OTHER_KEY);

    const kept = await runAiKeyImport({ prisma, credentials }, { apply: true, replace: false });
    expect(kept.entries.find((e) => e.provider === 'openai')).toMatchObject({
      outcome: 'skipped_existing',
      reason: 'different_key_kept_use_replace',
    });
    expect(await credentials.getSecret(AI_CREDENTIAL_PURPOSE, 'openai')).toBe(OTHER_KEY);

    const replaced = await runAiKeyImport({ prisma, credentials }, { apply: true, replace: true });
    expect(replaced.entries.find((e) => e.provider === 'openai')).toMatchObject({
      outcome: 'imported',
      replacesExisting: true,
    });
    expect(await credentials.getSecret(AI_CREDENTIAL_PURPOSE, 'openai')).toBe(OPENAI_KEY);
  });

  it('apply refuses before writing anything when the settings row does not exist yet', async () => {
    await prisma.systemSettings.deleteMany({ where: { key: 'global' } });
    await expect(runAiKeyImport({ prisma, credentials }, { apply: true, replace: false })).rejects.toThrow(
      /start the API once/,
    );
    expect(await prisma.credential.count({ where: { purpose: AI_CREDENTIAL_PURPOSE } })).toBe(0);
  });

  it('an undecryptable row is reported and does not stop the others', async () => {
    await prisma.aiProviderCredential.update({
      where: { provider: 'anthropic' },
      data: { encryptedKey: Buffer.from('not-a-legacy-envelope-at-all-0123456789').toString('base64') },
    });
    const result = await runAiKeyImport({ prisma, credentials }, { apply: true, replace: false });
    expect(result.exitCode).toBe(1);
    expect(result.entries.map((e) => [e.provider, e.outcome])).toEqual([
      ['anthropic', 'undecryptable'],
      ['openai', 'imported'],
    ]);
    expect(await credentials.getSecret(AI_CREDENTIAL_PURPOSE, 'anthropic')).toBeNull();
    expect(await credentials.getSecret(AI_CREDENTIAL_PURPOSE, 'openai')).toBe(OPENAI_KEY);
    expect(result.lines.join('\n')).toContain('provider=anthropic outcome=undecryptable last4=8765');
  });
});
