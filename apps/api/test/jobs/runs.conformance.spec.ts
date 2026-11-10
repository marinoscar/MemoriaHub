// =============================================================================
// The run-engine job handlers against the platform handler contract (RETRO-C7, #604)
// =============================================================================
//
// The three "run engines" (Media Workflow Automation, the shared review runs of
// bursts / duplicates / location suggestions, Empty Trash at scale) plus
// `trash_purge` and the two run-history retention purges are native platform
// `JobHandler`s. This spec runs each one through `describeJobHandlerConformance`
// (settle through the in-memory queue, double run, failure by throwing, dedup,
// `canDelete`) over a small in-memory database, with the scenarios the issue
// names: a run cancelled before its batch, a run already terminal, an item
// cascade-deleted mid-run (finalize still converges), the node result of
// `workflow_execute_batch` (valid, and tampered: never a source of truth), and
// the `canDelete` veto.
//
// PLATFORM-ADOPTION-SHIM(#604): the platform contract checks that a type is
// "dotted, lower-case, two segments". MemoriaHub's type strings are permanent
// snake_case (`workflow_evaluate`, ...), so the conformance runs against an
// ALIAS of each handler whose `type` is `memoriahub.<type>`; everything else
// (label, profile, node pair, process, canDelete) is the real handler's,
// reached through the prototype. A separate case pins that the type pattern is
// the ONLY contract finding on the real handler. Seam request:
// `JobHandlerContractOptions` has no allowance for a legacy undotted type.
// =============================================================================

import {
  JobHandlerRegistry,
  RETENTION_PURGE_BATCH_SIZE,
  type Job,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import {
  createFakeJobQueue,
  describeJobHandlerConformance,
  findJobHandlerContractViolations,
} from '@marinoscar/platform-api/jobs/testing';

import { TrashEmptyEvaluateHandler } from '@marinoscar/memoriahub-api/media';
import { TrashEmptyExecuteBatchHandler } from '@marinoscar/memoriahub-api/media';
import { TrashPurgeHandler } from '@marinoscar/memoriahub-api/media';
import { ReviewRunEvaluateHandler } from '../../src/review-runs/review-run-evaluate.handler';
import { ReviewRunExecuteBatchHandler } from '../../src/review-runs/review-run-execute-batch.handler';
import { ReviewRunsRetentionHandler, STALE_RUN_ERROR } from '../../src/review-runs/review-runs-retention.handler';
import { WorkflowEvaluateHandler } from '../../src/workflows/runs/workflow-evaluate.handler';
import { WorkflowEvaluateItemHandler } from '../../src/workflows/runs/workflow-evaluate-item.handler';
import { WorkflowExecuteBatchHandler } from '../../src/workflows/runs/workflow-execute-batch.handler';
import { WorkflowRunsRetentionHandler } from '../../src/workflows/runs/workflow-runs-retention.handler';

jest.mock('../../src/workflows/execution/item-revalidation.util', () => ({
  revalidateItemMatches: jest.fn(async () => true),
}));

// -----------------------------------------------------------------------------
// A tiny in-memory table: just the Prisma calls these handlers make.
// -----------------------------------------------------------------------------

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'AND') {
      if (!(cond as Row[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (key === 'OR') {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond && !(cond.in as unknown[]).includes(row[key])) return false;
      if ('lt' in cond && !(row[key] != null && row[key] < cond.lt)) return false;
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
  findUnique = async ({ where }: { where: Row }) => this.rows.find((r) => matches(r, where)) ?? null;
  findFirst = async ({ where }: { where?: Row } = {}) => this.rows.find((r) => matches(r, where)) ?? null;
  findMany = async ({ where, take }: { where?: Row; take?: number } = {}) => {
    const found = this.rows.filter((r) => matches(r, where));
    return take === undefined ? found : found.slice(0, take);
  };
  count = async ({ where }: { where?: Row } = {}) => this.rows.filter((r) => matches(r, where)).length;
  update = async ({ where, data }: { where: Row; data: Row }) => {
    const row = this.rows.find((r) => matches(r, where));
    if (!row) throw new Error('Record to update not found');
    apply(row, data);
    return row;
  };
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
  createMany = async ({ data }: { data: Row[] }) => {
    data.forEach((d) => this.rows.push({ ...d }));
    return { count: data.length };
  };
  create = async ({ data }: { data: Row }) => {
    const row = { id: `row-${this.rows.length + 1}`, ...data };
    this.rows.push(row);
    return row;
  };
  groupBy = async ({ where }: { by: string[]; where?: Row }) => {
    const counts = new Map<string, number>();
    for (const r of this.rows.filter((row) => matches(row, where))) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    return [...counts].map(([status, n]) => ({ status, _count: { _all: n } }));
  };
}

const registry = { register: jest.fn() } as unknown as JobHandlerRegistry;

/** The handler under its own type string, for the contract check that tolerates snake_case. */
function alias(handler: JobHandler): JobHandler {
  const aliased = Object.create(handler) as JobHandler;
  Object.defineProperty(aliased, 'type', { value: `memoriahub.${handler.type}`, enumerable: true });
  return aliased;
}

const CIRCLE = '00000000-0000-4000-8000-0000000000c1';
const RUN = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-0000000000e1';
const CIRCLE_SUBJECT = { subjectType: 'circle', subjectId: CIRCLE } as const;
const DAY = 86_400_000;

function pendingJob(payload: Row, status: Job['status'] = 'pending'): Partial<Job> {
  return { status, payload: payload as Job['payload'] };
}

// =============================================================================
// Media Workflow Automation
// =============================================================================

const wf = {
  runs: new Table(),
  items: new Table(),
  media: new Table(),
  notified: 0,
  enqueued: 0,
  failMedia: false,
};

function wfPrisma(): any {
  return {
    workflowRun: wf.runs,
    workflowRunItem: wf.items,
    mediaItem: {
      findMany: async (args: Row) => {
        if (wf.failMedia) throw new Error('database unavailable');
        return wf.media.findMany(args);
      },
      findFirst: (args: Row) => wf.media.findFirst(args),
    },
    workflow: { findUnique: async () => null },
    auditEvent: { create: async () => ({}) },
    userRole: { findMany: async () => [] },
  };
}

const wfNotifications = { notifyRunFinishedAsync: () => void (wf.notified += 1) };
const compiler = { compile: () => ({ where: { circleId: CIRCLE }, refinements: [] }) };

function wfRun(over: Row = {}): Row {
  return {
    id: RUN,
    workflowId: 'wf-1',
    circleId: CIRCLE,
    status: 'evaluating',
    triggerType: 'manual',
    definitionSnapshot: { actions: [{ type: 'add_tags', tags: ['Tag A'] }] },
    startedById: USER,
    approvedById: USER,
    matchedCount: 0,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    ...over,
  };
}

function wfSeed(runs: Row[], items: Row[] = [], media: Row[] = []): void {
  wf.runs.reset(runs);
  wf.items.reset(items);
  wf.media.reset(media);
  wf.notified = 0;
  wf.enqueued = 0;
  wf.failMedia = false;
}

const wfObserve = () => ({ runs: wf.runs.snapshot(), items: wf.items.snapshot(), notified: wf.notified, enqueued: wf.enqueued });

function buildWorkflowEvaluate(): WorkflowEvaluateHandler {
  const runService = {
    shouldBypassApproval: () => false,
    enqueueExecuteBatches: async () => void (wf.enqueued += 1),
  };
  const settings = { getSettings: async () => ({ workflows: { maxItemsPerRun: 10_000 } }) };
  return new WorkflowEvaluateHandler(
    registry,
    wfPrisma(),
    settings as never,
    compiler as never,
    runService as never,
    wfNotifications as never,
  );
}

describeJobHandlerConformance('workflow_evaluate', () => alias(buildWorkflowEvaluate()), {
  payloads: [
    {
      name: 'the run is gone',
      payload: { runId: RUN },
      ...CIRCLE_SUBJECT,
      arrange: () => wfSeed([]),
      observe: wfObserve,
    },
    {
      name: 'the run is already terminal',
      payload: { runId: RUN },
      ...CIRCLE_SUBJECT,
      arrange: () => wfSeed([wfRun({ status: 'completed' })]),
      observe: wfObserve,
    },
    {
      name: 'no item matches: the run completes',
      payload: { runId: RUN },
      ...CIRCLE_SUBJECT,
      arrange: () => wfSeed([wfRun()]),
      observe: wfObserve,
    },
    {
      name: 'two items match: the run awaits approval',
      payload: { runId: RUN },
      ...CIRCLE_SUBJECT,
      arrange: () =>
        wfSeed([wfRun()], [], [
          { id: 'item-1', circleId: CIRCLE, capturedAt: null },
          { id: 'item-2', circleId: CIRCLE, capturedAt: null },
        ]),
      observe: wfObserve,
    },
    {
      name: 'the database fails mid-scan',
      payload: { runId: RUN },
      ...CIRCLE_SUBJECT,
      arrange: () => {
        wfSeed([wfRun()]);
        wf.failMedia = true;
      },
      expectFailure: 'database unavailable',
    },
  ],
  canDelete: [
    { name: 'pending job of an evaluating run', job: pendingJob({ runId: RUN }), arrange: () => wfSeed([wfRun()]), expected: 'veto', reasonIncludes: 'Cancel the run' },
    { name: 'pending job of a finished run', job: pendingJob({ runId: RUN }), arrange: () => wfSeed([wfRun({ status: 'completed' })]), expected: 'allow' },
    { name: 'a succeeded job (history)', job: pendingJob({ runId: RUN }, 'succeeded'), arrange: () => wfSeed([wfRun()]), expected: 'allow' },
  ],
});

describe('workflow_evaluate run transitions', () => {
  it('zero matches completes the run and notifies once', async () => {
    wfSeed([wfRun()]);
    const handler = buildWorkflowEvaluate();
    await handler.process({ id: 'j', attempts: 1, payload: { runId: RUN } });
    await handler.process({ id: 'j', attempts: 1, payload: { runId: RUN } });
    expect(wf.runs.rows[0]).toMatchObject({ status: 'completed', matchedCount: 0 });
    expect(wf.notified).toBe(1);
  });

  it('marks the run failed only on the profile’s last attempt', async () => {
    const handler = buildWorkflowEvaluate();
    wfSeed([wfRun()]);
    wf.failMedia = true;
    await expect(handler.process({ id: 'j', attempts: 1, payload: { runId: RUN } })).rejects.toThrow();
    expect(wf.runs.rows[0]!['status']).toBe('evaluating');
    await expect(
      handler.process({ id: 'j', attempts: handler.profile.maxAttempts, payload: { runId: RUN } }),
    ).rejects.toThrow();
    expect(wf.runs.rows[0]!['status']).toBe('failed');
  });
});

function buildWorkflowEvaluateItem(enabled: boolean): WorkflowEvaluateItemHandler {
  const settings = {
    getSettings: async () => ({ features: { workflows: enabled }, workflows: { triggers: { onEnrichment: true } } }),
  };
  const prisma = {
    ...wfPrisma(),
    workflow: {
      findUnique: async () => {
        if (wf.failMedia) throw new Error('database unavailable');
        return null;
      },
    },
  };
  return new WorkflowEvaluateItemHandler(registry, prisma as never, settings as never, compiler as never);
}

describeJobHandlerConformance('workflow_evaluate_item', () => alias(buildWorkflowEvaluateItem(true)), {
  payloads: [
    {
      name: 'the workflow is gone',
      payload: { workflowId: 'wf-1', mediaItemId: 'item-1' },
      subjectType: 'media_item',
      subjectId: 'item-1',
      arrange: () => wfSeed([]),
      observe: wfObserve,
    },
    {
      name: 'the database fails',
      payload: { workflowId: 'wf-1', mediaItemId: 'item-1' },
      subjectType: 'media_item',
      subjectId: 'item-1',
      arrange: () => {
        wfSeed([]);
        wf.failMedia = true;
      },
      expectFailure: 'database unavailable',
    },
  ],
});

const executor = { execute: jest.fn(async (..._args: unknown[]) => ({ status: 'applied' })), clearRunCache: jest.fn() };

function buildWorkflowExecuteBatch(): WorkflowExecuteBatchHandler {
  return new WorkflowExecuteBatchHandler(
    registry,
    wfPrisma(),
    compiler as never,
    executor as never,
    wfNotifications as never,
  );
}

const matched = (id: string): Row => ({ runId: RUN, mediaItemId: id, status: 'matched' });

describeJobHandlerConformance('workflow_execute_batch', () => alias(buildWorkflowExecuteBatch()), {
  payloads: [
    {
      name: 'the run was cancelled before the batch',
      payload: { runId: RUN, itemIds: ['item-1'] },
      ...CIRCLE_SUBJECT,
      arrange: () => wfSeed([wfRun({ status: 'cancelled' })], [matched('item-1')]),
      observe: wfObserve,
    },
    {
      name: 'the run is already terminal',
      payload: { runId: RUN, itemIds: ['item-1'] },
      ...CIRCLE_SUBJECT,
      arrange: () => wfSeed([wfRun({ status: 'completed' })], [{ ...matched('item-1'), status: 'applied' }]),
      observe: wfObserve,
    },
    {
      name: 'an item was cascade-deleted mid-run: the run still finalizes',
      payload: { runId: RUN, itemIds: ['item-1', 'item-2', 'item-gone'] },
      ...CIRCLE_SUBJECT,
      arrange: () => wfSeed([wfRun({ status: 'running', matchedCount: 3 })], [matched('item-1'), matched('item-2')]),
      observe: wfObserve,
    },
  ],
  canDelete: [
    { name: 'pending batch of a running run', job: pendingJob({ runId: RUN, itemIds: [] }), arrange: () => wfSeed([wfRun({ status: 'running' })]), expected: 'veto', reasonIncludes: 'still running' },
    { name: 'pending batch of a cancelled run', job: pendingJob({ runId: RUN, itemIds: [] }), arrange: () => wfSeed([wfRun({ status: 'cancelled' })]), expected: 'allow' },
    { name: 'a failed batch (history)', job: pendingJob({ runId: RUN, itemIds: [] }, 'failed'), arrange: () => wfSeed([wfRun({ status: 'running' })]), expected: 'allow' },
  ],
});

describe('workflow_execute_batch: finalize and the node result', () => {
  const job = (itemIds: string[]): Job => ({ id: 'job-1', payload: { runId: RUN, itemIds }, attempts: 1 }) as unknown as Job;

  beforeEach(() => executor.execute.mockClear());

  it('a cascade-deleted item does not stop the run from completing, and it finalizes once', async () => {
    wfSeed([wfRun({ status: 'running' })], [matched('item-1'), matched('item-2')]);
    const handler = buildWorkflowExecuteBatch();
    await handler.process(job(['item-1', 'item-gone']));
    expect(wf.runs.rows[0]!['status']).toBe('running'); // item-2 still matched
    await handler.process(job(['item-2']));
    await handler.process(job(['item-2'])); // a retry of the last batch
    expect(wf.runs.rows[0]).toMatchObject({ status: 'completed', processedCount: 2, succeededCount: 2 });
    expect(wf.notified).toBe(1);
  });

  it('is node-eligible: a valid result parses and persists from the trusted payload', async () => {
    wfSeed([wfRun({ status: 'running' })], [matched('item-1')]);
    const handler = buildWorkflowExecuteBatch();
    const result = handler.nodeResultSchema.parse({
      runId: RUN,
      items: [{ mediaItemId: 'item-1', actionResults: [{ type: 'add_tags', status: 'applied' }] }],
    });
    await handler.persistNodeResult(job(['item-1']), result);
    expect(wf.items.rows[0]!['status']).toBe('applied');
    expect(wf.runs.rows[0]!['status']).toBe('completed');
  });

  it('ignores a tampered node result as a source of truth', async () => {
    wfSeed([wfRun({ status: 'running' })], [matched('item-1'), matched('item-2')]);
    const handler = buildWorkflowExecuteBatch();
    // The node claims to have applied item-2 (not in this batch) and to have failed item-1.
    const tampered = handler.nodeResultSchema.parse({
      runId: 'another-run',
      items: [
        { mediaItemId: 'item-2', actionResults: [{ type: 'hard_delete', status: 'applied' }] },
        { mediaItemId: 'item-1', actionResults: [{ type: 'add_tags', status: 'failed' }] },
      ],
    });
    await handler.persistNodeResult(job(['item-1']), tampered);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'add_tags' }), { id: 'item-1' }, expect.anything());
    expect(wf.items.rows.find((r) => r['mediaItemId'] === 'item-1')!['status']).toBe('applied');
    expect(wf.items.rows.find((r) => r['mediaItemId'] === 'item-2')!['status']).toBe('matched');
    expect(wf.runs.rows[0]!['status']).toBe('running');
  });

  it('a node path through the queue: the job settles and the run finalizes once', async () => {
    wfSeed([wfRun({ status: 'running' })], [matched('item-1')]);
    const handler = buildWorkflowExecuteBatch();
    const queue = createFakeJobQueue();
    queue.register(handler);
    const queued = await queue.enqueue({
      type: handler.type,
      reason: 'rerun',
      ...CIRCLE_SUBJECT,
      payload: { runId: RUN, itemIds: ['item-1'] },
      skipDedup: true,
      orgId: null,
    });
    await handler.persistNodeResult(queue.get(queued.id)!, { runId: RUN, items: [] });
    await handler.persistNodeResult(queue.get(queued.id)!, { runId: RUN, items: [] }); // a late duplicate
    expect(wf.items.rows[0]!['status']).toBe('applied');
    expect(wf.runs.rows[0]!['status']).toBe('completed');
    expect(wf.notified).toBe(1);
  });
});

// =============================================================================
// Review runs (bursts / duplicates / location suggestions)
// =============================================================================

const rv = { runs: new Table(), items: new Table(), subjects: [] as string[], enqueued: 0, fail: false };

function rvRun(over: Row = {}): Row {
  return {
    id: RUN,
    circleId: CIRCLE,
    subjectType: 'burst_group',
    action: 'dismiss',
    status: 'evaluating',
    matchedCount: 0,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    ...over,
  };
}

function rvSeed(runs: Row[], items: Row[] = [], subjects: string[] = []): void {
  rv.runs.reset(runs);
  rv.items.reset(items);
  rv.subjects = subjects;
  rv.enqueued = 0;
  rv.fail = false;
}

const rvObserve = () => ({ runs: rv.runs.snapshot(), items: rv.items.snapshot(), enqueued: rv.enqueued });

const strategy = {
  subjectColumn: 'burstGroupId',
  evaluatePage: async (_run: Row, cursor: unknown) => {
    if (rv.fail) throw new Error('database unavailable');
    return cursor ? { subjectIds: [], nextCursor: null } : { subjectIds: rv.subjects, nextCursor: null };
  },
  executeItem: async () => 'applied',
};
const subjects = { get: () => strategy };

function buildReviewEvaluate(): ReviewRunEvaluateHandler {
  const runService = { enqueueExecuteBatches: async () => void (rv.enqueued += 1) };
  return new ReviewRunEvaluateHandler(
    registry,
    { reviewRun: rv.runs, reviewRunItem: rv.items } as never,
    runService as never,
    subjects as never,
  );
}

describeJobHandlerConformance('review_run_evaluate', () => alias(buildReviewEvaluate()), {
  payloads: [
    { name: 'the run is gone', payload: { runId: RUN }, ...CIRCLE_SUBJECT, arrange: () => rvSeed([]), observe: rvObserve },
    { name: 'the run is already terminal', payload: { runId: RUN }, ...CIRCLE_SUBJECT, arrange: () => rvSeed([rvRun({ status: 'completed' })]), observe: rvObserve },
    { name: 'two groups match: the run starts', payload: { runId: RUN }, ...CIRCLE_SUBJECT, arrange: () => rvSeed([rvRun()], [], ['g-1', 'g-2']), observe: rvObserve },
    {
      name: 'the strategy fails',
      payload: { runId: RUN },
      ...CIRCLE_SUBJECT,
      arrange: () => {
        rvSeed([rvRun()]);
        rv.fail = true;
      },
      expectFailure: 'database unavailable',
    },
  ],
  canDelete: [
    { name: 'pending job of an evaluating run', job: pendingJob({ runId: RUN }), arrange: () => rvSeed([rvRun()]), expected: 'veto' },
    { name: 'pending job of a running run (evaluation done)', job: pendingJob({ runId: RUN }), arrange: () => rvSeed([rvRun({ status: 'running' })]), expected: 'allow' },
  ],
});

function buildReviewExecute(): ReviewRunExecuteBatchHandler {
  return new ReviewRunExecuteBatchHandler(registry, { reviewRun: rv.runs, reviewRunItem: rv.items } as never, subjects as never);
}

const rvItem = (id: string, group: string, status = 'matched'): Row => ({ id, runId: RUN, burstGroupId: group, status });

describeJobHandlerConformance('review_run_execute_batch', () => alias(buildReviewExecute()), {
  payloads: [
    {
      name: 'the run was cancelled before the batch',
      payload: { runId: RUN, subjectIds: ['g-1'] },
      ...CIRCLE_SUBJECT,
      arrange: () => rvSeed([rvRun({ status: 'cancelled' })], [rvItem('i-1', 'g-1')]),
      observe: rvObserve,
    },
    {
      name: 'the run is already terminal',
      payload: { runId: RUN, subjectIds: ['g-1'] },
      ...CIRCLE_SUBJECT,
      arrange: () => rvSeed([rvRun({ status: 'completed' })], [rvItem('i-1', 'g-1', 'applied')]),
      observe: rvObserve,
    },
    {
      name: 'a group was cascade-deleted mid-run: the run still finalizes',
      payload: { runId: RUN, subjectIds: ['g-1', 'g-gone'] },
      ...CIRCLE_SUBJECT,
      arrange: () => rvSeed([rvRun({ status: 'running', matchedCount: 2 })], [rvItem('i-1', 'g-1')]),
      observe: rvObserve,
    },
  ],
  canDelete: [
    { name: 'pending batch of a running run', job: pendingJob({ runId: RUN, subjectIds: [] }), arrange: () => rvSeed([rvRun({ status: 'running' })]), expected: 'veto' },
    { name: 'pending batch of a completed run', job: pendingJob({ runId: RUN, subjectIds: [] }), arrange: () => rvSeed([rvRun({ status: 'completed' })]), expected: 'allow' },
  ],
});

describe('review_run_execute_batch finalize', () => {
  it('converges to completed although matchedCount was never reached', async () => {
    rvSeed([rvRun({ status: 'running', matchedCount: 2 })], [rvItem('i-1', 'g-1')]);
    await buildReviewExecute().process({ id: 'j', attempts: 1, payload: { runId: RUN, subjectIds: ['g-1', 'g-gone'] } });
    expect(rv.runs.rows[0]).toMatchObject({ status: 'completed', processedCount: 1, succeededCount: 1 });
  });
});

// =============================================================================
// Empty Trash at scale and trash_purge
// =============================================================================

const tr = { runs: new Table(), items: new Table(), media: new Table(), enqueued: 0, fail: false };

function trRun(over: Row = {}): Row {
  return { id: RUN, circleId: CIRCLE, status: 'evaluating', matchedCount: 0, processedCount: 0, succeededCount: 0, failedCount: 0, skippedCount: 0, ...over };
}

function trSeed(runs: Row[], items: Row[] = [], media: Row[] = []): void {
  tr.runs.reset(runs);
  tr.items.reset(items);
  tr.media.reset(media);
  tr.enqueued = 0;
  tr.fail = false;
}

const trObserve = () => ({ runs: tr.runs.snapshot(), items: tr.items.snapshot(), media: tr.media.snapshot(), enqueued: tr.enqueued });

const mediaService = {
  purgeMediaItemsBatched: async (ids: string[]) => {
    // A hard delete cascades the run item away with its media item.
    await tr.media.deleteMany({ where: { id: { in: ids } } });
    await tr.items.deleteMany({ where: { mediaItemId: { in: ids } } });
    return { deleted: ids.length, failedIds: [] as string[] };
  },
};

const trPrisma = () => ({
  trashEmptyRun: tr.runs,
  trashEmptyRunItem: tr.items,
  mediaItem: {
    findMany: async (args: Row) => {
      if (tr.fail) throw new Error('database unavailable');
      return tr.media.findMany(args);
    },
  },
});

/** The slice's job port, over the platform registry the suite already holds. */
const trJobsPort = () => ({ registerHandler: (handler: unknown) => registry.register(handler as never) });

function buildTrashEvaluate(): TrashEmptyEvaluateHandler {
  const runService = { enqueueExecuteBatches: async () => void (tr.enqueued += 1) };
  return new TrashEmptyEvaluateHandler(trJobsPort() as never, trPrisma() as never, runService as never);
}

const trashed = (id: string, deletedAt = new Date()): Row => ({ id, circleId: CIRCLE, capturedAt: null, deletedAt });

describeJobHandlerConformance('trash_empty_evaluate', () => alias(buildTrashEvaluate()), {
  payloads: [
    { name: 'the run is gone', payload: { runId: RUN }, ...CIRCLE_SUBJECT, arrange: () => trSeed([]), observe: trObserve },
    { name: 'the run is already terminal', payload: { runId: RUN }, ...CIRCLE_SUBJECT, arrange: () => trSeed([trRun({ status: 'cancelled' })]), observe: trObserve },
    { name: 'two trashed items: the run starts', payload: { runId: RUN }, ...CIRCLE_SUBJECT, arrange: () => trSeed([trRun()], [], [trashed('m-1'), trashed('m-2')]), observe: trObserve },
    {
      name: 'the database fails mid-scan',
      payload: { runId: RUN },
      ...CIRCLE_SUBJECT,
      arrange: () => {
        trSeed([trRun()]);
        tr.fail = true;
      },
      expectFailure: 'database unavailable',
    },
  ],
  canDelete: [
    { name: 'pending job of an evaluating run', job: pendingJob({ runId: RUN }), arrange: () => trSeed([trRun()]), expected: 'veto' },
    { name: 'pending job of a gone run', job: pendingJob({ runId: RUN }), arrange: () => trSeed([]), expected: 'allow' },
  ],
});

function buildTrashExecute(): TrashEmptyExecuteBatchHandler {
  return new TrashEmptyExecuteBatchHandler(trJobsPort() as never, trPrisma() as never, mediaService as never);
}

const trItem = (id: string, status = 'matched'): Row => ({ runId: RUN, mediaItemId: id, status });

describeJobHandlerConformance('trash_empty_execute_batch', () => alias(buildTrashExecute()), {
  payloads: [
    {
      name: 'the run was cancelled before the batch',
      payload: { runId: RUN, itemIds: ['m-1'] },
      ...CIRCLE_SUBJECT,
      arrange: () => trSeed([trRun({ status: 'cancelled' })], [trItem('m-1')], [trashed('m-1')]),
      observe: trObserve,
    },
    {
      name: 'an item was cascade-deleted mid-run: the run still finalizes',
      payload: { runId: RUN, itemIds: ['m-1', 'm-gone'] },
      ...CIRCLE_SUBJECT,
      arrange: () => trSeed([trRun({ status: 'running', matchedCount: 2 })], [trItem('m-1')], [trashed('m-1')]),
      observe: trObserve,
    },
  ],
  canDelete: [
    { name: 'pending batch of a running run', job: pendingJob({ runId: RUN, itemIds: [] }), arrange: () => trSeed([trRun({ status: 'running' })]), expected: 'veto' },
    { name: 'pending batch of a completed run', job: pendingJob({ runId: RUN, itemIds: [] }), arrange: () => trSeed([trRun({ status: 'completed' })]), expected: 'allow' },
  ],
});

describe('trash_empty_execute_batch finalize', () => {
  it('converges to completed although an item vanished', async () => {
    trSeed([trRun({ status: 'running', matchedCount: 2 })], [trItem('m-1')], [trashed('m-1')]);
    await buildTrashExecute().process({ id: 'j', attempts: 1, payload: { runId: RUN, itemIds: ['m-1', 'm-gone'] } });
    expect(tr.runs.rows[0]).toMatchObject({ status: 'completed', processedCount: 1, succeededCount: 1 });
    expect(tr.media.rows).toHaveLength(0);
  });
});

function buildTrashPurge(): TrashPurgeHandler {
  // The handler reaches the queue and the settings through the media slice's ports (RETRO-J5).
  const jobsPort = trJobsPort();
  const settings = { readSystem: async () => ({ value: { trash: { retentionDays: 30 } }, version: 1 }) };
  return new TrashPurgeHandler(jobsPort as never, trPrisma() as never, settings as never, mediaService as never);
}

describeJobHandlerConformance('trash_purge', () => alias(buildTrashPurge()), {
  payloads: [
    {
      name: 'purges trash past the retention window and keeps the rest',
      arrange: () => trSeed([], [], [trashed('old', new Date(Date.now() - 40 * DAY)), trashed('recent')]),
      observe: () => tr.media.snapshot().map((r) => r['id']),
    },
    {
      name: 'the database fails',
      arrange: () => {
        trSeed([]);
        tr.fail = true;
      },
      expectFailure: 'database unavailable',
    },
  ],
});

// =============================================================================
// The two run-history retention purges
// =============================================================================

const rt = {
  workflowRuns: new Table(),
  reviewRuns: new Table(),
  trashRuns: new Table(),
  policy: { workflowRuns: { enabled: true, days: 30 }, reviewRuns: { enabled: true, days: 30 } } as Row,
  fail: false,
};

const ago = (days: number) => new Date(Date.now() - days * DAY);

function rtSeed(): void {
  rt.workflowRuns.reset([
    { id: 'w-approval', status: 'awaiting_approval', updatedAt: ago(2), finishedAt: null },
    { id: 'w-old', status: 'completed', updatedAt: ago(40), finishedAt: ago(40) },
    { id: 'w-old-nofinish', status: 'cancelled', updatedAt: ago(40), finishedAt: null },
    { id: 'w-recent', status: 'completed', updatedAt: ago(10), finishedAt: ago(10) },
    { id: 'w-running', status: 'running', updatedAt: ago(40), finishedAt: null },
  ]);
  rt.reviewRuns.reset([
    { id: 'r-stale', status: 'evaluating', updatedAt: ago(2), finishedAt: null },
    { id: 'r-old', status: 'failed', updatedAt: ago(40), finishedAt: ago(40) },
    { id: 'r-recent', status: 'completed', updatedAt: ago(1), finishedAt: ago(1) },
  ]);
  rt.trashRuns.reset([
    { id: 't-stale', status: 'running', updatedAt: ago(3), finishedAt: null },
    { id: 't-old', status: 'completed', updatedAt: ago(31), finishedAt: ago(31) },
  ]);
  rt.policy = { workflowRuns: { enabled: true, days: 30 }, reviewRuns: { enabled: true, days: 30 } };
  rt.fail = false;
}

const rtSettings = {
  getSettings: async () => ({ workflows: { previewTtlHours: 24 } }),
  getRetentionPolicy: async () => {
    if (rt.fail) throw new Error('settings unreadable');
    return rt.policy;
  },
};

const rtPrisma = () => ({ workflowRun: rt.workflowRuns, reviewRun: rt.reviewRuns, trashEmptyRun: rt.trashRuns });
const ids = (table: Table) => table.rows.map((r) => r['id']).sort();

function buildWorkflowRetention(): WorkflowRunsRetentionHandler {
  return new WorkflowRunsRetentionHandler(registry, rtPrisma() as never, rtSettings as never);
}

function buildReviewRetention(): ReviewRunsRetentionHandler {
  return new ReviewRunsRetentionHandler(registry, rtPrisma() as never, rtSettings as never);
}

const rtObserve = () => ({ w: rt.workflowRuns.snapshot(), r: rt.reviewRuns.snapshot(), t: rt.trashRuns.snapshot() });

describeJobHandlerConformance('workflow_history_purge', () => alias(buildWorkflowRetention()), {
  payloads: [
    { name: 'expires approvals and purges old runs', arrange: rtSeed, observe: rtObserve },
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

describeJobHandlerConformance('review_run_history_purge', () => alias(buildReviewRetention()), {
  payloads: [
    { name: 'fails stale runs and purges old ones', arrange: rtSeed, observe: rtObserve },
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

describe('run-history retention policies', () => {
  const job = { id: 'purge-1' } as Job;

  it('workflowRuns: expires stale approvals, deletes terminal runs past the cutoff only', async () => {
    rtSeed();
    await buildWorkflowRetention().process(job);
    expect(ids(rt.workflowRuns)).toEqual(['w-approval', 'w-recent', 'w-running']);
    expect(rt.workflowRuns.rows.find((r) => r['id'] === 'w-approval')!['status']).toBe('expired');
  });

  it('workflowRuns disabled: approvals still expire, nothing is deleted', async () => {
    rtSeed();
    rt.policy['workflowRuns'] = { enabled: false, days: 30 };
    await buildWorkflowRetention().process(job);
    expect(rt.workflowRuns.rows).toHaveLength(5);
    expect(rt.workflowRuns.rows.find((r) => r['id'] === 'w-approval')!['status']).toBe('expired');
  });

  it('workflowRuns honours the operator’s days', async () => {
    rtSeed();
    rt.policy['workflowRuns'] = { enabled: true, days: 5 };
    await buildWorkflowRetention().process(job);
    expect(ids(rt.workflowRuns)).toEqual(['w-approval', 'w-running']);
  });

  it('reviewRuns: fails runs stuck over 24h and purges review and empty-trash history', async () => {
    rtSeed();
    await buildReviewRetention().process(job);
    expect(rt.reviewRuns.rows.find((r) => r['id'] === 'r-stale')).toMatchObject({ status: 'failed', lastError: STALE_RUN_ERROR });
    expect(rt.trashRuns.rows.find((r) => r['id'] === 't-stale')).toMatchObject({ status: 'failed' });
    expect(ids(rt.reviewRuns)).toEqual(['r-recent', 'r-stale']);
    expect(ids(rt.trashRuns)).toEqual(['t-stale']);
  });

  it('reviewRuns disabled: stale runs are still failed, nothing is deleted', async () => {
    rtSeed();
    rt.policy['reviewRuns'] = { enabled: false, days: 30 };
    await buildReviewRetention().process(job);
    expect(rt.reviewRuns.rows).toHaveLength(3);
    expect(rt.trashRuns.rows).toHaveLength(2);
    expect(rt.reviewRuns.rows.find((r) => r['id'] === 'r-stale')!['status']).toBe('failed');
  });

  it('deletes in batches of the platform batch size', async () => {
    rtSeed();
    rt.workflowRuns.reset(
      Array.from({ length: RETENTION_PURGE_BATCH_SIZE + 1 }, (_, i) => ({
        id: `w-${i}`,
        status: 'completed',
        updatedAt: ago(40),
        finishedAt: ago(40),
      })),
    );
    const deleteMany = jest.spyOn(rt.workflowRuns, 'deleteMany');
    await buildWorkflowRetention().process(job);
    expect(rt.workflowRuns.rows).toHaveLength(0);
    expect(deleteMany.mock.calls.map((c) => (c[0]!.where!['id'] as { in: string[] }).in.length)).toEqual([
      RETENTION_PURGE_BATCH_SIZE,
      1,
    ]);
    deleteMany.mockRestore();
  });
});

// =============================================================================
// Registration facts
// =============================================================================

describe('run-engine handlers: registration and eligibility', () => {
  const build = (): JobHandler[] => [
    buildWorkflowEvaluate(),
    buildWorkflowEvaluateItem(true),
    buildWorkflowExecuteBatch(),
    buildReviewEvaluate(),
    buildReviewExecute(),
    buildTrashEvaluate(),
    buildTrashExecute(),
    buildTrashPurge(),
    buildWorkflowRetention(),
    buildReviewRetention(),
  ];

  it('the only contract finding on the real handlers is the snake_case type (see the header)', () => {
    for (const handler of build()) {
      const findings = findJobHandlerContractViolations(handler);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain('dotted');
    }
  });

  it('registers natively and only workflow_execute_batch is node-eligible', () => {
    const real = new JobHandlerRegistry();
    for (const handler of build()) real.register(handler);
    expect(real.types().sort()).toEqual([
      'review_run_evaluate',
      'review_run_execute_batch',
      'review_run_history_purge',
      'trash_empty_evaluate',
      'trash_empty_execute_batch',
      'trash_purge',
      'workflow_evaluate',
      'workflow_evaluate_item',
      'workflow_execute_batch',
      'workflow_history_purge',
    ]);
    expect(real.serverOnlyTypes()).not.toContain('workflow_execute_batch');
    expect(real.serverOnlyTypes()).toHaveLength(9);
  });
});
