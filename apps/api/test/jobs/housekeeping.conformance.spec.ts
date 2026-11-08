// =============================================================================
// The housekeeping job handlers against the platform handler contract (RETRO-C8, #608)
// =============================================================================
//
// `memory_generation`, `memory_digest`, `storage_insights`, `broadcast_start`,
// `broadcast_chunk` and the `notification_purge` retention purge are native
// platform `JobHandler`s. This spec runs each one through
// `describeJobHandlerConformance` (settle through the in-memory queue, double
// run, failure by throwing, dedup, `canDelete`) over a small in-memory world,
// plus the facts the issue names: the digest watermark is read from `jobs`, the
// insights refresh state follows the newest `jobs` row, a pending broadcast job
// of a live broadcast cannot be deleted, and the retention purge never deletes
// an unread notification.
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

import { StorageInsightsHandler } from '../../src/insights/storage-insights.handler';
import { InsightsService } from '../../src/insights/insights.service';
import { MemoryDigestHandler } from '../../src/memories/digest/memory-digest.handler';
import { MemoryDigestService } from '../../src/memories/digest/memory-digest.service';
import { MemoryGenerationHandler } from '../../src/memories/memory-generation.handler';
import type {
  MemoryCurator,
  MemoryCuratorContext,
} from '../../src/memories/curators/memory-curator.interface';
import { BroadcastChunkHandler } from '../../src/notifications/broadcasts/handlers/broadcast-chunk.handler';
import { BroadcastStartHandler } from '../../src/notifications/broadcasts/handlers/broadcast-start.handler';
import { NotificationsRetentionHandler } from '../../src/notifications/notifications-retention.handler';
import { APP_NOTIFICATIONS_RETENTION_POLICY } from '../../src/notifications/notifications.retention';
import { platformJob, subjectPrisma } from '../helpers/platform-job';

// -----------------------------------------------------------------------------
// A tiny in-memory table: just the Prisma calls these handlers make.
// -----------------------------------------------------------------------------

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond && !(cond.in as unknown[]).includes(row[key])) return false;
      if ('lt' in cond && !(row[key] != null && row[key] < cond.lt)) return false;
      if ('lte' in cond && !(row[key] != null && row[key] <= cond.lte)) return false;
      if ('gt' in cond && !(row[key] != null && row[key] > cond.gt)) return false;
      if ('not' in cond && cond.not === null && row[key] == null) return false;
      continue;
    }
    if ((row[key] ?? null) !== cond) return false;
  }
  return true;
}

function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && 'increment' in value) {
      row[key] = (row[key] ?? 0) + (value as { increment: number }).increment;
    } else {
      row[key] = value;
    }
  }
}

class Table {
  rows: Row[] = [];
  reset(rows: Row[]): void {
    this.rows = rows.map((r) => ({ ...r }));
  }
  snapshot(): Row[] {
    return this.rows.map((r) => ({ ...r }));
  }
  findUnique = async ({ where }: { where: Row }) =>
    this.rows.find((r) => matches(r, where)) ?? null;
  findMany = async ({ where, take }: { where?: Row; take?: number } = {}) => {
    const found = this.rows
      .filter((r) => matches(r, where))
      .sort((a, b) => String(a['id']).localeCompare(String(b['id'])));
    return take === undefined ? found : found.slice(0, take);
  };
  count = async ({ where }: { where?: Row } = {}) =>
    this.rows.filter((r) => matches(r, where)).length;
  updateMany = async ({ where, data }: { where?: Row; data: Row }) => {
    const hit = this.rows.filter((r) => matches(r, where));
    hit.forEach((r) => apply(r, data));
    return { count: hit.length };
  };
  deleteMany = async ({ where }: { where?: Row } = {}) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, where));
    return { count: before - this.rows.length };
  };
}

const registry = { register: jest.fn() } as unknown as JobHandlerRegistry;

/** The handler under a dotted alias of its type (see the header). */
function alias(handler: JobHandler): JobHandler {
  const aliased = Object.create(handler) as JobHandler;
  Object.defineProperty(aliased, 'type', { value: `memoriahub.${handler.type}`, enumerable: true });
  return aliased;
}

const CIRCLE = '00000000-0000-4000-8000-0000000000c1';
const BROADCAST = '00000000-0000-4000-8000-0000000000b1';
const DAY = 86_400_000;

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
    subjectPrisma({ circles: [CIRCLE] }) as never,
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
    subjectPrisma({ circles: [CIRCLE] }) as never,
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
    const svc = new MemoryDigestService(prisma as never, {} as never, {} as never, {} as never);
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
  return new StorageInsightsHandler(registry, insights as never);
}

describeJobHandlerConformance('storage_insights', () => alias(buildInsights()), {
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
// broadcast_start / broadcast_chunk
// =============================================================================

const bc = {
  broadcasts: new Table(),
  users: new Table(),
  chunkJobs: [] as string[],
  delivered: [] as string[],
};

function broadcastRow(over: Row = {}): Row {
  return {
    id: BROADCAST,
    status: 'scheduled',
    audienceCutoff: null,
    cursorUserId: null,
    processedCount: 0,
    recipientCount: null,
    title: 'Title A',
    body: 'Body A',
    link: null,
    ctaLabel: null,
    critical: false,
    channels: ['inbox'],
    ...over,
  };
}

function bcSeed(broadcast: Row | null): void {
  bc.broadcasts.reset(broadcast ? [broadcast] : []);
  bc.users.reset([
    {
      id: 'u-1',
      email: 'person.a@example.test',
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    {
      id: 'u-2',
      email: 'person.b@example.test',
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  ]);
  bc.chunkJobs = [];
  bc.delivered = [];
}

function bcPrisma(): any {
  return {
    mhLegacyNotificationBroadcast: bc.broadcasts,
    user: bc.users,
    job: { findFirst: async () => (bc.chunkJobs.length > 0 ? { id: bc.chunkJobs[0] } : null) },
  };
}

const bcJobs = {
  enqueue: async () => {
    const id = `chunk-${bc.chunkJobs.length + 1}`;
    bc.chunkJobs.push(id);
    return { id };
  },
};

const bcObserve = () => ({
  broadcasts: bc.broadcasts
    .snapshot()
    .map(({ startedAt, audienceCutoff, finishedAt, ...r }) => ({
      ...r,
      started: Boolean(startedAt),
    })),
  chunks: bc.chunkJobs.length,
  delivered: [...bc.delivered],
});

const buildStart = () => new BroadcastStartHandler(bcPrisma(), bcJobs as never, registry);

const buildChunk = () =>
  new BroadcastChunkHandler(bcPrisma(), bcJobs as never, registry, {
    deliver: async (_b: unknown, recipient: { id: string }) => {
      bc.delivered.push(recipient.id);
      return {};
    },
  } as never);

const vetoCases = [
  {
    name: 'pending job of a sending broadcast',
    job: { status: 'pending' as const, payload: { broadcastId: BROADCAST } },
    arrange: () => bcSeed(broadcastRow({ status: 'sending' })),
    expected: 'veto' as const,
    reasonIncludes: 'Cancel the broadcast',
  },
  {
    name: 'pending job of a scheduled broadcast',
    job: { status: 'pending' as const, payload: { broadcastId: BROADCAST } },
    arrange: () => bcSeed(broadcastRow()),
    expected: 'veto' as const,
  },
  {
    name: 'pending job of a cancelled broadcast',
    job: { status: 'pending' as const, payload: { broadcastId: BROADCAST } },
    arrange: () => bcSeed(broadcastRow({ status: 'canceled' })),
    expected: 'allow' as const,
  },
  {
    name: 'a failed job (history)',
    job: { status: 'failed' as const, payload: { broadcastId: BROADCAST } },
    arrange: () => bcSeed(broadcastRow({ status: 'sending' })),
    expected: 'allow' as const,
  },
];

describeJobHandlerConformance('broadcast_start', () => alias(buildStart()), {
  payloads: [
    {
      name: 'claims a scheduled broadcast and queues the first chunk once',
      payload: { broadcastId: BROADCAST },
      arrange: () => bcSeed(broadcastRow()),
      observe: bcObserve,
    },
    {
      name: 'the broadcast was deleted',
      payload: { broadcastId: BROADCAST },
      arrange: () => bcSeed(null),
      observe: bcObserve,
    },
    {
      name: 'the broadcast was cancelled',
      payload: { broadcastId: BROADCAST },
      arrange: () => bcSeed(broadcastRow({ status: 'canceled' })),
      observe: bcObserve,
    },
  ],
  canDelete: vetoCases,
});

describeJobHandlerConformance('broadcast_chunk', () => alias(buildChunk()), {
  payloads: [
    {
      name: 'delivers a short page and finishes the broadcast',
      payload: { broadcastId: BROADCAST },
      arrange: () =>
        bcSeed(
          broadcastRow({ status: 'sending', audienceCutoff: new Date('2030-01-01T00:00:00Z') })
        ),
      observe: bcObserve,
    },
    {
      name: 'a cancelled broadcast sends nothing',
      payload: { broadcastId: BROADCAST },
      arrange: () =>
        bcSeed(
          broadcastRow({ status: 'canceled', audienceCutoff: new Date('2030-01-01T00:00:00Z') })
        ),
      observe: bcObserve,
    },
  ],
  canDelete: vetoCases,
});

describe('broadcast fan-out', () => {
  it('start then chunk delivers every active user exactly once and marks the broadcast sent', async () => {
    bcSeed(broadcastRow());
    await buildStart().process(
      platformJob({ type: 'broadcast_start', payload: { broadcastId: BROADCAST } })
    );
    expect(bc.chunkJobs).toHaveLength(1);
    await buildChunk().process(
      platformJob({ type: 'broadcast_chunk', payload: { broadcastId: BROADCAST } })
    );
    expect(bc.delivered.sort()).toEqual(['u-1', 'u-2']);
    expect(bc.broadcasts.rows[0]).toMatchObject({
      status: 'sent',
      recipientCount: 2,
      processedCount: 2,
    });
  });
});

// =============================================================================
// notification_purge: the retention.appNotifications policy
// =============================================================================

const rt = {
  notifications: new Table(),
  deliveries: new Table(),
  policy: {} as Record<string, unknown>,
  fail: false,
};

function rtSeed(): void {
  const now = Date.now();
  const old = new Date(now - 60 * DAY);
  const recent = new Date(now - 2 * DAY);
  rt.notifications.reset([
    { id: 'n-dismissed-old', readAt: old, dismissedAt: old },
    { id: 'n-dismissed-recent', readAt: old, dismissedAt: recent },
    { id: 'n-read-old', readAt: old, dismissedAt: null },
    { id: 'n-read-recent', readAt: recent, dismissedAt: null },
    // Unread for a year: never deleted by age.
    {
      id: 'n-unread-ancient',
      readAt: null,
      dismissedAt: null,
      createdAt: new Date(now - 365 * DAY),
    },
  ]);
  rt.deliveries.reset([
    { id: 'd-old', createdAt: old },
    { id: 'd-recent', createdAt: recent },
  ]);
  rt.policy = {};
  rt.fail = false;
}

function buildRetention(): NotificationsRetentionHandler {
  const prisma = {
    mhLegacyNotification: rt.notifications,
    mhLegacyNotificationDelivery: rt.deliveries,
  };
  const settings = {
    getRetentionPolicy: async () => {
      if (rt.fail) throw new Error('settings unreadable');
      return rt.policy;
    },
  };
  return new NotificationsRetentionHandler(registry, prisma as never, settings as never);
}

const ids = (t: Table) => t.rows.map((r) => r['id']).sort();
const rtObserve = () => ({ n: ids(rt.notifications), d: ids(rt.deliveries) });

describeJobHandlerConformance('notification_purge', () => alias(buildRetention()), {
  payloads: [
    {
      name: 'purges resolved notifications and old deliveries',
      arrange: rtSeed,
      observe: rtObserve,
    },
    {
      name: 'the retention setting cannot be read',
      arrange: () => {
        rtSeed();
        rt.fail = true;
      },
      expectFailure: 'settings unreadable',
    },
  ],
});

describe('retention.appNotifications', () => {
  const job = { id: 'purge-1' } as Job;

  it('registers a camelCase key and keeps the permanent purge type', () => {
    expect(APP_NOTIFICATIONS_RETENTION_POLICY.key).toMatch(/^[a-z][A-Za-z0-9]{1,47}$/);
    expect(APP_NOTIFICATIONS_RETENTION_POLICY).toMatchObject({
      key: 'appNotifications',
      defaultDays: 30,
      defaultEnabled: true,
      minDays: 1,
      maxDays: 365,
      purge: { type: 'notification_purge' },
    });
  });

  it('deletes dismissed and read rows past the window, never an unread one', async () => {
    rtSeed();
    await buildRetention().process(job);
    expect(ids(rt.notifications)).toEqual([
      'n-dismissed-recent',
      'n-read-recent',
      'n-unread-ancient',
    ]);
    expect(ids(rt.deliveries)).toEqual(['d-recent']);
  });

  it('keeps a row read long ago but dismissed recently (dismissal is the clock)', async () => {
    rtSeed();
    await buildRetention().process(job);
    expect(ids(rt.notifications)).toContain('n-dismissed-recent');
  });

  it('an unread row survives even a one-day window', async () => {
    rtSeed();
    rt.policy['appNotifications'] = { enabled: true, days: 1 };
    await buildRetention().process(job);
    expect(ids(rt.notifications)).toEqual(['n-unread-ancient']);
  });

  it('disabled: a logged no-op', async () => {
    rtSeed();
    rt.policy['appNotifications'] = { enabled: false, days: 30 };
    await buildRetention().process(job);
    expect(rt.notifications.rows).toHaveLength(5);
    expect(rt.deliveries.rows).toHaveLength(2);
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
    buildStart(),
    buildChunk(),
    buildRetention(),
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
      broadcast_start: { maxRuntimeMs: 120_000, maxAttempts: 3 },
      broadcast_chunk: { maxRuntimeMs: 600_000, maxAttempts: 3 },
      notification_purge: { maxRuntimeMs: 1_800_000, maxAttempts: 3 },
    });
  });

  it('registers natively, all six server-only', () => {
    const real = new JobHandlerRegistry();
    for (const handler of build()) real.register(handler);
    expect(real.types().sort()).toEqual([
      'broadcast_chunk',
      'broadcast_start',
      'memory_digest',
      'memory_generation',
      'notification_purge',
      'storage_insights',
    ]);
    expect(real.serverOnlyTypes().sort()).toEqual(real.types().sort());
  });
});
