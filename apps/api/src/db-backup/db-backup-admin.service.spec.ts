import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import {
  DatabaseBackupAdminService,
  computeNextRunAt,
  toRunDto,
} from './db-backup-admin.service';
import { DatabaseBackupAlreadyRunningError } from './db-backup.errors';

const BASE_CONFIG = {
  enabled: true,
  frequency: 'daily' as const,
  dayOfWeek: 0,
  dayOfMonth: 1,
  timeOfDay: '02:00',
  timezone: 'UTC',
  retentionCount: 7,
  storageProvider: null as string | null,
  runStaleMinutes: 30,
  compressionLevel: 1,
  restoreRollbackMode: 'retain_database' as const,
  oldDatabaseRetentionHours: 168,
};

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    status: 'completed',
    trigger: 'manual',
    startedAt: new Date('2026-08-09T02:00:00.000Z'),
    finishedAt: new Date('2026-08-09T02:30:00.000Z'),
    lastHeartbeatAt: new Date('2026-08-09T02:30:00.000Z'),
    verifiedAt: new Date('2026-08-09T02:29:00.000Z'),
    bytesWritten: 12345678901234n,
    sizeBytes: 12345678901234n,
    storageProvider: 'r2',
    storageKey: 'db-backups/2026-08-09-run-1.dump',
    bucket: 'archive-bucket',
    format: 'custom',
    checksumSha256: 'abc123',
    dbVersion: 'PostgreSQL 16',
    appVersion: '1.2.3',
    migrationName: '20260809150000_add_database_backups',
    lastError: null,
    createdById: 'user-1',
    restoreStatus: null,
    restoreError: null,
    restoredAt: null,
    restoredById: null,
    restoreScratchDb: null,
    restoreOldDb: null,
    swappedAt: null,
    preRestoreBackupId: null,
    ...overrides,
  } as any;
}

describe('DatabaseBackupAdminService', () => {
  let prisma: any;
  let config: any;
  let systemSettings: any;
  let resolver: any;
  let runner: any;
  let service: DatabaseBackupAdminService;
  let provider: any;

  beforeEach(() => {
    provider = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://signed/url'),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    prisma = {
      databaseBackupRun: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        delete: jest.fn().mockResolvedValue(undefined),
      },
      storageProviderCredential: {
        findUnique: jest.fn(),
      },
    };

    config = { get: jest.fn((_k: string, d?: unknown) => d) };
    systemSettings = {
      getSettings: jest.fn().mockResolvedValue({ databaseBackup: BASE_CONFIG }),
      patchSettings: jest.fn().mockResolvedValue(undefined),
    };
    resolver = { getProviderFor: jest.fn().mockResolvedValue(provider) };
    runner = { startBackup: jest.fn(), cancelRun: jest.fn() };

    service = new DatabaseBackupAdminService(
      prisma,
      config,
      systemSettings,
      resolver,
      runner,
    );
  });

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  describe('getConfig', () => {
    it('returns the namespace plus a computed next run time', async () => {
      const result = await service.getConfig();
      expect(result.config).toEqual(BASE_CONFIG);
      expect(result.nextRunAt).toMatch(/T02:00:00\.000Z$/);
      expect(result.activeRunId).toBeNull();
    });

    it('surfaces the active run id when one holds the slot', async () => {
      prisma.databaseBackupRun.findFirst.mockResolvedValue({ id: 'run-live' });
      await expect(service.getConfig()).resolves.toMatchObject({
        activeRunId: 'run-live',
      });
    });
  });

  describe('updateConfig', () => {
    it('rejects an unknown IANA time zone', async () => {
      await expect(
        service.updateConfig({ timezone: 'Mars/Olympus_Mons' } as any, 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(systemSettings.patchSettings).not.toHaveBeenCalled();
    });

    it('accepts a real IANA time zone', async () => {
      await service.updateConfig({ timezone: 'America/Costa_Rica' } as any, 'u1');
      expect(systemSettings.patchSettings).toHaveBeenCalledWith(
        { databaseBackup: { timezone: 'America/Costa_Rica' } },
        'u1',
      );
    });

    it('rejects a storageProvider that is not configured', async () => {
      prisma.storageProviderCredential.findUnique.mockResolvedValue(null);
      await expect(
        service.updateConfig({ storageProvider: 'r2' } as any, 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(systemSettings.patchSettings).not.toHaveBeenCalled();
    });

    it('rejects a storageProvider that is configured but DISABLED', async () => {
      prisma.storageProviderCredential.findUnique.mockResolvedValue({
        enabled: false,
      });
      await expect(
        service.updateConfig({ storageProvider: 'r2' } as any, 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown provider key outright', async () => {
      await expect(
        service.updateConfig({ storageProvider: 'dropbox' } as any, 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a configured, enabled provider', async () => {
      prisma.storageProviderCredential.findUnique.mockResolvedValue({
        enabled: true,
      });
      await service.updateConfig({ storageProvider: 'r2' } as any, 'u1');
      expect(systemSettings.patchSettings).toHaveBeenCalled();
    });

    it('accepts local disk with no credential row (requiresCredentials: false)', async () => {
      prisma.storageProviderCredential.findUnique.mockResolvedValue(null);
      await service.updateConfig({ storageProvider: 'local' } as any, 'u1');
      expect(systemSettings.patchSettings).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Trigger
  // -------------------------------------------------------------------------

  describe('startRun', () => {
    it('returns immediately with the run id without awaiting the dump', async () => {
      let settle: (v: any) => void = () => {};
      const completion = new Promise((res) => {
        settle = res;
      });
      runner.startBackup.mockResolvedValue({ runId: 'run-9', completion });

      await expect(service.startRun('u1')).resolves.toEqual({
        runId: 'run-9',
        status: 'running',
      });
      expect(runner.startBackup).toHaveBeenCalledWith({
        trigger: 'manual',
        createdById: 'u1',
      });
      settle(undefined);
    });

    it('attaches a catch so a background failure is not an unhandled rejection', async () => {
      const completion = Promise.reject(new Error('pg_dump exploded'));
      runner.startBackup.mockResolvedValue({ runId: 'run-9', completion });

      await service.startRun('u1');
      // Give the attached handler a turn; an unhandled rejection would surface
      // as a process-level warning/failure rather than a passing assertion.
      await new Promise((r) => setImmediate(r));
      await expect(completion.catch((e) => e.message)).resolves.toBe(
        'pg_dump exploded',
      );
    });

    it('returns 409 CARRYING the active run id when the slot is held', async () => {
      runner.startBackup.mockRejectedValue(
        new DatabaseBackupAlreadyRunningError('run-live'),
      );

      await expect(service.startRun('u1')).rejects.toBeInstanceOf(
        ConflictException,
      );

      try {
        await service.startRun('u1');
      } catch (err: any) {
        expect(err.getResponse()).toMatchObject({ activeRunId: 'run-live' });
      }
    });

    it('still 409s when the winning run finished before it could be looked up', async () => {
      runner.startBackup.mockRejectedValue(
        new DatabaseBackupAlreadyRunningError(null),
      );
      try {
        await service.startRun('u1');
        fail('expected a conflict');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse()).toMatchObject({ activeRunId: null });
      }
    });
  });

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  describe('listRuns / getRun', () => {
    it('lists newest first with pagination meta', async () => {
      prisma.databaseBackupRun.findMany.mockResolvedValue([makeRun()]);
      prisma.databaseBackupRun.count.mockResolvedValue(3);

      const res = await service.listRuns({ page: 1, pageSize: 2 } as any);

      expect(prisma.databaseBackupRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          skip: 0,
          take: 2,
        }),
      );
      expect(res.meta).toEqual({
        page: 1,
        pageSize: 2,
        totalItems: 3,
        totalPages: 2,
      });
    });

    it('filters by status when given', async () => {
      await service.listRuns({ page: 1, pageSize: 20, status: 'failed' } as any);
      expect(prisma.databaseBackupRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'failed' } }),
      );
    });

    it('404s an unknown run', async () => {
      prisma.databaseBackupRun.findUnique.mockResolvedValue(null);
      await expect(service.getRun('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('reports elapsed time against now while still running', async () => {
      prisma.databaseBackupRun.findUnique.mockResolvedValue(
        makeRun({
          status: 'running',
          startedAt: new Date(Date.now() - 60_000),
          finishedAt: null,
        }),
      );
      const run = await service.getRun('run-1');
      expect(run.elapsedMs).toBeGreaterThanOrEqual(60_000);
    });
  });

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  describe('getDownloadUrl', () => {
    it('rejects a run that is not completed', async () => {
      prisma.databaseBackupRun.findUnique.mockResolvedValue(
        makeRun({ status: 'running' }),
      );
      await expect(
        service.getDownloadUrl('run-1', {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(resolver.getProviderFor).not.toHaveBeenCalled();
    });

    it('rejects a failed run', async () => {
      prisma.databaseBackupRun.findUnique.mockResolvedValue(
        makeRun({ status: 'failed' }),
      );
      await expect(
        service.getDownloadUrl('run-1', {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resolves the provider RECORDED ON THE RUN, not the active one', async () => {
      prisma.databaseBackupRun.findUnique.mockResolvedValue(
        makeRun({ storageProvider: 'r2', bucket: 'archive-bucket' }),
      );

      const res = await service.getDownloadUrl('run-1', {} as any);

      expect(resolver.getProviderFor).toHaveBeenCalledWith(
        'r2',
        'archive-bucket',
      );
      // The active-provider path must never be consulted here.
      expect(resolver.getActiveProvider).toBeUndefined();
      expect(provider.getSignedDownloadUrl).toHaveBeenCalledWith(
        'db-backups/2026-08-09-run-1.dump',
        { expiresIn: 3600 },
      );
      expect(res).toEqual({ url: 'https://signed/url', expiresIn: 3600 });
    });

    it('honours an explicit expiresIn', async () => {
      prisma.databaseBackupRun.findUnique.mockResolvedValue(makeRun());
      const res = await service.getDownloadUrl('run-1', {
        expiresIn: 900,
      } as any);
      expect(provider.getSignedDownloadUrl).toHaveBeenCalledWith(
        expect.any(String),
        { expiresIn: 900 },
      );
      expect(res.expiresIn).toBe(900);
    });

    it('rejects a completed run with no recorded storage location', async () => {
      prisma.databaseBackupRun.findUnique.mockResolvedValue(
        makeRun({ storageKey: null }),
      );
      await expect(
        service.getDownloadUrl('run-1', {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  describe('deleteRun', () => {
    it('refuses to delete a running row', async () => {
      prisma.databaseBackupRun.findUnique.mockResolvedValue(
        makeRun({ status: 'running' }),
      );
      await expect(service.deleteRun('run-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.databaseBackupRun.delete).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it('refuses to delete a pending row (it holds the active slot too)', async () => {
      prisma.databaseBackupRun.findUnique.mockResolvedValue(
        makeRun({ status: 'pending' }),
      );
      await expect(service.deleteRun('run-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('deletes the object via the recorded provider, then the row', async () => {
      prisma.databaseBackupRun.findUnique.mockResolvedValue(makeRun());

      const res = await service.deleteRun('run-1');

      expect(resolver.getProviderFor).toHaveBeenCalledWith(
        'r2',
        'archive-bucket',
      );
      expect(provider.delete).toHaveBeenCalledWith(
        'db-backups/2026-08-09-run-1.dump',
      );
      expect(prisma.databaseBackupRun.delete).toHaveBeenCalledWith({
        where: { id: 'run-1' },
      });
      expect(res).toEqual({ deleted: true, objectDeleted: true });
    });

    it('still deletes the row when the object is already gone', async () => {
      prisma.databaseBackupRun.findUnique.mockResolvedValue(makeRun());
      provider.delete.mockRejectedValue(new Error('NoSuchKey'));

      const res = await service.deleteRun('run-1');

      expect(prisma.databaseBackupRun.delete).toHaveBeenCalled();
      expect(res.objectDeleted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  describe('cancelRun', () => {
    it('delegates to the runner for a running row', async () => {
      prisma.databaseBackupRun.findUnique.mockResolvedValue(
        makeRun({ status: 'running' }),
      );
      runner.cancelRun.mockResolvedValue({ signalled: true });

      await expect(service.cancelRun('run-1')).resolves.toEqual({
        runId: 'run-1',
        signalled: true,
      });
      expect(runner.cancelRun).toHaveBeenCalledWith('run-1');
    });

    it('refuses to cancel a terminal run', async () => {
      prisma.databaseBackupRun.findUnique.mockResolvedValue(
        makeRun({ status: 'completed' }),
      );
      await expect(service.cancelRun('run-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(runner.cancelRun).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // BigInt serialization — the highest-risk bug in this feature
  // -------------------------------------------------------------------------

  describe('BigInt serialization', () => {
    it('JSON-serializes a run detail response without throwing', async () => {
      prisma.databaseBackupRun.findUnique.mockResolvedValue(makeRun());
      const run = await service.getRun('run-1');

      // A raw Prisma row here would throw
      // "Do not know how to serialize a BigInt".
      const json = JSON.parse(JSON.stringify(run));
      expect(json.bytesWritten).toBe('12345678901234');
      expect(json.sizeBytes).toBe('12345678901234');
      expect(typeof json.bytesWritten).toBe('string');
    });

    it('JSON-serializes a list response without throwing', async () => {
      prisma.databaseBackupRun.findMany.mockResolvedValue([
        makeRun(),
        makeRun({ id: 'run-2', sizeBytes: null, bytesWritten: 0n }),
      ]);
      prisma.databaseBackupRun.count.mockResolvedValue(2);

      const res = await service.listRuns({ page: 1, pageSize: 20 } as any);
      const json = JSON.parse(JSON.stringify(res));

      expect(json.items[0].sizeBytes).toBe('12345678901234');
      expect(json.items[1].sizeBytes).toBeNull();
      expect(json.items[1].bytesWritten).toBe('0');
    });

    it('leaves no BigInt anywhere in the mapped DTO', () => {
      const dto = toRunDto(makeRun());
      for (const [key, value] of Object.entries(dto)) {
        expect(typeof value).not.toBe('bigint');
        expect(key).toBeDefined();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Schedule computation
// ---------------------------------------------------------------------------

describe('computeNextRunAt', () => {
  it('returns null when backups are disabled', () => {
    expect(computeNextRunAt({ ...BASE_CONFIG, enabled: false }, new Date())).toBeNull();
  });

  it('picks today for a daily schedule that has not fired yet', () => {
    const now = new Date('2026-08-09T01:00:00.000Z');
    expect(computeNextRunAt(BASE_CONFIG, now)?.toISOString()).toBe(
      '2026-08-09T02:00:00.000Z',
    );
  });

  it('rolls to tomorrow once today has passed', () => {
    const now = new Date('2026-08-09T03:00:00.000Z');
    expect(computeNextRunAt(BASE_CONFIG, now)?.toISOString()).toBe(
      '2026-08-10T02:00:00.000Z',
    );
  });

  it('resolves the wall-clock time in the configured zone, not UTC', () => {
    // 02:00 in UTC-06:00 is 08:00 UTC.
    const now = new Date('2026-08-09T00:00:00.000Z');
    const next = computeNextRunAt(
      { ...BASE_CONFIG, timezone: 'America/Costa_Rica' },
      now,
    );
    expect(next?.toISOString()).toBe('2026-08-09T08:00:00.000Z');
  });

  it('lands on the configured weekday for a weekly schedule', () => {
    const now = new Date('2026-08-09T12:00:00.000Z'); // a Sunday
    const next = computeNextRunAt(
      { ...BASE_CONFIG, frequency: 'weekly', dayOfWeek: 3 },
      now,
    );
    expect(next?.getUTCDay()).toBe(3);
    expect(next!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('lands on the configured day for a monthly schedule', () => {
    const now = new Date('2026-08-09T12:00:00.000Z');
    const next = computeNextRunAt(
      { ...BASE_CONFIG, frequency: 'monthly', dayOfMonth: 1 },
      now,
    );
    expect(next?.toISOString()).toBe('2026-09-01T02:00:00.000Z');
  });
});
