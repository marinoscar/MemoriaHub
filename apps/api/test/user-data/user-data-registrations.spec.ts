/**
 * MemoriaHub's registrations on the platform user-data slice (RETRO-H1, #591).
 *
 * Pins what the conformance suite does not: the permanent job type strings and
 * scope phrases, that the platform's `storageObjects: true` hint never wins, the
 * factory reset steps and their order, and that every delegated purge is
 * server-only.
 */
import {
  factoryResetKeptLines,
  factoryResetStepRegistry,
  findUserDataScope,
  storageObjectModelHint,
  userDataKeptLines,
  userDataModelRegistry,
} from '@marinoscar/platform-api/user-data';

import '../../src/platform/user-data/user-data.manifest';
import {
  MEMORIAHUB_PURGE_HANDLERS,
  MEMORIAHUB_PURGE_JOB_TYPES,
  purgeUserIdOf,
} from '../../src/platform/user-data/memoriahub-purge.handlers';
import { memoriaHubCircleContentRemovalHook } from '../../src/platform/user-data/user-removal.hook';
import { MemoriaHubUserDataService } from '../../src/platform/user-data/memoriahub-user-data.service';

describe('MemoriaHub user-data registrations', () => {
  it('pins the delegated job types (permanent strings)', () => {
    expect(MEMORIAHUB_PURGE_JOB_TYPES).toEqual({
      CIRCLE: 'memoriahub.circle.purge',
      DEVICES: 'memoriahub.media_sync.purge',
      PROFILE: 'memoriahub.profile.purge',
    });
    const types = MEMORIAHUB_PURGE_HANDLERS.map(
      (Handler) => new (Handler as unknown as new (...args: unknown[]) => { type: string })({}, {}).type,
    );
    expect(types.sort()).toEqual(Object.values(MEMORIAHUB_PURGE_JOB_TYPES).sort());
  });

  it('every delegated purge is server-only with an explicit profile', () => {
    for (const Handler of MEMORIAHUB_PURGE_HANDLERS) {
      const handler = new (Handler as unknown as new (...args: unknown[]) => Record<string, unknown>)({}, {});
      expect(handler.nodeResultSchema).toBeUndefined();
      expect(handler.persistNodeResult).toBeUndefined();
      expect(handler.profile).toEqual({ maxRuntimeMs: expect.any(Number), maxAttempts: 3 });
    }
  });

  it('reads { userId } and refuses anything else', () => {
    const userId = '6f1c2f8e-3b3a-4c55-9a3e-4f6f2a1b2c3d';
    expect(purgeUserIdOf({ id: 'j', type: 't', payload: { userId } } as never)).toBe(userId);
    expect(() => purgeUserIdOf({ id: 'j', type: 't', payload: {} } as never)).toThrow(/userId/);
  });

  it('never lets the platform delete storage objects: StorageObject delegates to the circle purge and is kept by the reset', () => {
    expect(storageObjectModelHint()).toBeUndefined();
    expect(userDataModelRegistry.get('StorageObject')).toMatchObject({
      category: 'files',
      factoryReset: 'keep',
      delegate: { jobType: MEMORIAHUB_PURGE_JOB_TYPES.CIRCLE },
    });
    expect(userDataModelRegistry.get('StorageObject')?.delegate?.payload('u-1')).toEqual({ userId: 'u-1' });
  });

  it('declares the narrow scopes with their phrases, and keeps the built-in ones', () => {
    expect(findUserDataScope('library')).toMatchObject({ categories: ['files'], confirmation: 'LIBRARY' });
    // `shares` is retired with `media_shares` (RETRO-I4): public links are link grants the sharing slice owns.
    expect(findUserDataScope('shares')).toBeUndefined();
    expect(findUserDataScope('devices')).toMatchObject({ categories: ['devices'], confirmation: 'DEVICES' });
    expect(findUserDataScope('everything')).toBeDefined();
    expect(findUserDataScope('content')).toBeDefined();
  });

  it('registers the factory reset steps ahead of the platform deployment steps', () => {
    const ids = factoryResetStepRegistry.list().map((step) => step.id);
    expect(ids.slice(0, 4)).toEqual([
      'memoriahub.content',
      'memoriahub.legacy-nodes',
      'memoriahub.leftovers',
      'memoriahub.storage',
    ]);
    expect(ids).toEqual(expect.arrayContaining(['platform.broadcasts', 'platform.allowlist']));
  });

  it('lists what is kept on both pages', () => {
    expect(userDataKeptLines()).toContain('Your circle memberships, and what you added to circles shared with others');
    expect(factoryResetKeptLines()).toEqual(
      expect.arrayContaining(['The AI tag vocabulary', 'Location groups and their aliases', 'Android app releases and their APK files']),
    );
  });

  it('the removal hook resolves the MemoriaHub service', async () => {
    expect(memoriaHubCircleContentRemovalHook.inject).toBe(MemoriaHubUserDataService);
    const service = { prepareUserRemoval: jest.fn().mockResolvedValue({ circlesDeleted: 1 }) };
    await expect(memoriaHubCircleContentRemovalHook.run(service as never, 'u-1')).resolves.toEqual({ circlesDeleted: 1 });
    expect(service.prepareUserRemoval).toHaveBeenCalledWith('u-1');
  });
});
