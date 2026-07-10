/**
 * Unit tests for EnrichmentJobWorker — rate-limit and scheduledFor paths.
 *
 * Extends coverage in face/processing/face-job.worker.spec.ts (which covers
 * the basic worker lifecycle). This file focuses on:
 *
 *  1. claimNextJob where clause includes the scheduledFor OR-filter, and the
 *     claim UPDATE charges the attempt up-front (attempts: { increment: 1 })
 *     so OOM crash loops self-limit (attempts = "attempts STARTED")
 *  2. Rate-limit deferral path (RateLimitError thrown or classified from 429):
 *     - rateLimitHits incremented; the claim-time attempt charge is UN-charged
 *       (attempts written back to job.attempts - 1, the pre-claim value)
 *     - scheduledFor set to a future date, status stays pending
 *     - after RL_MAX_HITS hits → status becomes failed
 *  3. Normal error retry path:
 *     - attempts NOT written (already charged at claim time); scheduledFor set
 *       for backoff, status pending while claimed attempts < MAX_ATTEMPTS
 *     - once the claimed row's attempts reach MAX_ATTEMPTS → status failed
 *  4. Per-type execution timeout: video_face_detection / social_media_detection
 *     use ENRICHMENT_VIDEO_JOB_TIMEOUT_MS (default 20 min); all other types
 *     keep the global ENRICHMENT_JOB_TIMEOUT_MS (default 10 min)
 *
 * NOTE on claim mocks: claimNextJob() returns the row from the claim UPDATE,
 * which in production carries the claim-time increment. Claim mocks therefore
 * echo `attempts: job.attempts + 1` so the processJob failure paths see the
 * same charged value the real DB would return.
 *
 * IMPORTANT: The worker reads env vars into module-level constants at import
 * time (e.g. const RL_MAX_HITS = getEnvInt('ENRICHMENT_RATELIMIT_MAX_HITS', 10)).
 * Tests that need non-default limits use jest.isolateModules() so the worker
 * is re-imported with the desired env vars active.
 *
 * tick() and claimNextJob() are accessed via bracket notation (private).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EnrichmentHandlerRegistry } from './enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { EnrichmentJob, JobReason, JobStatus } from '@prisma/client';
import { RateLimitError } from './rate-limit.error';
// Import with a regular import; for the isolated-module tests we re-import below.
import { EnrichmentJobWorker } from './enrichment-job.worker';
import { EnrichmentClaimService } from './enrichment-claim.service';
import { ProviderThrottleService } from './provider-throttle.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A mock EnrichmentClaimService whose claim() DELEGATES to the same prisma mock
 * the old in-process claimNextJob used (findFirst → update). This keeps every
 * existing per-test `findFirst`/`update` setup — and the assertions on the
 * claim UPDATE's attempts/scheduledFor/status — driving the claim path even
 * though claiming has moved into the shared, DB-atomic claim service.
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
          // Claim-time attempt charge, mirroring the real claim SQL.
          attempts: { increment: 1 },
        },
      });
      return [claimed as EnrichmentJob];
    }),
  };
}

/** A mock handler registry exposing the get()/types() surface the worker uses. */
function makeRegistryMock(handler: unknown): { get: jest.Mock; types: jest.Mock } {
  return {
    get: jest.fn().mockReturnValue(handler),
    types: jest.fn().mockReturnValue(['face_detection', 'metadata_extraction']),
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

async function buildWorker(
  WorkerClass: typeof EnrichmentJobWorker,
): Promise<{
  worker: EnrichmentJobWorker;
  mockPrisma: MockPrismaService;
  mockHandler: { type: string; process: jest.Mock };
  mockClaim: { claim: jest.Mock };
}> {
  const mockPrisma = createMockPrismaService();
  const mockHandler = { type: 'face_detection', process: jest.fn() };
  const mockRegistry = makeRegistryMock(mockHandler);
  const mockClaim = makeClaimMock(mockPrisma);

  (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn(mockPrisma),
  );
  (mockPrisma.enrichmentJob.update as jest.Mock).mockResolvedValue({});

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      WorkerClass,
      { provide: PrismaService, useValue: mockPrisma },
      { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
      // ProviderThrottleService has no required NestJS DI deps (constructor takes
      // optional hooks); provide a real no-clock instance so throttle calls are
      // genuine no-ops during these tests.
      { provide: ProviderThrottleService, useValue: new ProviderThrottleService() },
      // Claiming now goes through the shared, DB-atomic claim service; the mock
      // delegates to the same prisma findFirst/update mock the old claim used.
      { provide: EnrichmentClaimService, useValue: mockClaim },
    ],
  }).compile();

  const worker = module.get<EnrichmentJobWorker>(WorkerClass);
  worker.onApplicationBootstrap();

  return { worker, mockPrisma, mockHandler, mockClaim };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnrichmentJobWorker — scheduledFor and rate-limit paths', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeAll(() => {
    savedEnv = {
      ENRICHMENT_WORKER_ENABLED: process.env['ENRICHMENT_WORKER_ENABLED'],
      FACE_WORKER_ENABLED: process.env['FACE_WORKER_ENABLED'],
    };
    // Disable the polling interval for all tests in this file
    process.env['ENRICHMENT_WORKER_ENABLED'] = 'false';
    delete process.env['FACE_WORKER_ENABLED'];
  });

  afterAll(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // scheduledFor OR-filter in claimNextJob
  // =========================================================================

  describe('claimNextJob — scheduledFor OR-filter', () => {
    let worker: EnrichmentJobWorker;
    let mockPrisma: MockPrismaService;

    beforeEach(async () => {
      ({ worker, mockPrisma } = await buildWorker(EnrichmentJobWorker));
    });

    afterEach(() => {
      worker.onModuleDestroy();
    });

    it('passes scheduledFor OR-filter when claiming the next job', async () => {
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);

      await (worker as any).tick();

      expect(mockPrisma.enrichmentJob.findFirst).toHaveBeenCalled();
      const findFirstArg = (mockPrisma.enrichmentJob.findFirst as jest.Mock).mock.calls[0][0];
      const where = findFirstArg.where as Record<string, unknown>;

      // Status must be pending
      expect(where.status).toBe(JobStatus.pending);

      // OR clause must include both branches
      expect(where.OR).toBeDefined();
      const orClause = where.OR as Array<Record<string, unknown>>;
      expect(orClause).toHaveLength(2);

      // First branch: scheduledFor is null (immediate jobs)
      expect(orClause[0]).toMatchObject({ scheduledFor: null });

      // Second branch: scheduledFor <= now (backoff window has expired)
      expect(orClause[1]).toHaveProperty('scheduledFor');
      const sfBranch = orClause[1]['scheduledFor'] as Record<string, unknown>;
      expect(sfBranch).toHaveProperty('lte');
      expect(sfBranch['lte']).toBeInstanceOf(Date);
    });

    it('lte date in OR-filter is approximately now (within 1 second)', async () => {
      const before = Date.now();
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);

      await (worker as any).tick();

      const after = Date.now();
      const findFirstArg = (mockPrisma.enrichmentJob.findFirst as jest.Mock).mock.calls[0][0];
      const orClause = findFirstArg.where.OR as Array<Record<string, unknown>>;
      const lteDate = (orClause[1]['scheduledFor'] as Record<string, unknown>)['lte'] as Date;

      expect(lteDate.getTime()).toBeGreaterThanOrEqual(before - 100);
      expect(lteDate.getTime()).toBeLessThanOrEqual(after + 100);
    });

    it('claim update sets scheduledFor: null, status: running, and charges the attempt', async () => {
      const job = makeJob();
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({ ...job, status: JobStatus.succeeded });

      (await buildWorker(EnrichmentJobWorker)).mockHandler.process.mockResolvedValue(undefined);

      // Re-use the same worker's handler
      const mockRegistry = makeRegistryMock({ type: 'face_detection', process: jest.fn().mockResolvedValue(undefined) });
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EnrichmentJobWorker,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
          { provide: ProviderThrottleService, useValue: new ProviderThrottleService() },
          { provide: EnrichmentClaimService, useValue: makeClaimMock(mockPrisma) },
        ],
      }).compile();
      const w2 = module.get<EnrichmentJobWorker>(EnrichmentJobWorker);
      w2.onApplicationBootstrap();

      await (w2 as any).tick();

      const firstUpdate = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls[0][0];
      expect(firstUpdate.data.scheduledFor).toBeNull();
      expect(firstUpdate.data.status).toBe(JobStatus.running);
      // Claim-time attempt charging: the claim UPDATE itself increments
      // attempts so a job that SIGKILLs the process still carries its charge.
      expect(firstUpdate.data.attempts).toEqual({ increment: 1 });
      expect(firstUpdate.data.startedAt).toBeInstanceOf(Date);

      w2.onModuleDestroy();
    });
  });

  // =========================================================================
  // Rate-limit deferral path — using defaults (RL_MAX_HITS=10)
  // =========================================================================

  describe('rate-limit deferral — RateLimitError thrown directly', () => {
    let worker: EnrichmentJobWorker;
    let mockPrisma: MockPrismaService;
    let mockHandler: { type: string; process: jest.Mock };

    beforeEach(async () => {
      ({ worker, mockPrisma, mockHandler } = await buildWorker(EnrichmentJobWorker));
    });

    afterEach(() => {
      worker.onModuleDestroy();
    });

    it('increments rateLimitHits, un-charges the claim-time attempt, sets scheduledFor, status stays pending', async () => {
      const job = makeJob({ rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null, attempts: 0 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new RateLimitError('rate limited', undefined, 'anthropic'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const rlUpdate = updateCalls[updateCalls.length - 1][0];

      // hits incremented to 1
      expect(rlUpdate.data.rateLimitHits).toBe(1);
      // attempts NOT net-charged for rate-limit deferrals: the claim-time
      // increment is un-charged with an absolute write back to the pre-claim
      // value (claimed row had attempts=1 → written back to 0).
      expect(rlUpdate.data.attempts).toBe(0);
      // status remains pending (hits=1 < max=10)
      expect(rlUpdate.data.status).toBe(JobStatus.pending);
      // scheduledFor is a future Date
      expect(rlUpdate.data.scheduledFor).toBeInstanceOf(Date);
      expect((rlUpdate.data.scheduledFor as Date).getTime()).toBeGreaterThan(Date.now());
      // rateLimitedAt is set
      expect(rlUpdate.data.rateLimitedAt).toBeInstanceOf(Date);
      // finishedAt not set on deferral
      expect(rlUpdate.data.finishedAt).toBeUndefined();
    });

    it('uses retryAfterMs from RateLimitError as floor for scheduledFor', async () => {
      const retryAfterMs = 30_000; // 30 seconds
      const job = makeJob({ rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null, attempts: 0 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new RateLimitError('rate limited', retryAfterMs));

      const beforeTick = Date.now();
      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const rlUpdate = updateCalls[updateCalls.length - 1][0];
      const scheduledFor: Date = rlUpdate.data.scheduledFor;

      // scheduledFor must be at least retryAfterMs from now
      expect(scheduledFor.getTime()).toBeGreaterThanOrEqual(beforeTick + retryAfterMs);
    });

    it('keeps status pending when rateLimitHits is below RL_MAX_HITS (default 10)', async () => {
      const job = makeJob({ rateLimitHits: 8,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null, attempts: 0 }); // hits 8 → 9 < 10 → still pending
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new RateLimitError('rate limited'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const rlUpdate = updateCalls[updateCalls.length - 1][0];

      expect(rlUpdate.data.rateLimitHits).toBe(9);
      expect(rlUpdate.data.status).toBe(JobStatus.pending);
    });
  });

  // =========================================================================
  // Rate-limit: giveUp at RL_MAX_HITS (default=10)
  // =========================================================================

  describe('rate-limit deferral — giveUp at RL_MAX_HITS (default 10)', () => {
    let worker: EnrichmentJobWorker;
    let mockPrisma: MockPrismaService;
    let mockHandler: { type: string; process: jest.Mock };

    beforeEach(async () => {
      ({ worker, mockPrisma, mockHandler } = await buildWorker(EnrichmentJobWorker));
    });

    afterEach(() => {
      worker.onModuleDestroy();
    });

    it('marks job as failed when rateLimitHits reaches RL_MAX_HITS=10', async () => {
      // hits=9 → next hit=10 → giveUp (10 >= 10)
      const job = makeJob({ rateLimitHits: 9,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null, attempts: 0 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new RateLimitError('rate limited'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const rlUpdate = updateCalls[updateCalls.length - 1][0];

      expect(rlUpdate.data.rateLimitHits).toBe(10); // 9+1
      expect(rlUpdate.data.status).toBe(JobStatus.failed);
      expect(rlUpdate.data.finishedAt).toBeInstanceOf(Date);
      // scheduledFor cleared on giveUp
      expect(rlUpdate.data.scheduledFor).toBeNull();
      // attempts NOT net-charged: claim-time increment un-charged back to the
      // pre-claim value (claimed 1 → written back to 0), even on giveUp.
      expect(rlUpdate.data.attempts).toBe(0);
    });

    it('last error message is stored from RateLimitError on giveUp', async () => {
      const job = makeJob({ rateLimitHits: 9,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null, attempts: 0 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new RateLimitError('too many requests from Anthropic'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const rlUpdate = updateCalls[updateCalls.length - 1][0];

      expect(rlUpdate.data.lastError).toBe('too many requests from Anthropic');
    });
  });

  // =========================================================================
  // Rate-limit deferral — unclassified 429 (classifyRateLimit fallback)
  // =========================================================================

  describe('rate-limit deferral — unclassified 429 (classifyRateLimit fallback)', () => {
    let worker: EnrichmentJobWorker;
    let mockPrisma: MockPrismaService;
    let mockHandler: { type: string; process: jest.Mock };

    beforeEach(async () => {
      ({ worker, mockPrisma, mockHandler } = await buildWorker(EnrichmentJobWorker));
    });

    afterEach(() => {
      worker.onModuleDestroy();
    });

    it('detects a 429-status error via classifyRateLimit and enters the RL deferral path', async () => {
      const job = makeJob({ rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null, attempts: 0 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      // Plain object with status=429 (not a RateLimitError instance)
      mockHandler.process.mockRejectedValue({ status: 429, message: 'Too Many Requests' });

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const rlUpdate = updateCalls[updateCalls.length - 1][0];

      expect(rlUpdate.data.rateLimitHits).toBe(1);
      expect(rlUpdate.data.status).toBe(JobStatus.pending);
      // attempts un-charged back to the pre-claim value (claimed 1 → 0)
      expect(rlUpdate.data.attempts).toBe(0);
    });

    it('detects AWS ThrottlingException via classifyRateLimit', async () => {
      const job = makeJob({ rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null, attempts: 1 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue({
        name: 'ThrottlingException',
        message: 'Rate exceeded',
      });

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const rlUpdate = updateCalls[updateCalls.length - 1][0];

      expect(rlUpdate.data.rateLimitHits).toBe(1);
      // un-charged back to the pre-claim value (claimed 2 → written back 1)
      expect(rlUpdate.data.attempts).toBe(1);
      expect(rlUpdate.data.status).toBe(JobStatus.pending);
    });
  });

  // =========================================================================
  // Normal error — exponential retry path
  // =========================================================================

  describe('normal error retry path', () => {
    let worker: EnrichmentJobWorker;
    let mockPrisma: MockPrismaService;
    let mockHandler: { type: string; process: jest.Mock };

    beforeEach(async () => {
      ({ worker, mockPrisma, mockHandler } = await buildWorker(EnrichmentJobWorker));
    });

    afterEach(() => {
      worker.onModuleDestroy();
    });

    it('does NOT write attempts (already charged at claim) and schedules a backoff retry while claimed attempts < MAX_ATTEMPTS', async () => {
      const job = makeJob({ attempts: 0, rateLimitHits: 0 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        // Claimed row carries the claim-time charge: attempts=1 (< MAX 3)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new Error('transient failure'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const retryUpdate = updateCalls[updateCalls.length - 1][0];

      // attempts already charged at claim time — the failure write must not
      // touch it (no double-charge).
      expect(retryUpdate.data.attempts).toBeUndefined();
      expect(retryUpdate.data.status).toBe(JobStatus.pending);
      expect(retryUpdate.data.scheduledFor).toBeInstanceOf(Date);
      expect((retryUpdate.data.scheduledFor as Date).getTime()).toBeGreaterThan(Date.now());
      expect(retryUpdate.data.lastError).toBe('transient failure');
      // rateLimitHits must NOT be changed
      expect(retryUpdate.data.rateLimitHits).toBeUndefined();
      // finishedAt must NOT be set on retry
      expect(retryUpdate.data.finishedAt).toBeUndefined();
    });

    it('retries (pending + backoff) when the claimed attempts are one below MAX_ATTEMPTS', async () => {
      // attempts=1 pre-claim → claimed row carries 2 (< MAX 3) → one retry left
      const job = makeJob({ attempts: 1, rateLimitHits: 0 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new Error('still failing'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const retryUpdate = updateCalls[updateCalls.length - 1][0];

      expect(retryUpdate.data.status).toBe(JobStatus.pending);
      expect(retryUpdate.data.attempts).toBeUndefined();
      expect(retryUpdate.data.scheduledFor).toBeInstanceOf(Date);
      expect(retryUpdate.data.finishedAt).toBeUndefined();
    });

    it('marks job as failed when the claimed attempts reach MAX_ATTEMPTS (default 3)', async () => {
      // attempts=2 pre-claim → claim charges to 3 → 3 < 3 is false → giveUp
      const job = makeJob({ attempts: 2, rateLimitHits: 0 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new Error('fatal error'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const failUpdate = updateCalls[updateCalls.length - 1][0];

      // attempts is not written on the failure path (claim already charged it)
      expect(failUpdate.data.attempts).toBeUndefined();
      expect(failUpdate.data.status).toBe(JobStatus.failed);
      expect(failUpdate.data.finishedAt).toBeInstanceOf(Date);
      expect(failUpdate.data.scheduledFor).toBeNull();
    });

    it('a normal error does NOT touch rateLimitHits', async () => {
      const job = makeJob({ attempts: 0, rateLimitHits: 2 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new Error('non-rl error'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const retryUpdate = updateCalls[updateCalls.length - 1][0];

      // rateLimitHits is not set in the normal-retry data payload
      expect(retryUpdate.data.rateLimitHits).toBeUndefined();
      // and attempts is no longer written here either (charged at claim time)
      expect(retryUpdate.data.attempts).toBeUndefined();
      expect(retryUpdate.data.status).toBe(JobStatus.pending);
    });
  });

  // =========================================================================
  // Active per-job execution timeout (ENRICHMENT_JOB_TIMEOUT_MS)
  //
  // JOB_TIMEOUT_MS is read into a module-level const at import time (default
  // 600_000). Rather than re-import the module with a smaller env value — which
  // breaks NestJS DI token identity under jest.isolateModules — these tests use
  // the default timeout and simply advance Jest fake timers past it (virtual
  // time is instantaneous regardless of magnitude), keeping the test fast and
  // deterministic. A hung handler is raced against the timeout; when the timeout
  // wins it rejects with a plain Error that flows through the normal-failure
  // retry path (attempt already charged at claim time; backoff; permanent-fail
  // once the claimed attempts reach MAX_ATTEMPTS).
  // =========================================================================

  describe('active per-job timeout (ENRICHMENT_JOB_TIMEOUT_MS)', () => {
    // Matches the module-level JOB_TIMEOUT_MS default (env var not set in tests).
    const TIMEOUT_MS = 600_000;

    afterEach(() => {
      jest.useRealTimers();
    });

    it('times out a hung handler and routes it through the normal-failure retry path', async () => {
      const { worker, mockPrisma, mockHandler } = await buildWorker(EnrichmentJobWorker);

      // 'metadata_extraction' has no provider throttle key, keeping the race
      // free of unrelated cooldown timers under fake timers.
      const job = makeJob({ type: 'metadata_extraction', attempts: 0, rateLimitHits: 0 });
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      // Handler never resolves — only the timeout can settle the race.
      mockHandler.process.mockReturnValue(new Promise<void>(() => {}));

      jest.useFakeTimers();
      const tickPromise = (worker as any).tick();
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS + 500);
      await tickPromise;

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const timeoutUpdate = updateCalls[updateCalls.length - 1][0];

      // normal-failure path: attempts already charged at claim time (not
      // rewritten here), rateLimitHits untouched
      expect(timeoutUpdate.data.attempts).toBeUndefined();
      expect(timeoutUpdate.data.rateLimitHits).toBeUndefined();
      // still retryable (claimed attempts 1 < MAX_ATTEMPTS default 3): pending + future scheduledFor
      expect(timeoutUpdate.data.status).toBe(JobStatus.pending);
      expect(timeoutUpdate.data.scheduledFor).toBeInstanceOf(Date);
      expect((timeoutUpdate.data.scheduledFor as Date).getTime()).toBeGreaterThan(Date.now());
      // timeout message stored as lastError
      expect(String(timeoutUpdate.data.lastError)).toContain('timed out');
      // not a permanent failure yet
      expect(timeoutUpdate.data.finishedAt).toBeUndefined();

      worker.onModuleDestroy();
    });

    it('permanently fails a repeatedly-hanging job once attempts reach MAX_ATTEMPTS', async () => {
      const { worker, mockPrisma, mockHandler } = await buildWorker(EnrichmentJobWorker);

      // attempts=2 pre-claim → claim charges to 3 = MAX_ATTEMPTS (default 3) → failed
      const job = makeJob({ type: 'metadata_extraction', attempts: 2, rateLimitHits: 0 });
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      mockHandler.process.mockReturnValue(new Promise<void>(() => {}));

      jest.useFakeTimers();
      const tickPromise = (worker as any).tick();
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS + 500);
      await tickPromise;

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const failUpdate = updateCalls[updateCalls.length - 1][0];

      expect(failUpdate.data.attempts).toBeUndefined();
      expect(failUpdate.data.status).toBe(JobStatus.failed);
      expect(failUpdate.data.finishedAt).toBeInstanceOf(Date);
      expect(failUpdate.data.scheduledFor).toBeNull();
      expect(String(failUpdate.data.lastError)).toContain('timed out');

      worker.onModuleDestroy();
    });

    it('frees the worker slot: a later tick claims and processes the next job after a timeout', async () => {
      const { worker, mockPrisma, mockHandler } = await buildWorker(EnrichmentJobWorker);

      const jobA = makeJob({ id: 'job-A', type: 'metadata_extraction' });
      const jobB = makeJob({ id: 'job-B', type: 'metadata_extraction' });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock)
        .mockResolvedValueOnce(jobA) // tick 1 claims A
        .mockResolvedValueOnce(jobB) // tick 2 claims B
        .mockResolvedValue(null);
      // The claim update returns the claimed job (processJob uses its id/type),
      // so each tick's claim must echo the right job back.
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...jobA, status: JobStatus.running, attempts: 1 }) // tick 1 claim
        .mockResolvedValueOnce({}) // tick 1 timeout-failure update
        .mockResolvedValueOnce({ ...jobB, status: JobStatus.running, attempts: 1 }) // tick 2 claim
        .mockResolvedValueOnce({}); // tick 2 success update

      // A hangs (times out); B resolves normally.
      mockHandler.process
        .mockReturnValueOnce(new Promise<void>(() => {}))
        .mockResolvedValueOnce(undefined);

      jest.useFakeTimers();

      // Tick 1: job A times out and its slot is released.
      const t1 = (worker as any).tick();
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS + 500);
      await t1;

      // Tick 2: job B is claimed and succeeds — proving the timed-out job did
      // not permanently block processing.
      const t2 = (worker as any).tick();
      await jest.advanceTimersByTimeAsync(0);
      await t2;

      expect(mockHandler.process).toHaveBeenCalledTimes(2);

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const lastUpdate = updateCalls[updateCalls.length - 1][0];
      expect(lastUpdate.where.id).toBe('job-B');
      expect(lastUpdate.data.status).toBe(JobStatus.succeeded);

      worker.onModuleDestroy();
    });
  });

  // =========================================================================
  // Per-type timeout override (ENRICHMENT_VIDEO_JOB_TIMEOUT_MS)
  //
  // video_face_detection and social_media_detection legitimately run far longer
  // than the global default (download + ffmpeg + per-frame provider calls), so
  // they are governed by ENRICHMENT_VIDEO_JOB_TIMEOUT_MS (default 1_200_000 ms)
  // instead of ENRICHMENT_JOB_TIMEOUT_MS (default 600_000 ms). Neither env var
  // is set in tests, so the module-level defaults apply; fake timers make the
  // magnitudes instantaneous.
  // =========================================================================

  describe('per-type timeout override for video job types', () => {
    const GLOBAL_TIMEOUT_MS = 600_000; // ENRICHMENT_JOB_TIMEOUT_MS default
    const VIDEO_TIMEOUT_MS = 1_200_000; // ENRICHMENT_VIDEO_JOB_TIMEOUT_MS default

    afterEach(() => {
      jest.useRealTimers();
    });

    it('a hung video_face_detection job survives the global timeout and only fails at the video timeout', async () => {
      const { worker, mockPrisma, mockHandler } = await buildWorker(EnrichmentJobWorker);

      const job = makeJob({ id: 'job-video', type: 'video_face_detection', attempts: 0 });
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      // Handler never resolves — only a timeout can settle the race.
      mockHandler.process.mockReturnValue(new Promise<void>(() => {}));

      jest.useFakeTimers();
      let settled = false;
      const tickPromise = ((worker as any).tick() as Promise<boolean>).then(() => {
        settled = true;
      });

      // Just past the GLOBAL timeout: a video-type job must still be running —
      // only the claim update has happened, and tick() has not settled.
      await jest.advanceTimersByTimeAsync(GLOBAL_TIMEOUT_MS + 1_000);
      expect(settled).toBe(false);
      expect((mockPrisma.enrichmentJob.update as jest.Mock).mock.calls).toHaveLength(1);

      // Past the VIDEO timeout: the job now fails through the normal-failure path.
      await jest.advanceTimersByTimeAsync(VIDEO_TIMEOUT_MS - GLOBAL_TIMEOUT_MS);
      await tickPromise;
      expect(settled).toBe(true);

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const timeoutUpdate = updateCalls[updateCalls.length - 1][0];
      expect(String(timeoutUpdate.data.lastError)).toContain(`timed out after ${VIDEO_TIMEOUT_MS}ms`);
      // Claimed attempts 1 < MAX 3 → retryable
      expect(timeoutUpdate.data.status).toBe(JobStatus.pending);
      expect(timeoutUpdate.data.scheduledFor).toBeInstanceOf(Date);

      worker.onModuleDestroy();
    });

    it('social_media_detection is also governed by the video timeout', async () => {
      const { worker, mockPrisma, mockHandler } = await buildWorker(EnrichmentJobWorker);

      const job = makeJob({ id: 'job-social', type: 'social_media_detection', attempts: 0 });
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      mockHandler.process.mockReturnValue(new Promise<void>(() => {}));

      jest.useFakeTimers();
      let settled = false;
      const tickPromise = ((worker as any).tick() as Promise<boolean>).then(() => {
        settled = true;
      });

      await jest.advanceTimersByTimeAsync(GLOBAL_TIMEOUT_MS + 1_000);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(VIDEO_TIMEOUT_MS - GLOBAL_TIMEOUT_MS);
      await tickPromise;

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const timeoutUpdate = updateCalls[updateCalls.length - 1][0];
      expect(String(timeoutUpdate.data.lastError)).toContain(`timed out after ${VIDEO_TIMEOUT_MS}ms`);

      worker.onModuleDestroy();
    });

    it('a non-video type still times out at the global ENRICHMENT_JOB_TIMEOUT_MS', async () => {
      const { worker, mockPrisma, mockHandler } = await buildWorker(EnrichmentJobWorker);

      const job = makeJob({ type: 'metadata_extraction', attempts: 0 });
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running, attempts: job.attempts + 1 })
        .mockResolvedValueOnce({});

      mockHandler.process.mockReturnValue(new Promise<void>(() => {}));

      jest.useFakeTimers();
      const tickPromise = (worker as any).tick();
      await jest.advanceTimersByTimeAsync(GLOBAL_TIMEOUT_MS + 500);
      await tickPromise;

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const timeoutUpdate = updateCalls[updateCalls.length - 1][0];
      expect(String(timeoutUpdate.data.lastError)).toContain(`timed out after ${GLOBAL_TIMEOUT_MS}ms`);

      worker.onModuleDestroy();
    });
  });

  // =========================================================================
  // Continuous worker pool — DB-atomic claiming
  //
  // The in-process promise-chain claim mutex has been REMOVED. Claiming now goes
  // through the shared EnrichmentClaimService (UPDATE ... FOR UPDATE SKIP
  // LOCKED), which is multi-process safe: serialization lives in Postgres, so a
  // server worker and a remote CLI node never claim the same row. These tests
  // assert the worker delegates claiming to that service and that a slow slot
  // does not block an independent tick.
  // =========================================================================

  describe('continuous pool — DB-atomic claiming', () => {
    // Flush the microtask + macrotask queue so pending awaits make progress.
    const flush = () => new Promise((r) => setImmediate(r));

    it('delegates claiming to the shared claim service with the server-plane args, taking the first returned job', async () => {
      const { worker, mockClaim } = await buildWorker(EnrichmentJobWorker);

      const jobA = makeJob({ id: 'job-A', type: 'metadata_extraction', status: JobStatus.running });
      // Override the delegating default: return a single claimed job.
      mockClaim.claim.mockResolvedValueOnce([jobA]);

      const claimed = await (worker as any).claimNextJob();

      expect(mockClaim.claim).toHaveBeenCalledTimes(1);
      const args = mockClaim.claim.mock.calls[0][0];
      // Server in-process worker: unowned claim, executor='server', one at a time.
      expect(args.nodeId).toBeNull();
      expect(args.executor).toBe('server');
      expect(args.limit).toBe(1);
      expect(Array.isArray(args.eligibleTypes)).toBe(true);
      expect(typeof args.leaseMs).toBe('number');
      expect(args.leaseMs).toBeGreaterThan(0);
      // Takes the first row from the returned batch.
      expect(claimed).toBe(jobA);

      worker.onModuleDestroy();
    });

    it('returns null when the claim service claims nothing (empty queue)', async () => {
      const { worker, mockClaim } = await buildWorker(EnrichmentJobWorker);

      mockClaim.claim.mockResolvedValueOnce([]);

      const claimed = await (worker as any).claimNextJob();
      expect(claimed).toBeNull();

      worker.onModuleDestroy();
    });

    it('a slow processJob in one tick does not block a second, independent tick from claiming and processing another job', async () => {
      const { worker, mockPrisma, mockHandler } = await buildWorker(EnrichmentJobWorker);

      const jobA = makeJob({ id: 'job-A', type: 'metadata_extraction' });
      const jobB = makeJob({ id: 'job-B', type: 'metadata_extraction' });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock)
        .mockResolvedValueOnce(jobA) // tick 1 claims A
        .mockResolvedValueOnce(jobB) // tick 2 claims B
        .mockResolvedValue(null);
      // Claim updates echo the running job back (processJob reads its id/type);
      // terminal updates return {}. Keyed off data.status so ordering is robust.
      (mockPrisma.enrichmentJob.update as jest.Mock).mockImplementation(
        async ({ where, data }: any) => {
          if (data?.status === JobStatus.running) {
            return { ...makeJob({ id: where.id, type: 'metadata_extraction' }), status: JobStatus.running };
          }
          return {};
        },
      );

      // A's processing blocks indefinitely (until released); B's resolves.
      let releaseA!: () => void;
      const aGate = new Promise<void>((r) => (releaseA = r));
      mockHandler.process
        .mockImplementationOnce(() => aGate)
        .mockResolvedValueOnce(undefined);

      // Tick 1: claims A, then awaits processJob(A) — which hangs.
      const t1 = (worker as any).tick() as Promise<boolean>;
      let t1Done = false;
      void t1.then(() => {
        t1Done = true;
      });
      await flush();

      // tick() awaits processJob before returning — it has NOT resolved yet.
      expect(t1Done).toBe(false);

      // Tick 2: independently claims B and processes it to completion while A
      // is still hung — proving the slow slot does not block the queue.
      const t2Result = await (worker as any).tick();
      expect(t2Result).toBe(true);
      expect(mockHandler.process).toHaveBeenCalledTimes(2);

      // Now let A finish; tick 1 resolves true.
      releaseA();
      expect(await t1).toBe(true);

      worker.onModuleDestroy();
    });
  });

  // =========================================================================
  // safeTerminalUpdate — retry-once on transient DB write failure
  //
  // Exercises the private safeTerminalUpdate(jobId, jobType, data) helper
  // directly (bypassing tick/processJob) so the retry/give-up behavior is
  // isolated from claim/handler mechanics. The method's real implementation
  // sleeps 1s between the first failure and the retry; that sleep is stubbed
  // to resolve immediately so the test stays fast and deterministic.
  // =========================================================================

  describe('safeTerminalUpdate — retry once on transient failure', () => {
    let worker: EnrichmentJobWorker;
    let mockPrisma: MockPrismaService;

    beforeEach(async () => {
      ({ worker, mockPrisma } = await buildWorker(EnrichmentJobWorker));
    });

    afterEach(() => {
      worker.onModuleDestroy();
    });

    it('retries once after the first update() throws, and succeeds on the retry', async () => {
      const sleepSpy = jest.spyOn(worker as any, 'sleep').mockResolvedValue(undefined);
      const loggerWarnSpy = jest.spyOn((worker as any).logger, 'warn').mockImplementation(() => {});
      const loggerErrorSpy = jest.spyOn((worker as any).logger, 'error').mockImplementation(() => {});

      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockRejectedValueOnce(new Error('transient DB error'))
        .mockResolvedValueOnce({});

      const data = { status: JobStatus.succeeded, finishedAt: new Date() };
      await (worker as any).safeTerminalUpdate('job-retry-1', 'face_detection', data);

      // Both attempts used the same where/data payload.
      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      expect(updateCalls).toHaveLength(2);
      expect(updateCalls[0][0]).toEqual({ where: { id: 'job-retry-1' }, data });
      expect(updateCalls[1][0]).toEqual({ where: { id: 'job-retry-1' }, data });

      // Slept once (~1s) between the two attempts.
      expect(sleepSpy).toHaveBeenCalledTimes(1);
      expect(sleepSpy).toHaveBeenCalledWith(1_000);

      // A warning was logged for the first failure; no error since the retry succeeded.
      expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
      expect(loggerWarnSpy.mock.calls[0][0]).toContain('job-retry-1');
      expect(loggerErrorSpy).not.toHaveBeenCalled();
    });

    it('logs an error and swallows the failure (does not throw) when both attempts fail', async () => {
      const sleepSpy = jest.spyOn(worker as any, 'sleep').mockResolvedValue(undefined);
      const loggerWarnSpy = jest.spyOn((worker as any).logger, 'warn').mockImplementation(() => {});
      const loggerErrorSpy = jest.spyOn((worker as any).logger, 'error').mockImplementation(() => {});

      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockRejectedValueOnce(new Error('db down'))
        .mockRejectedValueOnce(new Error('still down'));

      const data = { status: JobStatus.failed, finishedAt: new Date(), lastError: 'boom' };

      // Must not throw — the caller (processJob) relies on this being swallowed
      // so the worker slot is freed even when the DB write itself fails.
      await expect(
        (worker as any).safeTerminalUpdate('job-retry-2', 'ocr', data),
      ).resolves.toBeUndefined();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      expect(updateCalls).toHaveLength(2);

      expect(sleepSpy).toHaveBeenCalledTimes(1);
      expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
      expect(loggerErrorSpy.mock.calls[0][0]).toContain('job-retry-2');
      expect(loggerErrorSpy.mock.calls[0][0]).toContain('stuck-reset cron');
    });

    it('does not retry when the first update() succeeds', async () => {
      const sleepSpy = jest.spyOn(worker as any, 'sleep').mockResolvedValue(undefined);

      (mockPrisma.enrichmentJob.update as jest.Mock).mockResolvedValueOnce({});

      await (worker as any).safeTerminalUpdate('job-ok', 'face_detection', {
        status: JobStatus.succeeded,
      });

      expect(mockPrisma.enrichmentJob.update).toHaveBeenCalledTimes(1);
      expect(sleepSpy).not.toHaveBeenCalled();
    });

    it('processJob success path routes through safeTerminalUpdate and recovers from one transient failure', async () => {
      // Stub the retry-delay sleep so the test resolves immediately regardless
      // of the requested duration.
      jest.spyOn(worker as any, 'sleep').mockResolvedValue(undefined);

      const job = makeJob({ id: 'job-e2e-1', attempts: 0 });
      const mockRegistry = makeRegistryMock({ type: 'face_detection', process: jest.fn().mockResolvedValue(undefined) });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EnrichmentJobWorker,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
          { provide: ProviderThrottleService, useValue: new ProviderThrottleService() },
          { provide: EnrichmentClaimService, useValue: makeClaimMock(mockPrisma) },
        ],
      }).compile();
      const w2 = module.get<EnrichmentJobWorker>(EnrichmentJobWorker);
      w2.onApplicationBootstrap();

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValueOnce(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running }) // claim
        .mockRejectedValueOnce(new Error('flaky write')) // first terminal write attempt
        .mockResolvedValueOnce({}); // retried terminal write succeeds

      await (w2 as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      // claim + first (failed) terminal write + retried terminal write
      expect(updateCalls).toHaveLength(3);
      expect(updateCalls[2][0].data.status).toBe(JobStatus.succeeded);

      w2.onModuleDestroy();
    });
  });
});
