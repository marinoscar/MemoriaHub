import { ForbiddenException, HttpException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { DeepMockProxy, mockDeep } from 'jest-mock-extended';

import type { AuthCredentialInfo } from '../auth/decorators/auth-credential.decorator';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CheckinInput, MediaSyncConfig } from './dto/media-sync.dto';
import { defaultConfig } from './media-sync-config';
import { MediaSyncService, updateStatus } from './media-sync.service';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const DEVICE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INSTALL_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const PAT_A = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const PAT_B = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const PAT_OLD = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0';
const PAT_CLI = 'c9c9c9c9-c9c9-4c9c-8c9c-c9c9c9c9c9c9';
const PERSONAL_CIRCLE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_CIRCLE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const JWT: AuthCredentialInfo = { kind: 'jwt' };
const pat = (tokenId: string): AuthCredentialInfo => ({ kind: 'pat', tokenId });

const INVENTORY = [
  { bucketId: '111', name: 'Camera', relativePath: 'DCIM/Camera/', photoCount: 10, videoCount: 2, bytes: 5000 },
  { bucketId: '222', name: 'WhatsApp Images', relativePath: 'Pictures/WhatsApp/', photoCount: 3, videoCount: 0, bytes: 900 },
];

type DeviceRow = Record<string, any>;

function deviceRow(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: DEVICE_A,
    userId: USER,
    installationId: INSTALL_A,
    name: 'Pixel 9',
    manufacturer: 'Google',
    model: 'Pixel 9',
    androidVersion: '15',
    sdkInt: 35,
    appVersion: '1.0.0',
    appVersionCode: 1,
    packageName: 'memoriahub.marin.cr',
    signingSha256: null,
    timezone: 'America/Costa_Rica',
    patId: PAT_A,
    status: 'active',
    config: defaultConfig(PERSONAL_CIRCLE),
    configVersion: 1,
    appliedConfigVersion: 0,
    inventory: INVENTORY,
    stats: null,
    permission: null,
    networkState: null,
    batteryOptimized: null,
    lastSeenAt: NOW,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    pat: { expiresAt: new Date('2027-01-01T00:00:00.000Z'), revokedAt: null },
    ...overrides,
  };
}

const STATS = {
  eligible: 12,
  uploaded: 5,
  deduplicated: 1,
  pending: 3,
  uploading: 1,
  failed: 1,
  blocked: 1,
  bytesPending: 1000,
  bytesUploaded: 4000,
};

function checkinBody(overrides: Partial<CheckinInput> = {}): CheckinInput {
  return {
    appliedConfigVersion: 1,
    stats: STATS,
    permission: 'full',
    networkState: 'wifi',
    batteryOptimized: false,
    ...overrides,
  };
}

/** Whether a Prisma `where` (the subset this service uses) matches a row. */
function matches(row: DeviceRow, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'NOT') return !matches(row, value as Record<string, unknown>);
    return row[key] === value;
  });
}

function refusalOf(error: unknown): { status: number; reason?: string; details?: Record<string, unknown> } {
  expect(error).toBeInstanceOf(HttpException);
  const http = error as HttpException;
  const body = http.getResponse() as { details?: Record<string, unknown> };
  return { status: http.getStatus(), reason: body.details?.reason as string | undefined, details: body.details };
}

describe('MediaSyncService', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let circles: { assertCircleAccess: jest.Mock };
  let service: MediaSyncService;
  let devices: DeviceRow[];

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    circles = { assertCircleAccess: jest.fn().mockResolvedValue({ role: 'collaborator', isSuperAdmin: false }) };
    service = new MediaSyncService(prisma as unknown as PrismaService, circles as unknown as CircleMembershipService);
    devices = [deviceRow(), deviceRow({ id: DEVICE_B, installationId: 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1', patId: PAT_B })];

    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
    (prisma.mediaSyncDevice.findFirst as jest.Mock).mockImplementation(async ({ where }) =>
      devices.find((d) => matches(d, where)) ?? null,
    );
    (prisma.mediaSyncDevice.findUniqueOrThrow as jest.Mock).mockImplementation(async ({ where }) => {
      const row = devices.find((d) => d.id === where.id);
      if (!row) throw new Error('not found');
      return row;
    });
    // Compare-and-swap writes: apply when every where-field matches.
    (prisma.mediaSyncDevice.updateMany as jest.Mock).mockImplementation(async ({ where, data }) => {
      let count = 0;
      for (const row of devices) {
        if (!matches(row, where)) continue;
        Object.assign(row, data);
        count++;
      }
      return { count };
    });
    (prisma.androidAppRelease.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.auditEvent.create as jest.Mock).mockResolvedValue({});
    (prisma.$executeRaw as unknown as jest.Mock).mockResolvedValue(0);
  });

  // ---------------------------------------------------------------------------
  // register
  // ---------------------------------------------------------------------------

  describe('register', () => {
    const input = { installationId: INSTALL_A, name: 'Pixel 9', appVersionCode: 3 };

    beforeEach(() => {
      (prisma.circle.findFirst as jest.Mock).mockResolvedValue({ id: PERSONAL_CIRCLE });
      (prisma.mediaSyncDevice.upsert as jest.Mock).mockImplementation(async ({ create }) =>
        deviceRow({ patId: create.patId }),
      );
    });

    it('refuses a session token with 400 PAT_REQUIRED', async () => {
      const error = await service.register(USER, input, JWT).catch((e) => e);
      expect(refusalOf(error)).toMatchObject({ status: 400, reason: 'PAT_REQUIRED' });
      expect(prisma.mediaSyncDevice.upsert).not.toHaveBeenCalled();
    });

    it('creates a new device with the default config on the personal circle and links the PAT', async () => {
      (prisma.mediaSyncDevice.findUnique as jest.Mock).mockResolvedValue(null);

      const { created } = await service.register(USER, input, pat(PAT_A), NOW);

      expect(created).toBe(true);
      const call = (prisma.mediaSyncDevice.upsert as jest.Mock).mock.calls[0][0];
      expect(call.where).toEqual({ userId_installationId: { userId: USER, installationId: INSTALL_A } });
      expect(call.create.config).toEqual({
        targetCircleId: PERSONAL_CIRCLE,
        folders: [],
        includePhotos: true,
        includeVideos: true,
        network: 'wifi',
        requireCharging: false,
        paused: false,
        uploadExisting: 'all',
        retryFailedGeneration: 0,
        syncNowGeneration: 0,
      });
      expect(call.create.patId).toBe(PAT_A);
      expect(call.update).not.toHaveProperty('config');
      expect(call.update).toMatchObject({ patId: PAT_A, status: 'active' });
      expect(prisma.personalAccessToken.updateMany).not.toHaveBeenCalled();
    });

    it('re-registering with a new PAT revokes the previously linked one in the same transaction', async () => {
      (prisma.mediaSyncDevice.findUnique as jest.Mock).mockResolvedValue({ patId: PAT_OLD });

      const { created } = await service.register(USER, input, pat(PAT_A), NOW);

      expect(created).toBe(false);
      expect(prisma.personalAccessToken.updateMany).toHaveBeenCalledWith({
        where: { id: PAT_OLD, userId: USER, revokedAt: null },
        data: { revokedAt: NOW },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('re-registering with the same PAT revokes nothing', async () => {
      (prisma.mediaSyncDevice.findUnique as jest.Mock).mockResolvedValue({ patId: PAT_A });
      await service.register(USER, input, pat(PAT_A), NOW);
      expect(prisma.personalAccessToken.updateMany).not.toHaveBeenCalled();
    });

    it('retires another installation that was linked to the same PAT', async () => {
      (prisma.mediaSyncDevice.findUnique as jest.Mock).mockResolvedValue(null);
      await service.register(USER, input, pat(PAT_B), NOW);
      expect(prisma.mediaSyncDevice.updateMany).toHaveBeenCalledWith({
        where: { userId: USER, patId: PAT_B, NOT: { installationId: INSTALL_A } },
        data: { patId: null, status: 'revoked' },
      });
    });

    it('retries a lost unique-index race as an update', async () => {
      (prisma.mediaSyncDevice.findUnique as jest.Mock).mockResolvedValue(null);
      const p2002 = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
      (prisma.$transaction as jest.Mock)
        .mockRejectedValueOnce(p2002)
        .mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));

      await expect(service.register(USER, input, pat(PAT_A), NOW)).resolves.toBeDefined();
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('falls back to a collaborator circle, and refuses when the user has none', async () => {
      (prisma.circle.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.circleMember.findFirst as jest.Mock).mockResolvedValue(null);

      const error = await service.register(USER, input, pat(PAT_A)).catch((e) => e);
      expect(refusalOf(error)).toMatchObject({ status: 409, reason: 'NO_TARGET_CIRCLE' });
    });
  });

  // ---------------------------------------------------------------------------
  // reads and the view
  // ---------------------------------------------------------------------------

  describe('get / list', () => {
    it("is a 404 for another user's device", async () => {
      await expect(service.get(OTHER_USER, DEVICE_A)).rejects.toMatchObject({ status: 404 });
    });

    it('builds the view: configPending, tokenExpiresAt, update availability', async () => {
      devices[0].configVersion = 3;
      devices[0].appliedConfigVersion = 2;
      (prisma.androidAppRelease.findFirst as jest.Mock).mockResolvedValue({
        packageName: 'memoriahub.marin.cr',
        versionCode: 2,
      });

      const view = await service.get(USER, DEVICE_A);

      expect(view).toMatchObject({
        id: DEVICE_A,
        configVersion: 3,
        appliedConfigVersion: 2,
        configPending: true,
        latestVersionCode: 2,
        updateAvailable: true,
        tokenExpiresAt: '2027-01-01T00:00:00.000Z',
        inventory: INVENTORY,
        stats: null,
      });
      expect(view.config.targetCircleId).toBe(PERSONAL_CIRCLE);
    });

    it('reports no token expiry once the linked PAT is revoked', async () => {
      devices[0].pat = { expiresAt: new Date('2027-01-01'), revokedAt: NOW };
      expect((await service.get(USER, DEVICE_A)).tokenExpiresAt).toBeNull();
    });

    it('lists only the caller\'s devices, most recently seen first', async () => {
      (prisma.mediaSyncDevice.findMany as jest.Mock).mockResolvedValue([devices[0]]);
      await service.list(USER);
      expect(prisma.mediaSyncDevice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER },
          orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });
  });

  describe('updateStatus', () => {
    it('ignores a release of another package', () => {
      expect(
        updateStatus({ packageName: 'memoriahub.marin.cr.debug', appVersionCode: 1 }, { packageName: 'memoriahub.marin.cr', versionCode: 5 }),
      ).toEqual({ latestVersionCode: null, updateAvailable: false });
    });

    it('needs a known, lower versionCode for an update', () => {
      const release = { packageName: 'memoriahub.marin.cr', versionCode: 5 };
      expect(updateStatus({ packageName: null, appVersionCode: null }, release)).toEqual({
        latestVersionCode: 5,
        updateAvailable: false,
      });
      expect(updateStatus({ packageName: null, appVersionCode: 5 }, release).updateAvailable).toBe(false);
      expect(updateStatus({ packageName: null, appVersionCode: 4 }, release).updateAvailable).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // config
  // ---------------------------------------------------------------------------

  describe('updateConfig', () => {
    const web = { id: USER, permissions: ['media:write'] };

    it('bumps configVersion, takes folder names from the inventory, and audits the web actor', async () => {
      const result = await service.updateConfig(
        web,
        DEVICE_A,
        { folders: [{ bucketId: '111', name: 'whatever the client says' }], network: 'any' },
        JWT,
      );

      expect(result.configVersion).toBe(2);
      expect(result.config.folders).toEqual([{ bucketId: '111', name: 'Camera' }]);
      expect(result.config.network).toBe('any');
      expect(devices[0].configVersion).toBe(2);
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'media_sync.config.updated',
          targetType: 'media_sync_device',
          targetId: DEVICE_A,
          meta: expect.objectContaining({ actor: 'web', configVersion: 2, changed: ['folders', 'network'] }),
        }),
      });
    });

    it('refuses a target circle the caller cannot write with 403 TARGET_CIRCLE_FORBIDDEN', async () => {
      circles.assertCircleAccess.mockRejectedValue(new ForbiddenException('nope'));

      const error = await service.updateConfig(web, DEVICE_A, { targetCircleId: OTHER_CIRCLE }, JWT).catch((e) => e);

      expect(refusalOf(error)).toMatchObject({
        status: 403,
        reason: 'TARGET_CIRCLE_FORBIDDEN',
        details: { reason: 'TARGET_CIRCLE_FORBIDDEN', circleId: OTHER_CIRCLE },
      });
      expect(circles.assertCircleAccess).toHaveBeenCalledWith(USER, OTHER_CIRCLE, ['media:write'], 'collaborator');
      expect(devices[0].configVersion).toBe(1);
    });

    it('accepts a collaborator target circle', async () => {
      const result = await service.updateConfig(web, DEVICE_A, { targetCircleId: OTHER_CIRCLE }, JWT);
      expect(result.config.targetCircleId).toBe(OTHER_CIRCLE);
    });

    it('refuses a folder missing from the inventory with 400 UNKNOWN_FOLDER and the bucket ids', async () => {
      const error = await service
        .updateConfig(web, DEVICE_A, { folders: [{ bucketId: '111', name: 'a' }, { bucketId: '999', name: 'b' }] }, JWT)
        .catch((e) => e);

      expect(refusalOf(error)).toMatchObject({ status: 400, reason: 'UNKNOWN_FOLDER', details: { bucketIds: ['999'] } });
    });

    it('allows an empty folder list', async () => {
      devices[0].inventory = null;
      const result = await service.updateConfig(web, DEVICE_A, { folders: [] }, JWT);
      expect(result.config.folders).toEqual([]);
    });

    it('refuses inventory from a session token with 400 INVENTORY_NOT_ALLOWED', async () => {
      const error = await service.updateConfig(web, DEVICE_A, { inventory: INVENTORY }, JWT).catch((e) => e);
      expect(refusalOf(error)).toMatchObject({ status: 400, reason: 'INVENTORY_NOT_ALLOWED' });
    });

    it("lets the device's PAT report a fresh folder and select it in one request", async () => {
      const fresh = [...INVENTORY, { bucketId: '333', name: 'Screenshots', relativePath: 'Pictures/Screenshots/', photoCount: 1, videoCount: 0, bytes: 10 }];

      const result = await service.updateConfig(
        web,
        DEVICE_A,
        { inventory: fresh, folders: [{ bucketId: '333', name: 'x' }] },
        pat(PAT_A),
      );

      expect(result.config.folders).toEqual([{ bucketId: '333', name: 'Screenshots' }]);
      expect(devices[0].inventory).toEqual(fresh);
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ meta: expect.objectContaining({ actor: 'device' }) }),
      });
    });

    it("gives a PAT linked to device A a 404 on device B's config", async () => {
      await expect(service.updateConfig(web, DEVICE_B, { network: 'any' }, pat(PAT_A))).rejects.toMatchObject({
        status: 404,
      });
      expect(devices[1].configVersion).toBe(1);
    });

    it('lets a PAT linked to no device (a CLI token) manage every device', async () => {
      const result = await service.updateConfig(web, DEVICE_B, { network: 'any' }, pat(PAT_CLI));
      expect(result.configVersion).toBe(2);
    });

    it('retries the compare-and-swap when another writer bumped the version', async () => {
      const real = (prisma.mediaSyncDevice.updateMany as jest.Mock).getMockImplementation()!;
      (prisma.mediaSyncDevice.updateMany as jest.Mock).mockImplementationOnce(async () => {
        devices[0].configVersion = 5; // a concurrent edit landed
        return { count: 0 };
      });
      (prisma.mediaSyncDevice.updateMany as jest.Mock).mockImplementation(real);

      const result = await service.updateConfig(web, DEVICE_A, { requireCharging: true }, JWT);

      expect(result.configVersion).toBe(6);
    });

    it('refuses a revoked device with 409 DEVICE_REVOKED', async () => {
      devices[0].status = 'revoked';
      const error = await service.updateConfig(web, DEVICE_A, { network: 'any' }, JWT).catch((e) => e);
      expect(refusalOf(error)).toMatchObject({ status: 409, reason: 'DEVICE_REVOKED' });
    });
  });

  // ---------------------------------------------------------------------------
  // commands
  // ---------------------------------------------------------------------------

  describe('command', () => {
    const cases: Array<[string, Partial<MediaSyncConfig>]> = [
      ['pause', { paused: true }],
      ['retry_failed', { retryFailedGeneration: 1 }],
      ['sync_now', { syncNowGeneration: 1 }],
    ];

    it.each(cases)('%s mutates the config and bumps configVersion', async (action, expected) => {
      const result = await service.command(USER, DEVICE_A, action as never, JWT);
      expect(result.config).toMatchObject(expected);
      expect(result.configVersion).toBe(2);
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'media_sync.command',
          meta: expect.objectContaining({ action, actor: 'web' }),
        }),
      });
    });

    it('resume clears paused, and repeated commands keep bumping', async () => {
      await service.command(USER, DEVICE_A, 'pause', pat(PAT_A));
      const result = await service.command(USER, DEVICE_A, 'resume', pat(PAT_A));
      expect(result.config.paused).toBe(false);
      expect(result.configVersion).toBe(3);
    });

    it('increments generations monotonically', async () => {
      await service.command(USER, DEVICE_A, 'sync_now', JWT);
      const result = await service.command(USER, DEVICE_A, 'sync_now', JWT);
      expect(result.config.syncNowGeneration).toBe(2);
    });

    it("gives a PAT linked to device A a 404 on device B's commands", async () => {
      await expect(service.command(USER, DEVICE_B, 'pause', pat(PAT_A))).rejects.toMatchObject({ status: 404 });
    });
  });

  // ---------------------------------------------------------------------------
  // check-in
  // ---------------------------------------------------------------------------

  describe('checkin', () => {
    it('refuses a session token with 400 PAT_REQUIRED', async () => {
      const error = await service.checkin(USER, DEVICE_A, checkinBody(), JWT).catch((e) => e);
      expect(refusalOf(error)).toMatchObject({ status: 400, reason: 'PAT_REQUIRED' });
    });

    it("refuses a PAT that is not the device's own with 400 PAT_REQUIRED", async () => {
      const error = await service.checkin(USER, DEVICE_A, checkinBody(), pat(PAT_CLI)).catch((e) => e);
      expect(refusalOf(error)).toMatchObject({ status: 400, reason: 'PAT_REQUIRED' });
    });

    it("gives a PAT linked to device A a 404 on device B's check-in", async () => {
      await expect(service.checkin(USER, DEVICE_B, checkinBody(), pat(PAT_A))).rejects.toMatchObject({ status: 404 });
    });

    it("is a 404 for another user's device", async () => {
      await expect(service.checkin(OTHER_USER, DEVICE_A, checkinBody(), pat(PAT_A))).rejects.toMatchObject({
        status: 404,
      });
    });

    it('refuses a revoked device with 409 DEVICE_REVOKED', async () => {
      devices[0].status = 'revoked';
      const error = await service.checkin(USER, DEVICE_A, checkinBody(), pat(PAT_A)).catch((e) => e);
      expect(refusalOf(error)).toMatchObject({ status: 409, reason: 'DEVICE_REVOKED', details: { deviceId: DEVICE_A } });
    });

    it('stores the reported state and returns the desired config', async () => {
      devices[0].configVersion = 4;

      const result = await service.checkin(
        USER,
        DEVICE_A,
        checkinBody({ appliedConfigVersion: 9, inventory: INVENTORY, appVersion: '1.0.1', appVersionCode: 2 }),
        pat(PAT_A),
        NOW,
      );

      expect(result).toEqual({ config: devices[0].config, configVersion: 4, serverTime: NOW.toISOString() });
      expect(devices[0]).toMatchObject({
        stats: STATS,
        inventory: INVENTORY,
        permission: 'full',
        networkState: 'wifi',
        batteryOptimized: false,
        appliedConfigVersion: 4, // clamped: the phone cannot apply a version never issued
        appVersion: '1.0.1',
        appVersionCode: 2,
        lastSeenAt: NOW,
      });
      expect(prisma.mediaSyncRun.create).not.toHaveBeenCalled();
    });

    it('keeps the stored inventory when the check-in omits it', async () => {
      await service.checkin(USER, DEVICE_A, checkinBody(), pat(PAT_A), NOW);
      expect(devices[0].inventory).toEqual(INVENTORY);
    });

    it('records a run, stamps the last-sync fields and trims to the newest 200 runs', async () => {
      const run = {
        trigger: 'periodic' as const,
        status: 'partial' as const,
        startedAt: '2026-10-02T11:00:00.000Z',
        finishedAt: '2026-10-02T11:05:00.000Z',
        filesUploaded: 4,
        bytesUploaded: 5_000_000_000,
        filesFailed: 1,
        filesDeduplicated: 2,
        failedSample: [{ name: 'IMG_1.jpg', relativePath: 'DCIM/Camera/', sizeBytes: 10, attempts: 2, lastError: 'HTTP 500' }],
      };

      await service.checkin(USER, DEVICE_A, checkinBody({ run }), pat(PAT_A), NOW);

      expect(prisma.mediaSyncRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          deviceId: DEVICE_A,
          trigger: 'periodic',
          status: 'partial',
          filesUploaded: 4,
          filesFailed: 1,
          filesDeduplicated: 2,
          bytesUploaded: BigInt(5_000_000_000),
          errorCode: null,
          details: { failedSample: run.failedSample },
        }),
      });
      expect(devices[0]).toMatchObject({
        lastSyncAt: new Date(run.finishedAt),
        lastSyncStatus: 'partial',
        lastError: 'HTTP 500',
      });
      const trim = (prisma.$executeRaw as unknown as jest.Mock).mock.calls[0];
      expect(trim[0].join('')).toContain('DELETE FROM "media_sync_runs"');
      expect(trim.slice(1)).toEqual([DEVICE_A, DEVICE_A, 200]);
    });

    it('clears lastError on an ok run and keeps it on a skipped one', async () => {
      devices[0].lastError = 'old';
      const base = {
        trigger: 'manual' as const,
        startedAt: '2026-10-02T11:00:00.000Z',
        finishedAt: '2026-10-02T11:00:01.000Z',
        filesUploaded: 0,
        bytesUploaded: 0,
        filesFailed: 0,
        filesDeduplicated: 0,
      };

      await service.checkin(USER, DEVICE_A, checkinBody({ run: { ...base, status: 'skipped' } }), pat(PAT_A));
      expect(devices[0].lastError).toBe('old');

      await service.checkin(USER, DEVICE_A, checkinBody({ run: { ...base, status: 'ok' } }), pat(PAT_A));
      expect(devices[0].lastError).toBeNull();
    });

    it('turns an unpair that lands mid-check-in into 409 DEVICE_REVOKED', async () => {
      (prisma.mediaSyncDevice.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });
      const error = await service.checkin(USER, DEVICE_A, checkinBody(), pat(PAT_A)).catch((e) => e);
      expect(refusalOf(error)).toMatchObject({ status: 409, reason: 'DEVICE_REVOKED' });
    });
  });

  // ---------------------------------------------------------------------------
  // runs and diagnostics
  // ---------------------------------------------------------------------------

  describe('runs and diagnostics', () => {
    it('serializes bytesUploaded as a string', async () => {
      (prisma.mediaSyncRun.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'r1',
          deviceId: DEVICE_A,
          trigger: 'manual',
          status: 'ok',
          startedAt: NOW,
          finishedAt: NOW,
          filesUploaded: 1,
          filesFailed: 0,
          filesDeduplicated: 0,
          bytesUploaded: BigInt('9007199254740993'),
          errorCode: null,
          details: null,
          createdAt: NOW,
        },
      ]);

      const runs = await service.listRuns(USER, DEVICE_A, 50);

      expect(runs[0].bytesUploaded).toBe('9007199254740993');
      expect(() => JSON.stringify(runs)).not.toThrow();
      expect(prisma.mediaSyncRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
    });

    it('stores a report and trims to the newest 20, also for a revoked device', async () => {
      devices[0].status = 'revoked';
      (prisma.mediaSyncDiagnosticReport.create as jest.Mock).mockResolvedValue({ id: 'rep1', createdAt: NOW });

      const created = await service.uploadDiagnostics(USER, DEVICE_A, { summary: '2 problems', report: { checks: [] } }, pat(PAT_A));

      expect(created).toEqual({ id: 'rep1', createdAt: NOW.toISOString() });
      const trim = (prisma.$executeRaw as unknown as jest.Mock).mock.calls[0];
      expect(trim[0].join('')).toContain('DELETE FROM "media_sync_diagnostic_reports"');
      expect(trim.slice(1)).toEqual([DEVICE_A, DEVICE_A, 20]);
    });

    it("gives a PAT linked to device A a 404 on device B's diagnostics upload", async () => {
      await expect(
        service.uploadDiagnostics(USER, DEVICE_B, { report: {} }, pat(PAT_A)),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('is a 404 for a report of another device', async () => {
      (prisma.mediaSyncDiagnosticReport.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(service.getDiagnostics(USER, DEVICE_A, 'rep-x')).rejects.toMatchObject({ status: 404 });
      expect(prisma.mediaSyncDiagnosticReport.findFirst).toHaveBeenCalledWith({
        where: { id: 'rep-x', deviceId: DEVICE_A },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // unpair
  // ---------------------------------------------------------------------------

  describe('unpair', () => {
    it('revokes the device and its linked PAT in one transaction', async () => {
      await service.unpair(USER, DEVICE_A, JWT, NOW);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.mediaSyncDevice.update).toHaveBeenCalledWith({ where: { id: DEVICE_A }, data: { status: 'revoked' } });
      expect(prisma.personalAccessToken.updateMany).toHaveBeenCalledWith({
        where: { id: PAT_A, userId: USER, revokedAt: null },
        data: { revokedAt: NOW },
      });
    });

    it("gives a PAT linked to device A a 404 when unpairing device B", async () => {
      await expect(service.unpair(USER, DEVICE_B, pat(PAT_A))).rejects.toMatchObject({ status: 404 });
      expect(prisma.mediaSyncDevice.update).not.toHaveBeenCalled();
    });
  });
});
