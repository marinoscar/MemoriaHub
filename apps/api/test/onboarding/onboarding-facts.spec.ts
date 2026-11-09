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
import { AiDeploymentKeySource } from '../../src/ai-port/ai-deployment-key-source';
import { GroupInvitesService } from '@marinoscar/platform-api/sharing';
import { DefaultOrgId } from '../../src/common/tenancy/default-org-id';

const CALLER = '00000000-0000-4000-8000-000000000001';

function makePrisma() {
  return {
    mediaItem: { count: jest.fn().mockResolvedValue(1) },
    album: { count: jest.fn().mockResolvedValue(0) },
    circleMember: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    person: { count: jest.fn().mockResolvedValue(1) },
    mediaSyncDevice: { count: jest.fn().mockResolvedValue(0) },
    personalAccessToken: { count: jest.fn().mockResolvedValue(1) },
    // The AI key status (RETRO-E3, #605): platform first, then the legacy row; never key material.
    aiKeys: { status: jest.fn().mockResolvedValue({ configured: false, enabled: false }) },
  };
}

const ORG = '00000000-0000-4000-8000-0000000000aa';
const groupInvites = { list: jest.fn() };

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
      if (token === AiDeploymentKeySource) return prisma.aiKeys;
      if (token === StorageConfigService) return storageConfig;
      if (token === GroupInvitesService) return groupInvites;
      if (token === DefaultOrgId) return { get: async () => ORG };
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
    expect(groupInvites.list).not.toHaveBeenCalled();
  });

  it('circle membership counts other members, then pending group invites of administered shared circles', async () => {
    const prisma = makePrisma();
    groupInvites.list.mockReset();
    prisma.circleMember.findMany.mockResolvedValue([
      { circleId: 'c1', role: 'collaborator', circle: { isPersonal: false } },
      { circleId: 'c2', role: 'circle_admin', circle: { isPersonal: true } },
      { circleId: 'c3', role: 'circle_admin', circle: { isPersonal: false } },
    ]);
    groupInvites.list.mockResolvedValue({ items: [{}], total: 1, page: 1, pageSize: 1, totalPages: 1 });
    await expect(CIRCLE_MEMBERSHIP_FACT.resolve(ctx(prisma))).resolves.toEqual({
      collaboratorCircles: 3,
      otherMembers: 0,
      pendingInvites: 1,
    });
    expect(prisma.circleMember.findMany.mock.calls[0][0].take).toBe(100);
    expect(prisma.circleMember.count).toHaveBeenCalledWith({
      where: { circleId: { in: ['c1', 'c2', 'c3'] }, userId: { not: CALLER } },
      take: 1,
    });
    // Only the administered SHARED circle is probed (a personal circle has no group), as the caller.
    expect(groupInvites.list).toHaveBeenCalledTimes(1);
    expect(groupInvites.list).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CALLER, activeOrgId: ORG }),
      'c3',
      { status: 'pending', page: 1, pageSize: 1 },
    );
  });

  it('circle membership reads no invite once another member is in', async () => {
    const prisma = makePrisma();
    groupInvites.list.mockReset();
    prisma.circleMember.findMany.mockResolvedValue([{ circleId: 'c3', role: 'circle_admin', circle: { isPersonal: false } }]);
    prisma.circleMember.count.mockResolvedValue(1);
    await expect(CIRCLE_MEMBERSHIP_FACT.resolve(ctx(prisma))).resolves.toEqual({
      collaboratorCircles: 1,
      otherMembers: 1,
      pendingInvites: 0,
    });
    expect(groupInvites.list).not.toHaveBeenCalled();
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
      expect(prisma.aiKeys.status).not.toHaveBeenCalled();
    });

    it('reports storage not ready when the storage configuration cannot be resolved', async () => {
      const fact = await FEATURE_READINESS_FACT.resolve(ctx(makePrisma(), {}, new Error('not configured')));
      expect(fact.storageReady).toBe(false);
    });

    it('reads flags, the storage resolution and an enabled tagging key, selecting ids only', async () => {
      const prisma = makePrisma();
      prisma.aiKeys.status.mockResolvedValue({ configured: true, enabled: true });
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
      expect(prisma.aiKeys.status).toHaveBeenCalledWith('openai');
    });

    it('a configured but disabled tagging key is not ready', async () => {
      const prisma = makePrisma();
      prisma.aiKeys.status.mockResolvedValue({ configured: true, enabled: false });
      const settings = { ai: { features: { tagging: { provider: 'openai', model: 'model-x' } } } };
      const fact = await FEATURE_READINESS_FACT.resolve(ctx(prisma, settings, { configured: true }));
      expect(fact.taggingProviderReady).toBe(false);
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
