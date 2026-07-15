/**
 * Unit tests — StorageProcessingRecoveryService
 *
 * Mock strategy: PrismaService is a jest-mock-extended deep mock;
 * ObjectProcessingService.handleObjectUploaded is a jest.fn(). No I/O, no DB.
 *
 * Tests cover:
 *   - recoverStuckObjects: threshold filtering delegated to Prisma (query args),
 *     retry counter persisted BEFORE the pipeline call (durability under a
 *     crash-during-retry), cap exhaustion marks status=failed without invoking
 *     the pipeline, mixed-batch tallying, one bad object doesn't abort the batch.
 *   - reprocessObjectNow: bypasses threshold/cap, clears prior retry
 *     bookkeeping, resets status to 'processing' before invoking.
 */

import { StorageProcessingRecoveryService } from './storage-processing-recovery.service';
import { ObjectProcessingService } from '../processing/object-processing.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

function makeStorageObject(overrides: Partial<{
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
  updatedAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? 'obj-001',
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    storageKey: 'originals/photo.jpg',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: overrides.status ?? 'processing',
    s3UploadId: null,
    metadata: overrides.metadata ?? null,
    uploadedById: 'user-1',
    size: BigInt(1000),
    createdAt: new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  } as any;
}

describe('StorageProcessingRecoveryService', () => {
  let service: StorageProcessingRecoveryService;
  let prisma: MockPrismaService;
  let handleObjectUploaded: jest.Mock;

  beforeEach(() => {
    prisma = createMockPrismaService();
    handleObjectUploaded = jest.fn().mockResolvedValue(undefined);

    service = new StorageProcessingRecoveryService(
      prisma as any,
      { handleObjectUploaded } as unknown as ObjectProcessingService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // recoverStuckObjects — candidate selection
  // -------------------------------------------------------------------------

  describe('recoverStuckObjects — candidate selection', () => {
    it('queries only status=processing rows older than the threshold', async () => {
      (prisma.storageObject.findMany as jest.Mock).mockResolvedValue([]);

      await service.recoverStuckObjects(10);

      expect(prisma.storageObject.findMany).toHaveBeenCalledWith({
        where: { status: 'processing', updatedAt: { lt: expect.any(Date) } },
      });
    });

    it('returns all-zero result when there are no candidates', async () => {
      (prisma.storageObject.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.recoverStuckObjects(10);

      expect(result).toEqual({ claimed: 0, reprocessed: 0, exhausted: 0, errors: 0 });
      expect(handleObjectUploaded).not.toHaveBeenCalled();
    });

    it('uses STORAGE_PROCESSING_STUCK_MINUTES env default when no argument is passed', async () => {
      const saved = process.env['STORAGE_PROCESSING_STUCK_MINUTES'];
      process.env['STORAGE_PROCESSING_STUCK_MINUTES'] = '25';
      (prisma.storageObject.findMany as jest.Mock).mockResolvedValue([]);

      const before = Date.now();
      await service.recoverStuckObjects();
      const after = Date.now();

      const cutoff = (prisma.storageObject.findMany as jest.Mock).mock.calls[0][0].where.updatedAt.lt as Date;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 25 * 60_000 - 1000);
      expect(cutoff.getTime()).toBeLessThanOrEqual(after - 25 * 60_000 + 1000);

      if (saved === undefined) delete process.env['STORAGE_PROCESSING_STUCK_MINUTES'];
      else process.env['STORAGE_PROCESSING_STUCK_MINUTES'] = saved;
    });
  });

  // -------------------------------------------------------------------------
  // recoverStuckObjects — retry counter durability (the crux regression test)
  // -------------------------------------------------------------------------

  describe('recoverStuckObjects — retry counter persisted before pipeline call', () => {
    it('increments and persists the retry counter even when the pipeline call rejects', async () => {
      const object = makeStorageObject({ metadata: null });
      (prisma.storageObject.findMany as jest.Mock).mockResolvedValue([object]);
      (prisma.storageObject.update as jest.Mock).mockResolvedValue({
        ...object,
        metadata: { _processingRetryCount: 1 },
      });
      handleObjectUploaded.mockRejectedValue(new Error('OOM killed mid-pipeline'));

      const result = await service.recoverStuckObjects(10);

      // The counter-increment update must have happened BEFORE the (failing) pipeline call
      expect(prisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: object.id },
        data: { metadata: { _processingRetryCount: 1 } },
      });
      expect(handleObjectUploaded).toHaveBeenCalledTimes(1);
      // The rejection is caught at the batch level — one bad object doesn't throw
      expect(result.errors).toBe(1);
      expect(result.reprocessed).toBe(0);
    });

    it('increments from an existing count rather than resetting it', async () => {
      const object = makeStorageObject({ metadata: { _processingRetryCount: 1 } });
      (prisma.storageObject.findMany as jest.Mock).mockResolvedValue([object]);
      (prisma.storageObject.update as jest.Mock).mockResolvedValue(object);

      await service.recoverStuckObjects(10);

      expect(prisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: object.id },
        data: { metadata: { _processingRetryCount: 2 } },
      });
    });

    it('invokes the pipeline with the freshly-updated row, not the original', async () => {
      const object = makeStorageObject({ metadata: null });
      const updated = { ...object, metadata: { _processingRetryCount: 1 } };
      (prisma.storageObject.findMany as jest.Mock).mockResolvedValue([object]);
      (prisma.storageObject.update as jest.Mock).mockResolvedValue(updated);

      await service.recoverStuckObjects(10);

      const eventArg = handleObjectUploaded.mock.calls[0][0];
      expect(eventArg.object).toEqual(updated);
    });
  });

  // -------------------------------------------------------------------------
  // recoverStuckObjects — retry cap exhaustion
  // -------------------------------------------------------------------------

  describe('recoverStuckObjects — retry cap exhaustion', () => {
    it('marks status=failed and does NOT invoke the pipeline once the cap is reached', async () => {
      const object = makeStorageObject({ metadata: { _processingRetryCount: 3 } });
      (prisma.storageObject.findMany as jest.Mock).mockResolvedValue([object]);
      (prisma.storageObject.update as jest.Mock).mockResolvedValue(object);

      const result = await service.recoverStuckObjects(10);

      expect(prisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: object.id },
        data: {
          status: 'failed',
          metadata: { _processingRetryCount: 3, _processingRetryExhausted: true },
        },
      });
      expect(handleObjectUploaded).not.toHaveBeenCalled();
      expect(result.exhausted).toBe(1);
      expect(result.reprocessed).toBe(0);
    });

    it('respects a custom STORAGE_PROCESSING_MAX_RETRIES', async () => {
      const saved = process.env['STORAGE_PROCESSING_MAX_RETRIES'];
      process.env['STORAGE_PROCESSING_MAX_RETRIES'] = '1';

      const object = makeStorageObject({ metadata: { _processingRetryCount: 1 } });
      (prisma.storageObject.findMany as jest.Mock).mockResolvedValue([object]);
      (prisma.storageObject.update as jest.Mock).mockResolvedValue(object);

      const result = await service.recoverStuckObjects(10);

      expect(result.exhausted).toBe(1);
      expect(handleObjectUploaded).not.toHaveBeenCalled();

      if (saved === undefined) delete process.env['STORAGE_PROCESSING_MAX_RETRIES'];
      else process.env['STORAGE_PROCESSING_MAX_RETRIES'] = saved;
    });
  });

  // -------------------------------------------------------------------------
  // recoverStuckObjects — mixed batch
  // -------------------------------------------------------------------------

  describe('recoverStuckObjects — mixed batch', () => {
    it('tallies reprocessed, exhausted, and errors independently across a batch', async () => {
      const ok = makeStorageObject({ id: 'obj-ok', metadata: null });
      const capped = makeStorageObject({ id: 'obj-capped', metadata: { _processingRetryCount: 3 } });
      const throws = makeStorageObject({ id: 'obj-throws', metadata: null });

      (prisma.storageObject.findMany as jest.Mock).mockResolvedValue([ok, capped, throws]);
      (prisma.storageObject.update as jest.Mock).mockImplementation(({ where, data }) => {
        if (where.id === 'obj-capped') return Promise.resolve({ ...capped, ...data });
        if (where.id === 'obj-throws') return Promise.reject(new Error('DB write failed'));
        return Promise.resolve({ ...ok, ...data });
      });

      const result = await service.recoverStuckObjects(10);

      expect(result.claimed).toBe(3);
      expect(result.reprocessed).toBe(1);
      expect(result.exhausted).toBe(1);
      expect(result.errors).toBe(1);
      // handleObjectUploaded only ever called for the object that reached the pipeline
      expect(handleObjectUploaded).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // reprocessObjectNow — manual bypass
  // -------------------------------------------------------------------------

  describe('reprocessObjectNow', () => {
    it('resets status to processing and clears prior retry bookkeeping before invoking', async () => {
      const object = makeStorageObject({
        status: 'failed',
        metadata: { _processingRetryCount: 3, _processingRetryExhausted: true, thumbnailOf: 'irrelevant' },
      });
      const reset = { ...object, status: 'processing', metadata: { thumbnailOf: 'irrelevant' } };
      (prisma.storageObject.update as jest.Mock).mockResolvedValue(reset);

      await service.reprocessObjectNow(object);

      expect(prisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: object.id },
        data: { status: 'processing', metadata: { thumbnailOf: 'irrelevant' } },
      });
      expect(handleObjectUploaded).toHaveBeenCalledTimes(1);
      const eventArg = handleObjectUploaded.mock.calls[0][0];
      expect(eventArg.object).toEqual(reset);
    });

    it('does not check status or retry count before invoking (explicit user action always retries)', async () => {
      const readyObject = makeStorageObject({ status: 'ready', metadata: null });
      (prisma.storageObject.update as jest.Mock).mockResolvedValue({ ...readyObject, status: 'processing' });

      await service.reprocessObjectNow(readyObject);

      expect(handleObjectUploaded).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // recoverFailedImageObjects — issue #106 (HEIC/HEIF failed-image recovery)
  // -------------------------------------------------------------------------

  describe('recoverFailedImageObjects', () => {
    it('queries failed image objects excluding thumbnails, with no take clause when no limit is given', async () => {
      (prisma.storageObject.findMany as jest.Mock).mockResolvedValue([]);

      await service.recoverFailedImageObjects();

      expect(prisma.storageObject.findMany).toHaveBeenCalledWith({
        where: {
          status: 'failed',
          mimeType: { startsWith: 'image/' },
          NOT: { storageKey: { startsWith: 'thumbnails/' } },
        },
      });
    });

    it('includes take: <limit> in the same query when a limit is passed', async () => {
      (prisma.storageObject.findMany as jest.Mock).mockResolvedValue([]);

      await service.recoverFailedImageObjects({ limit: 25 });

      expect(prisma.storageObject.findMany).toHaveBeenCalledWith({
        where: {
          status: 'failed',
          mimeType: { startsWith: 'image/' },
          NOT: { storageKey: { startsWith: 'thumbnails/' } },
        },
        take: 25,
      });
    });

    it('returns { claimed: 0, reprocessed: 0, exhausted: 0, errors: 0 } and never calls reprocessObjectNow when there are no candidates', async () => {
      (prisma.storageObject.findMany as jest.Mock).mockResolvedValue([]);
      const reprocessSpy = jest.spyOn(service, 'reprocessObjectNow');

      const result = await service.recoverFailedImageObjects();

      expect(result).toEqual({ claimed: 0, reprocessed: 0, exhausted: 0, errors: 0 });
      expect(reprocessSpy).not.toHaveBeenCalled();
    });

    it('delegates to reprocessObjectNow once per candidate and counts reprocessed for a multi-item batch', async () => {
      const a = makeStorageObject({ id: 'obj-a', status: 'failed' });
      const b = makeStorageObject({ id: 'obj-b', status: 'failed' });
      const c = makeStorageObject({ id: 'obj-c', status: 'failed' });
      (prisma.storageObject.findMany as jest.Mock).mockResolvedValue([a, b, c]);
      const reprocessSpy = jest.spyOn(service, 'reprocessObjectNow').mockResolvedValue(undefined);

      const result = await service.recoverFailedImageObjects();

      expect(reprocessSpy).toHaveBeenCalledTimes(3);
      expect(reprocessSpy).toHaveBeenNthCalledWith(1, a);
      expect(reprocessSpy).toHaveBeenNthCalledWith(2, b);
      expect(reprocessSpy).toHaveBeenNthCalledWith(3, c);
      expect(result).toEqual({ claimed: 3, reprocessed: 3, exhausted: 0, errors: 0 });
    });

    it('counts an error and continues the batch when reprocessObjectNow rejects for one candidate', async () => {
      const ok = makeStorageObject({ id: 'obj-ok', status: 'failed' });
      const throws = makeStorageObject({ id: 'obj-throws', status: 'failed' });
      (prisma.storageObject.findMany as jest.Mock).mockResolvedValue([ok, throws]);
      const reprocessSpy = jest
        .spyOn(service, 'reprocessObjectNow')
        .mockImplementation(async (object: any) => {
          if (object.id === 'obj-throws') {
            throw new Error('sharp decode failed: still undecodable');
          }
        });

      const result = await service.recoverFailedImageObjects();

      expect(reprocessSpy).toHaveBeenCalledTimes(2);
      expect(reprocessSpy).toHaveBeenNthCalledWith(1, ok);
      expect(reprocessSpy).toHaveBeenNthCalledWith(2, throws);
      expect(result).toEqual({ claimed: 2, reprocessed: 1, exhausted: 0, errors: 1 });
    });
  });
});
