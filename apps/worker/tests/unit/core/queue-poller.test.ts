import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProcessingJob } from '@memoriahub/shared';

// Mock dependencies
vi.mock('../../../src/repositories/index.js', () => ({
  processingJobRepository: {
    acquireJob: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    releaseJob: vi.fn(),
  },
}));

vi.mock('../../../src/core/job-router.js', () => ({
  jobRouter: {
    hasHandler: vi.fn(),
    route: vi.fn(),
  },
}));

vi.mock('../../../src/core/job-context.js', () => ({
  createJobContext: vi.fn(),
}));

vi.mock('../../../src/infrastructure/logging/index.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  LogEventTypes: {
    QUEUE_POLLING: 'queue.polling',
    QUEUE_EMPTY: 'queue.empty',
    QUEUE_PAUSED: 'queue.paused',
    QUEUE_RESUMED: 'queue.resumed',
    JOB_TIMEOUT: 'job.timeout',
    JOB_COMPLETED: 'job.completed',
    JOB_ACQUIRED: 'job.acquired',
  },
}));

import { QueuePoller } from '../../../src/core/queue-poller.js';
import { processingJobRepository } from '../../../src/repositories/index.js';
import { jobRouter } from '../../../src/core/job-router.js';
import { createJobContext } from '../../../src/core/job-context.js';
import type { QueueConfig } from '../../../src/config/index.js';

describe('QueuePoller', () => {
  let poller: QueuePoller;
  const mockConfig: QueueConfig = {
    enabled: true,
    concurrency: 2,
    pollIntervalMs: 100,
    jobTimeoutMs: 5000,
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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    poller = new QueuePoller('default', mockConfig, 'worker-1');
  });

  afterEach(() => {
    poller.stop();
    vi.useRealTimers();
  });

  describe('start/stop', () => {
    it('starts the poller', () => {
      poller.start();
      expect(poller['isRunning']).toBe(true);
    });

    it('does not start twice if already running', () => {
      poller.start();
      poller.start(); // Second call should be ignored
      expect(poller['isRunning']).toBe(true);
    });

    it('stops the poller', () => {
      poller.start();
      poller.stop();
      expect(poller['isRunning']).toBe(false);
    });

    it('clears poll timer when stopping', () => {
      poller.start();
      expect(poller['pollTimer']).not.toBeNull();
      poller.stop();
      expect(poller['pollTimer']).toBeNull();
    });
  });

  describe('pause/resume', () => {
    it('pauses job acquisition', () => {
      poller.start();
      poller.pause();
      expect(poller['isPaused']).toBe(true);
    });

    it('resumes job acquisition', () => {
      poller.start();
      poller.pause();
      poller.resume();
      expect(poller['isPaused']).toBe(false);
    });

    it('canAcceptJobs returns false when paused', () => {
      poller.start();
      expect(poller.canAcceptJobs).toBe(true);
      poller.pause();
      expect(poller.canAcceptJobs).toBe(false);
    });
  });

  describe('activeJobCount', () => {
    it('returns 0 initially', () => {
      expect(poller.activeJobCount).toBe(0);
    });
  });

  describe('canAcceptJobs', () => {
    it('returns true when running, not paused, and under concurrency', () => {
      poller.start();
      expect(poller.canAcceptJobs).toBe(true);
    });

    it('returns false when not running', () => {
      expect(poller.canAcceptJobs).toBe(false);
    });

    it('returns false when paused', () => {
      poller.start();
      poller.pause();
      expect(poller.canAcceptJobs).toBe(false);
    });

    it('returns false when at max concurrency', () => {
      poller.start();
      // Manually add active jobs to simulate reaching max concurrency
      const job1 = createMockJob({ id: 'job-1' });
      const job2 = createMockJob({ id: 'job-2' });
      poller['activeJobs'].set('job-1', { job: job1, abortController: new AbortController() });
      poller['activeJobs'].set('job-2', { job: job2, abortController: new AbortController() });
      expect(poller.canAcceptJobs).toBe(false);
    });
  });

  describe('poll', () => {
    it('acquires and processes jobs when available', async () => {
      const mockJob = createMockJob();
      const mockContext = {
        job: mockJob,
        logger: { info: vi.fn(), debug: vi.fn() },
        workerId: 'worker-1',
        startTime: Date.now(),
        getElapsedMs: () => 100,
        abortSignal: new AbortController().signal,
      };
      const mockResult = { outputKey: 'test.jpg', outputSize: 1234 };

      vi.mocked(processingJobRepository.acquireJob)
        .mockResolvedValueOnce(mockJob)
        .mockResolvedValueOnce(null); // Second call returns null to stop loop
      vi.mocked(jobRouter.hasHandler).mockReturnValue(true);
      vi.mocked(createJobContext).mockReturnValue(mockContext as ReturnType<typeof createJobContext>);
      vi.mocked(jobRouter.route).mockResolvedValue(mockResult);
      vi.mocked(processingJobRepository.complete).mockResolvedValue(mockJob);

      poller.start();

      // Advance timers to trigger poll
      await vi.advanceTimersByTimeAsync(mockConfig.pollIntervalMs);

      expect(processingJobRepository.acquireJob).toHaveBeenCalledWith('default', 'worker-1');
      expect(jobRouter.hasHandler).toHaveBeenCalledWith('generate_thumbnail');
      expect(jobRouter.route).toHaveBeenCalledWith(mockContext);
      expect(processingJobRepository.complete).toHaveBeenCalledWith('job-123', mockResult);
    });

    it('does not process when no jobs available', async () => {
      vi.mocked(processingJobRepository.acquireJob).mockResolvedValue(null);

      poller.start();
      await vi.advanceTimersByTimeAsync(mockConfig.pollIntervalMs);

      expect(processingJobRepository.acquireJob).toHaveBeenCalled();
      expect(jobRouter.route).not.toHaveBeenCalled();
    });

    it('fails job when no handler is registered', async () => {
      const mockJob = createMockJob();

      vi.mocked(processingJobRepository.acquireJob)
        .mockResolvedValueOnce(mockJob)
        .mockResolvedValueOnce(null);
      vi.mocked(jobRouter.hasHandler).mockReturnValue(false);
      vi.mocked(processingJobRepository.fail).mockResolvedValue(mockJob);

      poller.start();
      await vi.advanceTimersByTimeAsync(mockConfig.pollIntervalMs);

      // Wait for the job processing to complete
      await vi.advanceTimersByTimeAsync(100);

      expect(processingJobRepository.fail).toHaveBeenCalledWith(
        'job-123',
        expect.stringContaining('No handler registered for job type')
      );
    });

    it('fails job when processing throws error', async () => {
      const mockJob = createMockJob();
      const mockContext = {
        job: mockJob,
        logger: { info: vi.fn(), debug: vi.fn() },
        workerId: 'worker-1',
        startTime: Date.now(),
        getElapsedMs: () => 100,
        abortSignal: new AbortController().signal,
      };

      vi.mocked(processingJobRepository.acquireJob)
        .mockResolvedValueOnce(mockJob)
        .mockResolvedValueOnce(null);
      vi.mocked(jobRouter.hasHandler).mockReturnValue(true);
      vi.mocked(createJobContext).mockReturnValue(mockContext as ReturnType<typeof createJobContext>);
      vi.mocked(jobRouter.route).mockRejectedValue(new Error('Processing failed'));
      vi.mocked(processingJobRepository.fail).mockResolvedValue(mockJob);

      poller.start();
      await vi.advanceTimersByTimeAsync(mockConfig.pollIntervalMs);

      // Wait for the job processing to complete
      await vi.advanceTimersByTimeAsync(100);

      expect(processingJobRepository.fail).toHaveBeenCalledWith('job-123', 'Processing failed');
    });
  });

  describe('waitForCompletion', () => {
    it('resolves immediately when no active jobs', async () => {
      vi.useRealTimers();
      await expect(poller.waitForCompletion(1000)).resolves.toBeUndefined();
    });

    it('waits for active jobs to complete', async () => {
      vi.useRealTimers();

      const job = createMockJob();
      poller['activeJobs'].set('job-1', { job, abortController: new AbortController() });

      // Remove the job after a short delay
      setTimeout(() => {
        poller['activeJobs'].delete('job-1');
      }, 50);

      await expect(poller.waitForCompletion(1000)).resolves.toBeUndefined();
    });

    it('stops waiting after timeout', async () => {
      vi.useRealTimers();

      const job = createMockJob();
      poller['activeJobs'].set('job-1', { job, abortController: new AbortController() });

      // Don't remove the job - let it timeout
      const startTime = Date.now();
      await poller.waitForCompletion(100);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(poller['activeJobs'].size).toBe(1); // Job still there
    });
  });

  describe('abortActiveJobs', () => {
    it('aborts all active jobs and releases them', async () => {
      const job1 = createMockJob({ id: 'job-1' });
      const job2 = createMockJob({ id: 'job-2' });
      const controller1 = new AbortController();
      const controller2 = new AbortController();

      poller['activeJobs'].set('job-1', { job: job1, abortController: controller1 });
      poller['activeJobs'].set('job-2', { job: job2, abortController: controller2 });

      vi.mocked(processingJobRepository.releaseJob).mockResolvedValue(job1);

      await poller.abortActiveJobs();

      expect(controller1.signal.aborted).toBe(true);
      expect(controller2.signal.aborted).toBe(true);
      expect(processingJobRepository.releaseJob).toHaveBeenCalledWith('job-1');
      expect(processingJobRepository.releaseJob).toHaveBeenCalledWith('job-2');
      expect(poller['activeJobs'].size).toBe(0);
    });

    it('handles errors when releasing jobs', async () => {
      const job = createMockJob();
      poller['activeJobs'].set('job-1', { job, abortController: new AbortController() });

      vi.mocked(processingJobRepository.releaseJob).mockRejectedValue(new Error('Release failed'));

      // Should not throw
      await expect(poller.abortActiveJobs()).resolves.toBeUndefined();
      expect(poller['activeJobs'].size).toBe(0);
    });
  });

  describe('job timeout', () => {
    it('aborts job after timeout', async () => {
      vi.useRealTimers();

      const mockJob = createMockJob();
      const mockContext = {
        job: mockJob,
        logger: { info: vi.fn(), debug: vi.fn() },
        workerId: 'worker-1',
        startTime: Date.now(),
        getElapsedMs: () => 100,
        abortSignal: new AbortController().signal,
      };

      // Create a slow-resolving route that will be aborted
      vi.mocked(processingJobRepository.acquireJob)
        .mockResolvedValueOnce(mockJob)
        .mockResolvedValue(null);
      vi.mocked(jobRouter.hasHandler).mockReturnValue(true);
      vi.mocked(createJobContext).mockReturnValue(mockContext as ReturnType<typeof createJobContext>);
      vi.mocked(jobRouter.route).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({}), 10000))
      );
      vi.mocked(processingJobRepository.fail).mockResolvedValue(mockJob);

      // Use a shorter timeout for testing
      const shortTimeoutPoller = new QueuePoller('default', { ...mockConfig, jobTimeoutMs: 50 }, 'worker-1');
      shortTimeoutPoller.start();

      // Wait for job to timeout
      await new Promise((resolve) => setTimeout(resolve, 200));

      shortTimeoutPoller.stop();

      expect(processingJobRepository.fail).toHaveBeenCalledWith(
        'job-123',
        expect.stringContaining('aborted')
      );
    });
  });
});
