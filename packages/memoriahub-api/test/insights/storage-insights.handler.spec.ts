/**
 * Unit tests for StorageInsightsHandler.
 *
 * Verifies: handler type constant; onModuleInit registers with the registry;
 * process() delegates to insightsService.runComputation().
 *
 * No database required — registry and InsightsService are fully mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MEMORIAHUB_JOBS, type MemoriahubJob } from '../../src/ports/index.js';
import { StorageInsightsHandler } from '../../src/insights/storage-insights.handler.js';
import { InsightsService } from '../../src/insights/insights.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<MemoriahubJob> = {}): MemoriahubJob {
  return { id: 'job-si-1', type: 'storage_insights', subjectType: null, subjectId: null, payload: {}, attempts: 1, orgId: null, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StorageInsightsHandler', () => {
  let handler: StorageInsightsHandler;
  let mockRegistry: { registerHandler: jest.Mock };
  let mockInsightsService: jest.Mocked<Pick<InsightsService, 'runComputation'>>;

  beforeEach(async () => {
    mockRegistry = {
      registerHandler: jest.fn(),
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
        { provide: MEMORIAHUB_JOBS, useValue: mockRegistry },
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
    it('registers itself in the jobs port on init', () => {
      handler.onModuleInit();

      expect(mockRegistry.registerHandler).toHaveBeenCalledWith(handler);
    });

    it('registers exactly once per call', () => {
      // Call onModuleInit a second time (e.g., to simulate a restart scenario)
      // — the registry receives another register call; the handler does not
      // de-duplicate (that is the registry's responsibility).
      const callsBefore = mockRegistry.registerHandler.mock.calls.length;
      handler.onModuleInit();
      expect(mockRegistry.registerHandler).toHaveBeenCalledTimes(callsBefore + 1);
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
      await handler.process();

      // runComputation is called regardless of job fields
      expect(mockInsightsService.runComputation).toHaveBeenCalledTimes(1);
    });
  });
});
