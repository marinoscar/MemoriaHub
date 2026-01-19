/**
 * Admin Controller Tests
 *
 * Tests for job management admin endpoints.
 * Covers job listing, creation, retry, cancellation, and statistics.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import type { ProcessingJob } from '@memoriahub/shared';

// Mock repository
const mockListJobs = vi.fn();
const mockFindById = vi.fn();
const mockCreate = vi.fn();
const mockRetryJob = vi.fn();
const mockCancel = vi.fn();
const mockDeleteJob = vi.fn();
const mockRetryAllFailed = vi.fn();
const mockGetStatsByQueue = vi.fn();
const mockGetStats = vi.fn();
const mockFindStuckJobs = vi.fn();
const mockResetStuckJobs = vi.fn();

vi.mock('../../../src/infrastructure/database/repositories/processing-job.repository.js', () => ({
  processingJobRepository: {
    listJobs: (...args: unknown[]) => mockListJobs(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    retryJob: (...args: unknown[]) => mockRetryJob(...args),
    cancel: (...args: unknown[]) => mockCancel(...args),
    deleteJob: (...args: unknown[]) => mockDeleteJob(...args),
    retryAllFailed: (...args: unknown[]) => mockRetryAllFailed(...args),
    getStatsByQueue: () => mockGetStatsByQueue(),
    getStats: () => mockGetStats(),
    findStuckJobs: (...args: unknown[]) => mockFindStuckJobs(...args),
    resetStuckJobs: (...args: unknown[]) => mockResetStuckJobs(...args),
  },
}));

// Mock logger
vi.mock('../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock request context
vi.mock('../../../src/infrastructure/logging/request-context.js', () => ({
  getTraceId: () => 'trace-123',
}));

import { AdminController } from '../../../src/api/controllers/admin.controller.js';

describe('AdminController', () => {
  let controller: AdminController;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;

  function createMockJob(overrides?: Partial<ProcessingJob>): ProcessingJob {
    return {
      id: 'job-123',
      assetId: 'asset-456',
      jobType: 'generate_thumbnail',
      queue: 'default',
      priority: 10,
      payload: {},
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
      workerId: null,
      result: null,
      traceId: 'trace-789',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      startedAt: null,
      completedAt: null,
      nextRetryAt: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();

    controller = new AdminController();

    mockReq = {
      query: {},
      params: {},
      body: {},
      user: { id: 'admin-user-123' },
    };

    mockRes = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
  });

  describe('listJobs', () => {
    it('returns paginated list of jobs', async () => {
      const jobs = [createMockJob(), createMockJob({ id: 'job-456' })];
      mockReq.query = { page: 1, limit: 50, sortBy: 'createdAt', sortOrder: 'desc' };
      mockListJobs.mockResolvedValue({ jobs, total: 2 });

      await controller.listJobs(mockReq as Request, mockRes as Response);

      expect(mockListJobs).toHaveBeenCalledWith(
        expect.objectContaining({
          status: undefined,
          jobType: undefined,
          queue: undefined,
        }),
        expect.objectContaining({
          page: 1,
          limit: 50,
          sortBy: 'createdAt',
          sortOrder: 'desc',
        })
      );
      expect(mockRes.json).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({ id: 'job-123' }),
          expect.objectContaining({ id: 'job-456' }),
        ]),
        meta: {
          page: 1,
          limit: 50,
          total: 2,
          totalPages: 1,
        },
      });
    });

    it('applies filters when provided', async () => {
      mockReq.query = {
        status: 'failed',
        jobType: 'generate_thumbnail',
        queue: 'default',
        assetId: 'asset-123',
        page: 1,
        limit: 50,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      };
      mockListJobs.mockResolvedValue({ jobs: [], total: 0 });

      await controller.listJobs(mockReq as Request, mockRes as Response);

      expect(mockListJobs).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          jobType: 'generate_thumbnail',
          queue: 'default',
          assetId: 'asset-123',
        }),
        expect.any(Object)
      );
    });

    it('calculates correct total pages', async () => {
      mockReq.query = { page: 1, limit: 10, sortBy: 'createdAt', sortOrder: 'desc' };
      mockListJobs.mockResolvedValue({ jobs: [], total: 45 });

      await controller.listJobs(mockReq as Request, mockRes as Response);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          meta: expect.objectContaining({
            totalPages: 5,
          }),
        })
      );
    });
  });

  describe('getJob', () => {
    it('returns job by ID', async () => {
      const job = createMockJob();
      mockReq.params = { id: 'job-123' };
      mockFindById.mockResolvedValue(job);

      await controller.getJob(mockReq as Request, mockRes as Response);

      expect(mockFindById).toHaveBeenCalledWith('job-123');
      expect(mockRes.json).toHaveBeenCalledWith({
        data: expect.objectContaining({ id: 'job-123' }),
      });
    });

    it('throws NotFoundError when job not found', async () => {
      mockReq.params = { id: 'nonexistent' };
      mockFindById.mockResolvedValue(null);

      await expect(controller.getJob(mockReq as Request, mockRes as Response))
        .rejects.toThrow('Job not found: nonexistent');
    });
  });

  describe('createJob', () => {
    it('creates a job manually', async () => {
      const job = createMockJob();
      mockReq.body = {
        assetId: 'asset-456',
        jobType: 'generate_thumbnail',
        queue: 'default',
        priority: 10,
      };
      mockCreate.mockResolvedValue(job);

      await controller.createJob(mockReq as Request, mockRes as Response);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: 'asset-456',
          jobType: 'generate_thumbnail',
          queue: 'default',
          priority: 10,
          traceId: 'trace-123',
        })
      );
      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json).toHaveBeenCalledWith({
        data: expect.objectContaining({ id: 'job-123' }),
      });
    });

    it('includes payload when provided', async () => {
      const job = createMockJob();
      mockReq.body = {
        assetId: 'asset-456',
        jobType: 'generate_thumbnail',
        payload: { customOption: true },
      };
      mockCreate.mockResolvedValue(job);

      await controller.createJob(mockReq as Request, mockRes as Response);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { customOption: true },
        })
      );
    });
  });

  describe('retryJob', () => {
    it('retries a failed job', async () => {
      const job = createMockJob({ status: 'failed' });
      mockReq.params = { id: 'job-123' };
      mockRetryJob.mockResolvedValue(job);

      await controller.retryJob(mockReq as Request, mockRes as Response);

      expect(mockRetryJob).toHaveBeenCalledWith('job-123');
      expect(mockRes.json).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'job-123',
          message: 'Job queued for retry',
        }),
      });
    });

    it('throws NotFoundError when job not found or not retriable', async () => {
      mockReq.params = { id: 'job-123' };
      mockRetryJob.mockResolvedValue(null);

      await expect(controller.retryJob(mockReq as Request, mockRes as Response))
        .rejects.toThrow('Job not found or not in retriable state: job-123');
    });
  });

  describe('cancelJob', () => {
    it('cancels a pending job', async () => {
      const job = createMockJob({ status: 'cancelled' });
      mockReq.params = { id: 'job-123' };
      mockCancel.mockResolvedValue(job);

      await controller.cancelJob(mockReq as Request, mockRes as Response);

      expect(mockCancel).toHaveBeenCalledWith('job-123');
      expect(mockRes.json).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'job-123',
          message: 'Job cancelled',
        }),
      });
    });

    it('throws NotFoundError when job not found or not cancellable', async () => {
      mockReq.params = { id: 'job-123' };
      mockCancel.mockResolvedValue(null);

      await expect(controller.cancelJob(mockReq as Request, mockRes as Response))
        .rejects.toThrow('Job not found or not cancellable: job-123');
    });
  });

  describe('deleteJob', () => {
    it('deletes a job', async () => {
      mockReq.params = { id: 'job-123' };
      mockDeleteJob.mockResolvedValue(true);

      await controller.deleteJob(mockReq as Request, mockRes as Response);

      expect(mockDeleteJob).toHaveBeenCalledWith('job-123');
      expect(mockRes.status).toHaveBeenCalledWith(204);
      expect(mockRes.send).toHaveBeenCalled();
    });

    it('throws NotFoundError when job not found', async () => {
      mockReq.params = { id: 'nonexistent' };
      mockDeleteJob.mockResolvedValue(false);

      await expect(controller.deleteJob(mockReq as Request, mockRes as Response))
        .rejects.toThrow('Job not found: nonexistent');
    });
  });

  describe('batchRetry', () => {
    it('retries specific jobs by ID', async () => {
      const job = createMockJob();
      mockReq.body = { jobIds: ['job-1', 'job-2', 'job-3'] };
      mockRetryJob
        .mockResolvedValueOnce(job)
        .mockResolvedValueOnce(job)
        .mockResolvedValueOnce(null); // Third job not found

      await controller.batchRetry(mockReq as Request, mockRes as Response);

      expect(mockRetryJob).toHaveBeenCalledTimes(3);
      expect(mockRes.json).toHaveBeenCalledWith({
        data: {
          retriedCount: 2,
          message: '2 job(s) queued for retry',
        },
      });
    });

    it('retries all failed jobs with filters', async () => {
      mockReq.body = {
        filters: {
          jobType: 'generate_thumbnail',
          queue: 'default',
        },
      };
      mockRetryAllFailed.mockResolvedValue(5);

      await controller.batchRetry(mockReq as Request, mockRes as Response);

      expect(mockRetryAllFailed).toHaveBeenCalledWith({
        jobType: 'generate_thumbnail',
        queue: 'default',
      });
      expect(mockRes.json).toHaveBeenCalledWith({
        data: {
          retriedCount: 5,
          message: '5 job(s) queued for retry',
        },
      });
    });

    it('retries all failed jobs when no filters provided', async () => {
      mockReq.body = {};
      mockRetryAllFailed.mockResolvedValue(10);

      await controller.batchRetry(mockReq as Request, mockRes as Response);

      expect(mockRetryAllFailed).toHaveBeenCalledWith();
      expect(mockRes.json).toHaveBeenCalledWith({
        data: {
          retriedCount: 10,
          message: '10 job(s) queued for retry',
        },
      });
    });
  });

  describe('getStats', () => {
    it('returns queue statistics', async () => {
      const stats = {
        queues: [
          { queue: 'default', pending: 10, processing: 2, completed: 100, failed: 5 },
          { queue: 'priority', pending: 5, processing: 1, completed: 50, failed: 2 },
        ],
      };
      mockGetStatsByQueue.mockResolvedValue(stats);

      await controller.getStats(mockReq as Request, mockRes as Response);

      expect(mockGetStatsByQueue).toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith({ data: stats });
    });
  });

  describe('getStatsSummary', () => {
    it('returns basic statistics', async () => {
      const stats = {
        total: 150,
        pending: 15,
        processing: 3,
        completed: 130,
        failed: 7,
      };
      mockGetStats.mockResolvedValue(stats);

      await controller.getStatsSummary(mockReq as Request, mockRes as Response);

      expect(mockGetStats).toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith({ data: stats });
    });
  });

  describe('findStuckJobs', () => {
    it('finds jobs stuck in processing', async () => {
      const stuckJobs = [
        createMockJob({ status: 'processing', startedAt: new Date('2024-01-01T00:00:00Z') }),
      ];
      mockReq.query = { minutes: '30' };
      mockFindStuckJobs.mockResolvedValue(stuckJobs);

      await controller.findStuckJobs(mockReq as Request, mockRes as Response);

      expect(mockFindStuckJobs).toHaveBeenCalledWith(30);
      expect(mockRes.json).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({ id: 'job-123' }),
        ]),
        meta: {
          stuckAfterMinutes: 30,
          count: 1,
        },
      });
    });

    it('uses default minutes when not provided', async () => {
      mockReq.query = {};
      mockFindStuckJobs.mockResolvedValue([]);

      await controller.findStuckJobs(mockReq as Request, mockRes as Response);

      expect(mockFindStuckJobs).toHaveBeenCalledWith(30);
    });
  });

  describe('resetStuckJobs', () => {
    it('resets stuck jobs to pending', async () => {
      mockReq.query = { minutes: '45' };
      mockResetStuckJobs.mockResolvedValue(3);

      await controller.resetStuckJobs(mockReq as Request, mockRes as Response);

      expect(mockResetStuckJobs).toHaveBeenCalledWith(45);
      expect(mockRes.json).toHaveBeenCalledWith({
        data: {
          resetCount: 3,
          message: '3 stuck job(s) reset to pending',
        },
      });
    });

    it('uses default minutes when not provided', async () => {
      mockReq.query = {};
      mockResetStuckJobs.mockResolvedValue(0);

      await controller.resetStuckJobs(mockReq as Request, mockRes as Response);

      expect(mockResetStuckJobs).toHaveBeenCalledWith(30);
    });
  });

  describe('DTO conversion', () => {
    it('converts dates to ISO strings', async () => {
      const job = createMockJob({
        startedAt: new Date('2024-01-01T01:00:00Z'),
        completedAt: new Date('2024-01-01T01:05:00Z'),
      });
      mockReq.params = { id: 'job-123' };
      mockFindById.mockResolvedValue(job);

      await controller.getJob(mockReq as Request, mockRes as Response);

      expect(mockRes.json).toHaveBeenCalledWith({
        data: expect.objectContaining({
          createdAt: '2024-01-01T00:00:00.000Z',
          startedAt: '2024-01-01T01:00:00.000Z',
          completedAt: '2024-01-01T01:05:00.000Z',
        }),
      });
    });

    it('handles null dates', async () => {
      const job = createMockJob({
        startedAt: null,
        completedAt: null,
        nextRetryAt: null,
      });
      mockReq.params = { id: 'job-123' };
      mockFindById.mockResolvedValue(job);

      await controller.getJob(mockReq as Request, mockRes as Response);

      expect(mockRes.json).toHaveBeenCalledWith({
        data: expect.objectContaining({
          startedAt: null,
          completedAt: null,
          nextRetryAt: null,
        }),
      });
    });
  });
});
