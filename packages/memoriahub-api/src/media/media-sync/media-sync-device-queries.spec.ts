import { mediaSyncDevicesBehind, mediaSyncReportedApps } from './media-sync-device-queries.js';

function fakePrisma() {
  return {
    mediaSyncDevice: {
      groupBy: jest.fn().mockResolvedValue([
        {
          packageName: 'example.app.one',
          signingSha256: 'ab:cd',
          _count: { _all: 3 },
          _max: { lastSeenAt: new Date('2026-10-01T00:00:00Z') },
        },
        { packageName: null, signingSha256: 'ab:cd', _count: { _all: 1 }, _max: { lastSeenAt: null } },
        { packageName: 'example.app.two', signingSha256: 'ef:01', _count: null, _max: null },
      ]),
      count: jest.fn().mockResolvedValue(2),
    },
  };
}

describe('the Media Sync device queries (RETRO-D5 #586, RETRO-J5 #613)', () => {
  it('groups ACTIVE devices that reported a package and a signer, one row per pair', async () => {
    const prisma = fakePrisma();
    const rows = await mediaSyncReportedApps(prisma as never);

    expect(prisma.mediaSyncDevice.groupBy).toHaveBeenCalledWith({
      by: ['packageName', 'signingSha256'],
      where: { status: 'active', packageName: { not: null }, signingSha256: { not: null } },
      _count: { _all: true },
      _max: { lastSeenAt: true },
    });
    expect(rows).toEqual([
      { packageName: 'example.app.one', signingSha256: 'ab:cd', deviceCount: 3, lastSeenAt: new Date('2026-10-01T00:00:00Z') },
      { packageName: 'example.app.two', signingSha256: 'ef:01', deviceCount: 0, lastSeenAt: null },
    ]);
  });

  it('counts active devices on an older build of the package, plus those that never reported one', async () => {
    const prisma = fakePrisma();
    await expect(mediaSyncDevicesBehind(prisma as never, 'example.app.one', 12)).resolves.toBe(2);
    expect(prisma.mediaSyncDevice.count).toHaveBeenCalledWith({
      where: {
        status: 'active',
        appVersionCode: { lt: 12 },
        OR: [{ packageName: 'example.app.one' }, { packageName: null }],
      },
    });
  });
});
