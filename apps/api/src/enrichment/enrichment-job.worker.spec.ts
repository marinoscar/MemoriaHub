/**
 * Unit tests for EnrichmentJobWorker — rate-limit and scheduledFor paths.
 *
 * Extends coverage in face/processing/face-job.worker.spec.ts (which covers
 * the basic worker lifecycle). This file focuses on:
 *
 *  1. claimNextJob where clause includes the scheduledFor OR-filter
 *  2. Rate-limit deferral path (RateLimitError thrown or classified from 429):
 *     - rateLimitHits incremented, attempts NOT incremented
 *     - scheduledFor set to a future date, status stays pending
 *     - after RL_MAX_HITS hits → status becomes failed
 *  3. Normal error retry path:
 *     - attempts incremented, scheduledFor set for backoff, status pending
 *     - after MAX_ATTEMPTS exhausted → status becomes failed
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
import { ProviderThrottleService } from './provider-throttle.service';

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

async function buildWorker(
  WorkerClass: typeof EnrichmentJobWorker,
): Promise<{ worker: EnrichmentJobWorker; mockPrisma: MockPrismaService; mockHandler: { type: string; process: jest.Mock } }> {
  const mockPrisma = createMockPrismaService();
  const mockHandler = { type: 'face_detection', process: jest.fn() };
  const mockRegistry = { get: jest.fn().mockReturnValue(mockHandler) };

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
    ],
  }).compile();

  const worker = module.get<EnrichmentJobWorker>(WorkerClass);
  worker.onApplicationBootstrap();

  return { worker, mockPrisma, mockHandler };
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

    it('claim update sets scheduledFor: null and status: running', async () => {
      const job = makeJob();
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running })
        .mockResolvedValueOnce({ ...job, status: JobStatus.succeeded });

      (await buildWorker(EnrichmentJobWorker)).mockHandler.process.mockResolvedValue(undefined);

      // Re-use the same worker's handler
      const mockRegistry = { get: jest.fn().mockReturnValue({ type: 'face_detection', process: jest.fn().mockResolvedValue(undefined) }) };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EnrichmentJobWorker,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
          { provide: ProviderThrottleService, useValue: new ProviderThrottleService() },
        ],
      }).compile();
      const w2 = module.get<EnrichmentJobWorker>(EnrichmentJobWorker);
      w2.onApplicationBootstrap();

      await (w2 as any).tick();

      const firstUpdate = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls[0][0];
      expect(firstUpdate.data.scheduledFor).toBeNull();
      expect(firstUpdate.data.status).toBe(JobStatus.running);

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

    it('increments rateLimitHits, does NOT increment attempts, sets scheduledFor, status stays pending', async () => {
      const job = makeJob({ rateLimitHits: 0, attempts: 0 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new RateLimitError('rate limited', undefined, 'anthropic'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const rlUpdate = updateCalls[updateCalls.length - 1][0];

      // hits incremented to 1
      expect(rlUpdate.data.rateLimitHits).toBe(1);
      // attempts NOT changed — should not be in the data at all
      expect(rlUpdate.data.attempts).toBeUndefined();
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
      const job = makeJob({ rateLimitHits: 0, attempts: 0 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running })
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
      const job = makeJob({ rateLimitHits: 8, attempts: 0 }); // hits 8 → 9 < 10 → still pending
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running })
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
      const job = makeJob({ rateLimitHits: 9, attempts: 0 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running })
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
      // attempts is NOT changed on rate-limit path
      expect(rlUpdate.data.attempts).toBeUndefined();
    });

    it('last error message is stored from RateLimitError on giveUp', async () => {
      const job = makeJob({ rateLimitHits: 9, attempts: 0 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running })
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
      const job = makeJob({ rateLimitHits: 0, attempts: 0 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running })
        .mockResolvedValueOnce({});

      // Plain object with status=429 (not a RateLimitError instance)
      mockHandler.process.mockRejectedValue({ status: 429, message: 'Too Many Requests' });

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const rlUpdate = updateCalls[updateCalls.length - 1][0];

      expect(rlUpdate.data.rateLimitHits).toBe(1);
      expect(rlUpdate.data.status).toBe(JobStatus.pending);
      // attempts is NOT set (not the normal-retry path)
      expect(rlUpdate.data.attempts).toBeUndefined();
    });

    it('detects AWS ThrottlingException via classifyRateLimit', async () => {
      const job = makeJob({ rateLimitHits: 0, attempts: 1 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue({
        name: 'ThrottlingException',
        message: 'Rate exceeded',
      });

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const rlUpdate = updateCalls[updateCalls.length - 1][0];

      expect(rlUpdate.data.rateLimitHits).toBe(1);
      expect(rlUpdate.data.attempts).toBeUndefined(); // NOT incremented
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

    it('increments attempts and sets scheduledFor for retry when attempts < MAX_ATTEMPTS', async () => {
      const job = makeJob({ attempts: 0, rateLimitHits: 0 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new Error('transient failure'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const retryUpdate = updateCalls[updateCalls.length - 1][0];

      expect(retryUpdate.data.attempts).toBe(1); // 0+1
      expect(retryUpdate.data.status).toBe(JobStatus.pending);
      expect(retryUpdate.data.scheduledFor).toBeInstanceOf(Date);
      expect((retryUpdate.data.scheduledFor as Date).getTime()).toBeGreaterThan(Date.now());
      expect(retryUpdate.data.lastError).toBe('transient failure');
      // rateLimitHits must NOT be changed
      expect(retryUpdate.data.rateLimitHits).toBeUndefined();
      // finishedAt must NOT be set on retry
      expect(retryUpdate.data.finishedAt).toBeUndefined();
    });

    it('marks job as failed when newAttempts reaches MAX_ATTEMPTS (default 3)', async () => {
      // attempts=2 → newAttempts=3 → 3 >= 3 → giveUp
      const job = makeJob({ attempts: 2, rateLimitHits: 0 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new Error('fatal error'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const failUpdate = updateCalls[updateCalls.length - 1][0];

      expect(failUpdate.data.attempts).toBe(3);
      expect(failUpdate.data.status).toBe(JobStatus.failed);
      expect(failUpdate.data.finishedAt).toBeInstanceOf(Date);
      expect(failUpdate.data.scheduledFor).toBeNull();
    });

    it('a normal error does NOT touch rateLimitHits', async () => {
      const job = makeJob({ attempts: 0, rateLimitHits: 2 });

      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running })
        .mockResolvedValueOnce({});

      mockHandler.process.mockRejectedValue(new Error('non-rl error'));

      await (worker as any).tick();

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const retryUpdate = updateCalls[updateCalls.length - 1][0];

      // rateLimitHits is not set in the normal-retry data payload
      expect(retryUpdate.data.rateLimitHits).toBeUndefined();
      expect(retryUpdate.data.attempts).toBe(1);
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
  // retry path (attempts++, backoff, permanent-fail after MAX_ATTEMPTS).
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
        .mockResolvedValueOnce({ ...job, status: JobStatus.running })
        .mockResolvedValueOnce({});

      // Handler never resolves — only the timeout can settle the race.
      mockHandler.process.mockReturnValue(new Promise<void>(() => {}));

      jest.useFakeTimers();
      const tickPromise = (worker as any).tick();
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS + 500);
      await tickPromise;

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const timeoutUpdate = updateCalls[updateCalls.length - 1][0];

      // normal-failure path: attempts incremented, rateLimitHits untouched
      expect(timeoutUpdate.data.attempts).toBe(1);
      expect(timeoutUpdate.data.rateLimitHits).toBeUndefined();
      // still retryable (1 < MAX_ATTEMPTS default 3): pending + future scheduledFor
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

      // attempts=2 → this timeout makes newAttempts=3 = MAX_ATTEMPTS (default 3) → failed
      const job = makeJob({ type: 'metadata_extraction', attempts: 2, rateLimitHits: 0 });
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(job);
      (mockPrisma.enrichmentJob.update as jest.Mock)
        .mockResolvedValueOnce({ ...job, status: JobStatus.running })
        .mockResolvedValueOnce({});

      mockHandler.process.mockReturnValue(new Promise<void>(() => {}));

      jest.useFakeTimers();
      const tickPromise = (worker as any).tick();
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS + 500);
      await tickPromise;

      const updateCalls = (mockPrisma.enrichmentJob.update as jest.Mock).mock.calls;
      const failUpdate = updateCalls[updateCalls.length - 1][0];

      expect(failUpdate.data.attempts).toBe(3);
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
        .mockResolvedValueOnce({ ...jobA, status: JobStatus.running }) // tick 1 claim
        .mockResolvedValueOnce({}) // tick 1 timeout-failure update
        .mockResolvedValueOnce({ ...jobB, status: JobStatus.running }) // tick 2 claim
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
  // Continuous worker pool — claim serialization
  //
  // The pool replaced the old setInterval+Promise.all-batch model with N
  // long-lived loops that each claim→process→repeat. Claims are serialized by
  // an in-process promise-chain mutex (claimOne) so two loops never select+claim
  // the same pending row under Prisma's read-committed findFirst→update. The
  // pool itself is not started in tests (ENRICHMENT_WORKER_ENABLED='false'), so
  // these tests drive the seams (claimOne/tick) directly.
  // =========================================================================

  describe('continuous pool — claim serialization', () => {
    // Flush the microtask + macrotask queue so pending awaits make progress.
    const flush = () => new Promise((r) => setImmediate(r));

    it('serializes two concurrent claimOne() calls — the second claim only begins after the first resolves, and results are distinct', async () => {
      const { worker } = await buildWorker(EnrichmentJobWorker);

      const jobA = makeJob({ id: 'job-A' });
      const jobB = makeJob({ id: 'job-B' });

      // Gate the first claim so we can observe whether the second one starts
      // while the first is still in flight (it must not, thanks to the mutex).
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((r) => (releaseFirst = r));
      let secondStarted = false;

      const claimSpy = jest
        .spyOn(worker as any, 'claimNextJob')
        .mockImplementationOnce(async () => {
          await firstGate;
          return jobA;
        })
        .mockImplementationOnce(async () => {
          secondStarted = true;
          return jobB;
        });

      // Fire both claims back-to-back (synchronously), as two pool loops would.
      const p1 = (worker as any).claimOne() as Promise<EnrichmentJob | null>;
      const p2 = (worker as any).claimOne() as Promise<EnrichmentJob | null>;

      await flush();

      // Mutex holds: only the first claim has begun; the second is blocked
      // behind the lock and has NOT touched claimNextJob yet.
      expect(claimSpy).toHaveBeenCalledTimes(1);
      expect(secondStarted).toBe(false);

      // Release the first claim; now the second is free to run.
      releaseFirst();
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(claimSpy).toHaveBeenCalledTimes(2);
      expect(secondStarted).toBe(true);
      // The two loops claimed different rows — never the same job.
      expect(r1).toBe(jobA);
      expect(r2).toBe(jobB);
      expect(r1).not.toBe(r2);

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
});
