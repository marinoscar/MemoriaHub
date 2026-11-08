/**
 * Unit tests for StorageInsightsHandler.
 *
 * Verifies: handler type constant; onModuleInit registers with the registry;
 * process() delegates to insightsService.runComputation().
 *
 * No database required — registry and InsightsService are fully mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { StorageInsightsHandler } from './storage-insights.handler';
import { JobHandlerRegistry, type Job } from '@marinoscar/platform-api/jobs';
import { InsightsService } from './insights.service';
import { systemJob } from '../../test/helpers/platform-job';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<Job> = {}): Job {
  return systemJob('storage_insights', { id: 'job-si-1', status: 'running', reason: 'backfill', priority: 100, attempts: 1, ...overrides });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StorageInsightsHandler', () => {
  let handler: StorageInsightsHandler;
  let mockRegistry: jest.Mocked<Pick<JobHandlerRegistry, 'register'>>;
  let mockInsightsService: jest.Mocked<Pick<InsightsService, 'runComputation'>>;

  beforeEach(async () => {
    mockRegistry = {
      register: jest.fn(),
    };

    mockInsightsService = {
      runComputation: jest.fn().mockResolvedValue({
        id: 'snap-1',
        status: 'ready',
        metrics: null,
        computedAt: new Date(),
        durationMs: 120,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageInsightsHandler,
        { provide: JobHandlerRegistry, useValue: mockRegistry },
        { provide: InsightsService, useValue: mockInsightsService },
      ],
    }).compile();

    handler = module.get<StorageInsightsHandler>(StorageInsightsHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // type constant
  // =========================================================================

  describe('type', () => {
    it('has type === "storage_insights"', () => {
      expect(handler.type).toBe('storage_insights');
    });

    it('declares its label and execution profile, and no node pair', () => {
      expect(handler.label).toBe('Storage insights');
      expect(handler.profile).toEqual({ maxRuntimeMs: 900_000, maxAttempts: 3 });
      expect((handler as { nodeResultSchema?: unknown }).nodeResultSchema).toBeUndefined();
    });
  });

  // =========================================================================
  // onModuleInit — registers with the registry
  // =========================================================================

  describe('onModuleInit', () => {
    it('registers itself in the platform JobHandlerRegistry on init', () => {
      handler.onModuleInit();

      expect(mockRegistry.register).toHaveBeenCalledWith(handler);
    });

    it('registers exactly once per call', () => {
      // Call onModuleInit a second time (e.g., to simulate a restart scenario)
      // — the registry receives another register call; the handler does not
      // de-duplicate (that is the registry's responsibility).
      const callsBefore = (mockRegistry.register as jest.Mock).mock.calls.length;
      handler.onModuleInit();
      expect(mockRegistry.register).toHaveBeenCalledTimes(callsBefore + 1);
    });
  });

  // =========================================================================
  // process — delegates to InsightsService.runComputation
  // =========================================================================

  describe('process', () => {
    it('calls insightsService.runComputation() with no arguments', async () => {
      await handler.process();

      expect(mockInsightsService.runComputation).toHaveBeenCalledTimes(1);
      expect(mockInsightsService.runComputation).toHaveBeenCalledWith();
    });

    it('resolves without throwing when runComputation succeeds', async () => {
      await expect(handler.process()).resolves.toBeUndefined();
    });

    it('propagates errors thrown by runComputation (worker records lastError and retries)', async () => {
      mockInsightsService.runComputation.mockRejectedValue(new Error('DB unavailable'));

      await expect(handler.process()).rejects.toThrow('DB unavailable');
    });

    it('ignores the job — a global job has no subject', async () => {
      const job = makeJob({ subjectType: null, subjectId: null });
      await (handler.process as (job: Job) => Promise<void>)(job);

      // runComputation is called regardless of job fields
      expect(mockInsightsService.runComputation).toHaveBeenCalledTimes(1);
    });
  });
});
