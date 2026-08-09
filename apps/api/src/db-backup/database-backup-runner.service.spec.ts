import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';

import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import {
  DatabaseBackupRunnerService,
  buildStorageKey,
} from './database-backup-runner.service';
import { DatabaseBackupAlreadyRunningError } from './db-backup.errors';
import { spawnPgDump, spawnPgRestoreList } from './pg-dump.util';

// The two spawn entry points are mocked; everything else in the util (argv
// builders, env builder) stays real so the runner is wired against the true
// contract.
jest.mock('./pg-dump.util', () => {
  const actual = jest.requireActual('./pg-dump.util');
  return {
    ...actual,
    spawnPgDump: jest.fn(),
    spawnPgRestoreList: jest.fn(),
  };
});

const spawnPgDumpMock = spawnPgDump as unknown as jest.Mock;
const spawnPgRestoreListMock = spawnPgRestoreList as unknown as jest.Mock;

const RUN_ID = '11111111-2222-3333-4444-555555555555';
const ARCHIVE = Buffer.from('PGDMP-fake-custom-format-archive-bytes');
const ARCHIVE_SHA256 = createHash('sha256').update(ARCHIVE).digest('hex');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeProc {
  stdout: PassThrough;
  stdin: PassThrough;
  done: Promise<void>;
  finish: () => void;
  fail: (err: Error) => void;
  stderrTail: () => string;
  kill: jest.Mock;
}

function makeFakeProc(): FakeProc {
  let resolveDone!: () => void;
  let rejectDone!: (err: Error) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  return {
    stdout: new PassThrough(),
    stdin: new PassThrough(),
    done,
    finish: () => resolveDone(),
    fail: (err: Error) => rejectDone(err),
    stderrTail: () => '',
    kill: jest.fn(),
  };
}

/** A pg_restore --list stand-in: echoes a TOC once its stdin closes. */
function makeFakeRestoreProc(opts: { emitToc?: boolean } = {}): FakeProc {
  const proc = makeFakeProc();
  proc.stdin.on('finish', () => {
    if (opts.emitToc !== false) {
      proc.stdout.write('; Archive created at 2026-08-09\n255; TABLE DATA media_items\n');
    }
    proc.stdout.end();
    proc.finish();
  });
  return proc;
}

describe('DatabaseBackupRunnerService', () => {
  let service: DatabaseBackupRunnerService;
  let prisma: {
    databaseBackupRun: {
      create: jest.Mock;
      update: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
    };
    $queryRaw: jest.Mock;
  };
  let provider: {
    upload: jest.Mock;
    download: jest.Mock;
    delete: jest.Mock;
    getBucket: jest.Mock;
  };
  let resolver: { getActiveProvider: jest.Mock; getProviderFor: jest.Mock };
  let settings: { getSettings: jest.Mock };
  let config: { get: jest.Mock };

  /** What `provider.upload` actually received, for the streaming assertions. */
  let uploadedBytes: Buffer;
  let uploadArg: unknown;
  let uploadCalledWhileSourceStillOpen: boolean | null;

  beforeEach(async () => {
    jest.clearAllMocks();
    uploadedBytes = Buffer.alloc(0);
    uploadArg = undefined;
    uploadCalledWhileSourceStillOpen = null;

    prisma = {
      databaseBackupRun: {
        create: jest.fn().mockResolvedValue({ id: RUN_ID }),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue({
          storageProvider: 's3',
          storageKey: `db-backups/stamp-${RUN_ID}.dump`,
          bucket: 'memoriahub-bucket',
        }),
      },
      $queryRaw: jest.fn().mockImplementation((strings: TemplateStringsArray) => {
        const sql = Array.isArray(strings) ? strings.join(' ') : String(strings);
        if (sql.includes('version()')) {
          return Promise.resolve([{ version: 'PostgreSQL 16.4 (Debian)' }]);
        }
        if (sql.includes('_prisma_migrations')) {
          return Promise.resolve([{ migration_name: '20260809150000_add_database_backups' }]);
        }
        return Promise.resolve([]);
      }),
    };

    provider = {
      upload: jest.fn(async (_key: string, stream: Readable) => {
        uploadArg = stream;
        uploadCalledWhileSourceStillOpen = sourceStillOpen;
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        uploadedBytes = Buffer.concat(chunks);
        return { key: _key, bucket: 'memoriahub-bucket', location: 'x' };
      }),
      download: jest.fn(async () => Readable.from([ARCHIVE])),
      delete: jest.fn().mockResolvedValue(undefined),
      getBucket: jest.fn().mockReturnValue('memoriahub-bucket'),
    };

    resolver = {
      getActiveProvider: jest.fn().mockResolvedValue({ id: 's3', provider }),
      getProviderFor: jest.fn().mockResolvedValue(provider),
    };

    settings = {
      getSettings: jest.fn().mockResolvedValue({
        databaseBackup: { compressionLevel: 1, storageProvider: null },
      }),
    };

    config = { get: jest.fn().mockReturnValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseBackupRunnerService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: SystemSettingsService, useValue: settings },
        { provide: StorageProviderResolver, useValue: resolver },
      ],
    }).compile();

    service = moduleRef.get(DatabaseBackupRunnerService);

    spawnPgRestoreListMock.mockImplementation(() => makeFakeRestoreProc());
  });

  /** Tracks whether the pg_dump source stream is still producing bytes. */
  let sourceStillOpen = false;

  /** Wire a pg_dump that streams ARCHIVE and exits 0 on the next tick. */
  function mockSuccessfulDump(): FakeProc {
    const proc = makeFakeProc();
    sourceStillOpen = true;
    proc.stdout.on('end', () => {
      sourceStillOpen = false;
    });
    spawnPgDumpMock.mockImplementation(() => {
      setImmediate(() => {
        proc.stdout.write(ARCHIVE);
        proc.stdout.end();
        proc.finish();
      });
      return proc;
    });
    return proc;
  }

  function lastUpdateData(): Record<string, unknown> {
    const calls = prisma.databaseBackupRun.update.mock.calls;
    return calls[calls.length - 1][0].data;
  }

  function updateDataMatching(
    predicate: (data: Record<string, unknown>) => boolean,
  ): Record<string, unknown> | undefined {
    return prisma.databaseBackupRun.update.mock.calls
      .map((c) => c[0].data as Record<string, unknown>)
      .find(predicate);
  }

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('happy path', () => {
    it('records sizeBytes, checksumSha256 and verifiedAt on completion', async () => {
      mockSuccessfulDump();

      const result = await service.runBackup({ trigger: 'manual', createdById: 'user-1' });

      expect(result.runId).toBe(RUN_ID);
      expect(result.sizeBytes).toBe(BigInt(ARCHIVE.length));
      expect(result.checksumSha256).toBe(ARCHIVE_SHA256);

      const completion = lastUpdateData();
      expect(completion.status).toBe('completed');
      expect(completion.sizeBytes).toBe(BigInt(ARCHIVE.length));
      expect(completion.checksumSha256).toBe(ARCHIVE_SHA256);
      expect(completion.verifiedAt).toBeInstanceOf(Date);
      expect(completion.finishedAt).toBeInstanceOf(Date);
      expect(completion.lastError).toBeNull();
    });

    it('claims the run as running before doing any work', async () => {
      mockSuccessfulDump();
      await service.runBackup({ trigger: 'scheduled' });

      expect(prisma.databaseBackupRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'running', trigger: 'scheduled' }),
        }),
      );
    });

    it('records dbVersion, appVersion and the latest applied migration', async () => {
      mockSuccessfulDump();
      process.env.APP_VERSION = '9.9.9';
      try {
        await service.runBackup({ trigger: 'manual' });
      } finally {
        delete process.env.APP_VERSION;
      }

      const completion = lastUpdateData();
      expect(completion.dbVersion).toContain('PostgreSQL 16.4');
      expect(completion.appVersion).toBe('9.9.9');
      expect(completion.migrationName).toBe('20260809150000_add_database_backups');
    });

    it('writes the storage pointer (provider/key/bucket/format) before streaming', async () => {
      mockSuccessfulDump();
      await service.runBackup({ trigger: 'manual' });

      const pointer = updateDataMatching((d) => d.storageKey !== undefined);
      expect(pointer).toBeDefined();
      expect(pointer!.storageProvider).toBe('s3');
      expect(pointer!.bucket).toBe('memoriahub-bucket');
      expect(pointer!.format).toBe('custom');
      expect(String(pointer!.storageKey)).toMatch(
        new RegExp(`^db-backups/.*-${RUN_ID}\\.dump$`),
      );
    });

    it('uses the databaseBackup.storageProvider override when configured', async () => {
      settings.getSettings.mockResolvedValue({
        databaseBackup: { compressionLevel: 4, storageProvider: 'r2' },
      });
      mockSuccessfulDump();

      await service.runBackup({ trigger: 'manual' });

      expect(resolver.getProviderFor).toHaveBeenCalledWith('r2');
      expect(resolver.getActiveProvider).not.toHaveBeenCalled();
      expect(spawnPgDumpMock).toHaveBeenCalledWith(
        expect.any(Object),
        4,
        expect.any(Object),
      );
    });

    it('verifies the UPLOADED object by streaming it through pg_restore --list', async () => {
      mockSuccessfulDump();
      await service.runBackup({ trigger: 'manual' });

      expect(provider.download).toHaveBeenCalledTimes(1);
      expect(spawnPgRestoreListMock).toHaveBeenCalledTimes(1);
      const [downloadedKey] = provider.download.mock.calls[0];
      const pointer = updateDataMatching((d) => d.storageKey !== undefined);
      expect(downloadedKey).toBe(pointer!.storageKey);
    });

    it('fails the run when pg_restore --list yields an empty table of contents', async () => {
      mockSuccessfulDump();
      spawnPgRestoreListMock.mockImplementation(() =>
        makeFakeRestoreProc({ emitToc: false }),
      );

      await expect(service.runBackup({ trigger: 'manual' })).rejects.toThrow(
        /empty table of contents/,
      );

      expect(lastUpdateData().status).toBe('failed');
    });
  });

  // -------------------------------------------------------------------------
  // Streaming — the regression this feature cannot afford to lose
  // -------------------------------------------------------------------------

  describe('streaming (never buffered)', () => {
    it('pipes pg_dump stdout into the upload instead of collecting it', async () => {
      const proc = mockSuccessfulDump();
      const pipeSpy = jest.spyOn(proc.stdout, 'pipe');

      await service.runBackup({ trigger: 'manual' });

      // The dump's stdout is piped (backpressure-respecting) …
      expect(pipeSpy).toHaveBeenCalledTimes(1);
      // … into the very object handed to provider.upload.
      expect(pipeSpy.mock.results[0].value).toBe(uploadArg);
    });

    it('hands provider.upload a stream, never a Buffer or string', async () => {
      mockSuccessfulDump();
      await service.runBackup({ trigger: 'manual' });

      expect(Buffer.isBuffer(uploadArg)).toBe(false);
      expect(typeof uploadArg).not.toBe('string');
      expect(typeof (uploadArg as Readable).pipe).toBe('function');
      expect(typeof (uploadArg as Readable).on).toBe('function');
    });

    it('starts the upload while the dump is still producing bytes', async () => {
      mockSuccessfulDump();
      await service.runBackup({ trigger: 'manual' });

      // If the implementation ever collected the archive first (toBuffer, a
      // chunk array, streamToString) the upload could only start after the
      // source had ended — which is exactly the multi-GB memory regression.
      expect(uploadCalledWhileSourceStillOpen).toBe(true);
    });

    it('the bytes reaching storage are the dump bytes, unaltered', async () => {
      mockSuccessfulDump();
      await service.runBackup({ trigger: 'manual' });

      expect(uploadedBytes.equals(ARCHIVE)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Failure path
  // -------------------------------------------------------------------------

  describe('failure path', () => {
    it('marks the run failed AND deletes the partial object on a non-zero pg_dump exit', async () => {
      const proc = makeFakeProc();
      spawnPgDumpMock.mockImplementation(() => {
        setImmediate(() => {
          proc.stdout.write(Buffer.from('PARTIAL'));
          proc.fail(new Error('pg_dump exited with code 1: connection lost'));
        });
        return proc;
      });

      await expect(service.runBackup({ trigger: 'manual' })).rejects.toThrow(
        /pg_dump exited with code 1/,
      );

      // Partial multi-GB objects must not be left behind — nothing in the UI
      // would ever point at them again.
      expect(provider.delete).toHaveBeenCalledWith(
        `db-backups/stamp-${RUN_ID}.dump`,
      );

      const failure = lastUpdateData();
      expect(failure.status).toBe('failed');
      expect(String(failure.lastError)).toContain('connection lost');
      expect(failure.finishedAt).toBeInstanceOf(Date);
    });

    it('kills the dump child when the upload fails', async () => {
      const proc = makeFakeProc();
      spawnPgDumpMock.mockImplementation(() => proc);
      provider.upload.mockRejectedValue(new Error('S3 upload rejected'));

      await expect(service.runBackup({ trigger: 'manual' })).rejects.toThrow(
        /S3 upload rejected/,
      );

      expect(proc.kill).toHaveBeenCalled();
      proc.finish();
    });

    it('never marks the run completed when verification fails', async () => {
      mockSuccessfulDump();
      spawnPgRestoreListMock.mockImplementation(() => {
        const p = makeFakeProc();
        p.stdin.on('finish', () => p.fail(new Error('pg_restore --list exited with code 1')));
        return p;
      });

      await expect(service.runBackup({ trigger: 'manual' })).rejects.toThrow(
        /pg_restore --list exited with code 1/,
      );

      const completed = updateDataMatching((d) => d.status === 'completed');
      expect(completed).toBeUndefined();
      expect(lastUpdateData().status).toBe('failed');
    });

    it('still fails the run when deleting the partial object throws', async () => {
      const proc = makeFakeProc();
      spawnPgDumpMock.mockImplementation(() => {
        setImmediate(() => proc.fail(new Error('boom')));
        return proc;
      });
      provider.delete.mockRejectedValue(new Error('storage unreachable'));

      // The original failure is what surfaces — cleanup is best-effort and must
      // never mask it.
      await expect(service.runBackup({ trigger: 'manual' })).rejects.toThrow(
        /boom/,
      );
      expect(lastUpdateData().status).toBe('failed');
    });

    it('does not retry automatically', async () => {
      const proc = makeFakeProc();
      spawnPgDumpMock.mockImplementation(() => {
        setImmediate(() => proc.fail(new Error('boom')));
        return proc;
      });

      await expect(service.runBackup({ trigger: 'manual' })).rejects.toThrow();

      expect(spawnPgDumpMock).toHaveBeenCalledTimes(1);
      expect(prisma.databaseBackupRun.create).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency guard
  // -------------------------------------------------------------------------

  describe('single-active-run guard', () => {
    it('surfaces a P2002 on claim as DatabaseBackupAlreadyRunningError with the active runId', async () => {
      prisma.databaseBackupRun.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '0.0.0',
          meta: { target: ['status'] },
        }),
      );
      prisma.databaseBackupRun.findFirst.mockResolvedValue({ id: 'active-run-id' });

      const err = await service
        .runBackup({ trigger: 'manual' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DatabaseBackupAlreadyRunningError);
      expect((err as DatabaseBackupAlreadyRunningError).activeRunId).toBe(
        'active-run-id',
      );
      // No second dump was started — that is the entire point of the guard.
      expect(spawnPgDumpMock).not.toHaveBeenCalled();
    });

    it('tolerates the winning run finishing between the failed INSERT and the lookup', async () => {
      prisma.databaseBackupRun.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '0.0.0',
        }),
      );
      prisma.databaseBackupRun.findFirst.mockResolvedValue(null);

      const err = await service
        .runBackup({ trigger: 'manual' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DatabaseBackupAlreadyRunningError);
      expect((err as DatabaseBackupAlreadyRunningError).activeRunId).toBeNull();
    });

    it('rethrows a non-P2002 claim failure untouched', async () => {
      prisma.databaseBackupRun.create.mockRejectedValue(new Error('db down'));

      await expect(service.runBackup({ trigger: 'manual' })).rejects.toThrow(
        /db down/,
      );
      expect(prisma.databaseBackupRun.findFirst).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  describe('heartbeat', () => {
    it('advances lastHeartbeatAt/bytesWritten on the configured interval and stops afterwards', async () => {
      jest.useFakeTimers();
      config.get.mockImplementation((key: string) =>
        key === 'DB_BACKUP_HEARTBEAT_MS' ? 1000 : undefined,
      );

      const proc = makeFakeProc();
      spawnPgDumpMock.mockImplementation(() => proc);

      const promise = service.runBackup({ trigger: 'scheduled' });
      // Let the claim + settings + pointer writes settle so the dump is live.
      await jest.advanceTimersByTimeAsync(0);
      proc.stdout.write(ARCHIVE);

      const heartbeatsAt = () =>
        prisma.databaseBackupRun.update.mock.calls.filter(
          (c) => c[0].data.lastHeartbeatAt !== undefined && c[0].data.status === undefined,
        ).length;

      expect(heartbeatsAt()).toBe(0);

      await jest.advanceTimersByTimeAsync(1000);
      expect(heartbeatsAt()).toBe(1);

      await jest.advanceTimersByTimeAsync(1000);
      expect(heartbeatsAt()).toBe(2);

      const progress = prisma.databaseBackupRun.update.mock.calls
        .map((c) => c[0].data)
        .find((d) => d.bytesWritten !== undefined && d.status === undefined);
      expect(progress.bytesWritten).toBe(BigInt(ARCHIVE.length));

      // Finish the run, then prove the interval was cleared.
      proc.stdout.end();
      proc.finish();
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      const afterCompletion = heartbeatsAt();
      await jest.advanceTimersByTimeAsync(5000);
      expect(heartbeatsAt()).toBe(afterCompletion);

      jest.useRealTimers();
    });

    it('does not fail the backup when a heartbeat write fails', async () => {
      jest.useFakeTimers();
      config.get.mockImplementation((key: string) =>
        key === 'DB_BACKUP_HEARTBEAT_MS' ? 1000 : undefined,
      );
      const proc = makeFakeProc();
      spawnPgDumpMock.mockImplementation(() => proc);

      const promise = service.runBackup({ trigger: 'scheduled' });
      await jest.advanceTimersByTimeAsync(0);

      prisma.databaseBackupRun.update.mockRejectedValueOnce(
        new Error('transient write error'),
      );
      await jest.advanceTimersByTimeAsync(1000);

      proc.stdout.write(ARCHIVE);
      proc.stdout.end();
      proc.finish();
      await jest.advanceTimersByTimeAsync(0);

      await expect(promise).resolves.toMatchObject({ runId: RUN_ID });
      jest.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // Key convention
  // -------------------------------------------------------------------------

  describe('buildStorageKey', () => {
    it('is prefixed, chronologically sortable and carries the run id', () => {
      const key = buildStorageKey(RUN_ID, new Date('2026-08-09T02:00:00.000Z'));
      expect(key).toBe(`db-backups/2026-08-09T02-00-00-000Z-${RUN_ID}.dump`);
    });

    it('sorts lexicographically in chronological order', () => {
      const earlier = buildStorageKey(RUN_ID, new Date('2026-08-09T02:00:00Z'));
      const later = buildStorageKey(RUN_ID, new Date('2026-08-10T02:00:00Z'));
      expect([later, earlier].sort()).toEqual([earlier, later]);
    });
  });
});
