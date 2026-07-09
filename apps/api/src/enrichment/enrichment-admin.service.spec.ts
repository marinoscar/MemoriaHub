/**
 * Unit tests for EnrichmentAdminService.
 *
 * Tests: getStats (empty and populated groupBy results, stuck count threshold),
 * listJobs (pagination, filters, empty results), retryJob (404, 400, success),
 * retryAllFailed (with/without type filter), resetStuck (time threshold, count),
 * deleteJob (404, 400 running, success).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { JobStatus } from '@prisma/client';
import { EnrichmentAdminService } from './enrichment-admin.service';
import { PrismaService } from '../prisma/prisma.service';

// NOTE: the exported STUCK_RUNNING_MINUTES constant was removed — the service
// now resolves its threshold from the jobs.stuckThresholdMinutes system
// setting. Kept locally only so existing threshold-window assertions compile;
// these tests need updating for the settings-driven threshold.
const STUCK_RUNNING_MINUTES = 10;
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-uuid-1',
    type: 'face_detection',
    status: JobStatus.pending,
    reason: 'upload',
    priority: 0,
    mediaItemId: 'media-uuid-1',
    circleId: 'circle-uuid-1',
    attempts: 0,
    lastError: null,
    providerKey: null,
    modelVersion: null,
    payload: null,
    createdAt: new Date('2024-01-01T10:00:00Z'),
    startedAt: null,
    finishedAt: null,
    // New rate-limit fields
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnrichmentAdminService', () => {
  let service: EnrichmentAdminService;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrichmentAdminService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<EnrichmentAdminService>(EnrichmentAdminService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // getStats
  // =========================================================================

  describe('getStats', () => {
    it('returns all-zero stats when groupBy results are empty', async () => {
      (mockPrisma.enrichmentJob.groupBy as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      const stats = await service.getStats();

      expect(stats).toEqual({
        total: 0,
        byStatus: { pending: 0, running: 0, succeeded: 0, failed: 0 },
        byType: [],
        stuckRunning: 0,
        scheduled: 0,
      });
    });

    it('aggregates byStatus counts correctly from groupBy results', async () => {
      const statusGroups = [
        { status: JobStatus.pending, _count: { id: 5 } },
        { status: JobStatus.running, _count: { id: 2 } },
        { status: JobStatus.succeeded, _count: { id: 10 } },
        { status: JobStatus.failed, _count: { id: 3 } },
      ];
      const typeStatusGroups = [
        { type: 'face_detection', status: JobStatus.succeeded, _count: { id: 10 } },
        { type: 'face_detection', status: JobStatus.pending, _count: { id: 5 } },
      ];

      (mockPrisma.enrichmentJob.groupBy as jest.Mock)
        .mockResolvedValueOnce(statusGroups)
        .mockResolvedValueOnce(typeStatusGroups);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(1);

      const stats = await service.getStats();

      expect(stats.total).toBe(20); // 5+2+10+3
      expect(stats.byStatus).toEqual({ pending: 5, running: 2, succeeded: 10, failed: 3 });
    });

    it('builds byType array sorted alphabetically with per-status counts', async () => {
      const statusGroups = [
        { status: JobStatus.failed, _count: { id: 4 } },
        { status: JobStatus.succeeded, _count: { id: 6 } },
      ];
      const typeStatusGroups = [
        { type: 'ocr', status: JobStatus.failed, _count: { id: 4 } },
        { type: 'face_detection', status: JobStatus.succeeded, _count: { id: 6 } },
      ];

      (mockPrisma.enrichmentJob.groupBy as jest.Mock)
        .mockResolvedValueOnce(statusGroups)
        .mockResolvedValueOnce(typeStatusGroups);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      const stats = await service.getStats();

      // Sorted alphabetically: face_detection before ocr
      expect(stats.byType).toHaveLength(2);
      expect(stats.byType[0].type).toBe('face_detection');
      expect(stats.byType[0].succeeded).toBe(6);
      expect(stats.byType[0].total).toBe(6);
      expect(stats.byType[1].type).toBe('ocr');
      expect(stats.byType[1].failed).toBe(4);
      expect(stats.byType[1].total).toBe(4);
    });

    it('accumulates multiple statuses per type into the same byType entry', async () => {
      const statusGroups = [
        { status: JobStatus.pending, _count: { id: 3 } },
        { status: JobStatus.running, _count: { id: 1 } },
        { status: JobStatus.failed, _count: { id: 2 } },
      ];
      const typeStatusGroups = [
        { type: 'face_detection', status: JobStatus.pending, _count: { id: 3 } },
        { type: 'face_detection', status: JobStatus.running, _count: { id: 1 } },
        { type: 'face_detection', status: JobStatus.failed, _count: { id: 2 } },
      ];

      (mockPrisma.enrichmentJob.groupBy as jest.Mock)
        .mockResolvedValueOnce(statusGroups)
        .mockResolvedValueOnce(typeStatusGroups);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      const stats = await service.getStats();

      expect(stats.byType).toHaveLength(1);
      expect(stats.byType[0]).toMatchObject({
        type: 'face_detection',
        pending: 3,
        running: 1,
        failed: 2,
        succeeded: 0,
        total: 6,
      });
    });

    it('returns stuckRunning count from the count query', async () => {
      (mockPrisma.enrichmentJob.groupBy as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(7);

      const stats = await service.getStats();

      expect(stats.stuckRunning).toBe(7);
    });

    it('passes a time threshold to the stuckRunning count using STUCK_RUNNING_MINUTES', async () => {
      const beforeCall = Date.now();

      (mockPrisma.enrichmentJob.groupBy as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      await service.getStats();

      const afterCall = Date.now();
      const expectedLowerBound = beforeCall - STUCK_RUNNING_MINUTES * 60 * 1000;
      const expectedUpperBound = afterCall - STUCK_RUNNING_MINUTES * 60 * 1000;

      const countCall = (mockPrisma.enrichmentJob.count as jest.Mock).mock.calls[0][0];
      expect(countCall.where.status).toBe(JobStatus.running);

      const threshold: Date = countCall.where.startedAt.lt;
      expect(threshold).toBeInstanceOf(Date);
      expect(threshold.getTime()).toBeGreaterThanOrEqual(expectedLowerBound);
      expect(threshold.getTime()).toBeLessThanOrEqual(expectedUpperBound);
    });

    it('issues both groupBy calls and two count calls via Promise.all', async () => {
      (mockPrisma.enrichmentJob.groupBy as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      await service.getStats();

      expect(mockPrisma.enrichmentJob.groupBy).toHaveBeenCalledTimes(2);
      // Two count calls: stuckRunning + scheduledCount
      expect(mockPrisma.enrichmentJob.count).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // listJobs
  // =========================================================================

  describe('listJobs', () => {
    it('returns paginated items and correct meta for page 1', async () => {
      const jobs = [makeJobRow(), makeJobRow({ id: 'job-uuid-2' })];
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue(jobs);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(2);

      const result = await service.listJobs({ page: 1, pageSize: 20 });

      expect(result.items).toEqual(jobs);
      expect(result.meta).toEqual({ page: 1, pageSize: 20, totalItems: 2, totalPages: 1 });
    });

    it('computes totalPages correctly when items span multiple pages', async () => {
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(45);

      const result = await service.listJobs({ page: 2, pageSize: 20 });

      expect(result.meta.totalPages).toBe(3); // ceil(45/20)
      expect(result.meta.page).toBe(2);
    });

    it('returns empty items array and totalPages=0 when no jobs exist', async () => {
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      const result = await service.listJobs({ page: 1, pageSize: 20 });

      expect(result.items).toEqual([]);
      expect(result.meta.totalItems).toBe(0);
      expect(result.meta.totalPages).toBe(0);
    });

    it('passes status filter to findMany and count where clause', async () => {
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      await service.listJobs({ status: JobStatus.failed, page: 1, pageSize: 20 });

      const findManyCall = (mockPrisma.enrichmentJob.findMany as jest.Mock).mock.calls[0][0];
      const countCall = (mockPrisma.enrichmentJob.count as jest.Mock).mock.calls[0][0];

      expect(findManyCall.where).toMatchObject({ status: JobStatus.failed });
      expect(countCall.where).toMatchObject({ status: JobStatus.failed });
    });

    it('passes type filter to findMany and count where clause', async () => {
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      await service.listJobs({ type: 'ocr', page: 1, pageSize: 20 });

      const findManyCall = (mockPrisma.enrichmentJob.findMany as jest.Mock).mock.calls[0][0];
      const countCall = (mockPrisma.enrichmentJob.count as jest.Mock).mock.calls[0][0];

      expect(findManyCall.where).toMatchObject({ type: 'ocr' });
      expect(countCall.where).toMatchObject({ type: 'ocr' });
    });

    it('combines status and type filters together', async () => {
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      await service.listJobs({ status: JobStatus.running, type: 'face_detection', page: 1, pageSize: 10 });

      const findManyCall = (mockPrisma.enrichmentJob.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({ status: JobStatus.running, type: 'face_detection' });
    });

    it('omits status and type from where when not provided', async () => {
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      await service.listJobs({ page: 1, pageSize: 20 });

      const findManyCall = (mockPrisma.enrichmentJob.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where).not.toHaveProperty('status');
      expect(findManyCall.where).not.toHaveProperty('type');
    });

    it('orders results by createdAt descending (newest first)', async () => {
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      await service.listJobs({ page: 1, pageSize: 20 });

      const findManyCall = (mockPrisma.enrichmentJob.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('computes correct skip offset from page and pageSize', async () => {
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      await service.listJobs({ page: 3, pageSize: 10 });

      const findManyCall = (mockPrisma.enrichmentJob.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.skip).toBe(20); // (3-1)*10
      expect(findManyCall.take).toBe(10);
    });
  });

  // =========================================================================
  // retryJob
  // =========================================================================

  describe('retryJob', () => {
    it('throws NotFoundException when job does not exist', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.retryJob('nonexistent-id')).rejects.toThrow(NotFoundException);
    });

    it('NotFoundException message includes the job id', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.retryJob('missing-job-id')).rejects.toThrow('missing-job-id');
    });

    it('throws BadRequestException when job status is running', async () => {
      const runningJob = makeJobRow({ status: JobStatus.running });
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(runningJob);

      await expect(service.retryJob('job-uuid-1')).rejects.toThrow(BadRequestException);
    });

    it('resets job to pending with zeroed attempts and cleared error/timestamps on success', async () => {
      const failedJob = makeJobRow({
        status: JobStatus.failed,
        attempts: 3,
        lastError: 'timeout',
        startedAt: new Date(),
        finishedAt: new Date(),
      });
      const updatedJob = makeJobRow({ status: JobStatus.pending, attempts: 0, lastError: null });
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(failedJob);
      (mockPrisma.enrichmentJob.update as jest.Mock).mockResolvedValue(updatedJob);

      const result = await service.retryJob('job-uuid-1');

      const updateCall = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 'job-uuid-1' });
      expect(updateCall.data).toMatchObject({
        status: JobStatus.pending,
        attempts: 0,
        lastError: null,
        startedAt: null,
        finishedAt: null,
      });
      expect(result).toEqual(updatedJob);
    });

    it('succeeds for a succeeded job (not just failed)', async () => {
      const succeededJob = makeJobRow({ status: JobStatus.succeeded });
      const updatedJob = makeJobRow({ status: JobStatus.pending });
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(succeededJob);
      (mockPrisma.enrichmentJob.update as jest.Mock).mockResolvedValue(updatedJob);

      const result = await service.retryJob('job-uuid-1');

      expect(result.status).toBe(JobStatus.pending);
    });
  });

  // =========================================================================
  // retryAllFailed
  // =========================================================================

  describe('retryAllFailed', () => {
    it('resets all failed jobs to pending and returns retried count', async () => {
      (mockPrisma.enrichmentJob.updateMany as jest.Mock).mockResolvedValue({ count: 8 });

      const result = await service.retryAllFailed();

      expect(result).toEqual({ retried: 8 });
    });

    it('filters only by status=failed when no type provided', async () => {
      (mockPrisma.enrichmentJob.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await service.retryAllFailed();

      const updateManyCall = (mockPrisma.enrichmentJob.updateMany as jest.Mock).mock.calls[0][0];
      expect(updateManyCall.where).toEqual({ status: JobStatus.failed });
      expect(updateManyCall.where).not.toHaveProperty('type');
    });

    it('adds type to the where clause when type is provided', async () => {
      (mockPrisma.enrichmentJob.updateMany as jest.Mock).mockResolvedValue({ count: 3 });

      await service.retryAllFailed('ocr');

      const updateManyCall = (mockPrisma.enrichmentJob.updateMany as jest.Mock).mock.calls[0][0];
      expect(updateManyCall.where).toEqual({ status: JobStatus.failed, type: 'ocr' });
    });

    it('resets attempts, lastError, startedAt, finishedAt to zero/null in data', async () => {
      (mockPrisma.enrichmentJob.updateMany as jest.Mock).mockResolvedValue({ count: 5 });

      await service.retryAllFailed();

      const updateManyCall = (mockPrisma.enrichmentJob.updateMany as jest.Mock).mock.calls[0][0];
      expect(updateManyCall.data).toMatchObject({
        status: JobStatus.pending,
        attempts: 0,
        lastError: null,
        startedAt: null,
        finishedAt: null,
      });
    });

    it('returns retried:0 when no failed jobs match', async () => {
      (mockPrisma.enrichmentJob.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      const result = await service.retryAllFailed();

      expect(result).toEqual({ retried: 0 });
    });
  });

  // =========================================================================
  // resetStuck
  // =========================================================================

  describe('resetStuck', () => {
    it('resets running jobs older than the default threshold and returns count', async () => {
      (mockPrisma.enrichmentJob.updateMany as jest.Mock).mockResolvedValue({ count: 4 });

      const result = await service.resetStuck();

      expect(result).toEqual({ reset: 4 });
    });

    it('filters by status=running with startedAt lt the computed threshold', async () => {
      const beforeCall = Date.now();
      (mockPrisma.enrichmentJob.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await service.resetStuck(STUCK_RUNNING_MINUTES);

      const afterCall = Date.now();
      const updateManyCall = (mockPrisma.enrichmentJob.updateMany as jest.Mock).mock.calls[0][0];

      expect(updateManyCall.where.status).toBe(JobStatus.running);
      const threshold: Date = updateManyCall.where.startedAt.lt;
      expect(threshold).toBeInstanceOf(Date);

      const expectedLower = beforeCall - STUCK_RUNNING_MINUTES * 60 * 1000;
      const expectedUpper = afterCall - STUCK_RUNNING_MINUTES * 60 * 1000;
      expect(threshold.getTime()).toBeGreaterThanOrEqual(expectedLower);
      expect(threshold.getTime()).toBeLessThanOrEqual(expectedUpper);
    });

    it('uses olderThanMinutes parameter to compute custom threshold', async () => {
      const beforeCall = Date.now();
      (mockPrisma.enrichmentJob.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await service.resetStuck(30);

      const afterCall = Date.now();
      const updateManyCall = (mockPrisma.enrichmentJob.updateMany as jest.Mock).mock.calls[0][0];
      const threshold: Date = updateManyCall.where.startedAt.lt;

      const expectedLower = beforeCall - 30 * 60 * 1000;
      const expectedUpper = afterCall - 30 * 60 * 1000;
      expect(threshold.getTime()).toBeGreaterThanOrEqual(expectedLower);
      expect(threshold.getTime()).toBeLessThanOrEqual(expectedUpper);
    });

    it('resets stuck jobs to pending and clears startedAt in data', async () => {
      (mockPrisma.enrichmentJob.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.resetStuck();

      const updateManyCall = (mockPrisma.enrichmentJob.updateMany as jest.Mock).mock.calls[0][0];
      expect(updateManyCall.data).toMatchObject({
        status: JobStatus.pending,
        startedAt: null,
      });
    });

    it('returns reset:0 when no stuck jobs found', async () => {
      (mockPrisma.enrichmentJob.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      const result = await service.resetStuck();

      expect(result).toEqual({ reset: 0 });
    });
  });

  // =========================================================================
  // deleteJob
  // =========================================================================

  describe('deleteJob', () => {
    it('throws NotFoundException when job does not exist', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.deleteJob('nonexistent-id')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when job is currently running', async () => {
      const runningJob = makeJobRow({ status: JobStatus.running });
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(runningJob);

      await expect(service.deleteJob('job-uuid-1')).rejects.toThrow(BadRequestException);
    });

    it('deletes the job and returns {deleted: true} for a non-running job', async () => {
      const failedJob = makeJobRow({ status: JobStatus.failed });
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(failedJob);
      (mockPrisma.enrichmentJob.delete as jest.Mock).mockResolvedValue(failedJob);

      const result = await service.deleteJob('job-uuid-1');

      expect(mockPrisma.enrichmentJob.delete).toHaveBeenCalledWith({ where: { id: 'job-uuid-1' } });
      expect(result).toEqual({ deleted: true });
    });

    it('deletes a pending job successfully', async () => {
      const pendingJob = makeJobRow({ status: JobStatus.pending });
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(pendingJob);
      (mockPrisma.enrichmentJob.delete as jest.Mock).mockResolvedValue(pendingJob);

      const result = await service.deleteJob('job-uuid-1');

      expect(result).toEqual({ deleted: true });
    });

    it('deletes a succeeded job successfully', async () => {
      const succeededJob = makeJobRow({ status: JobStatus.succeeded });
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(succeededJob);
      (mockPrisma.enrichmentJob.delete as jest.Mock).mockResolvedValue(succeededJob);

      const result = await service.deleteJob('job-uuid-1');

      expect(result).toEqual({ deleted: true });
    });

    it('looks up job by the provided id', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.deleteJob('target-id')).rejects.toThrow(NotFoundException);

      expect(mockPrisma.enrichmentJob.findUnique).toHaveBeenCalledWith({ where: { id: 'target-id' } });
    });
  });

  // =========================================================================
  // retryJob — rate-limit field reset (new fields: scheduledFor, rateLimitHits)
  // =========================================================================

  describe('retryJob — resets scheduledFor and rateLimitHits', () => {
    it('sets scheduledFor: null in the update payload', async () => {
      const failedJob = makeJobRow({
        status: JobStatus.failed,
        scheduledFor: new Date(Date.now() + 60_000),
        rateLimitHits: 3,
      });
      const updatedJob = makeJobRow({ status: JobStatus.pending, scheduledFor: null, rateLimitHits: 0 });
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(failedJob);
      (mockPrisma.enrichmentJob.update as jest.Mock).mockResolvedValue(updatedJob);

      await service.retryJob('job-uuid-1');

      const updateCall = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.scheduledFor).toBeNull();
    });

    it('sets rateLimitHits: 0 in the update payload', async () => {
      const failedJob = makeJobRow({
        status: JobStatus.failed,
        rateLimitHits: 7,
      });
      const updatedJob = makeJobRow({ status: JobStatus.pending, rateLimitHits: 0 });
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(failedJob);
      (mockPrisma.enrichmentJob.update as jest.Mock).mockResolvedValue(updatedJob);

      await service.retryJob('job-uuid-1');

      const updateCall = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.rateLimitHits).toBe(0);
    });

    it('resets all retry-related fields together in a single update call', async () => {
      const failedJob = makeJobRow({
        status: JobStatus.failed,
        attempts: 3,
        lastError: 'RL max hits reached',
        scheduledFor: new Date(Date.now() + 120_000),
        rateLimitHits: 10,
        startedAt: new Date(),
        finishedAt: new Date(),
      });
      const updatedJob = makeJobRow({ status: JobStatus.pending });
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(failedJob);
      (mockPrisma.enrichmentJob.update as jest.Mock).mockResolvedValue(updatedJob);

      await service.retryJob('job-uuid-1');

      const updateCall = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data).toMatchObject({
        status: JobStatus.pending,
        attempts: 0,
        lastError: null,
        startedAt: null,
        finishedAt: null,
        scheduledFor: null,
        rateLimitHits: 0,
      });
    });
  });

  // =========================================================================
  // retryAllFailed — rate-limit field reset
  // =========================================================================

  describe('retryAllFailed — resets scheduledFor and rateLimitHits', () => {
    it('sets scheduledFor: null in the updateMany data payload', async () => {
      (mockPrisma.enrichmentJob.updateMany as jest.Mock).mockResolvedValue({ count: 4 });

      await service.retryAllFailed();

      const updateManyCall = (mockPrisma.enrichmentJob.updateMany as jest.Mock).mock.calls[0][0];
      expect(updateManyCall.data.scheduledFor).toBeNull();
    });

    it('sets rateLimitHits: 0 in the updateMany data payload', async () => {
      (mockPrisma.enrichmentJob.updateMany as jest.Mock).mockResolvedValue({ count: 4 });

      await service.retryAllFailed();

      const updateManyCall = (mockPrisma.enrichmentJob.updateMany as jest.Mock).mock.calls[0][0];
      expect(updateManyCall.data.rateLimitHits).toBe(0);
    });

    it('bulk retry payload contains all expected reset fields', async () => {
      (mockPrisma.enrichmentJob.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.retryAllFailed('face_detection');

      const updateManyCall = (mockPrisma.enrichmentJob.updateMany as jest.Mock).mock.calls[0][0];
      expect(updateManyCall.data).toMatchObject({
        status: JobStatus.pending,
        attempts: 0,
        lastError: null,
        startedAt: null,
        finishedAt: null,
        scheduledFor: null,
        rateLimitHits: 0,
      });
    });
  });

  // =========================================================================
  // resetStuck — scheduledFor cleared
  // =========================================================================

  describe('resetStuck — sets scheduledFor: null', () => {
    it('includes scheduledFor: null in the resetStuck data payload', async () => {
      (mockPrisma.enrichmentJob.updateMany as jest.Mock).mockResolvedValue({ count: 3 });

      await service.resetStuck();

      const updateManyCall = (mockPrisma.enrichmentJob.updateMany as jest.Mock).mock.calls[0][0];
      expect(updateManyCall.data.scheduledFor).toBeNull();
    });

    it('resetStuck data contains status:pending, startedAt:null, scheduledFor:null', async () => {
      (mockPrisma.enrichmentJob.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.resetStuck(15);

      const updateManyCall = (mockPrisma.enrichmentJob.updateMany as jest.Mock).mock.calls[0][0];
      expect(updateManyCall.data).toMatchObject({
        status: JobStatus.pending,
        startedAt: null,
        scheduledFor: null,
      });
    });
  });

  // =========================================================================
  // getStats — scheduled count
  // =========================================================================

  describe('getStats — scheduled count', () => {
    it('returns a scheduled property in the stats result', async () => {
      (mockPrisma.enrichmentJob.groupBy as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock)
        .mockResolvedValueOnce(0)  // stuckRunning
        .mockResolvedValueOnce(5); // scheduledCount

      const stats = await service.getStats();

      expect(stats).toHaveProperty('scheduled');
      expect(stats.scheduled).toBe(5);
    });

    it('scheduled count is 0 when no deferred-pending jobs exist', async () => {
      (mockPrisma.enrichmentJob.groupBy as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock)
        .mockResolvedValueOnce(0)  // stuckRunning
        .mockResolvedValueOnce(0); // scheduledCount

      const stats = await service.getStats();

      expect(stats.scheduled).toBe(0);
    });

    it('scheduledCount query filters status=pending and scheduledFor > now', async () => {
      (mockPrisma.enrichmentJob.groupBy as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      const before = Date.now();
      await service.getStats();
      const after = Date.now();

      // getStats issues two count calls (stuckRunning + scheduledCount)
      const countCalls = (mockPrisma.enrichmentJob.count as jest.Mock).mock.calls;
      expect(countCalls).toHaveLength(2);

      // Find the scheduled count call — it must filter status=pending and scheduledFor > now
      const scheduledCountCall = countCalls.find(
        (c) => c[0].where?.status === JobStatus.pending,
      );
      expect(scheduledCountCall).toBeDefined();

      const where = scheduledCountCall![0].where;
      expect(where.status).toBe(JobStatus.pending);
      expect(where.scheduledFor).toBeDefined();
      const gtDate: Date = where.scheduledFor.gt;
      expect(gtDate).toBeInstanceOf(Date);
      // The gt date should be approximately now (within a 2-second window)
      expect(gtDate.getTime()).toBeGreaterThanOrEqual(before - 100);
      expect(gtDate.getTime()).toBeLessThanOrEqual(after + 100);
    });

    it('issues two groupBy calls and two count calls in total', async () => {
      (mockPrisma.enrichmentJob.groupBy as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      await service.getStats();

      expect(mockPrisma.enrichmentJob.groupBy).toHaveBeenCalledTimes(2);
      expect(mockPrisma.enrichmentJob.count).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // listJobs — scheduled filter
  // =========================================================================

  describe('listJobs — scheduled: true filter', () => {
    it('forces status=pending and scheduledFor > now when scheduled=true', async () => {
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      const before = Date.now();
      await service.listJobs({ scheduled: true, page: 1, pageSize: 20 });
      const after = Date.now();

      const findManyCall = (mockPrisma.enrichmentJob.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where.status).toBe(JobStatus.pending);
      expect(findManyCall.where.scheduledFor).toBeDefined();

      const gtDate: Date = findManyCall.where.scheduledFor.gt;
      expect(gtDate).toBeInstanceOf(Date);
      expect(gtDate.getTime()).toBeGreaterThanOrEqual(before - 100);
      expect(gtDate.getTime()).toBeLessThanOrEqual(after + 100);
    });

    it('same scheduled=true where clause is applied to the count query', async () => {
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(3);

      await service.listJobs({ scheduled: true, page: 1, pageSize: 20 });

      const countCall = (mockPrisma.enrichmentJob.count as jest.Mock).mock.calls[0][0];
      expect(countCall.where.status).toBe(JobStatus.pending);
      expect(countCall.where.scheduledFor).toHaveProperty('gt');
    });

    it('includes optional type filter alongside scheduled=true', async () => {
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      await service.listJobs({ scheduled: true, type: 'face_detection', page: 1, pageSize: 10 });

      const findManyCall = (mockPrisma.enrichmentJob.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where.status).toBe(JobStatus.pending);
      expect(findManyCall.where.type).toBe('face_detection');
      expect(findManyCall.where.scheduledFor).toHaveProperty('gt');
    });

    it('scheduled=false does not add scheduledFor filter', async () => {
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      await service.listJobs({ scheduled: false, page: 1, pageSize: 20 });

      const findManyCall = (mockPrisma.enrichmentJob.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where).not.toHaveProperty('scheduledFor');
    });

    it('omitting scheduled does not add scheduledFor filter', async () => {
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

      await service.listJobs({ page: 1, pageSize: 20 });

      const findManyCall = (mockPrisma.enrichmentJob.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where).not.toHaveProperty('scheduledFor');
    });
  });

  // =========================================================================
  // listJobs — processedWithin filter
  // =========================================================================

  describe('listJobs — processedWithin filter', () => {
    const TOLERANCE_MS = 60_000; // 60-second tolerance for cutoff assertions

    function getWhere() {
      return (mockPrisma.enrichmentJob.findMany as jest.Mock).mock.calls[0][0].where;
    }

    beforeEach(() => {
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);
    });

    it('omitting processedWithin produces no OR key in where clause', async () => {
      await service.listJobs({ page: 1, pageSize: 20 });

      expect(getWhere()).not.toHaveProperty('OR');
    });

    it('processedWithin: "all" produces no OR key in where clause', async () => {
      await service.listJobs({ processedWithin: 'all', page: 1, pageSize: 20 });

      expect(getWhere()).not.toHaveProperty('OR');
    });

    it('processedWithin: "24h" adds a two-clause OR with cutoff ~= now - 24h', async () => {
      const before = Date.now();
      await service.listJobs({ processedWithin: '24h', page: 1, pageSize: 20 });
      const after = Date.now();

      const where = getWhere();
      expect(where).toHaveProperty('OR');
      expect(where.OR).toHaveLength(2);

      // First clause: finishedAt >= cutoff
      expect(where.OR[0]).toEqual({ finishedAt: { gte: expect.any(Date) } });
      // Second clause: finishedAt null, createdAt >= cutoff
      expect(where.OR[1]).toEqual({ finishedAt: null, createdAt: { gte: expect.any(Date) } });

      // Both clauses should use the same cutoff date (within tolerance)
      const cutoff1: Date = where.OR[0].finishedAt.gte;
      const cutoff2: Date = where.OR[1].createdAt.gte;
      expect(cutoff1.getTime()).toBe(cutoff2.getTime());

      // Cutoff should be approximately now - 24h
      const expectedMs = 24 * 3_600_000;
      const expectedLower = before - expectedMs - TOLERANCE_MS;
      const expectedUpper = after - expectedMs + TOLERANCE_MS;
      expect(cutoff1.getTime()).toBeGreaterThanOrEqual(expectedLower);
      expect(cutoff1.getTime()).toBeLessThanOrEqual(expectedUpper);
    });

    it('processedWithin: "7d" adds a two-clause OR with cutoff ~= now - 7d', async () => {
      const before = Date.now();
      await service.listJobs({ processedWithin: '7d', page: 1, pageSize: 20 });
      const after = Date.now();

      const where = getWhere();
      expect(where).toHaveProperty('OR');
      expect(where.OR).toHaveLength(2);

      const cutoff: Date = where.OR[0].finishedAt.gte;
      expect(cutoff).toBeInstanceOf(Date);

      const expectedMs = 7 * 86_400_000;
      const expectedLower = before - expectedMs - TOLERANCE_MS;
      const expectedUpper = after - expectedMs + TOLERANCE_MS;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedLower);
      expect(cutoff.getTime()).toBeLessThanOrEqual(expectedUpper);
    });

    it('processedWithin: "4h" combined with status: "failed" includes both filters', async () => {
      const before = Date.now();
      await service.listJobs({ processedWithin: '4h', status: JobStatus.failed, page: 1, pageSize: 20 });
      const after = Date.now();

      const where = getWhere();

      // Status filter must be present
      expect(where.status).toBe(JobStatus.failed);

      // OR time clause must also be present
      expect(where).toHaveProperty('OR');
      expect(where.OR).toHaveLength(2);

      const cutoff: Date = where.OR[0].finishedAt.gte;
      expect(cutoff).toBeInstanceOf(Date);

      const expectedMs = 4 * 3_600_000;
      const expectedLower = before - expectedMs - TOLERANCE_MS;
      const expectedUpper = after - expectedMs + TOLERANCE_MS;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedLower);
      expect(cutoff.getTime()).toBeLessThanOrEqual(expectedUpper);
    });

    it('scheduled: true combined with processedWithin: "7d" includes status=pending, scheduledFor>now, and OR clause', async () => {
      const before = Date.now();
      await service.listJobs({ scheduled: true, processedWithin: '7d', page: 1, pageSize: 20 });
      const after = Date.now();

      const where = getWhere();

      // scheduled=true forces status=pending
      expect(where.status).toBe(JobStatus.pending);

      // scheduled=true forces scheduledFor > now
      expect(where).toHaveProperty('scheduledFor');
      const gtDate: Date = where.scheduledFor.gt;
      expect(gtDate).toBeInstanceOf(Date);
      expect(gtDate.getTime()).toBeGreaterThanOrEqual(before - 100);
      expect(gtDate.getTime()).toBeLessThanOrEqual(after + 100);

      // processedWithin: '7d' adds the OR time clause
      expect(where).toHaveProperty('OR');
      expect(where.OR).toHaveLength(2);

      const cutoff: Date = where.OR[0].finishedAt.gte;
      expect(cutoff).toBeInstanceOf(Date);

      const expectedMs = 7 * 86_400_000;
      const expectedLower = before - expectedMs - TOLERANCE_MS;
      const expectedUpper = after - expectedMs + TOLERANCE_MS;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedLower);
      expect(cutoff.getTime()).toBeLessThanOrEqual(expectedUpper);
    });

    it('same OR clause is applied to both findMany and count queries', async () => {
      await service.listJobs({ processedWithin: '24h', page: 1, pageSize: 20 });

      const findManyWhere = (mockPrisma.enrichmentJob.findMany as jest.Mock).mock.calls[0][0].where;
      const countWhere = (mockPrisma.enrichmentJob.count as jest.Mock).mock.calls[0][0].where;

      expect(findManyWhere.OR).toBeDefined();
      expect(countWhere.OR).toBeDefined();
      // Both cutoffs should be identical (same where object reference is shared)
      expect(findManyWhere.OR[0].finishedAt.gte.getTime())
        .toBe(countWhere.OR[0].finishedAt.gte.getTime());
    });
  });
});
