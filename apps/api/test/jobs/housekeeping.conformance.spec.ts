// =============================================================================
// The housekeeping job handlers against the platform handler contract (RETRO-C8, #608)
// =============================================================================
//
// `memory_generation`, `memory_digest` and `storage_insights` are native
// platform `JobHandler`s (RETRO-D3, #576, retired C8's `broadcast_start`,
// `broadcast_chunk` and `notification_purge`: the platform notifications slice
// owns broadcasts and the inbox purge). This spec runs each one through
// `describeJobHandlerConformance` (settle through the in-memory queue, double
// run, failure by throwing, dedup, `canDelete`) over a small in-memory world,
// plus the facts the issue names: the digest watermark is read from `jobs`, the
// insights refresh state follows the newest `jobs` row.
//
// PLATFORM-ADOPTION-SHIM(#608): as in RETRO-C3/C7, the platform contract checks
// that a type is "dotted, lower-case, two segments" and MemoriaHub's type
// strings are permanent snake_case, so the conformance runs against an ALIAS of
// each handler whose `type` is `memoriahub.<type>`; everything else is the real
// handler's, reached through the prototype. A separate case pins that the type
// pattern is the ONLY contract finding on the real handlers. Seam request: EAB
// #1120 (`JobHandlerContractOptions` has no allowance for a legacy undotted type).
// =============================================================================

import { JobHandlerRegistry, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';
import {
  describeJobHandlerConformance,
  findJobHandlerContractViolations,
} from '@marinoscar/platform-api/jobs/testing';

import { InsightsService, StorageInsightsHandler } from '@marinoscar/memoriahub-api/insights';
import { MemoryDigestHandler } from '../../src/memories/digest/memory-digest.handler';
import { MemoryDigestService } from '../../src/memories/digest/memory-digest.service';
import { MemoryGenerationHandler } from '../../src/memories/memory-generation.handler';
import type {
  MemoryCurator,
  MemoryCuratorContext,
} from '../../src/memories/curators/memory-curator.interface';
import { subjectPrisma, subjectScopes } from '../helpers/platform-job';

const registry = { register: jest.fn() } as unknown as JobHandlerRegistry;

/** The handler under a dotted alias of its type (see the header). */
function alias(handler: JobHandler): JobHandler {
  const aliased = Object.create(handler) as JobHandler;
  Object.defineProperty(aliased, 'type', { value: `memoriahub.${handler.type}`, enumerable: true });
  return aliased;
}

const CIRCLE = '00000000-0000-4000-8000-0000000000c1';

// =============================================================================
// memory_generation
// =============================================================================

const mem = { store: new Map<string, number>(), enabled: true, failCurator: false };

function memSeed(enabled = true): void {
  mem.store.clear();
  mem.enabled = enabled;
  mem.failCurator = false;
}

/** A curator that UPSERTS one memory per circle: a re-run converges. */
const upsertingCurator: MemoryCurator = {
  name: 'on_this_day',
  isEnabled: () => true,
  run: async (ctx: MemoryCuratorContext) => {
    if (mem.failCurator) throw new Error('curator exploded');
    const created = mem.store.has(ctx.circleId) ? 0 : 1;
    mem.store.set(ctx.circleId, 3);
    return { created, refreshed: 1 - created, skipped: 0, tombstoned: 0 };
  },
} as unknown as MemoryCurator;

function buildMemoryGeneration(): MemoryGenerationHandler {
  const settings = { getSettings: async () => ({ features: { memories: mem.enabled } }) };
  const titles = { beginRun: () => ({ aiCalls: 0, stopReason: null }) };
  const notifications = { recordGeneratedAsync: () => undefined };
  return new MemoryGenerationHandler(
    registry,
    subjectPrisma() as never,
    subjectScopes([CIRCLE]) as never,
    settings as never,
    titles as never,
    notifications as never,
    [upsertingCurator]
  );
}

const memObserve = () => [...mem.store.entries()];

describeJobHandlerConformance('memory_generation', () => alias(buildMemoryGeneration()), {
  payloads: [
    {
      name: 'one circle',
      subjectType: 'circle',
      subjectId: CIRCLE,
      arrange: () => memSeed(),
      observe: memObserve,
    },
    {
      name: 'a sharded backfill row',
      payload: { backfill: true, curators: ['on_this_day'], aiTitleCap: 5 },
      subjectType: 'circle',
      subjectId: CIRCLE,
      arrange: () => memSeed(),
      observe: memObserve,
    },
    {
      name: 'a circle deleted since the job was queued (no-op)',
      subjectType: 'circle',
      subjectId: '00000000-0000-4000-8000-0000000000ff',
      arrange: () => memSeed(),
      observe: memObserve,
    },
    {
      name: 'Memories disabled (no-op)',
      subjectType: 'circle',
      subjectId: CIRCLE,
      arrange: () => memSeed(false),
      observe: memObserve,
    },
    {
      name: 'a curator throws: isolated, the job still succeeds',
      subjectType: 'circle',
      subjectId: CIRCLE,
      arrange: () => {
        memSeed();
        mem.failCurator = true;
      },
      observe: memObserve,
    },
    {
      name: 'a job about a media item (malformed)',
      subjectType: 'media_item',
      subjectId: 'media-1',
      arrange: () => memSeed(),
      expectFailure: 'not about a circle',
    },
  ],
});

// =============================================================================
// memory_digest
// =============================================================================

const dig = { sent: new Set<string>(), fail: false };

function buildMemoryDigest(): MemoryDigestHandler {
  const digest = {
    sendForCircle: async (circleId: string) => {
      if (dig.fail) throw new Error('database unavailable');
      if (dig.sent.has(circleId)) {
        return {
          candidates: 0,
          recipients: 0,
          sent: 0,
          skippedOptOut: 0,
          skippedEmpty: 0,
          skippedNoEmail: 0,
          failed: 0,
          skippedReason: 'no_new_content',
        };
      }
      dig.sent.add(circleId);
      return {
        candidates: 2,
        recipients: 2,
        sent: 1,
        skippedOptOut: 0,
        skippedEmpty: 0,
        skippedNoEmail: 0,
        failed: 1,
      };
    },
  };
  return new MemoryDigestHandler(
    registry,
    subjectPrisma() as never,
    subjectScopes([CIRCLE]) as never,
    digest as never
  );
}

function digSeed(fail = false): void {
  dig.sent.clear();
  dig.fail = fail;
}

describeJobHandlerConformance('memory_digest', () => alias(buildMemoryDigest()), {
  payloads: [
    {
      name: 'a partial send succeeds (a retry would re-mail everyone)',
      subjectType: 'circle',
      subjectId: CIRCLE,
      arrange: () => digSeed(),
      observe: () => [...dig.sent],
    },
    {
      name: 'a circle deleted since the job was queued (no-op)',
      subjectType: 'circle',
      subjectId: '00000000-0000-4000-8000-0000000000ff',
      arrange: () => digSeed(),
      observe: () => [...dig.sent],
    },
    {
      name: 'an infrastructure error fails the job',
      subjectType: 'circle',
      subjectId: CIRCLE,
      arrange: () => digSeed(true),
      expectFailure: 'database unavailable',
    },
    {
      name: 'a global row (malformed)',
      arrange: () => digSeed(),
      expectFailure: 'not about a circle',
    },
  ],
});

describe('memory_digest watermark (read from the platform jobs table)', () => {
  function service(row: { finishedAt: Date } | null) {
    const prisma = { job: { findFirst: jest.fn().mockResolvedValue(row) } };
    const svc = new MemoryDigestService(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    return { svc, prisma };
  }

  it('is the finishedAt of the newest SUCCEEDED memory_digest job of the circle', async () => {
    const finishedAt = new Date('2026-10-01T08:05:00Z');
    const { svc, prisma } = service({ finishedAt });
    await expect(svc.lastDigestAt(CIRCLE)).resolves.toEqual(finishedAt);
    expect(prisma.job.findFirst).toHaveBeenCalledWith({
      where: {
        type: 'memory_digest',
        subjectType: 'circle',
        subjectId: CIRCLE,
        status: 'succeeded',
      },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    });
  });

  it('is null when the circle never had a succeeded digest (a failed row is no watermark)', async () => {
    await expect(service(null).svc.lastDigestAt(CIRCLE)).resolves.toBeNull();
  });
});

// =============================================================================
// storage_insights
// =============================================================================

const ins = { runs: 0, fail: false };

function buildInsights(): StorageInsightsHandler {
  const insights = {
    runComputation: async () => {
      if (ins.fail) throw new Error('aggregate failed');
      ins.runs += 1;
    },
  };
  return new StorageInsightsHandler({ registerHandler: jest.fn() } as never, insights as never);
}

describeJobHandlerConformance('storage_insights', () => alias(buildInsights() as unknown as JobHandler), {
  payloads: [
    {
      name: 'recomputes the snapshot (replacing the previous one)',
      arrange: () => {
        ins.runs = 0;
        ins.fail = false;
      },
      // Each run replaces the single snapshot: what is stored after one run and
      // after two is the same snapshot, so only "it ran" is observable here.
      assertIdempotent: (_s, expect) => expect(ins.runs).toBeGreaterThanOrEqual(1),
    },
    {
      name: 'the aggregate fails',
      arrange: () => {
        ins.fail = true;
      },
      expectFailure: 'aggregate failed',
    },
  ],
});

describe('storage_insights refresh state (the newest jobs row of the type)', () => {
  function service(row: Partial<Job> | null) {
    const prisma = { job: { findFirst: jest.fn().mockResolvedValue(row) } };
    return { svc: new InsightsService(prisma as never, {} as never), prisma };
  }

  it.each([
    ['pending', { state: 'pending', jobId: 'j1', lastError: null }],
    ['running', { state: 'running', jobId: 'j1', lastError: null }],
    ['failed', { state: 'failed', jobId: 'j1', lastError: 'boom' }],
    ['succeeded', { state: 'idle', jobId: null, lastError: null }],
  ] as const)('%s', async (status, expected) => {
    const { svc, prisma } = service({ id: 'j1', status, lastError: 'boom' });
    await expect(svc.getRefreshState()).resolves.toEqual(expected);
    expect(prisma.job.findFirst).toHaveBeenCalledWith({
      where: { type: 'storage_insights' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('is idle when no job of the type exists', async () => {
    await expect(service(null).svc.getRefreshState()).resolves.toEqual({
      state: 'idle',
      jobId: null,
      lastError: null,
    });
  });
});

// =============================================================================
// Registration facts
// =============================================================================

describe('housekeeping handlers: registration and eligibility', () => {
  const build = (): JobHandler[] => [
    buildMemoryGeneration(),
    buildMemoryDigest(),
    buildInsights(),
  ];

  it('the only contract finding on the real handlers is the snake_case type (see the header)', () => {
    for (const handler of build()) {
      const findings = findJobHandlerContractViolations(handler);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain('dotted');
    }
  });

  it('declares the issue’s profiles', () => {
    const profiles = Object.fromEntries(build().map((h) => [h.type, h.profile]));
    expect(profiles).toEqual({
      memory_generation: { maxRuntimeMs: 1_200_000, maxAttempts: 3 },
      memory_digest: { maxRuntimeMs: 900_000, maxAttempts: 2 },
      storage_insights: { maxRuntimeMs: 900_000, maxAttempts: 3 },
    });
  });

  it('registers natively, all three server-only', () => {
    const real = new JobHandlerRegistry();
    for (const handler of build()) real.register(handler);
    expect(real.types().sort()).toEqual(['memory_digest', 'memory_generation', 'storage_insights']);
    expect(real.serverOnlyTypes().sort()).toEqual(real.types().sort());
  });
});
