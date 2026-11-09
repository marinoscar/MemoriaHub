/**
 * Real-Postgres tier (issue #502; post-RETRO-D5 model, #586): proves the raw-SQL
 * partial unique index `android_app_releases_one_current_uniq_idx` (intentional
 * schema drift, installed by the platform migration `0033_add_android_app`, see
 * the AndroidAppRelease model comment) allows at most ONE current release
 * deployment-wide on the platform table the android-app slice serves, that the
 * slice's `AndroidReleaseService.makeCurrent` keeps it under concurrency, and
 * that the CHECK constraints on media_sync_runs hold.
 *
 * Needs a database migrated to the latest schema (`npm run prisma:migrate`).
 * When no database is reachable the suite skips (logged) so the default
 * `npm test` stays runnable without Postgres; a reachable but un-migrated
 * database fails loudly.
 */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AndroidReleaseService,
  ONE_CURRENT_RELEASE_INDEX,
  isUniqueViolation,
  resolveAndroidAppModuleOptions,
} from '@marinoscar/platform-api/android-app';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { buildBaseDatabaseUrl } from '../../src/config/database-url.util';
import { applyReleaseCopy, planReleaseCopy } from '../../src/legacy/legacy-android-releases-migration';
import { PrismaService } from '../../src/prisma/prisma.service';

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
    expect(isUniqueViolation(error, ONE_CURRENT_RELEASE_INDEX)).toBe(true);
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
      prisma! as never,
      { upload: jest.fn(), download: jest.fn(), delete: jest.fn() } as never,
      { resolve: jest.fn() } as never,
      { ensureTrusted: jest.fn().mockResolvedValue(false) } as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      resolveAndroidAppModuleOptions({ appName: 'MemoriaHub', apkStem: 'memoriahub-android' }),
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

  // ---------------------------------------------------------------------------
  // The legacy release copy (RETRO-D5, #586): `npm run android:migrate-legacy-releases`.
  // In THIS file for the same reason as above: it sets the deployment-wide current flag.
  // ---------------------------------------------------------------------------

  describe('legacy release copy (mh_legacy_android_app_releases -> android_app_releases)', () => {
    const COPY_PKG = 'example.test.copy';
    let client: Client;

    const insertLegacy = (id: string, code: number, current: boolean) =>
      client.query(
        `INSERT INTO mh_legacy_android_app_releases (id, package_name, version_name, version_code, signing_sha256,
           file_sha256, size_bytes, storage_key, storage_provider, bucket, is_current, uploaded_by_id)
         VALUES ($1, $2, $3, $4, 'AA:BB', $5, 5000000000, $6, 'r2', 'apk-bucket', $7, $8)`,
        [id, COPY_PKG, `1.0.${code}`, code, 'c'.repeat(64), `android-releases/${id}.apk`, current, userId],
      );

    const clean = async () => {
      await client.query('DELETE FROM android_app_releases WHERE package_name = $1', [COPY_PKG]);
      await client.query('DELETE FROM mh_legacy_android_app_releases WHERE package_name = $1', [COPY_PKG]);
    };

    beforeAll(async () => {
      if (!prisma) return;
      client = new Client({ connectionString: buildBaseDatabaseUrl() });
      await client.connect();
    });

    afterAll(async () => {
      if (!prisma) return;
      await clean();
      await client.end();
    });

    beforeEach(async () => {
      if (!prisma) return;
      await clean();
      // The deployment-wide current flag belongs to these tests while they run.
      await prisma.androidAppRelease.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
    });

    it('dry run reports, copies nothing; apply copies under the same ids, promotes the legacy current, keeps conflicts', async () => {
      if (!prisma) return;
      const [old, current, clash, platformClash] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      await insertLegacy(old, 1, false);
      await insertLegacy(current, 2, true);
      await insertLegacy(clash, 3, false);
      // A version the slice already serves under another id: the platform row wins.
      await client.query(
        `INSERT INTO android_app_releases (id, package_name, version_name, version_code, signing_sha256, file_sha256,
           size_bytes, storage_key) VALUES ($1, $2, '1.0.3', 3, 'AA:BB', $3, 1, $4)`,
        [platformClash, COPY_PKG, 'd'.repeat(64), `android-releases/${platformClash}.apk`],
      );

      const plan = await planReleaseCopy(client);
      expect(plan).not.toBeNull();
      expect(plan!.conflicts).toEqual([
        { id: clash, packageName: COPY_PKG, versionCode: 3, platformId: platformClash },
      ]);
      expect(plan!.legacyCurrentId).toBe(current);
      expect(plan!.platformCurrentId).toBeNull();
      expect(await prisma.androidAppRelease.count({ where: { packageName: COPY_PKG } })).toBe(1);

      const result = await applyReleaseCopy(client);
      expect(result.copied).toBeGreaterThanOrEqual(2);
      expect(result.promotedCurrent).toBe(true);
      expect(result.currentId).toBe(current);

      const copied = await prisma.androidAppRelease.findMany({
        where: { packageName: COPY_PKG },
        orderBy: { versionCode: 'asc' },
      });
      expect(copied.map((row) => [row.id, row.versionCode, row.isCurrent])).toEqual([
        [old, 1, false],
        [current, 2, true],
        [platformClash, 3, false],
      ]);
      expect(copied[1]).toMatchObject({
        storageKey: `android-releases/${current}.apk`,
        storageProvider: 'r2',
        bucket: 'apk-bucket',
        sizeBytes: BigInt(5_000_000_000),
        uploadedById: userId,
      });

      // The legacy table is never modified.
      const legacy = await client.query(
        'SELECT id::text AS id, is_current FROM mh_legacy_android_app_releases WHERE package_name = $1 ORDER BY version_code',
        [COPY_PKG],
      );
      expect(legacy.rows).toEqual([
        { id: old, is_current: false },
        { id: current, is_current: true },
        { id: clash, is_current: false },
      ]);

      // Idempotent: a second run copies and promotes nothing.
      const again = await applyReleaseCopy(client);
      expect(again).toEqual({ copied: 0, promotedCurrent: false, currentId: current });
    });

    it('keeps a current release the slice already serves', async () => {
      if (!prisma) return;
      const legacyCurrent = randomUUID();
      const platformCurrent = randomUUID();
      await insertLegacy(legacyCurrent, 1, true);
      await client.query(
        `INSERT INTO android_app_releases (id, package_name, version_name, version_code, signing_sha256, file_sha256,
           size_bytes, storage_key, is_current) VALUES ($1, $2, '1.0.9', 9, 'AA:BB', $3, 1, $4, true)`,
        [platformCurrent, COPY_PKG, 'e'.repeat(64), `android-releases/${platformCurrent}.apk`],
      );

      const result = await applyReleaseCopy(client);

      expect(result.promotedCurrent).toBe(false);
      expect(result.currentId).toBe(platformCurrent);
      const copied = await prisma.androidAppRelease.findUnique({ where: { id: legacyCurrent } });
      expect(copied?.isCurrent).toBe(false);
    });
  });
});
