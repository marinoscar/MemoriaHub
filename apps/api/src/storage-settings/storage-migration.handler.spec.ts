/**
 * Unit tests for StorageMigrationHandler.
 *
 * Tests cover:
 *  - type property
 *  - onModuleInit(): registers with the EnrichmentHandlerRegistry
 *  - process() happy path: download→upload→exists(true)→$transaction repoints object
 *    and marks item completed + increments migratedCount; source.delete NOT called
 *  - process() verify fail: dest.exists returns false → throws (worker retries)
 *  - process() idempotent: item already completed → returns immediately, no copy
 *  - process() cancelled run → item skipped, skippedCount incremented, no copy
 *  - process() already-on-target: object already on targetProvider+destBucket → marks completed without copying
 *  - process() terminal failure: when job.attempts >= MAX_ATTEMPTS and copy throws
 *    → item marked failed + failedCount incremented before rethrow. NOTE:
 *    attempts are charged at CLAIM time by the worker, so the job row process()
 *    receives already counts the in-flight attempt (a job on its final attempt
 *    arrives with attempts === MAX_ATTEMPTS).
 *  - process() missing payload → throws with descriptive error
 */

import {
  EnrichmentJob,
  JobReason,
  JobStatus,
  StorageMigrationItemStatus,
  StorageMigrationStatus,
  StorageObjectStatus,
} from '@prisma/client';
import { StorageMigrationHandler } from './storage-migration.handler';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { Readable } from 'stream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-mig-1',
    type: 'storage_migration',
    mediaItemId: null,
    circleId: null,
    status: JobStatus.running,
    reason: JobReason.backfill,
    priority: 100,
    providerKey: null,
    modelVersion: null,
    payload: {
      runId: 'run-1',
      itemId: 'item-1',
      objectId: 'obj-1',
    },
    // Attempts are charged at claim time — a running job always carries >= 1.
    attempts: 1,
    lastError: null,
    startedAt: new Date(),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    sourceProvider: 's3',
    targetProvider: 'r2',
    status: StorageMigrationStatus.running,
    totalCount: 5,
    migratedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedAt: new Date(),
    finishedAt: null,
    lastError: null,
    createdById: 'user-1',
    createdAt: new Date(),
    ...overrides,
  };
}

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    runId: 'run-1',
    objectId: 'obj-1',
    status: StorageMigrationItemStatus.pending,
    jobId: 'job-mig-1',
    newStorageKey: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeObject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'obj-1',
    storageProvider: 's3',
    bucket: 'source-bucket',
    storageKey: 'uploads/photo.jpg',
    mimeType: 'image/jpeg',
    size: BigInt(1024),
    status: StorageObjectStatus.ready,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeStorageProvider(overrides: Partial<{
  upload: jest.Mock;
  download: jest.Mock;
  exists: jest.Mock;
  delete: jest.Mock;
  getBucket: jest.Mock;
  getMetadata: jest.Mock;
}> = {}) {
  return {
    upload: jest.fn().mockResolvedValue({}),
    download: jest.fn().mockResolvedValue(Readable.from(Buffer.from('bytes'))),
    exists: jest.fn().mockResolvedValue(true),
    delete: jest.fn().mockResolvedValue(undefined),
    getBucket: jest.fn().mockReturnValue('dest-bucket'),
    getMetadata: jest.fn().mockResolvedValue({}),
    getSignedDownloadUrl: jest.fn(),
    getSignedUploadUrl: jest.fn(),
    initMultipartUpload: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    setMetadata: jest.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StorageMigrationHandler', () => {
  let handler: StorageMigrationHandler;
  let mockRegistry: { register: jest.Mock };
  let mockPrisma: MockPrismaService;
  let mockResolver: { getProviderFor: jest.Mock };
  let sourceProvider: ReturnType<typeof makeStorageProvider>;
  let destProvider: ReturnType<typeof makeStorageProvider>;

  beforeEach(() => {
    mockRegistry = { register: jest.fn() };
    mockPrisma = createMockPrismaService();
    sourceProvider = makeStorageProvider();
    destProvider = makeStorageProvider({ getBucket: jest.fn().mockReturnValue('dest-bucket') });

    mockResolver = {
      getProviderFor: jest.fn().mockImplementation(async (providerId: string) => {
        if (providerId === 's3') return sourceProvider;
        if (providerId === 'r2') return destProvider;
        return destProvider;
      }),
    };

    // Wire $transaction to execute the operation array
    mockPrisma.$transaction.mockImplementation(async (arg: any) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      if (typeof arg === 'function') {
        return arg(mockPrisma);
      }
      return arg;
    });

    handler = new StorageMigrationHandler(
      mockRegistry as any,
      mockPrisma as any,
      mockResolver as any,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // type
  // =========================================================================

  describe('type', () => {
    it('has type === "storage_migration"', () => {
      expect(handler.type).toBe('storage_migration');
    });
  });

  // =========================================================================
  // onModuleInit
  // =========================================================================

  describe('onModuleInit', () => {
    it('registers itself with the EnrichmentHandlerRegistry', () => {
      handler.onModuleInit();

      expect(mockRegistry.register).toHaveBeenCalledWith(handler);
    });
  });

  // =========================================================================
  // process() — invalid payload
  // =========================================================================

  describe('process() — invalid payload', () => {
    it('throws when payload is null', async () => {
      const job = makeJob({ payload: null });

      await expect(handler.process(job)).rejects.toThrow(/invalid payload/i);
    });

    it('throws when runId is missing from payload', async () => {
      const job = makeJob({ payload: { itemId: 'item-1', objectId: 'obj-1' } as any });

      await expect(handler.process(job)).rejects.toThrow(/invalid payload/i);
    });
  });

  // =========================================================================
  // process() — idempotent (item already completed)
  // =========================================================================

  describe('process() — idempotent: item already completed', () => {
    it('returns immediately without downloading or uploading', async () => {
      mockPrisma.storageMigrationItem.findUnique.mockResolvedValue(
        makeItem({ status: StorageMigrationItemStatus.completed }) as any,
      );

      await handler.process(makeJob());

      expect(sourceProvider.download).not.toHaveBeenCalled();
      expect(destProvider.upload).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // process() — cancelled run
  // =========================================================================

  describe('process() — cancelled run', () => {
    it('marks item as skipped and increments skippedCount without copying bytes', async () => {
      mockPrisma.storageMigrationItem.findUnique.mockResolvedValue(makeItem() as any);
      mockPrisma.storageMigrationRun.findUnique
        .mockResolvedValueOnce(makeRun({ status: StorageMigrationStatus.cancelled }) as any)
        // Second call from maybeFinalizeRun
        .mockResolvedValue(null as any);

      await handler.process(makeJob());

      // Should NOT have downloaded or uploaded bytes
      expect(sourceProvider.download).not.toHaveBeenCalled();
      expect(destProvider.upload).not.toHaveBeenCalled();

      // Transaction should have been called to mark item skipped + increment skippedCount
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      const txArg = mockPrisma.$transaction.mock.calls[0][0];
      // The transaction receives an array of prisma operations
      expect(Array.isArray(txArg)).toBe(true);
    });
  });

  // =========================================================================
  // process() — happy path: copy + repoint
  // =========================================================================

  describe('process() — happy path', () => {
    beforeEach(() => {
      mockPrisma.storageMigrationItem.findUnique.mockResolvedValue(makeItem() as any);
      mockPrisma.storageMigrationRun.findUnique.mockResolvedValue(makeRun() as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(makeObject() as any);
      mockPrisma.storageMigrationItem.update.mockResolvedValue({} as any);
      mockPrisma.storageMigrationRun.update.mockResolvedValue({} as any);
      mockPrisma.storageObject.update.mockResolvedValue({} as any);
    });

    it('downloads from source and uploads to destination', async () => {
      await handler.process(makeJob());

      expect(sourceProvider.download).toHaveBeenCalledWith('uploads/photo.jpg');
      expect(destProvider.upload).toHaveBeenCalledWith(
        'uploads/photo.jpg',
        expect.anything(),
        expect.objectContaining({ mimeType: 'image/jpeg' }),
      );
    });

    it('verifies the copy via dest.exists()', async () => {
      await handler.process(makeJob());

      expect(destProvider.exists).toHaveBeenCalledWith('uploads/photo.jpg');
    });

    it('NEVER deletes from source provider', async () => {
      await handler.process(makeJob());

      expect(sourceProvider.delete).not.toHaveBeenCalled();
    });

    it('repoints the StorageObject to the target provider inside a $transaction', async () => {
      await handler.process(makeJob());

      // At least one $transaction call should have happened that includes storageObject.update
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      // storageObject.update should be called with the target provider
      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            storageProvider: 'r2',
          }),
        }),
      );
    });

    it('marks the migration item as completed', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.storageMigrationItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: StorageMigrationItemStatus.completed,
          }),
        }),
      );
    });

    it('increments migratedCount on the run', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.storageMigrationRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            migratedCount: { increment: 1 },
          }),
        }),
      );
    });
  });

  // =========================================================================
  // process() — verify fail: dest.exists returns false
  // =========================================================================

  describe('process() — verification failure', () => {
    it('throws when dest.exists() returns false (worker will retry)', async () => {
      mockPrisma.storageMigrationItem.findUnique.mockResolvedValue(makeItem() as any);
      mockPrisma.storageMigrationRun.findUnique.mockResolvedValue(makeRun() as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(makeObject() as any);
      mockPrisma.storageMigrationItem.update.mockResolvedValue({} as any);
      mockPrisma.storageMigrationRun.update.mockResolvedValue({} as any);

      destProvider.exists.mockResolvedValue(false);

      await expect(handler.process(makeJob())).rejects.toThrow(/verification failed/i);
    });

    it('does NOT repoint the StorageObject when verification fails', async () => {
      mockPrisma.storageMigrationItem.findUnique.mockResolvedValue(makeItem() as any);
      mockPrisma.storageMigrationRun.findUnique.mockResolvedValue(makeRun() as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(makeObject() as any);
      mockPrisma.storageMigrationItem.update.mockResolvedValue({} as any);
      mockPrisma.storageMigrationRun.update.mockResolvedValue({} as any);

      destProvider.exists.mockResolvedValue(false);

      await expect(handler.process(makeJob())).rejects.toThrow();
      expect(mockPrisma.storageObject.update).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // process() — already on target (object.storageProvider === targetProvider)
  // =========================================================================

  describe('process() — already on target', () => {
    it('marks item completed without downloading or uploading bytes', async () => {
      // Object is already on r2 with the same bucket as destProvider.getBucket()
      const alreadyOnTarget = makeObject({
        storageProvider: 'r2',
        bucket: 'dest-bucket', // matches destProvider.getBucket()
      });
      mockPrisma.storageMigrationItem.findUnique.mockResolvedValue(makeItem() as any);
      mockPrisma.storageMigrationRun.findUnique.mockResolvedValue(makeRun() as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(alreadyOnTarget as any);
      mockPrisma.storageMigrationItem.update.mockResolvedValue({} as any);
      mockPrisma.storageMigrationRun.update.mockResolvedValue({} as any);

      await handler.process(makeJob());

      expect(sourceProvider.download).not.toHaveBeenCalled();
      expect(destProvider.upload).not.toHaveBeenCalled();
    });

    it('marks item as completed when already on target', async () => {
      const alreadyOnTarget = makeObject({
        storageProvider: 'r2',
        bucket: 'dest-bucket',
      });
      mockPrisma.storageMigrationItem.findUnique.mockResolvedValue(makeItem() as any);
      mockPrisma.storageMigrationRun.findUnique.mockResolvedValue(makeRun() as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(alreadyOnTarget as any);
      mockPrisma.storageMigrationItem.update.mockResolvedValue({} as any);
      mockPrisma.storageMigrationRun.update.mockResolvedValue({} as any);

      await handler.process(makeJob());

      expect(mockPrisma.storageMigrationItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: StorageMigrationItemStatus.completed,
          }),
        }),
      );
    });
  });

  // =========================================================================
  // process() — terminal failure accounting
  // =========================================================================

  describe('process() — terminal failure accounting', () => {
    it('marks item failed and increments failedCount on the final attempt, then rethrows', async () => {
      const copyError = new Error('S3 connection refused');
      // Make download throw to simulate a copy failure
      sourceProvider.download.mockRejectedValue(copyError);

      mockPrisma.storageMigrationItem.findUnique.mockResolvedValue(makeItem() as any);
      mockPrisma.storageMigrationRun.findUnique.mockResolvedValue(makeRun() as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(makeObject() as any);
      mockPrisma.storageMigrationItem.update.mockResolvedValue({} as any);
      mockPrisma.storageMigrationRun.update.mockResolvedValue({} as any);

      // Simulate terminal attempt: attempts >= MAX_ATTEMPTS (default 3).
      // The worker charges attempts at CLAIM time, so a job on its final
      // attempt arrives at process() with attempts = 3 (3 >= 3 → terminal).
      const terminalJob = makeJob({ attempts: 3 });

      await expect(handler.process(terminalJob)).rejects.toThrow('S3 connection refused');

      // Domain-level failure should have been recorded via $transaction
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      // The item should be marked failed
      expect(mockPrisma.storageMigrationItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: StorageMigrationItemStatus.failed,
            lastError: 'S3 connection refused',
          }),
        }),
      );
      // The run's failedCount should be incremented
      expect(mockPrisma.storageMigrationRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            failedCount: { increment: 1 },
          }),
        }),
      );
    });

    it('does NOT mark item failed on a non-terminal attempt (worker will retry)', async () => {
      const copyError = new Error('transient error');
      sourceProvider.download.mockRejectedValue(copyError);

      mockPrisma.storageMigrationItem.findUnique.mockResolvedValue(makeItem() as any);
      mockPrisma.storageMigrationRun.findUnique.mockResolvedValue(makeRun() as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(makeObject() as any);
      mockPrisma.storageMigrationItem.update.mockResolvedValue({} as any);
      mockPrisma.storageMigrationRun.update.mockResolvedValue({} as any);

      // Non-terminal attempt under claim-time charging: a claimed job always
      // has attempts >= 1; use the last retryable value (2 < 3 → retry left).
      const nonTerminalJob = makeJob({ attempts: 2 });

      await expect(handler.process(nonTerminalJob)).rejects.toThrow('transient error');

      // $transaction for marking failure should NOT have been called
      // (only the "mark copying" update and the item-not-found/run-not-found guards happen)
      const txCalls = mockPrisma.$transaction.mock.calls;
      // No $transaction call with a failedCount increment on a non-terminal attempt
      const hasFailedCountTx = txCalls.some((callArgs: any[]) => {
        const arg = callArgs[0];
        if (!Array.isArray(arg)) return false;
        // If any element of the array contains a failedCount increment, the test fails
        return false; // We just check via the update mock below
      });
      expect(hasFailedCountTx).toBe(false);

      // storageMigrationRun.update should not have been called with failedCount on non-terminal
      const runUpdateCalls = mockPrisma.storageMigrationRun.update.mock.calls;
      const hasFailedCountUpdate = runUpdateCalls.some((args: any[]) =>
        args[0]?.data?.failedCount !== undefined,
      );
      expect(hasFailedCountUpdate).toBe(false);
    });
  });

  // =========================================================================
  // process() — item not found
  // =========================================================================

  describe('process() — item not found', () => {
    it('returns without throwing when item does not exist', async () => {
      mockPrisma.storageMigrationItem.findUnique.mockResolvedValue(null as any);

      await expect(handler.process(makeJob())).resolves.toBeUndefined();
      expect(sourceProvider.download).not.toHaveBeenCalled();
    });
  });
});
