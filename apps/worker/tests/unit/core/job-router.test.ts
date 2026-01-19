import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessingJob, ProcessingJobResult } from '@memoriahub/shared';
import type { JobContext } from '../../../src/core/job-context.js';

// Mock the logger
vi.mock('../../../src/infrastructure/logging/index.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  LogEventTypes: {
    JOB_STARTED: 'job.started',
    JOB_COMPLETED: 'job.completed',
    JOB_FAILED: 'job.failed',
  },
}));

import { JobRouter, type JobHandler } from '../../../src/core/job-router.js';

describe('JobRouter', () => {
  let router: JobRouter;
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  function createMockJob(overrides?: Partial<ProcessingJob>): ProcessingJob {
    return {
      id: 'job-123',
      assetId: 'asset-456',
      jobType: 'generate_thumbnail',
      queue: 'default',
      priority: 1,
      payload: {},
      status: 'processing',
      attempts: 1,
      maxAttempts: 3,
      lastError: null,
      workerId: 'worker-1',
      result: null,
      traceId: 'trace-789',
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
      nextRetryAt: null,
      ...overrides,
    };
  }

  function createMockContext(job?: ProcessingJob): JobContext {
    return {
      job: job || createMockJob(),
      logger: mockLogger as unknown as import('pino').Logger,
      workerId: 'worker-1',
      startTime: Date.now(),
      getElapsedMs: () => 100,
      abortSignal: new AbortController().signal,
    };
  }

  function createMockHandler(
    jobType: ProcessingJob['jobType'],
    processImpl?: (context: JobContext) => Promise<ProcessingJobResult>
  ): JobHandler {
    return {
      jobType,
      process: processImpl || vi.fn().mockResolvedValue({ outputKey: 'test.jpg', outputSize: 1234 }),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    router = new JobRouter();
  });

  describe('register', () => {
    it('registers a handler for a job type', () => {
      const handler = createMockHandler('generate_thumbnail');

      router.register(handler);

      expect(router.hasHandler('generate_thumbnail')).toBe(true);
    });

    it('replaces existing handler when registering same type', () => {
      const handler1 = createMockHandler('generate_thumbnail');
      const handler2 = createMockHandler('generate_thumbnail');

      router.register(handler1);
      router.register(handler2);

      expect(router.getHandler('generate_thumbnail')).toBe(handler2);
    });

    it('can register multiple different handlers', () => {
      const thumbnailHandler = createMockHandler('generate_thumbnail');
      const previewHandler = createMockHandler('generate_preview');

      router.register(thumbnailHandler);
      router.register(previewHandler);

      expect(router.hasHandler('generate_thumbnail')).toBe(true);
      expect(router.hasHandler('generate_preview')).toBe(true);
    });
  });

  describe('hasHandler', () => {
    it('returns true when handler exists', () => {
      const handler = createMockHandler('generate_thumbnail');
      router.register(handler);

      expect(router.hasHandler('generate_thumbnail')).toBe(true);
    });

    it('returns false when handler does not exist', () => {
      expect(router.hasHandler('generate_thumbnail')).toBe(false);
    });
  });

  describe('getHandler', () => {
    it('returns handler when it exists', () => {
      const handler = createMockHandler('generate_thumbnail');
      router.register(handler);

      expect(router.getHandler('generate_thumbnail')).toBe(handler);
    });

    it('returns undefined when handler does not exist', () => {
      expect(router.getHandler('generate_thumbnail')).toBeUndefined();
    });
  });

  describe('getRegisteredTypes', () => {
    it('returns empty array when no handlers registered', () => {
      expect(router.getRegisteredTypes()).toEqual([]);
    });

    it('returns all registered job types', () => {
      router.register(createMockHandler('generate_thumbnail'));
      router.register(createMockHandler('generate_preview'));

      const types = router.getRegisteredTypes();

      expect(types).toHaveLength(2);
      expect(types).toContain('generate_thumbnail');
      expect(types).toContain('generate_preview');
    });
  });

  describe('route', () => {
    it('routes job to correct handler and returns result', async () => {
      const expectedResult = { outputKey: 'result.jpg', outputSize: 5678 };
      const handler = createMockHandler(
        'generate_thumbnail',
        vi.fn().mockResolvedValue(expectedResult)
      );
      router.register(handler);

      const context = createMockContext();
      const result = await router.route(context);

      expect(handler.process).toHaveBeenCalledWith(context);
      expect(result).toEqual(expectedResult);
    });

    it('throws error when no handler registered for job type', async () => {
      const context = createMockContext();

      await expect(router.route(context)).rejects.toThrow(
        'No handler registered for job type: generate_thumbnail'
      );
    });

    it('propagates errors from handler', async () => {
      const error = new Error('Handler processing failed');
      const handler = createMockHandler(
        'generate_thumbnail',
        vi.fn().mockRejectedValue(error)
      );
      router.register(handler);

      const context = createMockContext();

      await expect(router.route(context)).rejects.toThrow('Handler processing failed');
    });

    it('logs job start and completion', async () => {
      const handler = createMockHandler('generate_thumbnail');
      router.register(handler);

      const context = createMockContext();
      await router.route(context);

      expect(context.logger.info).toHaveBeenCalledTimes(2);
      expect(context.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'job.started',
          jobType: 'generate_thumbnail',
          assetId: 'asset-456',
        }),
        expect.any(String)
      );
      expect(context.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'job.completed',
          jobType: 'generate_thumbnail',
          assetId: 'asset-456',
        }),
        expect.any(String)
      );
    });

    it('routes different job types to different handlers', async () => {
      const thumbnailResult = { outputKey: 'thumb.jpg', outputSize: 1000 };
      const previewResult = { outputKey: 'preview.jpg', outputSize: 5000 };

      const thumbnailHandler = createMockHandler(
        'generate_thumbnail',
        vi.fn().mockResolvedValue(thumbnailResult)
      );
      const previewHandler = createMockHandler(
        'generate_preview',
        vi.fn().mockResolvedValue(previewResult)
      );

      router.register(thumbnailHandler);
      router.register(previewHandler);

      const thumbnailContext = createMockContext(createMockJob({ jobType: 'generate_thumbnail' }));
      const previewContext = createMockContext(createMockJob({ jobType: 'generate_preview' }));

      const result1 = await router.route(thumbnailContext);
      const result2 = await router.route(previewContext);

      expect(thumbnailHandler.process).toHaveBeenCalledWith(thumbnailContext);
      expect(previewHandler.process).toHaveBeenCalledWith(previewContext);
      expect(result1).toEqual(thumbnailResult);
      expect(result2).toEqual(previewResult);
    });
  });
});
