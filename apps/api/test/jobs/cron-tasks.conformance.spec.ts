// =============================================================================
// Enqueue-only crons and the job types they enqueue (RETRO-C9, #612)
// =============================================================================
//
// Root rule (AGENTS.md / docs/specs/enrichment-queue.md): a `@Cron` only
// decides whether work is due and enqueues it. RETRO-C9 moved the last inline
// cron bodies into five new server-only job types and switched the hourly
// enqueuers to `enqueueHousekeepingJob`. This spec pins, per cron:
//
//   * gate off   -> no enqueue (and, where it is cheap, no read either);
//   * due        -> exactly one enqueue, with the expected type / priority / org;
//   * not due    -> no enqueue (a job of the type already in flight, or nothing
//                   due for the two workflow ticks);
//   * the cron never throws (a throw out of a `@Cron` is an unhandled rejection);
//
// and runs each of the five new handlers through the platform's
// `describeJobHandlerConformance` (settle, double run, failure by throwing,
// dedup) over a small in-memory world. `test/conformance.spec.ts` runs the
// `cron-enqueue-only` scan itself over the whole app.
// =============================================================================

import { Logger } from '@nestjs/common';
import { JobHandlerRegistry, enqueueHousekeepingJob, type JobHandler } from '@marinoscar/platform-api/jobs';
import { describeJobHandlerConformance } from '@marinoscar/platform-api/jobs/testing';
import { WorkflowRunItemStatus, WorkflowRunStatus, WorkflowTrigger } from '@prisma/client';

import { PictureEnhancementPurgeTask } from '@marinoscar/memoriahub-api/enhancement';
import { ThumbnailRepairTask } from '@marinoscar/memoriahub-api/media';
import { TrashPurgeTask } from '@marinoscar/memoriahub-api/media';
import { NodeBackupStaleHandler } from '../../src/node-backup/node-backup-stale.handler';
import { NodeBackupStaleTask } from '../../src/node-backup/node-backup-stale.task';
import {
  ReviewQueueReconcileHandler,
  ReviewQueueReconcileTask,
  ShareExpiringHandler,
  ShareExpiringTask,
  StorageRecoveryTask,
} from '@marinoscar/memoriahub-api/media';
import { configuredWorkerMode } from '../../src/platform/jobs/legacy-env';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/settings/registry/default-system-settings';
import {
  WorkflowMicroRunFinalizeHandler,
  WorkflowMicroRunFinalizeTask,
  WorkflowScheduleTickHandler,
  WorkflowScheduleTask,
} from '@marinoscar/memoriahub-api/workflows';

beforeAll(() => {
  // The crons and handlers log on purpose; keep the test output readable.
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

afterAll(() => jest.restoreAllMocks());

const registry = { register: jest.fn() } as unknown as JobHandlerRegistry;

/** A queue and a `jobs` table that answer "is one in flight?". */
function queueWorld(inFlight: { id: string; status: string } | null = null) {
  return {
    jobs: { enqueue: jest.fn().mockResolvedValue({ id: 'job-new', status: 'pending' }) },
    prisma: { job: { findFirst: jest.fn().mockResolvedValue(inFlight) } },
  };
}

/** The input `enqueueHousekeepingJob` hands `JobsService.enqueue`. */
const housekeeping = (type: string) => ({ type, reason: 'backfill', orgId: null, priority: 100 });

// =============================================================================
// The housekeeping crons (enqueueHousekeepingJob)
// =============================================================================

interface HousekeepingCase {
  name: string;
  type: string;
  tick: (world: ReturnType<typeof queueWorld>) => Promise<void>;
  /** An env var that turns the enqueue off when set to its value. */
  gate?: { env: string; value: string };
}

const HOUSEKEEPING_CRONS: HousekeepingCase[] = [
  {
    name: 'TrashPurgeTask',
    type: 'trash_purge',
    // The media slice's cron asks the jobs port for the housekeeping job (RETRO-J5): the port over the
    // same platform helper the other crons call.
    tick: (w) =>
      new TrashPurgeTask({
        enqueueHousekeeping: async ({ type, what }: { type: string; what: string }) => {
          const job = await enqueueHousekeepingJob({ jobs: w.jobs as never, prisma: w.prisma as never, logger: new Logger('TrashPurgeTask'), type, what });
          return job ? { id: job.id } : null;
        },
      } as never).handleScheduledPurge(),
  },
  {
    name: 'ThumbnailRepairTask',
    type: 'thumbnail_repair',
    tick: (w) =>
      new ThumbnailRepairTask({
        enqueueHousekeeping: async ({ type, what }: { type: string; what: string }) => {
          const job = await enqueueHousekeepingJob({ jobs: w.jobs as never, prisma: w.prisma as never, logger: new Logger('ThumbnailRepairTask'), type, what });
          return job ? { id: job.id } : null;
        },
      } as never).handleScheduledRepair(),
    gate: { env: 'THUMBNAIL_REPAIR_ENABLED', value: 'false' },
  },
  {
    name: 'PictureEnhancementPurgeTask',
    type: 'picture_enhancement_purge',
    // The enhancement slice's cron asks the jobs port for the housekeeping job and the host says whether this
    // instance runs a worker (RETRO-J10).
    tick: (w) =>
      new PictureEnhancementPurgeTask(
        {
          enqueueHousekeeping: async ({ type, what }: { type: string; what: string }) => {
            const job = await enqueueHousekeepingJob({ jobs: w.jobs as never, prisma: w.prisma as never, logger: new Logger('PictureEnhancementPurgeTask'), type, what });
            return job ? { id: job.id } : null;
          },
        } as never,
        { housekeepingEnabled: () => configuredWorkerMode() !== 'off' },
      ).handleScheduledPurge(),
    gate: { env: 'JOBS_WORKER_MODE', value: 'off' },
  },
  {
    name: 'StorageRecoveryTask',
    type: 'media.storage.recover_stuck',
    // The media slice's cron (RETRO-J5): the same enqueue through the jobs port.
    tick: (w) =>
      new StorageRecoveryTask({
        enqueueHousekeeping: async ({ type, what }: { type: string; what: string }) => {
          const job = await enqueueHousekeepingJob({ jobs: w.jobs as never, prisma: w.prisma as never, logger: new Logger('StorageRecoveryTask'), type, what });
          return job ? { id: job.id } : null;
        },
      } as never).enqueueRecovery(),
    gate: { env: 'STORAGE_PROCESSING_STUCK_RESET_ENABLED', value: 'false' },
  },
  {
    name: 'NodeBackupStaleTask',
    type: 'node_backup.stale_sweep',
    tick: (w) => new NodeBackupStaleTask(w.jobs as never, w.prisma as never).handleStaleSweep(),
  },
  {
    name: 'NotificationReconcileTask',
    type: 'notifications.review_queue_reconcile',
    // The media slice's cron asks the jobs port for the housekeeping job (RETRO-J10).
    tick: (w) =>
      new ReviewQueueReconcileTask({
        enqueueHousekeeping: async ({ type, what }: { type: string; what: string }) => {
          const job = await enqueueHousekeepingJob({ jobs: w.jobs as never, prisma: w.prisma as never, logger: new Logger('ReviewQueueReconcileTask'), type, what });
          return job ? { id: job.id } : null;
        },
      } as never).handleScheduledReconcile(),
    gate: { env: 'NOTIFICATIONS_RECONCILE_ENABLED', value: 'false' },
  },
  {
    name: 'ShareExpiringTask',
    type: 'shares.expiring_sweep',
    // The media slice's cron asks the jobs port for the housekeeping job (RETRO-J10).
    tick: (w) =>
      new ShareExpiringTask({
        enqueueHousekeeping: async ({ type, what }: { type: string; what: string }) => {
          const job = await enqueueHousekeepingJob({ jobs: w.jobs as never, prisma: w.prisma as never, logger: new Logger('ShareExpiringTask'), type, what });
          return job ? { id: job.id } : null;
        },
      } as never).handleScheduledSweep(),
    gate: { env: 'NOTIFICATIONS_SHARE_EXPIRING_ENABLED', value: 'false' },
  },
];

const GATE_ENVS = [
  'THUMBNAIL_REPAIR_ENABLED',
  'JOBS_WORKER_MODE',
  'ENRICHMENT_WORKER_MODE',
  'ENRICHMENT_WORKER_ENABLED',
  'FACE_WORKER_ENABLED',
  'NOTIFICATIONS_RECONCILE_ENABLED',
  'STORAGE_PROCESSING_STUCK_RESET_ENABLED',
  'NOTIFICATIONS_SHARE_EXPIRING_ENABLED',
];

describe('housekeeping crons only enqueue (enqueueHousekeepingJob)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of GATE_ENVS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of GATE_ENVS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe.each(HOUSEKEEPING_CRONS)('$name', ({ type, tick, gate }) => {
    it('due: enqueues exactly one global system job of its type at the housekeeping priority', async () => {
      const world = queueWorld();
      await tick(world);
      expect(world.jobs.enqueue).toHaveBeenCalledTimes(1);
      expect(world.jobs.enqueue).toHaveBeenCalledWith(housekeeping(type));
      expect(world.prisma.job.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { type, status: { in: ['pending', 'running'] } } }),
      );
    });

    it('not due: a job of the type already in flight means no enqueue', async () => {
      const world = queueWorld({ id: 'job-1', status: 'running' });
      await tick(world);
      expect(world.jobs.enqueue).not.toHaveBeenCalled();
    });

    it('never throws, even when the queue is down', async () => {
      const world = queueWorld();
      world.jobs.enqueue.mockRejectedValue(new Error('queue down'));
      await expect(tick(world)).resolves.toBeUndefined();
    });

    if (gate) {
      it(`gate off (${gate.env}=${gate.value}): no read, no enqueue`, async () => {
        process.env[gate.env] = gate.value;
        const world = queueWorld();
        await tick(world);
        expect(world.prisma.job.findFirst).not.toHaveBeenCalled();
        expect(world.jobs.enqueue).not.toHaveBeenCalled();
      });

      it(`runs for any other value of ${gate.env}`, async () => {
        process.env[gate.env] = 'true' === gate.value ? 'false' : 'all';
        const world = queueWorld();
        await tick(world);
        expect(world.jobs.enqueue).toHaveBeenCalledTimes(1);
      });
    }
  });
});

// =============================================================================
// The two every-minute workflow crons (JobsService.enqueue at priority 20)
// =============================================================================

function workflowSettings(over: { enabled?: boolean; scheduled?: boolean } = {}) {
  return {
    ...DEFAULT_SYSTEM_SETTINGS,
    features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: over.enabled ?? true },
    workflows: {
      ...DEFAULT_SYSTEM_SETTINGS.workflows,
      triggers: { onEnrichment: true, scheduled: over.scheduled ?? true },
    },
  };
}

const TICK_ENQUEUE = (type: string) => ({ type, reason: 'backfill', payload: {}, orgId: null, priority: 20 });

/** The slice's settings port over a function that returns the settings document. */
const settingsPortOver = (getSettings: () => Promise<Record<string, unknown>>) => ({
  readSystem: async (name: string) => ({ value: (await getSettings())[name], version: 1 }),
});
/** The slice's job port over the platform registry the suite already holds. */
const wfJobs = () => ({ registerHandler: (handler: unknown) => registry.register(handler as never) });

describe('WorkflowScheduleTask only decides and enqueues workflows.schedule_tick', () => {
  function build(due: { id: string } | null, settings = workflowSettings()) {
    const jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'job-new' }) };
    const prisma = { workflow: { findFirst: jest.fn().mockResolvedValue(due) } };
    const systemSettings = { getSettings: jest.fn().mockResolvedValue(settings) };
    const task = new WorkflowScheduleTask(prisma as never, settingsPortOver(() => systemSettings.getSettings()) as never, jobs as never);
    return { task, jobs, prisma, systemSettings };
  }

  it('due: one enqueue, above the housekeeping priority so a scheduled run is not starved', async () => {
    const { task, jobs, prisma } = build({ id: 'wf-1' });
    await task.handleTick();
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledWith(TICK_ENQUEUE('workflows.schedule_tick'));
    expect(prisma.workflow.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { trigger: WorkflowTrigger.scheduled, enabled: true, nextRunAt: { lte: expect.any(Date) } },
      }),
    );
  });

  it('not due: no enqueue', async () => {
    const { task, jobs } = build(null);
    await task.handleTick();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('gate off (features.workflows): no due read, no enqueue', async () => {
    const { task, jobs, prisma } = build({ id: 'wf-1' }, workflowSettings({ enabled: false }));
    await task.handleTick();
    expect(prisma.workflow.findFirst).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('gate off (workflows.triggers.scheduled=false): no due read, no enqueue', async () => {
    const { task, jobs, prisma } = build({ id: 'wf-1' }, workflowSettings({ scheduled: false }));
    await task.handleTick();
    expect(prisma.workflow.findFirst).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const { task, systemSettings } = build({ id: 'wf-1' });
    systemSettings.getSettings.mockRejectedValue(new Error('settings down'));
    await expect(task.handleTick()).resolves.toBeUndefined();
  });
});

describe('WorkflowMicroRunFinalizeTask only decides and enqueues workflows.micro_run_finalize', () => {
  function build(due: { id: string } | null) {
    const jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'job-new' }) };
    const prisma = { workflowRun: { findFirst: jest.fn().mockResolvedValue(due) } };
    const task = new WorkflowMicroRunFinalizeTask(prisma as never, jobs as never);
    return { task, jobs, prisma };
  }

  it('due: one enqueue', async () => {
    const { task, jobs, prisma } = build({ id: 'run-1' });
    await task.handleTick();
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledWith(TICK_ENQUEUE('workflows.micro_run_finalize'));
    expect(prisma.workflowRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          triggerType: WorkflowTrigger.on_media_enriched,
          status: WorkflowRunStatus.running,
          approvedAt: null,
        }),
      }),
    );
  });

  it('not due: no enqueue', async () => {
    const { task, jobs } = build(null);
    await task.handleTick();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const { task, prisma } = build(null);
    prisma.workflowRun.findFirst.mockRejectedValue(new Error('db down'));
    await expect(task.handleTick()).resolves.toBeUndefined();
  });
});

// =============================================================================
// The five new job types against the platform handler contract
// =============================================================================

/** `workflows.schedule_tick` over an in-memory `workflows` table. */
const wf = {
  rows: [] as { id: string; trigger: WorkflowTrigger; enabled: boolean; cronExpression: string | null; nextRunAt: Date | null }[],
  started: [] as string[],
  enabled: true,
};

function wfSeed(enabled = true): void {
  wf.enabled = enabled;
  wf.started = [];
  wf.rows = [
    {
      id: 'wf-due',
      trigger: WorkflowTrigger.scheduled,
      enabled: true,
      cronExpression: '0 3 * * *',
      nextRunAt: new Date(Date.now() - 60_000),
    },
    {
      id: 'wf-later',
      trigger: WorkflowTrigger.scheduled,
      enabled: true,
      cronExpression: '0 3 * * *',
      nextRunAt: new Date(Date.now() + 3_600_000),
    },
  ];
}

function buildScheduleTick(): JobHandler {
  const prisma = {
    workflow: {
      findMany: async ({ where }: { where: { nextRunAt: { lte: Date } } }) =>
        wf.rows.filter((row) => row.enabled && row.nextRunAt && row.nextRunAt <= where.nextRunAt.lte),
      update: async ({ where, data }: { where: { id: string }; data: { nextRunAt: Date } }) => {
        const row = wf.rows.find((r) => r.id === where.id)!;
        row.nextRunAt = data.nextRunAt;
        return row;
      },
    },
    workflowRun: { count: async () => 0 },
  };
  const settings = settingsPortOver(async () => workflowSettings({ enabled: wf.enabled }) as never);
  const runService = {
    startUnattendedRun: async (workflow: { id: string }) => {
      wf.started.push(workflow.id);
      return { runId: `run-${wf.started.length}` };
    },
  };
  return new WorkflowScheduleTickHandler(wfJobs() as never, prisma as never, settings as never, runService as never);
}

describeJobHandlerConformance('workflows.schedule_tick', buildScheduleTick, {
  payloads: [
    {
      name: 'one due workflow: a run starts and nextRunAt rolls forward (the second run finds nothing due)',
      arrange: () => wfSeed(),
      observe: () => ({ started: [...wf.started], due: wf.rows.filter((r) => r.nextRunAt! <= new Date()).length }),
    },
    {
      name: 'workflows disabled (no-op)',
      arrange: () => wfSeed(false),
      observe: () => [...wf.started],
    },
  ],
});

/** `workflows.micro_run_finalize` over an in-memory `workflow_runs` table. */
const micro = {
  runs: [] as { id: string; status: WorkflowRunStatus; approvedAt: Date | null; matched: number; dispatched: boolean }[],
};

function microSeed(): void {
  micro.runs = [
    { id: 'run-matched', status: WorkflowRunStatus.running, approvedAt: null, matched: 3, dispatched: false },
    { id: 'run-empty', status: WorkflowRunStatus.running, approvedAt: null, matched: 0, dispatched: false },
  ];
}

function buildMicroRunFinalize(): JobHandler {
  const prisma = {
    workflowRun: {
      findMany: async () => micro.runs.filter((r) => r.status === WorkflowRunStatus.running && r.approvedAt === null),
      updateMany: async ({ where, data }: { where: { id: string; approvedAt?: null }; data: Record<string, unknown> }) => {
        const run = micro.runs.find(
          (r) => r.id === where.id && r.status === WorkflowRunStatus.running && (!('approvedAt' in where) || r.approvedAt === null),
        );
        if (!run) return { count: 0 };
        Object.assign(run, data);
        return { count: 1 };
      },
    },
    workflowRunItem: {
      count: async ({ where }: { where: { runId: string; status: WorkflowRunItemStatus } }) =>
        micro.runs.find((r) => r.id === where.runId)!.matched,
    },
  };
  const settings = settingsPortOver(async () => workflowSettings() as never);
  const runService = {
    enqueueExecuteBatches: async (run: { id: string }) => {
      micro.runs.find((r) => r.id === run.id)!.dispatched = true;
    },
  };
  return new WorkflowMicroRunFinalizeHandler(wfJobs() as never, prisma as never, settings as never, runService as never);
}

describeJobHandlerConformance('workflows.micro_run_finalize', buildMicroRunFinalize, {
  payloads: [
    {
      name: 'closed windows: a matched run dispatches once, an empty one completes',
      arrange: () => microSeed(),
      observe: () => micro.runs.map((r) => ({ id: r.id, status: r.status, dispatched: r.dispatched, claimed: r.approvedAt !== null })),
    },
  ],
});

/** The three thin sweeps: the service holds the logic and its own specs. */
const sweeps = { reconciled: 0, swept: 0, released: 0, fail: false };

function sweepSeed(fail = false): void {
  sweeps.reconciled = 0;
  sweeps.swept = 0;
  sweeps.released = 0;
  sweeps.fail = fail;
}

describeJobHandlerConformance(
  'notifications.review_queue_reconcile',
  () =>
    new ReviewQueueReconcileHandler({ registerHandler: (handler: unknown) => registry.register(handler as never) } as never, {
      reconcileAll: async () => {
        if (sweeps.fail) throw new Error('reconcile exploded');
        sweeps.reconciled = 1; // a re-statement converges: the second run changes nothing
        return { circles: 2, upserted: 1, resolved: 0, errors: 0 };
      },
    } as never),
  {
    payloads: [
      { name: 'every circle reconciled', arrange: () => sweepSeed(), observe: () => sweeps.reconciled },
      { name: 'the reconcile throws', arrange: () => sweepSeed(true), expectFailure: 'reconcile exploded' },
    ],
  },
);

describeJobHandlerConformance(
  'shares.expiring_sweep',
  () =>
    new ShareExpiringHandler({ registerHandler: (handler: unknown) => registry.register(handler as never) } as never, {
      sweep: async () => {
        if (sweeps.fail) throw new Error('sweep exploded');
        // `data.notifiedFor` keeps the sweep idempotent: the second run emits nothing.
        const emitted = sweeps.swept === 0 ? 1 : 0;
        sweeps.swept = 1;
        return { candidates: 1, emitted, skipped: 1 - emitted, errors: 0 };
      },
    } as never),
  {
    payloads: [
      { name: 'one share expiring', arrange: () => sweepSeed(), observe: () => sweeps.swept },
      { name: 'the sweep throws', arrange: () => sweepSeed(true), expectFailure: 'sweep exploded' },
    ],
  },
);

describeJobHandlerConformance(
  'node_backup.stale_sweep',
  () =>
    new NodeBackupStaleHandler(registry, {
      markStaleRuns: async () => {
        if (sweeps.fail) throw new Error('db down');
        const released = sweeps.released === 0 ? 2 : 0;
        sweeps.released = 2;
        return released;
      },
    } as never),
  {
    payloads: [
      { name: 'two stale runs released', arrange: () => sweepSeed(), observe: () => sweeps.released },
      { name: 'the update throws', arrange: () => sweepSeed(true), expectFailure: 'db down' },
    ],
  },
);
