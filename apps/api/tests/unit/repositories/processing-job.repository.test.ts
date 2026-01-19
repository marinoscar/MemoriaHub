/**
 * Processing Job Repository Tests
 *
 * Unit tests for the processing job repository.
 * Tests job creation, status updates, queue operations, and filtering.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessingJob, ProcessingJobType, ProcessingJobQueue } from '@memoriahub/shared';

// Mock the database client
const mockQuery = vi.fn();
vi.mock('../../../src/infrastructure/database/client.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
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

import { ProcessingJobRepository } from '../../../src/infrastructure/database/repositories/processing-job.repository.js';

describe('ProcessingJobRepository', () => {
  let repository: ProcessingJobRepository;

  function createMockRow(overrides?: Partial<{
    id: string;
    asset_id: string;
    job_type: ProcessingJobType;
    queue: ProcessingJobQueue;
    priority: number;
    payload: Record<string, unknown>;
    status: string;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
    worker_id: string | null;
    result: object | null;
    trace_id: string | null;
    created_at: Date;
    started_at: Date | null;
    completed_at: Date | null;
    next_retry_at: Date | null;
  }>) {
    return {
      id: 'job-123',
      asset_id: 'asset-456',
      job_type: 'generate_thumbnail' as ProcessingJobType,
      queue: 'default' as ProcessingJobQueue,
      priority: 10,
      payload: {},
      status: 'pending',
      attempts: 0,
      max_attempts: 3,
      last_error: null,
      worker_id: null,
      result: null,
      trace_id: 'trace-789',
      created_at: new Date('2024-01-01T00:00:00Z'),
      started_at: null,
      completed_at: null,
      next_retry_at: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    repository = new ProcessingJobRepository();
  });

  describe('findById', () => {
    it('returns job when found', async () => {
      const mockRow = createMockRow();
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.findById('job-123');

      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM processing_jobs WHERE id = $1',
        ['job-123']
      );
      expect(result).toEqual(expect.objectContaining({
        id: 'job-123',
        assetId: 'asset-456',
        jobType: 'generate_thumbnail',
        queue: 'default',
      }));
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByAssetId', () => {
    it('returns all jobs for an asset', async () => {
      const mockRows = [
        createMockRow({ id: 'job-1', job_type: 'generate_thumbnail' }),
        createMockRow({ id: 'job-2', job_type: 'generate_preview' }),
      ];
      mockQuery.mockResolvedValue({ rows: mockRows });

      const result = await repository.findByAssetId('asset-456');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('job-1');
      expect(result[1].id).toBe('job-2');
    });

    it('returns empty array when no jobs found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.findByAssetId('nonexistent');

      expect(result).toEqual([]);
    });
  });

  describe('create', () => {
    it('creates a job with default values', async () => {
      const mockRow = createMockRow();
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.create({
        assetId: 'asset-456',
        jobType: 'generate_thumbnail',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO processing_jobs'),
        ['asset-456', 'generate_thumbnail', 'default', 0, '{}', 'trace-123']
      );
      expect(result.id).toBe('job-123');
      expect(result.queue).toBe('default');
    });

    it('creates a job with custom values', async () => {
      const mockRow = createMockRow({
        queue: 'priority',
        priority: 50,
        payload: { customOption: true },
      });
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.create({
        assetId: 'asset-456',
        jobType: 'generate_thumbnail',
        queue: 'priority',
        priority: 50,
        payload: { customOption: true },
        traceId: 'custom-trace',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO processing_jobs'),
        ['asset-456', 'generate_thumbnail', 'priority', 50, '{"customOption":true}', 'custom-trace']
      );
      expect(result.queue).toBe('priority');
    });
  });

  describe('createMany', () => {
    it('creates multiple jobs', async () => {
      const row1 = createMockRow({ id: 'job-1' });
      const row2 = createMockRow({ id: 'job-2', job_type: 'generate_preview' });
      mockQuery
        .mockResolvedValueOnce({ rows: [row1] })
        .mockResolvedValueOnce({ rows: [row2] });

      const result = await repository.createMany([
        { assetId: 'asset-456', jobType: 'generate_thumbnail' },
        { assetId: 'asset-456', jobType: 'generate_preview' },
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('job-1');
      expect(result[1].id).toBe('job-2');
    });

    it('returns empty array for empty input', async () => {
      const result = await repository.createMany([]);

      expect(result).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('startProcessing', () => {
    it('starts processing a pending job', async () => {
      const mockRow = createMockRow({
        status: 'processing',
        started_at: new Date(),
        attempts: 1,
        worker_id: 'worker-1',
      });
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.startProcessing('job-123', 'worker-1');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'processing'"),
        ['job-123', 'worker-1']
      );
      expect(result?.status).toBe('processing');
      expect(result?.workerId).toBe('worker-1');
    });

    it('returns null when job not found or not pending', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.startProcessing('job-123', 'worker-1');

      expect(result).toBeNull();
    });
  });

  describe('complete', () => {
    it('marks job as completed with result', async () => {
      const mockRow = createMockRow({
        status: 'completed',
        completed_at: new Date(),
        started_at: new Date(),
        result: { outputKey: 'test.jpg' },
      });
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.complete('job-123', { outputKey: 'test.jpg', outputSize: 1234 });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'completed'"),
        ['job-123', expect.stringContaining('outputKey')]
      );
      expect(result?.status).toBe('completed');
    });

    it('marks job as completed without result', async () => {
      const mockRow = createMockRow({ status: 'completed' });
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      await repository.complete('job-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['job-123', null]
      );
    });
  });

  describe('fail', () => {
    it('sets status to pending and schedules retry if attempts < maxAttempts', async () => {
      const findRow = createMockRow({ attempts: 1, max_attempts: 3 });
      const updateRow = createMockRow({
        status: 'pending',
        attempts: 1,
        last_error: 'Test error',
        next_retry_at: new Date(),
      });

      mockQuery
        .mockResolvedValueOnce({ rows: [findRow] }) // findById
        .mockResolvedValueOnce({ rows: [updateRow] }); // update

      const result = await repository.fail('job-123', 'Test error');

      expect(result?.status).toBe('pending');
      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining("SET status = $2"),
        ['job-123', 'pending', 'Test error', expect.any(Date)]
      );
    });

    it('sets status to failed if attempts >= maxAttempts', async () => {
      const findRow = createMockRow({ attempts: 3, max_attempts: 3 });
      const updateRow = createMockRow({
        status: 'failed',
        attempts: 3,
        last_error: 'Final error',
      });

      mockQuery
        .mockResolvedValueOnce({ rows: [findRow] }) // findById
        .mockResolvedValueOnce({ rows: [updateRow] }); // update

      const result = await repository.fail('job-123', 'Final error');

      expect(result?.status).toBe('failed');
      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining("SET status = $2"),
        ['job-123', 'failed', 'Final error', null]
      );
    });

    it('returns null when job not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.fail('nonexistent', 'Error');

      expect(result).toBeNull();
    });
  });

  describe('cancel', () => {
    it('cancels a pending job', async () => {
      const mockRow = createMockRow({ status: 'cancelled' });
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.cancel('job-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'cancelled'"),
        ['job-123']
      );
      expect(result?.status).toBe('cancelled');
    });

    it('returns null when job not found or not cancellable', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.cancel('job-123');

      expect(result).toBeNull();
    });
  });

  describe('acquireJob', () => {
    it('atomically acquires a job from queue', async () => {
      const mockRow = createMockRow({
        status: 'processing',
        worker_id: 'worker-1',
        attempts: 1,
      });
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.acquireJob('default', 'worker-1');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FOR UPDATE SKIP LOCKED'),
        ['default', 'worker-1']
      );
      expect(result?.workerId).toBe('worker-1');
    });

    it('returns null when no jobs available', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.acquireJob('default', 'worker-1');

      expect(result).toBeNull();
    });
  });

  describe('releaseJob', () => {
    it('releases job back to pending state', async () => {
      const mockRow = createMockRow({
        status: 'pending',
        worker_id: null,
        started_at: null,
      });
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.releaseJob('job-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'pending'"),
        ['job-123']
      );
      expect(result?.status).toBe('pending');
      expect(result?.workerId).toBeNull();
    });
  });

  describe('retryJob', () => {
    it('resets a failed job to pending', async () => {
      const mockRow = createMockRow({
        status: 'pending',
        attempts: 0,
        last_error: null,
      });
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.retryJob('job-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'pending', attempts = 0"),
        ['job-123']
      );
      expect(result?.status).toBe('pending');
      expect(result?.attempts).toBe(0);
    });

    it('returns null when job not in retriable state', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.retryJob('job-123');

      expect(result).toBeNull();
    });
  });

  describe('retryAllFailed', () => {
    it('retries all failed jobs', async () => {
      mockQuery.mockResolvedValue({ rowCount: 5 });

      const result = await repository.retryAllFailed();

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'failed'"),
        []
      );
      expect(result).toBe(5);
    });

    it('applies filters when provided', async () => {
      mockQuery.mockResolvedValue({ rowCount: 3 });

      const result = await repository.retryAllFailed({
        jobType: 'generate_thumbnail',
        queue: 'default',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("job_type = $1"),
        ['generate_thumbnail', 'default']
      );
      expect(result).toBe(3);
    });
  });

  describe('listJobs', () => {
    it('lists jobs with pagination', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '100' }] })
        .mockResolvedValueOnce({
          rows: [createMockRow(), createMockRow({ id: 'job-456' })],
        });

      const result = await repository.listJobs({}, { page: 1, limit: 50 });

      expect(result.total).toBe(100);
      expect(result.jobs).toHaveLength(2);
    });

    it('applies filters correctly', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '10' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repository.listJobs(
        {
          status: 'failed',
          jobType: 'generate_thumbnail',
          queue: 'default',
        },
        { page: 1, limit: 50 }
      );

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("pj.status = $1"),
        expect.arrayContaining(['failed', 'generate_thumbnail', 'default'])
      );
    });

    it('calculates correct offset', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '100' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repository.listJobs({}, { page: 3, limit: 20 });

      // Offset should be (3-1) * 20 = 40
      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('OFFSET'),
        expect.arrayContaining([20, 40])
      );
    });
  });

  describe('deleteJob', () => {
    it('deletes a job and returns true', async () => {
      mockQuery.mockResolvedValue({ rowCount: 1 });

      const result = await repository.deleteJob('job-123');

      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM processing_jobs WHERE id = $1',
        ['job-123']
      );
      expect(result).toBe(true);
    });

    it('returns false when job not found', async () => {
      mockQuery.mockResolvedValue({ rowCount: 0 });

      const result = await repository.deleteJob('nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('getStats', () => {
    it('returns job statistics', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            { status: 'pending', count: '10' },
            { status: 'completed', count: '100' },
            { status: 'failed', count: '5' },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            { job_type: 'generate_thumbnail', count: '50' },
            { job_type: 'generate_preview', count: '50' },
          ],
        });

      const result = await repository.getStats();

      expect(result.total).toBe(115);
      expect(result.byStatus.pending).toBe(10);
      expect(result.byStatus.completed).toBe(100);
      expect(result.byStatus.failed).toBe(5);
      expect(result.byType.generate_thumbnail).toBe(50);
    });
  });

  describe('findStuckJobs', () => {
    it('finds jobs stuck in processing', async () => {
      const mockRow = createMockRow({
        status: 'processing',
        started_at: new Date('2024-01-01T00:00:00Z'),
      });
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.findStuckJobs(30);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'processing'"),
        [30]
      );
      expect(result).toHaveLength(1);
    });
  });

  describe('resetStuckJobs', () => {
    it('resets stuck jobs to pending', async () => {
      mockQuery.mockResolvedValue({ rowCount: 3 });

      const result = await repository.resetStuckJobs(30);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'pending'"),
        [30]
      );
      expect(result).toBe(3);
    });
  });

  describe('cleanupOldJobs', () => {
    it('deletes old completed/failed jobs', async () => {
      mockQuery.mockResolvedValue({ rowCount: 10 });

      const result = await repository.cleanupOldJobs(30);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM processing_jobs"),
        [30]
      );
      expect(result).toBe(10);
    });
  });

  describe('getCompletedJobTypesForAsset', () => {
    it('returns completed job types for an asset', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          { job_type: 'generate_thumbnail' },
          { job_type: 'generate_preview' },
        ],
      });

      const result = await repository.getCompletedJobTypesForAsset('asset-456');

      expect(result).toEqual(['generate_thumbnail', 'generate_preview']);
    });
  });
});
