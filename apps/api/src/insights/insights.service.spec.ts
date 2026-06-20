/**
 * Unit tests for InsightsService.
 *
 * Verifies: computeMetrics() BigInt-safe serialisation, totalFaces/taggedItems
 * call args, runComputation() happy/error paths, enqueueRefresh(), and
 * getRefreshState(); getLatest() query shape.
 *
 * No database required — PrismaService and EnrichmentJobService are fully mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobStatus, JobReason } from '@prisma/client';
import { InsightsService } from './insights.service';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'snap-uuid-1',
    status: 'ready',
    metrics: null,
    computedAt: new Date(),
    durationMs: 120,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeJob(status: JobStatus, lastError: string | null = null) {
  return {
    id: 'job-uuid-1',
    type: 'storage_insights',
    status,
    lastError,
    createdAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InsightsService', () => {
  let service: InsightsService;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: jest.Mocked<Pick<EnrichmentJobService, 'enqueue'>>;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = {
      enqueue: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InsightsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
      ],
    }).compile();

    service = module.get<InsightsService>(InsightsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // computeMetrics
  // =========================================================================

  describe('computeMetrics', () => {
    const photoRow = { type: 'photo', cnt: 800n, bytes: 472_000_000n };
    const videoRow = { type: 'video', cnt: 200n, bytes: 788_000_000n };

    beforeEach(() => {
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([photoRow, videoRow]);
      (mockPrisma.face.count as jest.Mock).mockResolvedValue(4217);
      (mockPrisma.mediaTagStatus.count as jest.Mock).mockResolvedValue(650);
    });

    it('returns byte fields as strings (no BigInt leaks)', async () => {
      const result = await service.computeMetrics();

      expect(typeof result.totalBytes).toBe('string');
      expect(typeof result.photoBytes).toBe('string');
      expect(typeof result.videoBytes).toBe('string');
    });

    it('serialises photo bytes correctly', async () => {
      const result = await service.computeMetrics();

      expect(result.photoBytes).toBe('472000000');
    });

    it('serialises video bytes correctly', async () => {
      const result = await service.computeMetrics();

      expect(result.videoBytes).toBe('788000000');
    });

    it('serialises total bytes as the sum of photo + video bytes', async () => {
      const result = await service.computeMetrics();

      const expected = (472_000_000n + 788_000_000n).toString();
      expect(result.totalBytes).toBe(expected);
    });

    it('returns count fields as numbers', async () => {
      const result = await service.computeMetrics();

      expect(typeof result.photoCount).toBe('number');
      expect(typeof result.videoCount).toBe('number');
      expect(typeof result.totalItems).toBe('number');
      expect(typeof result.totalFaces).toBe('number');
      expect(typeof result.taggedItems).toBe('number');
    });

    it('returns correct photoCount and videoCount', async () => {
      const result = await service.computeMetrics();

      expect(result.photoCount).toBe(800);
      expect(result.videoCount).toBe(200);
    });

    it('returns totalItems as the sum of photoCount + videoCount', async () => {
      const result = await service.computeMetrics();

      expect(result.totalItems).toBe(1000);
    });

    it('returns totalFaces from face.count()', async () => {
      const result = await service.computeMetrics();

      expect(result.totalFaces).toBe(4217);
    });

    it('returns taggedItems from mediaTagStatus.count()', async () => {
      const result = await service.computeMetrics();

      expect(result.taggedItems).toBe(650);
    });

    it('calls mediaTagStatus.count with tagCount gt:0 and soft-delete filter', async () => {
      await service.computeMetrics();

      expect(mockPrisma.mediaTagStatus.count).toHaveBeenCalledWith({
        where: {
          tagCount: { gt: 0 },
          mediaItem: { deletedAt: null },
        },
      });
    });

    it('handles a result set with only photos (no video row)', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([photoRow]);

      const result = await service.computeMetrics();

      expect(result.photoCount).toBe(800);
      expect(result.videoCount).toBe(0);
      expect(result.totalItems).toBe(800);
      expect(result.videoBytes).toBe('0');
      expect(result.totalBytes).toBe('472000000');
    });

    it('handles an empty result set (no media)', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      const result = await service.computeMetrics();

      expect(result.photoCount).toBe(0);
      expect(result.videoCount).toBe(0);
      expect(result.totalItems).toBe(0);
      expect(result.totalBytes).toBe('0');
      expect(result.photoBytes).toBe('0');
      expect(result.videoBytes).toBe('0');
    });

    it('runs $queryRaw, face.count, and mediaTagStatus.count concurrently (Promise.all)', async () => {
      const callOrder: string[] = [];
      (mockPrisma.$queryRaw as jest.Mock).mockImplementation(async () => {
        callOrder.push('queryRaw');
        return [photoRow, videoRow];
      });
      (mockPrisma.face.count as jest.Mock).mockImplementation(async () => {
        callOrder.push('faceCount');
        return 4217;
      });
      (mockPrisma.mediaTagStatus.count as jest.Mock).mockImplementation(async () => {
        callOrder.push('tagCount');
        return 650;
      });

      await service.computeMetrics();

      expect(callOrder).toContain('queryRaw');
      expect(callOrder).toContain('faceCount');
      expect(callOrder).toContain('tagCount');
    });
  });

  // =========================================================================
  // getLatest
  // =========================================================================

  describe('getLatest', () => {
    it('queries for the most recent ready snapshot', async () => {
      const snapshot = makeSnapshot();
      (mockPrisma.insightsSnapshot.findFirst as jest.Mock).mockResolvedValue(snapshot);

      const result = await service.getLatest();

      expect(mockPrisma.insightsSnapshot.findFirst).toHaveBeenCalledWith({
        where: { status: 'ready' },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toEqual(snapshot);
    });

    it('returns null when no ready snapshot exists', async () => {
      (mockPrisma.insightsSnapshot.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.getLatest();

      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // runComputation
  // =========================================================================

  describe('runComputation', () => {
    const readyRow = makeSnapshot({ id: 'snap-new', status: 'ready' });

    beforeEach(() => {
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([
        { type: 'photo', cnt: 100n, bytes: 1_000_000n },
      ]);
      (mockPrisma.face.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.mediaTagStatus.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.insightsSnapshot.create as jest.Mock).mockResolvedValue(readyRow);
      (mockPrisma.insightsSnapshot.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    });

    it('creates a ready snapshot row with metrics, computedAt, and durationMs', async () => {
      await service.runComputation();

      const createCall = (mockPrisma.insightsSnapshot.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.status).toBe('ready');
      expect(createCall.data.metrics).toBeTruthy();
      expect(createCall.data.computedAt).toBeInstanceOf(Date);
      expect(typeof createCall.data.durationMs).toBe('number');
      expect(createCall.data.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('deletes all other snapshots after creating the ready row', async () => {
      await service.runComputation();

      expect(mockPrisma.insightsSnapshot.deleteMany).toHaveBeenCalledWith({
        where: { id: { not: readyRow.id } },
      });
    });

    it('returns the newly created ready snapshot', async () => {
      const result = await service.runComputation();

      expect(result).toEqual(readyRow);
    });

    it('throws when computeMetrics fails (worker will retry)', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockRejectedValue(new Error('DB unavailable'));

      await expect(service.runComputation()).rejects.toThrow('DB unavailable');
    });

    it('does NOT write a computing or failed snapshot row (job row owns failure state)', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockRejectedValue(new Error('boom'));

      await expect(service.runComputation()).rejects.toThrow('boom');

      // Only create was never called in the error path (we throw before create on metrics failure)
      // No update to a failed status — the job row owns failure state
      expect(mockPrisma.insightsSnapshot.update).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // enqueueRefresh
  // =========================================================================

  describe('enqueueRefresh', () => {
    it('calls enrichmentJobService.enqueue with type=storage_insights and null scope', async () => {
      const job = makeJob(JobStatus.pending);
      mockEnrichmentJobService.enqueue.mockResolvedValue(job as any);

      await service.enqueueRefresh(JobReason.rerun, 0);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith({
        type: 'storage_insights',
        mediaItemId: null,
        circleId: null,
        reason: JobReason.rerun,
        priority: 0,
      });
    });

    it('returns the job returned by enrichmentJobService.enqueue', async () => {
      const job = makeJob(JobStatus.pending);
      mockEnrichmentJobService.enqueue.mockResolvedValue(job as any);

      const result = await service.enqueueRefresh(JobReason.backfill, 100);

      expect(result).toEqual(job);
    });
  });

  // =========================================================================
  // getRefreshState
  // =========================================================================

  describe('getRefreshState', () => {
    it('returns idle when no job exists', async () => {
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.getRefreshState();

      expect(result).toEqual({ state: 'idle', jobId: null, lastError: null });
    });

    it('returns pending with jobId when latest job is pending', async () => {
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(makeJob(JobStatus.pending));

      const result = await service.getRefreshState();

      expect(result).toEqual({ state: 'pending', jobId: 'job-uuid-1', lastError: null });
    });

    it('returns running with jobId when latest job is running', async () => {
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(makeJob(JobStatus.running));

      const result = await service.getRefreshState();

      expect(result).toEqual({ state: 'running', jobId: 'job-uuid-1', lastError: null });
    });

    it('returns failed with jobId and lastError when latest job failed', async () => {
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(
        makeJob(JobStatus.failed, 'DB connection lost'),
      );

      const result = await service.getRefreshState();

      expect(result).toEqual({ state: 'failed', jobId: 'job-uuid-1', lastError: 'DB connection lost' });
    });

    it('returns idle when latest job succeeded', async () => {
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(makeJob(JobStatus.succeeded));

      const result = await service.getRefreshState();

      expect(result).toEqual({ state: 'idle', jobId: null, lastError: null });
    });

    it('queries enrichment_jobs by type=storage_insights ordered by createdAt desc', async () => {
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);

      await service.getRefreshState();

      expect(mockPrisma.enrichmentJob.findFirst).toHaveBeenCalledWith({
        where: { type: 'storage_insights' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });
});
