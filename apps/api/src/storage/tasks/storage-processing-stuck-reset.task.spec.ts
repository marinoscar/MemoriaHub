/**
 * Unit tests for StorageProcessingStuckResetTask.handleStuckReset.
 *
 * Mock strategy: PrismaService (storageObject.findMany) and
 * MediaReprocessService (reprocessImageObject) are replaced with jest.fn()
 * mocks. No I/O, no DB.
 *
 * Verifies:
 *  - Kill-switch via STORAGE_PROCESSING_STUCK_RESET_ENABLED='false'
 *  - Sequential processing of stuck objects, respecting the batch (`take`) limit
 *  - Per-item failure isolation (one rejection doesn't stop the others)
 *  - Query shape: status='processing', updatedAt < cutoff, orderBy updatedAt asc
 *  - Cutoff shifts with STORAGE_PROCESSING_STUCK_MINUTES
 *  - Empty result short-circuit
 *
 * Env vars are saved/restored around each test so they don't leak, mirroring
 * the convention in enrichment-stuck-reset.task.spec.ts.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { StorageProcessingStuckResetTask } from './storage-processing-stuck-reset.task';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaReprocessService } from '../../media/media-reprocess.service';

describe('StorageProcessingStuckResetTask', () => {
  let task: StorageProcessingStuckResetTask;
  let mockFindMany: jest.Mock;
  let mockReprocessImageObject: jest.Mock;

  // Capture env values before the suite runs so we can restore them
  const SAVED_RESET_ENABLED = process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'];
  const SAVED_STUCK_MINUTES = process.env['STORAGE_PROCESSING_STUCK_MINUTES'];
  const SAVED_STUCK_BATCH = process.env['STORAGE_PROCESSING_STUCK_BATCH'];

  beforeEach(async () => {
    mockFindMany = jest.fn().mockResolvedValue([]);
    mockReprocessImageObject = jest.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageProcessingStuckResetTask,
        {
          provide: PrismaService,
          useValue: {
            storageObject: {
              findMany: mockFindMany,
            },
          },
        },
        {
          provide: MediaReprocessService,
          useValue: {
            reprocessImageObject: mockReprocessImageObject,
          },
        },
      ],
    }).compile();

    task = module.get<StorageProcessingStuckResetTask>(StorageProcessingStuckResetTask);
  });

  afterEach(() => {
    jest.clearAllMocks();

    if (SAVED_RESET_ENABLED === undefined) {
      delete process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'];
    } else {
      process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'] = SAVED_RESET_ENABLED;
    }
    if (SAVED_STUCK_MINUTES === undefined) {
      delete process.env['STORAGE_PROCESSING_STUCK_MINUTES'];
    } else {
      process.env['STORAGE_PROCESSING_STUCK_MINUTES'] = SAVED_STUCK_MINUTES;
    }
    if (SAVED_STUCK_BATCH === undefined) {
      delete process.env['STORAGE_PROCESSING_STUCK_BATCH'];
    } else {
      process.env['STORAGE_PROCESSING_STUCK_BATCH'] = SAVED_STUCK_BATCH;
    }
  });

  // -------------------------------------------------------------------------
  // Kill-switch
  // -------------------------------------------------------------------------

  describe('kill-switch', () => {
    it('does NOT call prisma.storageObject.findMany or reprocessImageObject when STORAGE_PROCESSING_STUCK_RESET_ENABLED=false', async () => {
      process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'] = 'false';

      await task.handleStuckReset();

      expect(mockFindMany).not.toHaveBeenCalled();
      expect(mockReprocessImageObject).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Sequential processing + batch limit
  // -------------------------------------------------------------------------

  describe('sequential processing + batch limit', () => {
    it('calls reprocessImageObject once per found id, in order', async () => {
      delete process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'];
      mockFindMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

      await task.handleStuckReset();

      expect(mockReprocessImageObject).toHaveBeenCalledTimes(3);
      expect(mockReprocessImageObject).toHaveBeenNthCalledWith(1, 'a');
      expect(mockReprocessImageObject).toHaveBeenNthCalledWith(2, 'b');
      expect(mockReprocessImageObject).toHaveBeenNthCalledWith(3, 'c');
    });

    it('uses the default batch size of 10 when STORAGE_PROCESSING_STUCK_BATCH is unset', async () => {
      delete process.env['STORAGE_PROCESSING_STUCK_BATCH'];
      mockFindMany.mockResolvedValue([]);

      await task.handleStuckReset();

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 }),
      );
    });

    it('uses STORAGE_PROCESSING_STUCK_BATCH as the take limit when set', async () => {
      process.env['STORAGE_PROCESSING_STUCK_BATCH'] = '5';
      mockFindMany.mockResolvedValue([]);

      await task.handleStuckReset();

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Per-item failure isolation
  // -------------------------------------------------------------------------

  describe('per-item failure isolation', () => {
    it('continues processing remaining ids when one reprocessImageObject call rejects', async () => {
      mockFindMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      mockReprocessImageObject.mockImplementation(async (id: string) => {
        if (id === 'b') {
          throw new Error('boom');
        }
      });

      await expect(task.handleStuckReset()).resolves.toBeUndefined();

      expect(mockReprocessImageObject).toHaveBeenCalledTimes(3);
      expect(mockReprocessImageObject).toHaveBeenNthCalledWith(1, 'a');
      expect(mockReprocessImageObject).toHaveBeenNthCalledWith(2, 'b');
      expect(mockReprocessImageObject).toHaveBeenNthCalledWith(3, 'c');
    });
  });

  // -------------------------------------------------------------------------
  // Query shape / age threshold
  // -------------------------------------------------------------------------

  describe('query shape / age threshold', () => {
    it('queries with status="processing", updatedAt < cutoff, orderBy updatedAt asc', async () => {
      mockFindMany.mockResolvedValue([]);

      await task.handleStuckReset();

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'processing',
            updatedAt: { lt: expect.any(Date) },
          },
          orderBy: { updatedAt: 'asc' },
        }),
      );
    });

    it('shifts the cutoff Date according to STORAGE_PROCESSING_STUCK_MINUTES', async () => {
      process.env['STORAGE_PROCESSING_STUCK_MINUTES'] = '30';
      mockFindMany.mockResolvedValue([]);

      const before = Date.now();
      await task.handleStuckReset();
      const after = Date.now();

      const callArg = mockFindMany.mock.calls[0][0];
      const cutoff: Date = callArg.where.updatedAt.lt;

      // cutoff should be ~30 minutes before "now" at call time, allowing slack
      // for test execution time on either side.
      const expectedMin = before - 30 * 60_000 - 1_000;
      const expectedMax = after - 30 * 60_000 + 1_000;

      expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedMin);
      expect(cutoff.getTime()).toBeLessThanOrEqual(expectedMax);
    });
  });

  // -------------------------------------------------------------------------
  // Empty result short-circuit
  // -------------------------------------------------------------------------

  describe('empty result short-circuit', () => {
    it('does not call reprocessImageObject and does not throw when findMany resolves []', async () => {
      mockFindMany.mockResolvedValue([]);

      await expect(task.handleStuckReset()).resolves.toBeUndefined();

      expect(mockReprocessImageObject).not.toHaveBeenCalled();
    });
  });
});
