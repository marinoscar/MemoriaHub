/**
 * Unit tests for EnrichmentJobWorker.
 *
 * Tests: job claiming, success/retry/failure transitions,
 * ENRICHMENT_WORKER_ENABLED=false / FACE_WORKER_ENABLED=false guard,
 * overlapping-tick guard, no-pending-job path,
 * unknown job type (no handler registered).
 *
 * tick() is called directly via bracket notation (private method access).
 * $transaction is mocked to execute the callback immediately.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EnrichmentJobWorker } from '../../enrichment/enrichment-job.worker';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnrichmentJobWorker', () => {
  let worker: EnrichmentJobWorker;
  let mockPrisma: MockPrismaService;
  let mockRegistry: { get: jest.Mock };
  let mockHandler: { type: string; process: jest.Mock };
  let originalEnvEnabled: string | undefined;
  let originalEnvFaceEnabled: string | undefined;
  let originalEnvPollMs: string | undefined;

  beforeEach(async () => {
    // Save env vars
    originalEnvEnabled = process.env['ENRICHMENT_WORKER_ENABLED'];
    originalEnvFaceEnabled = process.env['FACE_WORKER_ENABLED'];
    originalEnvPollMs = process.env['ENRICHMENT_JOB_POLL_MS'];

    // Disable the interval by default so tests control tick() manually
    process.env['ENRICHMENT_WORKER_ENABLED'] = 'false';
    delete process.env['FACE_WORKER_ENABLED'];

    mockPrisma = createMockPrismaService();
    mockHandler = { type: 'face_detection', process: jest.fn() };
    mockRegistry = { get: jest.fn().mockReturnValue(mockHandler) };

    // Default $transaction: execute callback with the prisma client
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: (tx: any) => any) =>
      fn(mockPrisma),
    );

    // Default enrichmentJob.update → return updated job
    (mockPrisma.enrichmentJob.update as jest.Mock).mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrichmentJobWorker,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
      ],
    }).compile();

    worker = module.get<EnrichmentJobWorker>(EnrichmentJobWorker);

    // Trigger onModuleInit explicitly so tests control it
    worker.onModuleInit();
  });

  afterEach(async () => {
    // Restore env vars
    if (originalEnvEnabled === undefined) {
      delete process.env['ENRICHMENT_WORKER_ENABLED'];
    } else {
      process.env['ENRICHMENT_WORKER_ENABLED'] = originalEnvEnabled;
    }
    if (originalEnvFaceEnabled === undefined) {
      delete process.env['FACE_WORKER_ENABLED'];
    } else {
      process.env['FACE_WORKER_ENABLED'] = originalEnvFaceEnabled;
    }
    if (originalEnvPollMs === undefined) {
      delete process.env['ENRICHMENT_JOB_POLL_MS'];
    } else {
      process.env['ENRICHMENT_JOB_POLL_MS'] = originalEnvPollMs;
    }
    worker.onModuleDestroy();
  });

  // -------------------------------------------------------------------------
  // ENRICHMENT_WORKER_ENABLED=false
  // -------------------------------------------------------------------------

  describe('ENRICHMENT_WORKER_ENABLED=false', () => {
    it('does NOT set intervalHandle when ENRICHMENT_WORKER_ENABLED is false', () => {
      // worker was initialized with ENRICHMENT_WORKER_ENABLED=false in beforeEach
      expect((worker as any).intervalHandle).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Legacy FACE_WORKER_ENABLED=false
  // -------------------------------------------------------------------------

  describe('FACE_WORKER_ENABLED=false (legacy env var)', () => {
    it('does NOT set intervalHandle when FACE_WORKER_ENABLED is false', async () => {
      // Create a new worker with FACE_WORKER_ENABLED=false
      delete process.env['ENRICHMENT_WORKER_ENABLED'];
      process.env['FACE_WORKER_ENABLED'] = 'false';

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EnrichmentJobWorker,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
        ],
      }).compile();

      const legacyWorker = module.get<EnrichmentJobWorker>(EnrichmentJobWorker);
      legacyWorker.onModuleInit();

      expect((legacyWorker as any).intervalHandle).toBeNull();

      legacyWorker.onModuleDestroy();
    });
  });

  // -------------------------------------------------------------------------
  // Overlapping-tick guard
  // -------------------------------------------------------------------------

  describe('overlapping-tick guard', () => {
    it('skips processJob when already running', async () => {
      // Force running=true to simulate an in-progress tick
      (worker as any).running = true;

      await (worker as any).tick();

      expect(mockHandler.process).not.toHaveBeenCalled();
    });

    it('running stays true when tick exits early due to guard', async () => {
      (worker as any).running = true;

      await (worker as any).tick();

      // guard returns early without resetting running
      expect((worker as any).running).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // No pending job
  // -------------------------------------------------------------------------

  describe('no pending job', () => {
    it('does not call handler.process when claimNextJob returns null', async () => {
      // findFirst returns null → no job to claim
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);

      await (worker as any).tick();

      expect(mockHandler.process).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Successful job processing
  // -------------------------------------------------------------------------

  describe('successful job', () => {
    it('claims job, calls handler.process, and updates status to succeeded', async () => {
      const job = makeJob();

      // findFirst returns pending job; update returns running job (claimed)
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running }) // claim
        .mockResolvedValueOnce({ ...job, status: JobStatus.succeeded }); // finish

      mockHandler.process.mockResolvedValue(undefined);

      await (worker as any).tick();

      expect(mockHandler.process).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'job-1', status: JobStatus.running }),
      );

      // Second update: succeeded
      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const finishUpdate = updateCalls[updateCalls.length - 1][0];
      expect(finishUpdate.data.status).toBe(JobStatus.succeeded);
      expect(finishUpdate.data.finishedAt).toBeInstanceOf(Date);
    });

    it('atomically claims job: findFirst then update inside $transaction', async () => {
      const job = makeJob();
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock).mockResolvedValue({ ...job, status: JobStatus.running });
      mockHandler.process.mockResolvedValue(undefined);

      await (worker as any).tick();

      // $transaction was called (atomic claim)
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      // findFirst was called with pending status + scheduledFor OR-filter
      expect(mockPrisma.enrichmentJob.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: JobStatus.pending,
            OR: expect.arrayContaining([
              { scheduledFor: null },
              { scheduledFor: { lte: expect.any(Date) } },
            ]),
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Failed job — retry (attempts < MAX_ATTEMPTS)
  // -------------------------------------------------------------------------

  describe('job failure with retry', () => {
    it('updates status back to pending with incremented attempts when attempts < 3', async () => {
      const job = makeJob({ attempts: 1 }); // newAttempts=2 < MAX_ATTEMPTS=3 → retry

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new Error('Detection failed'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const retryUpdate = updateCalls[updateCalls.length - 1][0];
      expect(retryUpdate.data.status).toBe(JobStatus.pending);
      expect(retryUpdate.data.attempts).toBe(2);
      expect(retryUpdate.data.lastError).toBe('Detection failed');
      // finishedAt should NOT be set on retry
      expect(retryUpdate.data.finishedAt).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Failed job — permanent failure (attempts >= MAX_ATTEMPTS)
  // -------------------------------------------------------------------------

  describe('job failure — permanent', () => {
    it('marks job as failed when newAttempts reaches MAX_ATTEMPTS (3)', async () => {
      // attempts=2 → newAttempts=3 → 3 >= MAX_ATTEMPTS=3 → failed
      const job = makeJob({ attempts: 2 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new Error('Fatal error'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const failUpdate = updateCalls[updateCalls.length - 1][0];
      expect(failUpdate.data.status).toBe(JobStatus.failed);
      expect(failUpdate.data.attempts).toBe(3);
      expect(failUpdate.data.lastError).toBe('Fatal error');
      expect(failUpdate.data.finishedAt).toBeInstanceOf(Date);
    });
  });

  // -------------------------------------------------------------------------
  // No handler registered for job type
  // -------------------------------------------------------------------------

  describe('no handler for job type', () => {
    it('marks job failed with clear error when no handler is registered for job.type', async () => {
      const job = makeJob({ type: 'unknown_type' });

      // Registry returns undefined for unknown type
      mockRegistry.get.mockReturnValue(undefined);

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running }) // claim
        .mockResolvedValueOnce({}); // fail update

      await (worker as any).tick();

      // Should have updated to failed with a descriptive error message
      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const failUpdate = updateCalls[updateCalls.length - 1][0];
      expect(failUpdate.data.status).toBe(JobStatus.failed);
      expect(failUpdate.data.lastError).toContain('unknown_type');
      expect(failUpdate.data.finishedAt).toBeInstanceOf(Date);

      // handler.process should never have been called
      expect(mockHandler.process).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // onModuleDestroy
  // -------------------------------------------------------------------------

  describe('onModuleDestroy', () => {
    it('clears interval on module destroy when interval was set', () => {
      // Set a real interval and ensure it gets cleared
      (worker as any).intervalHandle = setInterval(() => {}, 10000);
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      worker.onModuleDestroy();

      expect(clearIntervalSpy).toHaveBeenCalled();
      expect((worker as any).intervalHandle).toBeNull();
      clearIntervalSpy.mockRestore();
    });
  });
});
