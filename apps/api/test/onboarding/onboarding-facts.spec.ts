/**
 * MemoriaHub's onboarding facts (RETRO-H3, #599) against a mocked Prisma client and settings
 * service: each fact is a bounded presence test scoped to the caller, and the readiness fact never
 * reads key material.
 */
import type { OnboardingRequestContext } from '@marinoscar/platform-api/onboarding';
import { StorageConfigService } from '@marinoscar/platform-api/storage';

import {
  ALBUM_COUNTS_FACT,
  CIRCLE_MEMBERSHIP_FACT,
  DEVICES_FACT,
  FEATURE_READINESS_FACT,
  MEDIA_COUNTS_FACT,
  PEOPLE_NAMED_FACT,
} from '../../src/platform/onboarding/onboarding.facts';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AppSystemSettingsService } from '../../src/platform/settings/app-system-settings.service';

const CALLER = '00000000-0000-4000-8000-000000000001';

function makePrisma() {
  return {
    mediaItem: { count: jest.fn().mockResolvedValue(1) },
    album: { count: jest.fn().mockResolvedValue(0) },
    circleMember: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    circleInvite: { count: jest.fn().mockResolvedValue(0) },
    person: { count: jest.fn().mockResolvedValue(1) },
    mediaSyncDevice: { count: jest.fn().mockResolvedValue(0) },
    personalAccessToken: { count: jest.fn().mockResolvedValue(1) },
    aiProviderCredential: { findFirst: jest.fn().mockResolvedValue(null) },
  };
}

function ctx(
  prisma: ReturnType<typeof makePrisma>,
  settings: Record<string, unknown> = {},
  storage: { configured: boolean } | Error = { configured: false },
): OnboardingRequestContext {
  const appSettings = { getSettings: jest.fn().mockResolvedValue(settings) };
  // The storage slice's resolution (RETRO-D1): the active driver's settings and secret are complete.
  const storageConfig = {
    resolve: jest.fn(() => (storage instanceof Error ? Promise.reject(storage) : Promise.resolve(storage))),
  };
  return {
    caller: { id: CALLER, permissions: [], roles: [], activeOrgId: null },
    get: (token: unknown) => {
      if (token === PrismaService) return prisma;
      if (token === AppSystemSettingsService) return appSettings;
      if (token === StorageConfigService) return storageConfig;
      throw new Error('unexpected token');
    },
  } as unknown as OnboardingRequestContext;
}

describe('MemoriaHub onboarding facts', () => {
  it('media and album counts are presence tests scoped to the caller', async () => {
    const prisma = makePrisma();
    await expect(MEDIA_COUNTS_FACT.resolve(ctx(prisma))).resolves.toEqual({ addedByUser: 1 });
    await expect(ALBUM_COUNTS_FACT.resolve(ctx(prisma))).resolves.toEqual({ addedByUser: 0 });
    expect(prisma.mediaItem.count).toHaveBeenCalledWith({ where: { addedById: CALLER }, take: 1 });
    expect(prisma.album.count).toHaveBeenCalledWith({ where: { addedById: CALLER }, take: 1 });
  });

  it('circle membership reads nothing more without a collaborator membership', async () => {
    const prisma = makePrisma();
    await expect(CIRCLE_MEMBERSHIP_FACT.resolve(ctx(prisma))).resolves.toEqual({
      collaboratorCircles: 0,
      otherMembers: 0,
      pendingInvites: 0,
    });
    expect(prisma.circleMember.count).not.toHaveBeenCalled();
    expect(prisma.circleInvite.count).not.toHaveBeenCalled();
  });

  it('circle membership counts other members and pending invites in collaborator circles', async () => {
    const prisma = makePrisma();
    prisma.circleMember.findMany.mockResolvedValue([{ circleId: 'c1' }, { circleId: 'c2' }]);
    prisma.circleInvite.count.mockResolvedValue(1);
    await expect(CIRCLE_MEMBERSHIP_FACT.resolve(ctx(prisma))).resolves.toEqual({
      collaboratorCircles: 2,
      otherMembers: 0,
      pendingInvites: 1,
    });
    expect(prisma.circleMember.findMany.mock.calls[0][0].take).toBe(100);
    expect(prisma.circleMember.count).toHaveBeenCalledWith({
      where: { circleId: { in: ['c1', 'c2'] }, userId: { not: CALLER } },
      take: 1,
    });
    expect(prisma.circleInvite.count).toHaveBeenCalledWith({
      where: { circleId: { in: ['c1', 'c2'] }, claimedAt: null },
      take: 1,
    });
  });

  it('people named counts live, unmerged, named people in the caller\'s circles', async () => {
    const prisma = makePrisma();
    await expect(PEOPLE_NAMED_FACT.resolve(ctx(prisma))).resolves.toEqual({ named: 1 });
    expect(prisma.person.count.mock.calls[0][0]).toEqual({
      where: {
        name: { not: null },
        deletedAt: null,
        mergedIntoId: null,
        circle: { members: { some: { userId: CALLER } } },
      },
      take: 1,
    });
  });

  it('devices counts active sync devices and live tokens', async () => {
    const prisma = makePrisma();
    await expect(DEVICES_FACT.resolve(ctx(prisma))).resolves.toEqual({ syncDevices: 0, activeTokens: 1 });
    expect(prisma.personalAccessToken.count.mock.calls[0][0].where).toMatchObject({ userId: CALLER, revokedAt: null });
  });

  describe('feature readiness', () => {
    const OLD_ENV = process.env;
    beforeEach(() => {
      process.env = { ...OLD_ENV };
      delete process.env['STORAGE_PROVIDER'];
      delete process.env['MEMORIES_ENABLED'];
    });
    afterAll(() => {
      process.env = OLD_ENV;
    });

    it('is all off on a fresh deployment', async () => {
      const prisma = makePrisma();
      await expect(FEATURE_READINESS_FACT.resolve(ctx(prisma, {}))).resolves.toEqual({
        storageReady: false,
        faceRecognition: false,
        autoTagging: false,
        taggingProviderReady: false,
        memories: false,
      });
      // No tagging model means no AI credential read at all.
      expect(prisma.aiProviderCredential.findFirst).not.toHaveBeenCalled();
    });

    it('reports storage not ready when the storage configuration cannot be resolved', async () => {
      const fact = await FEATURE_READINESS_FACT.resolve(ctx(makePrisma(), {}, new Error('not configured')));
      expect(fact.storageReady).toBe(false);
    });

    it('reads flags, the storage resolution and an enabled tagging key, selecting ids only', async () => {
      const prisma = makePrisma();
      prisma.aiProviderCredential.findFirst.mockResolvedValue({ id: 'k' });
      const settings = {
        features: { faceRecognition: true, autoTagging: true, memories: true },
        ai: { features: { tagging: { provider: 'openai', model: 'model-x' } } },
      };
      await expect(FEATURE_READINESS_FACT.resolve(ctx(prisma, settings, { configured: true }))).resolves.toEqual({
        storageReady: true,
        faceRecognition: true,
        autoTagging: true,
        taggingProviderReady: true,
        memories: true,
      });
      expect(prisma.aiProviderCredential.findFirst).toHaveBeenCalledWith({
        where: { provider: 'openai', enabled: true },
        select: { id: true },
      });
    });

    it('honours the MEMORIES_ENABLED kill switch', async () => {
      process.env['MEMORIES_ENABLED'] = 'false';
      const fact = await FEATURE_READINESS_FACT.resolve(ctx(makePrisma(), { features: { memories: true } }));
      expect(fact.memories).toBe(false);
    });
  });
});

describe('OnboardingFeaturesAdapter (ONBOARDING_FEATURES)', () => {
  // Imported lazily so the module under test is the adapter alone.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OnboardingFeaturesAdapter } = require('../../src/platform/onboarding/onboarding-features.adapter');

  const adapter = (features: Record<string, boolean>) =>
    new OnboardingFeaturesAdapter({ getSettings: async () => ({ features }) } as never);

  it('reads features.<name>, and an unknown feature is off', async () => {
    await expect(adapter({ faceRecognition: true }).isEnabled('faceRecognition')).resolves.toBe(true);
    await expect(adapter({ faceRecognition: false }).isEnabled('faceRecognition')).resolves.toBe(false);
    await expect(adapter({}).isEnabled('nope')).resolves.toBe(false);
  });

  it('applies the MEMORIES_ENABLED kill switch to memories', async () => {
    const old = process.env['MEMORIES_ENABLED'];
    process.env['MEMORIES_ENABLED'] = 'false';
    try {
      await expect(adapter({ memories: true }).isEnabled('memories')).resolves.toBe(false);
    } finally {
      if (old === undefined) delete process.env['MEMORIES_ENABLED'];
      else process.env['MEMORIES_ENABLED'] = old;
    }
  });
});
