/**
 * Unit tests for EnrichmentJobService.
 *
 * Tests: happy-path job creation, default/custom priority, optional
 * fields (providerKey, modelVersion), idempotency for pending and
 * running jobs, and the exact findFirst query used for the idempotency
 * check.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EnrichmentJobService, EnqueueInput } from './enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { EnrichmentJob, JobReason, JobStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'face_detection',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.pending,
    reason: JobReason.upload,
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 0,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

function baseInput(overrides: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    type: 'face_detection',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    reason: JobReason.upload,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnrichmentJobService', () => {
  let service: EnrichmentJobService;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrichmentJobService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<EnrichmentJobService>(EnrichmentJobService);
  });

  // -------------------------------------------------------------------------
  // Happy path — creates a new job
  // -------------------------------------------------------------------------

  describe('enqueue — happy path', () => {
    it('creates a new job when no pending or running job exists', async () => {
      // Arrange
      const newJob = makeJob();
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.enrichmentJob.create as jest.Mock).mockResolvedValue(newJob);

      // Act
      const result = await service.enqueue(baseInput());

      // Assert
      expect(result).toBe(newJob);
      expect(mockPrisma.enrichmentJob.create).toHaveBeenCalledTimes(1);
    });

    it('passes type, mediaItemId, circleId, and reason to create', async () => {
      // Arrange
      const newJob = makeJob({ type: 'ocr', mediaItemId: 'media-99', circleId: 'circle-99' });
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.enrichmentJob.create as jest.Mock).mockResolvedValue(newJob);

      // Act
      await service.enqueue(
        baseInput({ type: 'ocr', mediaItemId: 'media-99', circleId: 'circle-99', reason: JobReason.rerun }),
      );

      // Assert
      const createCall = (mockPrisma.enrichmentJob.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data).toMatchObject({
        type: 'ocr',
        mediaItemId: 'media-99',
        circleId: 'circle-99',
        reason: JobReason.rerun,
        status: JobStatus.pending,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Priority
  // -------------------------------------------------------------------------

  describe('priority', () => {
    it('defaults priority to 0 when not provided', async () => {
      // Arrange
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.enrichmentJob.create as jest.Mock).mockResolvedValue(makeJob());

      // Act
      await service.enqueue(baseInput()); // no priority field

      // Assert
      const createCall = (mockPrisma.enrichmentJob.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.priority).toBe(0);
    });

    it('uses the provided priority when explicitly set', async () => {
      // Arrange
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.enrichmentJob.create as jest.Mock).mockResolvedValue(makeJob({ priority: 10 }));

      // Act
      await service.enqueue(baseInput({ priority: 10 }));

      // Assert
      const createCall = (mockPrisma.enrichmentJob.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.priority).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // Optional fields — providerKey and modelVersion
  // -------------------------------------------------------------------------

  describe('optional fields', () => {
    it('includes providerKey and modelVersion in create when provided', async () => {
      // Arrange
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.enrichmentJob.create as jest.Mock).mockResolvedValue(
        makeJob({ providerKey: 'human', modelVersion: 'v2' }),
      );

      // Act
      await service.enqueue(baseInput({ providerKey: 'human', modelVersion: 'v2' }));

      // Assert
      const createCall = (mockPrisma.enrichmentJob.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.providerKey).toBe('human');
      expect(createCall.data.modelVersion).toBe('v2');
    });

    it('leaves providerKey and modelVersion as undefined when not provided', async () => {
      // Arrange
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.enrichmentJob.create as jest.Mock).mockResolvedValue(makeJob());

      // Act
      await service.enqueue(baseInput()); // no providerKey / modelVersion

      // Assert
      const createCall = (mockPrisma.enrichmentJob.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.providerKey).toBeUndefined();
      expect(createCall.data.modelVersion).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    it('returns existing job and does not call create when a pending job exists', async () => {
      // Arrange
      const existingJob = makeJob({ status: JobStatus.pending });
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(existingJob);

      // Act
      const result = await service.enqueue(baseInput());

      // Assert
      expect(result).toBe(existingJob);
      expect(mockPrisma.enrichmentJob.create).not.toHaveBeenCalled();
    });

    it('returns existing job and does not call create when a running job exists', async () => {
      // Arrange
      const existingJob = makeJob({ status: JobStatus.running });
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(existingJob);

      // Act
      const result = await service.enqueue(baseInput());

      // Assert
      expect(result).toBe(existingJob);
      expect(mockPrisma.enrichmentJob.create).not.toHaveBeenCalled();
    });

    it('calls findFirst with type, mediaItemId, and status in [pending, running]', async () => {
      // Arrange
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.enrichmentJob.create as jest.Mock).mockResolvedValue(makeJob());

      // Act
      await service.enqueue(baseInput({ type: 'face_detection', mediaItemId: 'media-1' }));

      // Assert
      expect(mockPrisma.enrichmentJob.findFirst).toHaveBeenCalledWith({
        where: {
          type: 'face_detection',
          mediaItemId: 'media-1',
          status: { in: [JobStatus.pending, JobStatus.running] },
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // skipDedup: true — bypass idempotency for batch global jobs
  // -------------------------------------------------------------------------

  describe('skipDedup: true', () => {
    it('does NOT call findFirst when skipDedup is true', async () => {
      (mockPrisma.enrichmentJob.create as jest.Mock).mockResolvedValue(makeJob({ id: 'new-job-1' }));

      await service.enqueue(baseInput({ mediaItemId: null, skipDedup: true }));

      expect(mockPrisma.enrichmentJob.findFirst).not.toHaveBeenCalled();
    });

    it('always calls create even when a global job of the same type already exists', async () => {
      const existingJob = makeJob({ id: 'existing-global', type: 'storage_migration', mediaItemId: null, status: JobStatus.pending });
      const newJob = makeJob({ id: 'new-job-2', type: 'storage_migration', mediaItemId: null });

      // findFirst would return the existing job, but with skipDedup it should never be called
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(existingJob);
      (mockPrisma.enrichmentJob.create as jest.Mock).mockResolvedValue(newJob);

      const result = await service.enqueue(baseInput({
        type: 'storage_migration',
        mediaItemId: null,
        reason: JobReason.backfill,
        skipDedup: true,
      }));

      expect(mockPrisma.enrichmentJob.create).toHaveBeenCalledTimes(1);
      // Returns the newly created job, not the existing one
      expect(result.id).toBe('new-job-2');
    });

    it('can enqueue multiple distinct global jobs of the same type without collapsing them', async () => {
      const job1 = makeJob({ id: 'migration-job-1', type: 'storage_migration', mediaItemId: null });
      const job2 = makeJob({ id: 'migration-job-2', type: 'storage_migration', mediaItemId: null });

      (mockPrisma.enrichmentJob.create as jest.Mock)
        .mockResolvedValueOnce(job1)
        .mockResolvedValueOnce(job2);

      const r1 = await service.enqueue(baseInput({ type: 'storage_migration', mediaItemId: null, skipDedup: true, payload: { itemId: 'item-1' } }));
      const r2 = await service.enqueue(baseInput({ type: 'storage_migration', mediaItemId: null, skipDedup: true, payload: { itemId: 'item-2' } }));

      expect(mockPrisma.enrichmentJob.create).toHaveBeenCalledTimes(2);
      expect(r1.id).toBe('migration-job-1');
      expect(r2.id).toBe('migration-job-2');
    });

    it('with skipDedup false (default), dedup check IS performed for a global job', async () => {
      // Baseline: confirm the normal path still calls findFirst
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.enrichmentJob.create as jest.Mock).mockResolvedValue(makeJob({ mediaItemId: null }));

      await service.enqueue(baseInput({ mediaItemId: null, skipDedup: false }));

      expect(mockPrisma.enrichmentJob.findFirst).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // recordModel
  // -------------------------------------------------------------------------

  describe('recordModel', () => {
    it('calls prisma.enrichmentJob.update with jobId, providerKey, and modelVersion', async () => {
      (mockPrisma.enrichmentJob.update as jest.Mock).mockResolvedValue({});

      await service.recordModel('job-1', 'compreface', 'arcface-r100-v1');

      expect(mockPrisma.enrichmentJob.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { providerKey: 'compreface', modelVersion: 'arcface-r100-v1' },
      });
    });

    it('swallows errors from prisma.enrichmentJob.update without throwing', async () => {
      (mockPrisma.enrichmentJob.update as jest.Mock).mockRejectedValue(
        new Error('DB connection lost'),
      );

      // Must resolve (not reject) even when update fails
      await expect(
        service.recordModel('job-1', 'compreface', 'arcface-r100-v1'),
      ).resolves.toBeUndefined();
    });

    it('passes null providerKey and modelVersion through to update', async () => {
      (mockPrisma.enrichmentJob.update as jest.Mock).mockResolvedValue({});

      await service.recordModel('job-1', null, null);

      expect(mockPrisma.enrichmentJob.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { providerKey: null, modelVersion: null },
      });
    });
  });
});
