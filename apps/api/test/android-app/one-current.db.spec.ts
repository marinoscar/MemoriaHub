/**
 * Real-Postgres tier (issue #502): proves the raw-SQL partial unique index
 * `android_app_releases_one_current_uniq_idx` (intentional schema drift, see
 * the AndroidAppRelease model comment) allows at most ONE current release
 * deployment-wide, and that the CHECK constraints on media_sync_runs hold.
 *
 * Needs a database migrated to the latest schema (`npm run prisma:migrate`).
 * When no database is reachable the suite skips (logged) so the default
 * `npm test` stays runnable without Postgres; a reachable but un-migrated
 * database fails loudly.
 */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ONE_CURRENT_RELEASE_INDEX } from '../../src/android-app/releases/android-release.constants';
import {
  AndroidReleaseService,
  isUniqueViolationOn,
} from '../../src/android-app/releases/android-release.service';

const PKG = 'cr.marin.memoriahub.test';

describe('android_app_releases one-current partial unique index (db)', () => {
  let prisma: PrismaService | null = null;
  let userId: string;

  const release = (versionCode: number, isCurrent: boolean) =>
    prisma!.androidAppRelease.create({
      data: {
        packageName: PKG,
        versionName: `1.0.${versionCode}`,
        versionCode,
        signingSha256: 'AA:BB:CC',
        fileSha256: 'a'.repeat(64),
        sizeBytes: BigInt(5_000_000_000),
        storageKey: `android-releases/test-${versionCode}.apk`,
        isCurrent,
      },
    });

  beforeAll(async () => {
    const candidate = new PrismaService();
    try {
      await candidate.$connect();
      await candidate.$queryRaw`SELECT 1`; // the pg adapter connects lazily
    } catch (err) {
      console.warn(`Skipping one-current.db.spec: database unreachable (${(err as Error).message})`);
      await candidate.$disconnect().catch(() => undefined);
      return;
    }
    prisma = candidate;
    await prisma.androidAppRelease.deleteMany({ where: { packageName: PKG } });
    const user = await prisma.user.create({
      data: { email: `one-current-${Date.now()}@example.test` },
    });
    userId = user.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.androidAppRelease.deleteMany({ where: { packageName: PKG } });
    await prisma.auditEvent.deleteMany({ where: { actorUserId: userId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    if (prisma) await prisma.androidAppRelease.deleteMany({ where: { packageName: PKG } });
  });

  it('rejects a second is_current=true row with P2002', async () => {
    if (!prisma) return;
    await release(1, true);
    const error = await release(2, true).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'P2002' });
    // The release service recognises the index BY NAME in a real driver error
    // (issue #504: P2002 on it becomes 409 RELEASE_CURRENT_CONFLICT).
    expect(isUniqueViolationOn(error, ONE_CURRENT_RELEASE_INDEX)).toBe(true);
    await expect(release(2, true)).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('allows any number of non-current rows next to one current row', async () => {
    if (!prisma) return;
    await release(1, true);
    await release(2, false);
    await release(3, false);
    expect(await prisma.androidAppRelease.count({ where: { packageName: PKG } })).toBe(3);
  });

  it('allows make-current as clear-then-set in one transaction', async () => {
    if (!prisma) return;
    const a = await release(1, true);
    const b = await release(2, false);
    await prisma.$transaction([
      prisma.androidAppRelease.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } }),
      prisma.androidAppRelease.update({ where: { id: b.id }, data: { isCurrent: true } }),
    ]);
    const current = await prisma.androidAppRelease.findMany({ where: { isCurrent: true } });
    expect(current.map((r) => r.id)).toEqual([b.id]);
    expect(a.id).not.toBe(b.id);
  });

  it('enforces unique (package_name, version_code)', async () => {
    if (!prisma) return;
    await release(1, false);
    await expect(release(1, false)).rejects.toMatchObject({ code: 'P2002' });
  });

  it('round-trips a BigInt size above 2^31', async () => {
    if (!prisma) return;
    const row = await release(1, false);
    expect(row.sizeBytes).toBe(BigInt(5_000_000_000));
  });

  it('rejects negative media_sync_runs counters and cascades from the device', async () => {
    if (!prisma) return;
    const device = await prisma.mediaSyncDevice.create({
      data: {
        userId,
        installationId: '11111111-1111-4111-8111-111111111111',
        name: 'Pixel test',
        config: {},
      },
    });
    const base = {
      deviceId: device.id,
      trigger: 'manual' as const,
      status: 'ok' as const,
      startedAt: new Date(),
      finishedAt: new Date(),
    };
    await expect(
      prisma.mediaSyncRun.create({ data: { ...base, filesUploaded: -1 } }),
    ).rejects.toBeDefined();
    const ok = await prisma.mediaSyncRun.create({
      data: { ...base, bytesUploaded: BigInt(7_000_000_000) },
    });
    expect(ok.bytesUploaded).toBe(BigInt(7_000_000_000));

    await prisma.mediaSyncDevice.delete({ where: { id: device.id } });
    expect(await prisma.mediaSyncRun.count({ where: { deviceId: device.id } })).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // AndroidReleaseService.makeCurrent against the real index (issue #504).
  // Kept in THIS file rather than a sibling: the index is deployment-wide, so
  // two files creating current rows in parallel Jest workers would collide.
  // ---------------------------------------------------------------------------

  const service = () =>
    new AndroidReleaseService(
      prisma!,
      { getActiveProvider: jest.fn(), getProviderFor: jest.fn() } as never,
      { ensureTrusted: jest.fn().mockResolvedValue(false) } as never,
    );

  it('makeCurrent swaps the current release in one step, rollback included', async () => {
    if (!prisma) return;
    const one = await release(1, false);
    const two = await release(2, true);

    const view = await service().makeCurrent(one.id, userId);

    expect(view).toMatchObject({ id: one.id, isCurrent: true, sizeBytes: '5000000000' });
    const current = await prisma.androidAppRelease.findMany({ where: { packageName: PKG, isCurrent: true } });
    expect(current.map((row) => row.id)).toEqual([one.id]);
    expect((await prisma.androidAppRelease.findUnique({ where: { id: two.id } }))?.isCurrent).toBe(false);
  });

  it('two concurrent makeCurrent calls leave exactly one current release; a loser gets RELEASE_CURRENT_CONFLICT', async () => {
    if (!prisma) return;
    const rows = await Promise.all([1, 2, 3, 4].map((code) => release(code, false)));

    const results = await Promise.allSettled(rows.map((row) => service().makeCurrent(row.id, userId)));

    const current = await prisma.androidAppRelease.findMany({ where: { packageName: PKG, isCurrent: true } });
    expect(current).toHaveLength(1);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(ConflictException);
        expect((result.reason as ConflictException).getResponse()).toMatchObject({
          details: { reason: 'RELEASE_CURRENT_CONFLICT' },
        });
      }
    }
  });
});
