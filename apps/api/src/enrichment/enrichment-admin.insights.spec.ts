/**
 * Unit tests for EnrichmentAdminService.getInsights — ETA math and basis logic.
 *
 * Focuses on the pure computation logic in getInsights():
 *   - Concurrency read from ENRICHMENT_WORKER_CONCURRENCY env (default 1, min 1)
 *   - basis='none': overall history.samples === 0 → etaMs null, perType avgMs/etcMs null
 *   - basis='live': all types have type-specific history AND totalRemaining > 0
 *   - basis='partial': some types fall back to overall average → 'partial'
 *   - totalRemaining === 0 → etaMs 0, basis 'live'
 *   - ETA formula: etaMs = sum(pending+running) * effectiveAvg / concurrency
 *
 * Notes: API tests not run (Prisma engine download blocked in this env).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobStatus } from '@prisma/client';
import { EnrichmentAdminService, INSIGHTS_WINDOW_DAYS } from './enrichment-admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a status-groupBy result for getStats() */
function makeStatusGroups(counts: Partial<Record<JobStatus, number>> = {}) {
  return Object.entries(counts).map(([status, count]) => ({
    status: status as JobStatus,
    _count: { id: count as number },
  }));
}

/** Build a type+status groupBy result for getStats() */
function makeTypeStatusGroups(
  entries: Array<{ type: string; status: JobStatus; count: number }>,
) {
  return entries.map(({ type, status, count }) => ({
    type,
    status,
    _count: { id: count },
  }));
}

/** Build a $queryRaw per-type duration result */
function makeDurByType(
  entries: Array<{
    type: string;
    samples: number;
    avg_sec: number;
    p50_sec?: number;
    p95_sec?: number;
  }>,
) {
  return entries.map(({ type, samples, avg_sec, p50_sec = 0, p95_sec = 0 }) => ({
    type,
    samples,
    avg_sec,
    p50_sec,
    p95_sec,
  }));
}

/** Build a $queryRaw overall duration result (single row or empty) */
function makeDurOverall(
  samples: number,
  avg_sec: number,
  p50_sec = 0,
  p95_sec = 0,
): Array<{ samples: number; avg_sec: number; p50_sec: number; p95_sec: number }> {
  if (samples === 0) return [{ samples: 0, avg_sec: 0, p50_sec: 0, p95_sec: 0 }];
  return [{ samples, avg_sec, p50_sec, p95_sec }];
}

// ---------------------------------------------------------------------------
// Setup helpers for the "typical" groupBy mock chain
// ---------------------------------------------------------------------------

/**
 * Configure mockPrisma.enrichmentJob.groupBy to return different values
 * depending on call order: groupBy is called 3× in getInsights via getStats
 * (statusGroups, typeStatusGroups, throughputByType) plus 1 more at the end
 * for throughputByType.
 *
 * getStats internally calls groupBy twice: ['status'] and ['type','status'].
 * Then getInsights calls groupBy again for throughputByType.
 *
 * Call order:
 *   1st groupBy → statusGroups (by ['status'])
 *   2nd groupBy → typeStatusGroups (by ['type','status'])
 *   3rd groupBy → throughputByType (by ['type'], status=succeeded, last hour)
 */
function setupGroupByMocks(
  mockPrisma: MockPrismaService,
  opts: {
    statusGroups?: ReturnType<typeof makeStatusGroups>;
    typeStatusGroups?: ReturnType<typeof makeTypeStatusGroups>;
    throughputByType?: Array<{ type: string; _count: { id: number } }>;
  } = {},
) {
  const gb = mockPrisma.enrichmentJob.groupBy as jest.Mock;
  gb.mockResolvedValueOnce(opts.statusGroups ?? []);
  gb.mockResolvedValueOnce(opts.typeStatusGroups ?? []);
  gb.mockResolvedValueOnce(opts.throughputByType ?? []);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('EnrichmentAdminService.getInsights', () => {
  let service: EnrichmentAdminService;
  let mockPrisma: MockPrismaService;

  // Save / restore env vars
  const SAVED_CONCURRENCY = process.env['ENRICHMENT_WORKER_CONCURRENCY'];
  const SAVED_FACE_CONCURRENCY = process.env['FACE_WORKER_CONCURRENCY'];

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrichmentAdminService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<EnrichmentAdminService>(EnrichmentAdminService);

    // Default count mocks (stuckRunning=0, scheduledCount=0, rateLimited=0, retried=0)
    (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);

    // Default $queryRaw: no history. Three $queryRaw calls happen per getInsights
    // in order: durByType, durOverall, lifeDurByType (all-time live durations).
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

    // Lifetime rollup of purged rows — default empty so lifetime = live only.
    (mockPrisma.jobStatsRollup.findMany as jest.Mock).mockResolvedValue([]);
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Restore env vars
    if (SAVED_CONCURRENCY === undefined) {
      delete process.env['ENRICHMENT_WORKER_CONCURRENCY'];
    } else {
      process.env['ENRICHMENT_WORKER_CONCURRENCY'] = SAVED_CONCURRENCY;
    }
    if (SAVED_FACE_CONCURRENCY === undefined) {
      delete process.env['FACE_WORKER_CONCURRENCY'];
    } else {
      process.env['FACE_WORKER_CONCURRENCY'] = SAVED_FACE_CONCURRENCY;
    }
  });

  // =========================================================================
  // Concurrency
  // =========================================================================

  describe('concurrency', () => {
    beforeEach(() => {
      setupGroupByMocks(mockPrisma);
    });

    it('defaults to concurrency=1 when env is not set', async () => {
      delete process.env['ENRICHMENT_WORKER_CONCURRENCY'];
      delete process.env['FACE_WORKER_CONCURRENCY'];

      const result = await service.getInsights();

      expect(result.concurrency).toBe(1);
    });

    it('reads ENRICHMENT_WORKER_CONCURRENCY from env', async () => {
      process.env['ENRICHMENT_WORKER_CONCURRENCY'] = '4';

      setupGroupByMocks(mockPrisma);
      const result = await service.getInsights();

      expect(result.concurrency).toBe(4);
    });

    it('falls back to FACE_WORKER_CONCURRENCY when ENRICHMENT is not set', async () => {
      delete process.env['ENRICHMENT_WORKER_CONCURRENCY'];
      process.env['FACE_WORKER_CONCURRENCY'] = '2';

      setupGroupByMocks(mockPrisma);
      const result = await service.getInsights();

      expect(result.concurrency).toBe(2);
    });

    it('clamps concurrency to minimum 1 when env is 0', async () => {
      process.env['ENRICHMENT_WORKER_CONCURRENCY'] = '0';

      setupGroupByMocks(mockPrisma);
      const result = await service.getInsights();

      expect(result.concurrency).toBe(1);
    });

    it('clamps concurrency to minimum 1 when env is not a number', async () => {
      process.env['ENRICHMENT_WORKER_CONCURRENCY'] = 'not-a-number';

      setupGroupByMocks(mockPrisma);
      const result = await service.getInsights();

      expect(result.concurrency).toBe(1);
    });
  });

  // =========================================================================
  // (a) No history — basis='none'
  // =========================================================================

  describe('no history (basis=none)', () => {
    it('returns basis=none when overall history has samples=0', async () => {
      // Some pending jobs exist but no completed history
      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({ [JobStatus.pending]: 5 }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.pending, count: 5 },
        ]),
      });
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([]) // durByType → empty
        .mockResolvedValueOnce(makeDurOverall(0, 0)); // durOverall → samples=0

      const result = await service.getInsights();

      expect(result.eta.basis).toBe('none');
    });

    it('returns etaMs=null when basis=none', async () => {
      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({ [JobStatus.pending]: 3 }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'auto_tagging', status: JobStatus.pending, count: 3 },
        ]),
      });
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(makeDurOverall(0, 0));

      const result = await service.getInsights();

      expect(result.eta.etaMs).toBeNull();
    });

    it('returns perType avgMs=null and etcMs=null for all types when basis=none', async () => {
      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({ [JobStatus.pending]: 2, [JobStatus.running]: 1 }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.pending, count: 2 },
          { type: 'auto_tagging', status: JobStatus.running, count: 1 },
        ]),
      });
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(makeDurOverall(0, 0));

      const result = await service.getInsights();

      for (const pt of result.eta.perType) {
        expect(pt.avgMs).toBeNull();
        expect(pt.etcMs).toBeNull();
      }
    });

    it('still counts totalRemaining correctly even with no history', async () => {
      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({ [JobStatus.pending]: 4, [JobStatus.running]: 1 }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.pending, count: 4 },
          { type: 'face_detection', status: JobStatus.running, count: 1 },
        ]),
      });
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(makeDurOverall(0, 0));

      const result = await service.getInsights();

      expect(result.eta.totalRemaining).toBe(5);
    });
  });

  // =========================================================================
  // (b) Full history — basis='live'
  // =========================================================================

  describe('full history — all types have type-specific history (basis=live)', () => {
    it('returns basis=live when all remaining types have their own history', async () => {
      delete process.env['ENRICHMENT_WORKER_CONCURRENCY'];

      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({ [JobStatus.pending]: 10 }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.pending, count: 10 },
        ]),
      });
      // Per-type history exists for face_detection (avg 2s = 2000ms)
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(makeDurByType([{ type: 'face_detection', samples: 50, avg_sec: 2 }]))
        .mockResolvedValueOnce(makeDurOverall(50, 2));

      const result = await service.getInsights();

      expect(result.eta.basis).toBe('live');
    });

    it('computes etaMs = totalRemaining * avgMs / concurrency', async () => {
      delete process.env['ENRICHMENT_WORKER_CONCURRENCY'];

      // 10 pending, concurrency=1, avgMs=2000ms → etaMs = 10*2000/1 = 20000
      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({ [JobStatus.pending]: 10 }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.pending, count: 10 },
        ]),
      });
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(makeDurByType([{ type: 'face_detection', samples: 50, avg_sec: 2 }]))
        .mockResolvedValueOnce(makeDurOverall(50, 2));

      const result = await service.getInsights();

      expect(result.eta.etaMs).toBe(20000);
    });

    it('divides work by concurrency when concurrency > 1', async () => {
      process.env['ENRICHMENT_WORKER_CONCURRENCY'] = '2';

      // 10 pending, concurrency=2, avgMs=2000ms → etaMs = 10*2000/2 = 10000
      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({ [JobStatus.pending]: 10 }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.pending, count: 10 },
        ]),
      });
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(makeDurByType([{ type: 'face_detection', samples: 50, avg_sec: 2 }]))
        .mockResolvedValueOnce(makeDurOverall(50, 2));

      const result = await service.getInsights();

      expect(result.eta.etaMs).toBe(10000);
    });

    it('populates perType.avgMs from type-specific history', async () => {
      delete process.env['ENRICHMENT_WORKER_CONCURRENCY'];

      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({ [JobStatus.pending]: 6 }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.pending, count: 3 },
          { type: 'auto_tagging', status: JobStatus.pending, count: 3 },
        ]),
      });
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(
          makeDurByType([
            { type: 'auto_tagging', samples: 20, avg_sec: 1 },   // 1000ms
            { type: 'face_detection', samples: 30, avg_sec: 3 }, // 3000ms
          ]),
        )
        .mockResolvedValueOnce(makeDurOverall(50, 2));

      const result = await service.getInsights();

      const fdEntry = result.eta.perType.find((p) => p.type === 'face_detection');
      const atEntry = result.eta.perType.find((p) => p.type === 'auto_tagging');
      expect(fdEntry?.avgMs).toBe(3000);
      expect(atEntry?.avgMs).toBe(1000);
    });

    it('computes perType.etcMs = remaining * avgMs / concurrency', async () => {
      delete process.env['ENRICHMENT_WORKER_CONCURRENCY'];

      // face_detection: 4 pending, avg 3s = 3000ms → etcMs = 4*3000/1 = 12000
      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({ [JobStatus.pending]: 4 }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.pending, count: 4 },
        ]),
      });
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(makeDurByType([{ type: 'face_detection', samples: 10, avg_sec: 3 }]))
        .mockResolvedValueOnce(makeDurOverall(10, 3));

      const result = await service.getInsights();

      const fd = result.eta.perType.find((p) => p.type === 'face_detection');
      expect(fd?.etcMs).toBe(12000);
    });

    it('sets etcMs=0 for types with remaining=0', async () => {
      delete process.env['ENRICHMENT_WORKER_CONCURRENCY'];

      // face_detection has succeeded only, no pending/running
      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({ [JobStatus.succeeded]: 20 }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.succeeded, count: 20 },
        ]),
      });
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(makeDurByType([{ type: 'face_detection', samples: 20, avg_sec: 2 }]))
        .mockResolvedValueOnce(makeDurOverall(20, 2));

      const result = await service.getInsights();

      const fd = result.eta.perType.find((p) => p.type === 'face_detection');
      expect(fd?.etcMs).toBe(0);
    });
  });

  // =========================================================================
  // (c) Partial history — basis='partial'
  // =========================================================================

  describe('partial history (basis=partial)', () => {
    it('returns basis=partial when some types lack type-specific history', async () => {
      delete process.env['ENRICHMENT_WORKER_CONCURRENCY'];

      // Two types pending: face_detection has history, auto_tagging does not
      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({ [JobStatus.pending]: 6 }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.pending, count: 3 },
          { type: 'auto_tagging', status: JobStatus.pending, count: 3 },
        ]),
      });
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(
          // only face_detection has history
          makeDurByType([{ type: 'face_detection', samples: 30, avg_sec: 2 }]),
        )
        .mockResolvedValueOnce(makeDurOverall(30, 2)); // overall avg=2s

      const result = await service.getInsights();

      expect(result.eta.basis).toBe('partial');
    });

    it('uses overall avg for types that lack type-specific history', async () => {
      delete process.env['ENRICHMENT_WORKER_CONCURRENCY'];

      // auto_tagging has no history; overall avg = 2s = 2000ms
      // auto_tagging: 3 pending → etcMs = 3*2000/1 = 6000
      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({ [JobStatus.pending]: 6 }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.pending, count: 3 },
          { type: 'auto_tagging', status: JobStatus.pending, count: 3 },
        ]),
      });
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(makeDurByType([{ type: 'face_detection', samples: 30, avg_sec: 2 }]))
        .mockResolvedValueOnce(makeDurOverall(30, 2));

      const result = await service.getInsights();

      const at = result.eta.perType.find((p) => p.type === 'auto_tagging');
      // avgMs on perType should be null (no type-specific history)
      expect(at?.avgMs).toBeNull();
      // etcMs uses overall fallback: 3 * 2000 / 1 = 6000
      expect(at?.etcMs).toBe(6000);
    });

    it('includes fallback-based ETC in the total etaMs', async () => {
      delete process.env['ENRICHMENT_WORKER_CONCURRENCY'];

      // face_detection: 3 pending, avg 2s → 3*2000 = 6000
      // auto_tagging: 3 pending, falls back to overall avg 2s → 3*2000 = 6000
      // total: 12000ms / concurrency(1) = 12000
      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({ [JobStatus.pending]: 6 }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.pending, count: 3 },
          { type: 'auto_tagging', status: JobStatus.pending, count: 3 },
        ]),
      });
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(makeDurByType([{ type: 'face_detection', samples: 30, avg_sec: 2 }]))
        .mockResolvedValueOnce(makeDurOverall(30, 2));

      const result = await service.getInsights();

      expect(result.eta.etaMs).toBe(12000);
    });

    it('returns basis=partial NOT partial when no types are missing history (sanity)', async () => {
      // Regression: when both types have history, should be 'live' not 'partial'
      delete process.env['ENRICHMENT_WORKER_CONCURRENCY'];

      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({ [JobStatus.pending]: 4 }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.pending, count: 2 },
          { type: 'auto_tagging', status: JobStatus.pending, count: 2 },
        ]),
      });
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(
          makeDurByType([
            { type: 'face_detection', samples: 10, avg_sec: 2 },
            { type: 'auto_tagging', samples: 10, avg_sec: 1 },
          ]),
        )
        .mockResolvedValueOnce(makeDurOverall(20, 1.5));

      const result = await service.getInsights();

      expect(result.eta.basis).toBe('live');
    });
  });

  // =========================================================================
  // (d) Zero remaining — etaMs=0, basis='live'
  // =========================================================================

  describe('zero remaining', () => {
    it('returns etaMs=0 when totalRemaining=0', async () => {
      // All jobs are succeeded (no pending or running)
      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({ [JobStatus.succeeded]: 100 }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.succeeded, count: 100 },
        ]),
      });
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(makeDurByType([{ type: 'face_detection', samples: 100, avg_sec: 2 }]))
        .mockResolvedValueOnce(makeDurOverall(100, 2));

      const result = await service.getInsights();

      expect(result.eta.etaMs).toBe(0);
    });

    it('returns basis=live when totalRemaining=0 regardless of history', async () => {
      // No jobs at all
      setupGroupByMocks(mockPrisma);
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([]) // no durByType
        .mockResolvedValueOnce(makeDurOverall(0, 0)); // no overall

      const result = await service.getInsights();

      expect(result.eta.basis).toBe('live');
    });

    it('returns totalRemaining=0 when only succeeded/failed jobs exist', async () => {
      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({
          [JobStatus.succeeded]: 50,
          [JobStatus.failed]: 5,
        }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.succeeded, count: 50 },
          { type: 'face_detection', status: JobStatus.failed, count: 5 },
        ]),
      });
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(makeDurOverall(50, 2));

      const result = await service.getInsights();

      expect(result.eta.totalRemaining).toBe(0);
    });
  });

  // =========================================================================
  // windowDays and computedAt
  // =========================================================================

  describe('metadata fields', () => {
    it('passes windowDays through to the response', async () => {
      setupGroupByMocks(mockPrisma);
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(makeDurOverall(0, 0));

      const result = await service.getInsights(14);

      expect(result.windowDays).toBe(14);
    });

    it('uses INSIGHTS_WINDOW_DAYS as default', async () => {
      setupGroupByMocks(mockPrisma);
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(makeDurOverall(0, 0));

      const result = await service.getInsights();

      expect(result.windowDays).toBe(INSIGHTS_WINDOW_DAYS);
    });

    it('returns a valid ISO computedAt string', async () => {
      setupGroupByMocks(mockPrisma);
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(makeDurOverall(0, 0));

      const before = new Date().toISOString();
      const result = await service.getInsights();
      const after = new Date().toISOString();

      expect(result.computedAt >= before).toBe(true);
      expect(result.computedAt <= after).toBe(true);
    });
  });

  // =========================================================================
  // Live counts forwarded from getStats
  // =========================================================================

  describe('live counts', () => {
    it('propagates rateLimited count into live.rateLimited', async () => {
      setupGroupByMocks(mockPrisma);

      // First two count calls: stuckRunning=0, scheduledCount=0 (from getStats)
      // Next two count calls: rateLimited=3, retried=0 (from getInsights)
      const countMock = mockPrisma.enrichmentJob.count as jest.Mock;
      countMock
        .mockResolvedValueOnce(0) // stuckRunning
        .mockResolvedValueOnce(0) // scheduledCount
        .mockResolvedValueOnce(3) // rateLimited
        .mockResolvedValueOnce(0); // retried

      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(makeDurOverall(0, 0));

      const result = await service.getInsights();

      expect(result.live.rateLimited).toBe(3);
    });

    it('propagates retried count into live.retried', async () => {
      setupGroupByMocks(mockPrisma);

      const countMock = mockPrisma.enrichmentJob.count as jest.Mock;
      countMock
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(7); // retried

      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(makeDurOverall(0, 0));

      const result = await service.getInsights();

      expect(result.live.retried).toBe(7);
    });
  });

  // =========================================================================
  // Lifetime totals (live all-time + purged rollup)
  // =========================================================================

  describe('lifetime totals', () => {
    it('merges live all-time counts/durations with the purged rollup', async () => {
      setupGroupByMocks(mockPrisma, {
        statusGroups: makeStatusGroups({
          [JobStatus.succeeded]: 10,
          [JobStatus.failed]: 2,
        }),
        typeStatusGroups: makeTypeStatusGroups([
          { type: 'face_detection', status: JobStatus.succeeded, count: 10 },
          { type: 'face_detection', status: JobStatus.failed, count: 2 },
        ]),
      });
      // $queryRaw order: durByType, durOverall, lifeDurByType
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(makeDurByType([{ type: 'face_detection', samples: 10, avg_sec: 2 }]))
        .mockResolvedValueOnce(makeDurOverall(10, 2))
        // live all-time durations: 10 samples summing 20s (=20000ms)
        .mockResolvedValueOnce([{ type: 'face_detection', samples: 10, sum_sec: 20 }]);
      // Purged rollup: 90 succeeded / 8 failed, 90 duration samples summing 180000ms
      (mockPrisma.jobStatsRollup.findMany as jest.Mock).mockResolvedValue([
        {
          type: 'face_detection',
          succeededCount: 90,
          failedCount: 8,
          sumDurationMs: 180_000,
          durationSamples: 90,
        },
      ]);

      const result = await service.getInsights();

      const fd = result.lifetime.byType.find((t) => t.type === 'face_detection');
      expect(fd).toBeDefined();
      // 10 live + 90 rollup succeeded; 2 live + 8 rollup failed
      expect(fd?.succeeded).toBe(100);
      expect(fd?.failed).toBe(10);
      expect(fd?.total).toBe(110);
      // samples: 10 live + 90 rollup = 100; sumMs: 20000 + 180000 = 200000 → avg 2000
      expect(fd?.samples).toBe(100);
      expect(fd?.avgMs).toBe(2000);

      // Overall mirrors the single type here
      expect(result.lifetime.overall.total).toBe(110);
      expect(result.lifetime.overall.avgMs).toBe(2000);
    });

    it('reports zero lifetime totals when there is no live or purged history', async () => {
      setupGroupByMocks(mockPrisma);
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(makeDurOverall(0, 0))
        .mockResolvedValueOnce([]);
      (mockPrisma.jobStatsRollup.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.getInsights();

      expect(result.lifetime.overall.total).toBe(0);
      expect(result.lifetime.overall.avgMs).toBe(0);
      expect(result.lifetime.byType).toEqual([]);
    });
  });

  // =========================================================================
  // resetHistory
  // =========================================================================

  describe('resetHistory', () => {
    it('clears the rollup table and returns the cleared row count', async () => {
      (mockPrisma.jobStatsRollup.deleteMany as jest.Mock).mockResolvedValue({ count: 4 });

      const result = await service.resetHistory();

      expect(mockPrisma.jobStatsRollup.deleteMany).toHaveBeenCalledWith({});
      expect(result.reset).toBe(4);
    });
  });
});
