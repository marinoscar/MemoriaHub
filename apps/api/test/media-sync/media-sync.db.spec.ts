/**
 * Real-Postgres tier (issue #505). A mocked Prisma cannot prove these:
 *
 * - concurrent registrations of one `(userId, installationId)` converge on ONE
 *   `media_sync_devices` row (the `@@unique` plus the service's P2002 retry);
 * - the run and diagnostics retention trims (raw SQL) keep exactly the newest
 *   200 runs and 20 reports per device;
 * - the compare-and-swap config write bumps `config_version` exactly once per
 *   concurrent writer, never losing an update.
 *
 * Needs a database migrated to the latest schema (`npm run prisma:migrate`).
 * Skips (reported as skipped, never passed) when nothing listens on the port.
 */
import { randomUUID } from 'crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CircleMembershipService } from '../../src/circles/circle-membership.service';
import { MediaSyncService } from '../../src/media-sync/media-sync.service';
import { checkinSchema, registerDeviceSchema } from '../../src/media-sync/dto/media-sync.dto';
import { isDatabaseReachable } from '../helpers/db-probe.helper';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const STATS = {
  eligible: 1,
  uploaded: 0,
  deduplicated: 0,
  pending: 1,
  uploading: 0,
  failed: 0,
  blocked: 0,
  bytesPending: 1,
  bytesUploaded: 0,
};

describeMaybeDb('Media Sync (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
  let service: MediaSyncService;
  let userId: string;
  let circleId: string;
  let patId: string;

  const pat = () => ({ kind: 'pat' as const, tokenId: patId });
  const register = (installationId: string) =>
    service.register(userId, registerDeviceSchema.parse({ installationId, name: 'Pixel 9' }), pat());

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    service = new MediaSyncService(prisma, new CircleMembershipService(prisma));

    const user = await prisma.user.create({ data: { email: `media-sync-db-${Date.now()}@example.test` } });
    userId = user.id;
    const circle = await prisma.circle.create({ data: { name: 'Personal', ownerId: userId, isPersonal: true } });
    circleId = circle.id;
    await prisma.circleMember.create({ data: { circleId, userId, role: 'circle_admin' } });
    const token = await prisma.personalAccessToken.create({
      data: {
        userId,
        name: 'media-sync-db',
        tokenHash: randomUUID(),
        tokenPrefix: 'pat_test',
        durationValue: 30,
        durationUnit: 'days',
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    patId = token.id;
  });

  afterAll(async () => {
    await prisma.mediaSyncDevice.deleteMany({ where: { userId } });
    await prisma.personalAccessToken.deleteMany({ where: { userId } });
    await prisma.circle.deleteMany({ where: { ownerId: userId } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('collapses concurrent registrations of one installation into a single row', async () => {
    const installationId = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => register(installationId)));

    const rows = await prisma.mediaSyncDevice.findMany({ where: { userId, installationId } });
    expect(rows).toHaveLength(1);
    expect(new Set(results.map((r) => r.device.id))).toEqual(new Set([rows[0].id]));
    expect(results.some((r) => r.created)).toBe(true);
    expect(rows[0].patId).toBe(patId);
    expect(rows[0].status).toBe('active');
    expect((rows[0].config as { targetCircleId: string }).targetCircleId).toBe(circleId);
  });

  it('keeps only the newest 200 runs of a device', async () => {
    const { device } = await register(randomUUID());
    const base = Date.now() - 86_400_000;
    await prisma.mediaSyncRun.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({
        deviceId: device.id,
        trigger: 'periodic' as const,
        status: 'ok' as const,
        startedAt: new Date(base + i * 1000),
        finishedAt: new Date(base + i * 1000 + 500),
        createdAt: new Date(base + i * 1000),
      })),
    });
    const oldest = await prisma.mediaSyncRun.findFirst({
      where: { deviceId: device.id },
      orderBy: { createdAt: 'asc' },
    });

    await service.checkin(
      userId,
      device.id,
      checkinSchema.parse({
        appliedConfigVersion: 1,
        stats: STATS,
        permission: 'full',
        networkState: 'wifi',
        batteryOptimized: false,
        run: {
          trigger: 'manual',
          status: 'ok',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          filesUploaded: 1,
          bytesUploaded: 10,
          filesFailed: 0,
          filesDeduplicated: 0,
        },
      }),
      pat(),
    );

    expect(await prisma.mediaSyncRun.count({ where: { deviceId: device.id } })).toBe(200);
    expect(await prisma.mediaSyncRun.findUnique({ where: { id: oldest!.id } })).toBeNull();
    expect(await prisma.mediaSyncRun.count({ where: { deviceId: device.id, trigger: 'manual' } })).toBe(1);
  });

  it('keeps only the newest 20 diagnostics reports of a device', async () => {
    const { device } = await register(randomUUID());
    for (let i = 0; i < 22; i++) {
      await service.uploadDiagnostics(userId, device.id, { summary: `r${i}`, report: { i } }, pat());
    }
    const reports = await prisma.mediaSyncDiagnosticReport.findMany({ where: { deviceId: device.id } });
    expect(reports).toHaveLength(20);
    expect(reports.map((r) => r.summary)).not.toContain('r0');
    expect(reports.map((r) => r.summary)).toContain('r21');
  });

  it('bumps configVersion once per concurrent command without losing an update', async () => {
    const { device } = await register(randomUUID());
    const caller = { kind: 'jwt' as const };
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => service.command(userId, device.id, 'sync_now', caller)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;

    const row = await prisma.mediaSyncDevice.findUniqueOrThrow({ where: { id: device.id } });
    expect(row.configVersion).toBe(1 + ok);
    expect((row.config as { syncNowGeneration: number }).syncNowGeneration).toBe(ok);
    expect(ok).toBeGreaterThan(0);
  });
});
