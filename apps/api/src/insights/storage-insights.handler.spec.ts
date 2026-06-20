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
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { InsightsService } from './insights.service';
import type { EnrichmentJob } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-si-1',
    type: 'storage_insights',
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
    createdAt: new Date(),
    ...overrides,
  } as EnrichmentJob;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StorageInsightsHandler', () => {
  let handler: StorageInsightsHandler;
  let mockRegistry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
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
        { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
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
  });

  // =========================================================================
  // onModuleInit — registers with the registry
  // =========================================================================

  describe('onModuleInit', () => {
    it('registers itself in the EnrichmentHandlerRegistry on init', () => {
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
      const job = makeJob();
      await handler.process(job);

      expect(mockInsightsService.runComputation).toHaveBeenCalledTimes(1);
      expect(mockInsightsService.runComputation).toHaveBeenCalledWith();
    });

    it('resolves without throwing when runComputation succeeds', async () => {
      const job = makeJob();
      await expect(handler.process(job)).resolves.toBeUndefined();
    });

    it('propagates errors thrown by runComputation (worker records lastError and retries)', async () => {
      mockInsightsService.runComputation.mockRejectedValue(new Error('DB unavailable'));

      const job = makeJob();
      await expect(handler.process(job)).rejects.toThrow('DB unavailable');
    });

    it('ignores the job payload — global job has null mediaItemId and circleId', async () => {
      const job = makeJob({ mediaItemId: null, circleId: null });
      await handler.process(job);

      // runComputation is called regardless of job fields
      expect(mockInsightsService.runComputation).toHaveBeenCalledTimes(1);
    });
  });
});
