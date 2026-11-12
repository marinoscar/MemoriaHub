import { androidDeviceSourceRegistry } from '@marinoscar/platform-api/android-app';

import {
  MEDIA_SYNC_DEVICE_SOURCE,
  MEDIA_SYNC_DEVICE_SOURCE_ID,
  MediaSyncDeviceSourceBinder,
  bindMediaSyncDeviceSource,
  devicesBehind,
  reportedApps,
  registerMediaSyncDeviceSource,
} from './media-sync.device-source';

function fakePrisma() {
  return {
    mediaSyncDevice: {
      groupBy: jest.fn().mockResolvedValue([
        {
          packageName: 'memoriahub.marin.cr',
          signingSha256: 'ab:cd',
          _count: { _all: 3 },
          _max: { lastSeenAt: new Date('2026-10-01T00:00:00Z') },
        },
        { packageName: null, signingSha256: 'ab:cd', _count: { _all: 1 }, _max: { lastSeenAt: null } },
      ]),
      count: jest.fn().mockResolvedValue(2),
    },
  };
}

describe('the Media Sync device source (RETRO-D5, #586)', () => {
  afterEach(() => bindMediaSyncDeviceSource(null));

  it('is registered once under its permanent id, and a second registration is a no-op', () => {
    registerMediaSyncDeviceSource();
    registerMediaSyncDeviceSource();
    expect(androidDeviceSourceRegistry.get(MEDIA_SYNC_DEVICE_SOURCE_ID)).toBe(MEDIA_SYNC_DEVICE_SOURCE);
    expect(MEDIA_SYNC_DEVICE_SOURCE_ID).toBe('media-sync');
  });

  it('reports nothing until a client is bound', async () => {
    await expect(MEDIA_SYNC_DEVICE_SOURCE.reportedApps()).resolves.toEqual([]);
    await expect(MEDIA_SYNC_DEVICE_SOURCE.devicesBehind!('memoriahub.marin.cr', 9)).resolves.toBe(0);
  });

  it('delegates to the media slice queries over the bound client', async () => {
    const prisma = fakePrisma();
    await expect(reportedApps(prisma as never)).resolves.toEqual([
      { packageName: 'memoriahub.marin.cr', signingSha256: 'ab:cd', deviceCount: 3, lastSeenAt: new Date('2026-10-01T00:00:00Z') },
    ]);
    await expect(devicesBehind('memoriahub.marin.cr', 12, prisma as never)).resolves.toBe(2);
    expect(prisma.mediaSyncDevice.count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ appVersionCode: { lt: 12 } }) }));
  });

  it('reads through the client the binder binds at module init', async () => {
    const prisma = fakePrisma();
    new MediaSyncDeviceSourceBinder(prisma as never).onModuleInit();
    await expect(MEDIA_SYNC_DEVICE_SOURCE.devicesBehind!('memoriahub.marin.cr', 3)).resolves.toBe(2);
    expect(await MEDIA_SYNC_DEVICE_SOURCE.reportedApps()).toHaveLength(1);
  });
});
