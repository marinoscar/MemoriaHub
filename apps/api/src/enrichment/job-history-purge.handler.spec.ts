/**
 * Unit tests for JobHistoryPurgeHandler.
 *
 * Verifies:
 *   - type constant is 'job_history_purge'
 *   - onModuleInit registers with the registry
 *   - process() disabled path: purgeEnabled=false → no findMany/deleteMany
 *   - process() enabled path: deleteMany called with status in [succeeded,failed]
 *     AND finishedAt lt cutoff
 *   - batch loop: terminates when a short batch (<5000) is returned
 *   - cutoff date math matches jobs.history.retentionDays setting
 *   - error propagation from DB calls
 *
 * Notes: API tests not run (Prisma engine download blocked in this env).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobStatus } from '@prisma/client';
import type { EnrichmentJob } from '@prisma/client';
import { JobHistoryPurgeHandler } from './job-history-purge.handler';
import { EnrichmentHandlerRegistry } from './enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-purge-1',
    type: 'job_history_purge',
    mediaItemId: null,
    circleId: null,
    status: 'running' as any,
    reason: 'backfill' as any,
    priority: 100,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 1,
    lastError: null,
    startedAt: new Date(),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    createdAt: new Date(),
    ...overrides,
  } as EnrichmentJob;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobHistoryPurgeHandler', () => {
  let handler: JobHistoryPurgeHandler;
  let mockRegistry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
  let mockSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettingValue'>>;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockRegistry = {
      register: jest.fn(),
    };

    mockSettings = {
      getSettingValue: jest.fn().mockResolvedValue(30), // default 30 days
    };

    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobHistoryPurgeHandler,
        { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
        { provide: SystemSettingsService, useValue: mockSettings },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    handler = module.get<JobHistoryPurgeHandler>(JobHistoryPurgeHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // type constant
  // =========================================================================

  describe('type', () => {
    it('has type === "job_history_purge"', () => {
      expect(handler.type).toBe('job_history_purge');
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

    it('registers exactly once per call', () => {
      handler.onModuleInit();
      handler.onModuleInit();
      expect(mockRegistry.register).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // process — disabled (purgeEnabled=false)
  // =========================================================================

  describe('process — disabled', () => {
    it('does NOT call findMany when purgeEnabled=false', async () => {
      mockSettings.getSettingValue.mockResolvedValue(false);

      await handler.process(makeJob());

      expect(mockPrisma.enrichmentJob.findMany).not.toHaveBeenCalled();
    });

    it('does NOT call deleteMany when purgeEnabled=false', async () => {
      mockSettings.getSettingValue.mockResolvedValue(false);

      await handler.process(makeJob());

      expect(mockPrisma.enrichmentJob.deleteMany).not.toHaveBeenCalled();
    });

    it('resolves without throwing when disabled', async () => {
      mockSettings.getSettingValue.mockResolvedValue(false);

      await expect(handler.process(makeJob())).resolves.toBeUndefined();
    });

    it('reads jobs.history.purgeEnabled setting', async () => {
      // purgeEnabled is the first getSettingValue call
      mockSettings.getSettingValue.mockResolvedValue(false);

      await handler.process(makeJob());

      expect(mockSettings.getSettingValue).toHaveBeenCalledWith('jobs.history.purgeEnabled');
    });

    it('treats null purgeEnabled as true (default enabled) and proceeds', async () => {
      // null → nullish coalescing defaults to true → should proceed to findMany
      mockSettings.getSettingValue
        .mockResolvedValueOnce(null) // purgeEnabled defaults to true
        .mockResolvedValueOnce(30); // retentionDays

      mockPrisma.enrichmentJob.findMany.mockResolvedValue([]);

      await handler.process(makeJob());

      expect(mockPrisma.enrichmentJob.findMany).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // process — enabled, single empty batch
  // =========================================================================

  describe('process — enabled, no eligible jobs', () => {
    beforeEach(() => {
      // purgeEnabled=true (default mock returns 30, but first call must be boolean)
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)  // purgeEnabled
        .mockResolvedValueOnce(30);   // retentionDays
    });

    it('calls findMany with status in [succeeded, failed]', async () => {
      mockPrisma.enrichmentJob.findMany.mockResolvedValue([]);

      await handler.process(makeJob());

      expect(mockPrisma.enrichmentJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: [JobStatus.succeeded, JobStatus.failed] },
          }),
        }),
      );
    });

    it('calls findMany with finishedAt lt the cutoff', async () => {
      mockPrisma.enrichmentJob.findMany.mockResolvedValue([]);

      const before = Date.now();
      await handler.process(makeJob());
      const after = Date.now();

      const [call] = (mockPrisma.enrichmentJob.findMany as jest.Mock).mock.calls;
      const where = call[0].where;

      expect(where.finishedAt).toBeDefined();
      expect(where.finishedAt.not).toBeNull();
      const cutoff: Date = where.finishedAt.lt;
      expect(cutoff).toBeInstanceOf(Date);

      const thirtyDaysMs = 30 * 86_400_000;
      expect(cutoff.getTime()).toBeGreaterThan(before - thirtyDaysMs - 5000);
      expect(cutoff.getTime()).toBeLessThan(after - thirtyDaysMs + 5000);
    });

    it('does NOT call deleteMany when findMany returns empty batch', async () => {
      mockPrisma.enrichmentJob.findMany.mockResolvedValue([]);

      await handler.process(makeJob());

      expect(mockPrisma.enrichmentJob.deleteMany).not.toHaveBeenCalled();
    });

    it('resolves without throwing when no jobs to delete', async () => {
      mockPrisma.enrichmentJob.findMany.mockResolvedValue([]);

      await expect(handler.process(makeJob())).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // process — enabled, batch delete
  // =========================================================================

  describe('process — enabled, batch delete', () => {
    beforeEach(() => {
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(30);
    });

    it('calls deleteMany with id in the batch ids', async () => {
      const batchIds = [{ id: 'job-a' }, { id: 'job-b' }, { id: 'job-c' }];
      mockPrisma.enrichmentJob.findMany.mockResolvedValue(batchIds as any);
      mockPrisma.enrichmentJob.deleteMany.mockResolvedValue({ count: 3 });

      await handler.process(makeJob());

      expect(mockPrisma.enrichmentJob.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['job-a', 'job-b', 'job-c'] } },
        }),
      );
    });

    it('resolves without throwing after a successful batch delete', async () => {
      mockPrisma.enrichmentJob.findMany.mockResolvedValue([{ id: 'job-1' }] as any);
      mockPrisma.enrichmentJob.deleteMany.mockResolvedValue({ count: 1 });

      await expect(handler.process(makeJob())).resolves.toBeUndefined();
    });

    it('propagates errors thrown by deleteMany', async () => {
      mockPrisma.enrichmentJob.findMany.mockResolvedValue([{ id: 'job-1' }] as any);
      mockPrisma.enrichmentJob.deleteMany.mockRejectedValue(new Error('DB locked'));

      await expect(handler.process(makeJob())).rejects.toThrow('DB locked');
    });

    it('propagates errors thrown by findMany', async () => {
      mockPrisma.enrichmentJob.findMany.mockRejectedValue(new Error('Connection lost'));

      await expect(handler.process(makeJob())).rejects.toThrow('Connection lost');
    });
  });

  // =========================================================================
  // process — batch loop terminates on short batch
  // =========================================================================

  describe('process — batch loop', () => {
    beforeEach(() => {
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(30);
    });

    it('stops after the first short batch (< 5000 items)', async () => {
      // Batch of 3 items → well under 5000, loop should terminate after one iteration
      const batch = [{ id: 'job-a' }, { id: 'job-b' }, { id: 'job-c' }];
      mockPrisma.enrichmentJob.findMany.mockResolvedValue(batch as any);
      mockPrisma.enrichmentJob.deleteMany.mockResolvedValue({ count: 3 });

      await handler.process(makeJob());

      expect(mockPrisma.enrichmentJob.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.enrichmentJob.deleteMany).toHaveBeenCalledTimes(1);
    });

    it('continues batching until a short batch is received', async () => {
      // Simulate: first batch full (5000 items), second batch small (2 items)
      const fullBatch = Array.from({ length: 5000 }, (_, i) => ({ id: `job-${i}` }));
      const shortBatch = [{ id: 'job-last-a' }, { id: 'job-last-b' }];

      mockPrisma.enrichmentJob.findMany
        .mockResolvedValueOnce(fullBatch as any)
        .mockResolvedValueOnce(shortBatch as any);
      mockPrisma.enrichmentJob.deleteMany.mockResolvedValue({ count: 5000 });

      await handler.process(makeJob());

      // findMany called twice; deleteMany called twice
      expect(mockPrisma.enrichmentJob.findMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.enrichmentJob.deleteMany).toHaveBeenCalledTimes(2);
    });

    it('stops immediately when the first batch is empty', async () => {
      mockPrisma.enrichmentJob.findMany.mockResolvedValue([]);

      await handler.process(makeJob());

      expect(mockPrisma.enrichmentJob.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.enrichmentJob.deleteMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // process — retentionDays from settings
  // =========================================================================

  describe('process — cutoff date from retentionDays', () => {
    it('uses custom retentionDays of 7 when setting returns 7', async () => {
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(7);

      mockPrisma.enrichmentJob.findMany.mockResolvedValue([]);

      const before = Date.now();
      await handler.process(makeJob());
      const after = Date.now();

      const [call] = (mockPrisma.enrichmentJob.findMany as jest.Mock).mock.calls;
      const cutoff: Date = call[0].where.finishedAt.lt;
      const sevenDaysMs = 7 * 86_400_000;
      expect(cutoff.getTime()).toBeGreaterThan(before - sevenDaysMs - 5000);
      expect(cutoff.getTime()).toBeLessThan(after - sevenDaysMs + 5000);
    });

    it('reads jobs.history.retentionDays setting', async () => {
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(30);

      mockPrisma.enrichmentJob.findMany.mockResolvedValue([]);

      await handler.process(makeJob());

      expect(mockSettings.getSettingValue).toHaveBeenCalledWith('jobs.history.retentionDays');
    });

    it('uses default retentionDays of 30 when setting returns undefined', async () => {
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(undefined);

      mockPrisma.enrichmentJob.findMany.mockResolvedValue([]);

      const before = Date.now();
      await handler.process(makeJob());
      const after = Date.now();

      const [call] = (mockPrisma.enrichmentJob.findMany as jest.Mock).mock.calls;
      const cutoff: Date = call[0].where.finishedAt.lt;
      const thirtyDaysMs = 30 * 86_400_000;
      expect(cutoff.getTime()).toBeGreaterThan(before - thirtyDaysMs - 5000);
      expect(cutoff.getTime()).toBeLessThan(after - thirtyDaysMs + 5000);
    });
  });

  // =========================================================================
  // process — global job (mediaItemId and circleId are null)
  // =========================================================================

  describe('process — global job fields', () => {
    it('works correctly when mediaItemId and circleId are null', async () => {
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(30);

      mockPrisma.enrichmentJob.findMany.mockResolvedValue([]);

      const job = makeJob({ mediaItemId: null, circleId: null });

      await expect(handler.process(job)).resolves.toBeUndefined();
      expect(mockPrisma.enrichmentJob.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
