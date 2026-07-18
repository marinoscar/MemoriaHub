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
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EnrichmentJobWorker } from '../../enrichment/enrichment-job.worker';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { EnrichmentClaimService } from '../../enrichment/enrichment-claim.service';
import { EnrichmentTerminalService } from '../../enrichment/enrichment-terminal.service';
import { PrismaService } from '../../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import { EnrichmentJob, JobReason, JobStatus } from '@prisma/client';
import { ProviderThrottleService } from '../../enrichment/provider-throttle.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A mock EnrichmentClaimService whose claim() DELEGATES to the same prisma mock
 * the old in-process claimNextJob used (findFirst → update), mirroring
 * enrichment-job.worker.spec.ts. The claim UPDATE charges the attempt
 * (attempts + 1), matching the real claim SQL's claim-time charging.
 */
function makeClaimMock(mockPrisma: MockPrismaService): { claim: jest.Mock } {
  return {
    claim: jest.fn(async (): Promise<EnrichmentJob[]> => {
      const now = new Date();
      const job = await (mockPrisma.enrichmentJob.findFirst as jest.Mock)({
        where: {
          status: JobStatus.pending,
          OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
        },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });
      if (!job) return [];
      const claimed = await (mockPrisma.enrichmentJob.update as jest.Mock)({
        where: { id: job.id },
        data: {
          status: JobStatus.running,
          startedAt: new Date(),
          scheduledFor: null,
          attempts: { increment: 1 },
        },
      });
      return [claimed as EnrichmentJob];
    }),
  };
}

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
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null,
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
  let mockRegistry: { get: jest.Mock; types: jest.Mock };
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
    mockRegistry = {
      get: jest.fn().mockReturnValue(mockHandler),
      types: jest.fn().mockReturnValue(['face_detection']),
    };

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
        // ProviderThrottleService gained a dependency on this branch; provide
        // a real no-clock instance so acquire/trip/recordSuccess are genuine
        // no-ops during these tests.
        { provide: ProviderThrottleService, useValue: new ProviderThrottleService() },
        // Claiming goes through the shared, DB-atomic claim service; the mock
        // delegates to the same prisma findFirst/update mock the old claim used.
        { provide: EnrichmentClaimService, useValue: makeClaimMock(mockPrisma) },
        // Real terminal service (wraps the same mock prisma + real throttle).
        EnrichmentTerminalService,
        // EnrichmentTerminalService now emits ENRICHMENT_JOB_SETTLED_EVENT on
        // terminal success/failure — provide a minimal emit()-only mock.
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    worker = module.get<EnrichmentJobWorker>(EnrichmentJobWorker);

    // Trigger onApplicationBootstrap explicitly so tests control it
    worker.onApplicationBootstrap();
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
    it('does NOT start any pool loops when ENRICHMENT_WORKER_ENABLED is false', () => {
      // worker was initialized with ENRICHMENT_WORKER_ENABLED=false in beforeEach
      expect((worker as any).loops).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Legacy FACE_WORKER_ENABLED=false
  // -------------------------------------------------------------------------

  describe('FACE_WORKER_ENABLED=false (legacy env var)', () => {
    it('does NOT start any pool loops when FACE_WORKER_ENABLED is false', async () => {
      // Create a new worker with FACE_WORKER_ENABLED=false
      delete process.env['ENRICHMENT_WORKER_ENABLED'];
      process.env['FACE_WORKER_ENABLED'] = 'false';

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EnrichmentJobWorker,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
          { provide: ProviderThrottleService, useValue: new ProviderThrottleService() },
          { provide: EnrichmentClaimService, useValue: makeClaimMock(mockPrisma) },
          EnrichmentTerminalService,
          { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        ],
      }).compile();

      const legacyWorker = module.get<EnrichmentJobWorker>(EnrichmentJobWorker);
      legacyWorker.onApplicationBootstrap();

      expect((legacyWorker as any).loops).toEqual([]);

      legacyWorker.onModuleDestroy();
    });
  });

  // -------------------------------------------------------------------------
  // NOTE: the single global `running` reentrancy guard tested here previously
  // was removed by the continuous-worker-pool refactor — tick() is now a
  // single claim+process cycle safely callable concurrently across N pool
  // loops, with claims serialized by an in-process mutex instead (see
  // enrichment-job.worker.spec.ts's "continuous pool — claim serialization"
  // describe block for that coverage).
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

    it('claims through the shared claim service with the pending + scheduledFor OR-filter', async () => {
      const job = makeJob();
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock).mockResolvedValue({ ...job, status: JobStatus.running });
      mockHandler.process.mockResolvedValue(undefined);

      await (worker as any).tick();

      // Claiming is delegated to the shared, DB-atomic EnrichmentClaimService
      // (FOR UPDATE SKIP LOCKED in production; the delegating mock preserves
      // the observable findFirst filter shape here).
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
    it('updates status back to pending (attempts charged at claim time) when claimed attempts < 3', async () => {
      // attempts=1 pre-claim → claim charges to 2 < MAX_ATTEMPTS=3 → retry
      const job = makeJob({ attempts: 1 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new Error('Detection failed'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const retryUpdate = updateCalls[updateCalls.length - 1][0];
      expect(retryUpdate.data.status).toBe(JobStatus.pending);
      // attempts already charged at claim time — the failure write must not
      // touch it (no double-charge).
      expect(retryUpdate.data.attempts).toBeUndefined();
      expect(retryUpdate.data.lastError).toBe('Detection failed');
      // finishedAt should NOT be set on retry
      expect(retryUpdate.data.finishedAt).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Failed job — permanent failure (attempts >= MAX_ATTEMPTS)
  // -------------------------------------------------------------------------

  describe('job failure — permanent', () => {
    it('marks job as failed when the claimed attempts reach MAX_ATTEMPTS (3)', async () => {
      // attempts=2 pre-claim → claim charges to 3 → 3 < 3 is false → failed
      const job = makeJob({ attempts: 2 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new Error('Fatal error'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const failUpdate = updateCalls[updateCalls.length - 1][0];
      expect(failUpdate.data.status).toBe(JobStatus.failed);
      // attempts is not written on the failure path (claim already charged it)
      expect(failUpdate.data.attempts).toBeUndefined();
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
    it('sets shuttingDown and clears any outstanding empty-queue sleep timers', () => {
      // Simulate a loop currently parked in its empty-queue sleep.
      const timer = setTimeout(() => {}, 10000);
      (worker as any).sleepTimers.add(timer);
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

      worker.onModuleDestroy();

      expect((worker as any).shuttingDown).toBe(true);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
      expect((worker as any).sleepTimers.size).toBe(0);
      clearTimeoutSpy.mockRestore();
    });
  });
});
