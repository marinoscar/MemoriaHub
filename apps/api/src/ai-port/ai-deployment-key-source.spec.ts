/**
 * AiDeploymentKeySource (RETRO-E3, #605): the platform deployment key first, then the legacy row.
 */
import { BadRequestException } from '@nestjs/common';

import { AiDeploymentKeySource } from './ai-deployment-key-source';
import { encryptSecret } from '../legacy/legacy-secret-cipher';

const VALID_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';
const PLATFORM_KEY = 'platform-key-placeholder-7777';
const LEGACY_KEY = 'legacy-key-placeholder-1234';

function build(opts: {
  platform?: string | null;
  slot?: { enabled?: boolean; baseUrl?: string };
  legacy?: { enabled: boolean; baseUrl?: string | null } | null;
}) {
  const credentials = {
    getSecret: jest.fn().mockResolvedValue(opts.platform ?? null),
    describe: jest.fn().mockResolvedValue(
      opts.platform ? { hint: '••••7777', updatedAt: new Date('2026-01-01T00:00:00Z') } : null,
    ),
    list: jest.fn().mockResolvedValue(opts.platform ? [{ name: 'openai' }] : []),
  };
  const legacyRow = opts.legacy
    ? {
        provider: 'openai',
        encryptedKey: encryptSecret(LEGACY_KEY),
        last4: '1234',
        baseUrl: opts.legacy.baseUrl ?? null,
        enabled: opts.legacy.enabled,
        updatedAt: new Date('2025-01-01T00:00:00Z'),
      }
    : null;
  const prisma = {
    aiProviderCredential: {
      findUnique: jest.fn().mockResolvedValue(legacyRow),
      findMany: jest.fn().mockResolvedValue(legacyRow ? [{ provider: 'openai' }] : []),
    },
  };
  const settings = {
    getSettings: jest.fn().mockResolvedValue({ ai: { providers: opts.slot ? { openai: opts.slot } : {} } }),
  };
  const source = new AiDeploymentKeySource(prisma as never, credentials as never, settings as never);
  return { source, prisma, credentials };
}

describe('AiDeploymentKeySource', () => {
  const original = process.env.SECRETS_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;
  });
  afterAll(() => {
    if (original === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = original;
  });

  it('prefers the platform key and its slot (enabled, baseUrl) over the legacy row', async () => {
    const { source, prisma } = build({
      platform: PLATFORM_KEY,
      slot: { enabled: true, baseUrl: 'https://proxy.example.test/v1' },
      legacy: { enabled: true },
    });
    await expect(source.resolve('openai')).resolves.toEqual({
      apiKey: PLATFORM_KEY,
      baseUrl: 'https://proxy.example.test/v1',
    });
    expect(prisma.aiProviderCredential.findUnique).not.toHaveBeenCalled();
    await expect(source.status('openai')).resolves.toMatchObject({
      source: 'platform',
      configured: true,
      enabled: true,
      last4: '7777',
    });
  });

  it('a platform key whose slot is off is disabled, even when a legacy row is enabled', async () => {
    const { source } = build({ platform: PLATFORM_KEY, slot: { enabled: false }, legacy: { enabled: true } });
    await expect(source.resolve('openai')).rejects.toThrow(BadRequestException);
    await expect(source.resolve('openai')).rejects.toThrow(/disabled/);
    await expect(source.status('openai')).resolves.toMatchObject({ source: 'platform', enabled: false });
  });

  it('falls back to the legacy row when the platform store has no key', async () => {
    const { source } = build({ platform: null, legacy: { enabled: true, baseUrl: 'https://compat.example.test/v1' } });
    await expect(source.resolve('openai')).resolves.toEqual({
      apiKey: LEGACY_KEY,
      baseUrl: 'https://compat.example.test/v1',
    });
    await expect(source.status('openai')).resolves.toMatchObject({ source: 'legacy', last4: '1234', enabled: true });
  });

  it('a disabled legacy row is a 400', async () => {
    const { source } = build({ platform: null, legacy: { enabled: false } });
    await expect(source.resolve('openai')).rejects.toThrow(/disabled/);
  });

  it('no key anywhere is "not configured"', async () => {
    const { source } = build({ platform: null, legacy: null });
    await expect(source.resolve('openai')).rejects.toThrow(/not configured/);
    await expect(source.status('openai')).resolves.toMatchObject({ source: null, configured: false });
  });

  it('list merges known providers, platform keys and legacy rows, without key material', async () => {
    const { source } = build({ platform: PLATFORM_KEY, slot: { enabled: true }, legacy: { enabled: true } });
    const list = await source.list(['anthropic', 'openai']);
    expect(list.map((s) => [s.provider, s.source])).toEqual([
      ['anthropic', 'platform'],
      ['openai', 'platform'],
    ]);
    const text = JSON.stringify(list);
    expect(text).not.toContain(PLATFORM_KEY);
    expect(text).not.toContain(LEGACY_KEY);
  });
});
