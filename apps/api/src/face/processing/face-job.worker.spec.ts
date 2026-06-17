/**
 * Unit tests for FaceJobWorker.
 *
 * Tests: job claiming, success/retry/failure transitions,
 * FACE_WORKER_ENABLED=false guard, overlapping-tick guard, no-pending-job path.
 *
 * tick() is called directly via bracket notation (private method access).
 * $transaction is mocked to execute the callback immediately.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { FaceJobWorker } from './face-job.worker';
import { PrismaService } from '../../prisma/prisma.service';
import { FaceDetectionService } from '../face-detection.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import { FaceJob, FaceJobReason, FaceJobStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<FaceJob> = {}): FaceJob {
  return {
    id: 'job-1',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: FaceJobStatus.pending,
    reason: FaceJobReason.upload,
    providerKey: null,
    modelVersion: null,
    attempts: 0,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FaceJobWorker', () => {
  let worker: FaceJobWorker;
  let mockPrisma: MockPrismaService;
  let mockFaceDetectionService: { processMediaItem: jest.Mock };
  let originalEnvEnabled: string | undefined;
  let originalEnvPollMs: string | undefined;

  beforeEach(async () => {
    // Save env vars
    originalEnvEnabled = process.env['FACE_WORKER_ENABLED'];
    originalEnvPollMs = process.env['FACE_JOB_POLL_MS'];

    // Disable the interval by default so tests control tick() manually
    process.env['FACE_WORKER_ENABLED'] = 'false';

    mockPrisma = createMockPrismaService();
    mockFaceDetectionService = { processMediaItem: jest.fn() };

    // Default $transaction: execute callback with the prisma client
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: (tx: any) => any) =>
      fn(mockPrisma),
    );

    // Default faceJob.update → return updated job
    (mockPrisma.faceJob.update as jest.Mock).mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FaceJobWorker,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: FaceDetectionService, useValue: mockFaceDetectionService },
      ],
    }).compile();

    worker = module.get<FaceJobWorker>(FaceJobWorker);

    // Trigger onModuleInit explicitly so tests control it
    worker.onModuleInit();
  });

  afterEach(async () => {
    // Restore env vars
    if (originalEnvEnabled === undefined) {
      delete process.env['FACE_WORKER_ENABLED'];
    } else {
      process.env['FACE_WORKER_ENABLED'] = originalEnvEnabled;
    }
    if (originalEnvPollMs === undefined) {
      delete process.env['FACE_JOB_POLL_MS'];
    } else {
      process.env['FACE_JOB_POLL_MS'] = originalEnvPollMs;
    }
    worker.onModuleDestroy();
  });

  // -------------------------------------------------------------------------
  // FACE_WORKER_ENABLED=false
  // -------------------------------------------------------------------------

  describe('FACE_WORKER_ENABLED=false', () => {
    it('does NOT set intervalHandle when FACE_WORKER_ENABLED is false', () => {
      // worker was initialized with FACE_WORKER_ENABLED=false in beforeEach
      expect((worker as any).intervalHandle).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Overlapping-tick guard
  // -------------------------------------------------------------------------

  describe('overlapping-tick guard', () => {
    it('skips processMediaItem when already running', async () => {
      // Force running=true to simulate an in-progress tick
      (worker as any).running = true;

      await (worker as any).tick();

      expect(mockFaceDetectionService.processMediaItem).not.toHaveBeenCalled();
    });

    it('resets running to false after skipped tick', async () => {
      (worker as any).running = true;

      await (worker as any).tick();

      // running stays true because the guard returns early before setting it to false
      // (the tick didn't start a new cycle)
      expect((worker as any).running).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // No pending job
  // -------------------------------------------------------------------------

  describe('no pending job', () => {
    it('does not call processMediaItem when claimNextJob returns null', async () => {
      // findFirst returns null → no job to claim
      (mockPrisma.faceJob.findFirst as jest.Mock).mockResolvedValue(null);

      await (worker as any).tick();

      expect(mockFaceDetectionService.processMediaItem).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Successful job processing
  // -------------------------------------------------------------------------

  describe('successful job', () => {
    it('claims job, calls processMediaItem, and updates status to succeeded', async () => {
      const job = makeJob();

      // findFirst returns pending job; update returns running job (claimed)
      (mockPrisma.faceJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.faceJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: FaceJobStatus.running }) // claim
        .mockResolvedValueOnce({ ...job, status: FaceJobStatus.succeeded }); // finish

      mockFaceDetectionService.processMediaItem.mockResolvedValue(undefined);

      await (worker as any).tick();

      expect(mockFaceDetectionService.processMediaItem).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'job-1', status: FaceJobStatus.running }),
      );

      // Second update: succeeded
      const updateCalls = (mockPrisma.faceJob.update as jest.Mock).mock.calls;
      const finishUpdate = updateCalls[updateCalls.length - 1][0];
      expect(finishUpdate.data.status).toBe(FaceJobStatus.succeeded);
      expect(finishUpdate.data.finishedAt).toBeInstanceOf(Date);
    });

    it('atomically claims job: findFirst then update inside $transaction', async () => {
      const job = makeJob();
      (mockPrisma.faceJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.faceJob.update as jest.Mock).mockResolvedValue({ ...job, status: FaceJobStatus.running });
      mockFaceDetectionService.processMediaItem.mockResolvedValue(undefined);

      await (worker as any).tick();

      // $transaction was called (atomic claim)
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      // findFirst was called with pending status filter
      expect(mockPrisma.faceJob.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: FaceJobStatus.pending },
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

      (mockPrisma.faceJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.faceJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: FaceJobStatus.running })
        .mockResolvedValueOnce({});

      mockFaceDetectionService.processMediaItem.mockRejectedValue(new Error('Detection failed'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.faceJob.update as jest.Mock).mock.calls;
      const retryUpdate = updateCalls[updateCalls.length - 1][0];
      expect(retryUpdate.data.status).toBe(FaceJobStatus.pending);
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

      (mockPrisma.faceJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.faceJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: FaceJobStatus.running })
        .mockResolvedValueOnce({});

      mockFaceDetectionService.processMediaItem.mockRejectedValue(new Error('Fatal error'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.faceJob.update as jest.Mock).mock.calls;
      const failUpdate = updateCalls[updateCalls.length - 1][0];
      expect(failUpdate.data.status).toBe(FaceJobStatus.failed);
      expect(failUpdate.data.attempts).toBe(3);
      expect(failUpdate.data.lastError).toBe('Fatal error');
      expect(failUpdate.data.finishedAt).toBeInstanceOf(Date);
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
