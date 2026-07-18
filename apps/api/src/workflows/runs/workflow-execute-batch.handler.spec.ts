/**
 * Unit tests for WorkflowExecuteBatchHandler (issue #140).
 *
 * Covers:
 *   - Per-item idempotency: only 'matched' items are claimed; an already-
 *     terminal item (retried batch) is skipped without re-counting.
 *   - Drift re-validation: an item that no longer satisfies the compiled
 *     conditions is finalized 'skipped' WITHOUT any executor.execute call.
 *   - Per-item status semantics: applied / partially_applied / failed /
 *     skipped, and the hard_delete terminal short-circuit (later actions on
 *     the same item are never executed after a terminal outcome).
 *   - Run finalize: completed vs completed_with_errors, and the race-safe
 *     conditional updateMany (only fires the audit/cache-clear once).
 *   - Cooperative cancellation mid-batch (checked every 25 items).
 *
 * No database required -- PrismaService, WorkflowConditionCompiler, and
 * WorkflowActionExecutor are mocked; revalidateItemMatches is jest.mock'd as a
 * standalone module function so drift behavior is controlled per test.
 */

import { EnrichmentJob, WorkflowRunItemStatus, WorkflowRunStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { WorkflowExecuteBatchHandler } from './workflow-execute-batch.handler';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkflowConditionCompiler, CompiledWorkflow } from '../compiler/workflow-condition.compiler';
import { WorkflowActionExecutor } from '../actions/workflow-action.executor';
import { WorkflowDefinition } from '../definition/workflow-definition.schema';
import { ActionOutcome } from '../actions/action-executor.types';
import { revalidateItemMatches } from '../execution/item-revalidation.util';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

jest.mock('../execution/item-revalidation.util', () => ({
  revalidateItemMatches: jest.fn(),
}));

const mockRevalidate = revalidateItemMatches as jest.Mock;

const RUN_ID = randomUUID();
const CIRCLE_ID = randomUUID();
const ACTOR_ID = randomUUID();

function makeJob(payload: Record<string, unknown>): EnrichmentJob {
  return {
    id: randomUUID(),
    type: 'workflow_execute_batch',
    mediaItemId: null,
    circleId: CIRCLE_ID,
    status: 'running',
    reason: 'rerun',
    priority: 100,
    providerKey: null,
    modelVersion: null,
    payload,
    attempts: 1,
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: 'server',
  } as unknown as EnrichmentJob;
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    workflowId: randomUUID(),
    circleId: CIRCLE_ID,
    status: WorkflowRunStatus.running,
    triggerType: 'manual',
    definitionSnapshot: {
      version: 1,
      subject: 'media_item',
      match: 'all',
      conditions: [],
      actions: [{ type: 'move_to_trash' }],
    } as WorkflowDefinition,
    startedById: ACTOR_ID,
    approvedById: ACTOR_ID,
    ...overrides,
  };
}

function compiledStub(): CompiledWorkflow {
  return { where: { circleId: CIRCLE_ID, deletedAt: null }, dependencies: new Set(), refinements: [] };
}

describe('WorkflowExecuteBatchHandler', () => {
  let handler: WorkflowExecuteBatchHandler;
  let prisma: MockPrismaService;
  let registry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
  let compiler: jest.Mocked<Pick<WorkflowConditionCompiler, 'compile'>>;
  let executor: jest.Mocked<Pick<WorkflowActionExecutor, 'execute' | 'clearRunCache'>>;

  beforeEach(() => {
    prisma = createMockPrismaService();
    registry = { register: jest.fn() };
    compiler = { compile: jest.fn().mockReturnValue(compiledStub()) };
    executor = {
      execute: jest.fn().mockResolvedValue({ status: 'applied' } as ActionOutcome),
      clearRunCache: jest.fn(),
    };

    handler = new WorkflowExecuteBatchHandler(
      registry as unknown as EnrichmentHandlerRegistry,
      prisma as unknown as PrismaService,
      compiler as unknown as WorkflowConditionCompiler,
      executor as unknown as WorkflowActionExecutor,
    );

    // Actor permission resolution — a single role granting media:write.
    prisma.userRole.findMany.mockResolvedValue([
      {
        role: {
          rolePermissions: [{ permission: { name: 'media:write' } }],
        },
      },
    ] as any);

    // Default: item is still 'matched' and claimable.
    prisma.workflowRunItem.updateMany.mockResolvedValue({ count: 1 } as any);
    mockRevalidate.mockResolvedValue(true);
    prisma.workflowRun.update.mockResolvedValue({} as any);
    prisma.workflowRunItem.count.mockResolvedValue(0); // "no matched left" by default
    (prisma.workflowRunItem.groupBy as jest.Mock).mockResolvedValue([] as any);
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.workflowRun.findUnique.mockResolvedValue(makeRun() as any);
    prisma.auditEvent.create.mockResolvedValue({} as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('is a no-op when the run is gone', async () => {
    prisma.workflowRun.findUnique.mockResolvedValue(null);
    await handler.process(makeJob({ runId: RUN_ID, itemIds: ['a'] }));
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('is a no-op when the run is cancelled', async () => {
    prisma.workflowRun.findUnique.mockResolvedValue(
      makeRun({ status: WorkflowRunStatus.cancelled }) as any,
    );
    await handler.process(makeJob({ runId: RUN_ID, itemIds: ['a'] }));
    expect(executor.execute).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------

  describe('per-item idempotency', () => {
    it('skips an already-terminal item (claim count 0) without calling the executor or incrementing counters', async () => {
      prisma.workflowRunItem.updateMany.mockResolvedValueOnce({ count: 0 } as any); // claim fails
      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));

      expect(executor.execute).not.toHaveBeenCalled();
      // applyCounters early-returns for 'already_terminal' — no workflowRun.update
      // call carrying counter increments should be issued for this item.
      const counterUpdate = (prisma.workflowRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate).toBeUndefined();
    });

    it('processes an item that is still matched (claim succeeds)', async () => {
      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));
      expect(executor.execute).toHaveBeenCalledTimes(1);
      const counterUpdate = (prisma.workflowRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Drift re-validation
  // ---------------------------------------------------------------------------

  describe('drift re-validation', () => {
    it('finalizes an item as skipped WITHOUT calling the executor when it no longer matches', async () => {
      mockRevalidate.mockResolvedValueOnce(false);

      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));

      expect(executor.execute).not.toHaveBeenCalled();
      const finalize = (prisma.workflowRunItem.updateMany as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status === WorkflowRunItemStatus.skipped,
      );
      expect(finalize).toBeDefined();
    });

    it('proceeds to execute actions when the item still matches', async () => {
      mockRevalidate.mockResolvedValueOnce(true);
      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));
      expect(executor.execute).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Per-item status semantics
  // ---------------------------------------------------------------------------

  describe('per-item status semantics', () => {
    it('all actions applied -> item status applied, run succeededCount incremented', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(
        makeRun({
          definitionSnapshot: {
            version: 1,
            subject: 'media_item',
            match: 'all',
            conditions: [],
            actions: [{ type: 'add_tags', names: ['x'] }],
          },
        }) as any,
      );
      executor.execute.mockResolvedValue({ status: 'applied' });

      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));

      const finalize = (prisma.workflowRunItem.updateMany as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(finalize[0].data.status).toBe(WorkflowRunItemStatus.applied);
      const counterUpdate = (prisma.workflowRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.succeededCount,
      );
      expect(counterUpdate[0].data.succeededCount).toEqual({ increment: 1 });
    });

    it('all actions skipped -> item status skipped', async () => {
      executor.execute.mockResolvedValue({ status: 'skipped', reason: 'noop' });
      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));

      const finalize = (prisma.workflowRunItem.updateMany as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(finalize[0].data.status).toBe(WorkflowRunItemStatus.skipped);
    });

    it('a failure with no prior progress -> item status failed', async () => {
      executor.execute.mockResolvedValue({ status: 'failed', detail: 'boom' });
      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));

      const finalize = (prisma.workflowRunItem.updateMany as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(finalize[0].data.status).toBe(WorkflowRunItemStatus.failed);
      expect(finalize[0].data.error).toBe('boom');
    });

    it('a failure AFTER some progress -> item status partially_applied (counts as both succeeded and failed)', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(
        makeRun({
          definitionSnapshot: {
            version: 1,
            subject: 'media_item',
            match: 'all',
            conditions: [],
            actions: [
              { type: 'add_tags', names: ['x'] },
              { type: 'set_favorite', value: true },
            ],
          },
        }) as any,
      );
      executor.execute
        .mockResolvedValueOnce({ status: 'applied' })
        .mockResolvedValueOnce({ status: 'failed', detail: 'second action broke' });

      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));

      const finalize = (prisma.workflowRunItem.updateMany as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(finalize[0].data.status).toBe(WorkflowRunItemStatus.partially_applied);

      const counterUpdate = (prisma.workflowRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate[0].data.succeededCount).toEqual({ increment: 1 });
      expect(counterUpdate[0].data.failedCount).toEqual({ increment: 1 });
    });

    it('a terminal outcome (hard_delete) stops execution of any later actions in the list', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(
        makeRun({
          definitionSnapshot: {
            version: 1,
            subject: 'media_item',
            match: 'all',
            conditions: [],
            actions: [
              { type: 'hard_delete' },
              { type: 'add_tags', names: ['never-runs'] },
            ],
          },
        }) as any,
      );
      executor.execute.mockResolvedValueOnce({ status: 'applied', terminal: true });

      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));

      // Only ONE call to executor.execute — the second (add_tags) action never runs.
      expect(executor.execute).toHaveBeenCalledTimes(1);
      expect(executor.execute).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'hard_delete' }),
        { id: 'item-1' },
        expect.anything(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Run finalize
  // ---------------------------------------------------------------------------

  describe('run finalize', () => {
    it('finalizes completed when no matched items remain and none failed', async () => {
      prisma.workflowRunItem.count.mockResolvedValue(0); // none remain 'matched'
      (prisma.workflowRunItem.groupBy as jest.Mock).mockResolvedValue([
        { status: WorkflowRunItemStatus.applied, _count: { _all: 5 } },
      ]);

      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));

      const finalize = (prisma.workflowRun.updateMany as jest.Mock).mock.calls[0];
      expect(finalize[0].data.status).toBe(WorkflowRunStatus.completed);
    });

    it('finalizes completed_with_errors when failed/partially_applied items exist', async () => {
      prisma.workflowRunItem.count.mockResolvedValue(0);
      (prisma.workflowRunItem.groupBy as jest.Mock).mockResolvedValue([
        { status: WorkflowRunItemStatus.applied, _count: { _all: 3 } },
        { status: WorkflowRunItemStatus.failed, _count: { _all: 1 } },
      ]);

      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));

      const finalize = (prisma.workflowRun.updateMany as jest.Mock).mock.calls[0];
      expect(finalize[0].data.status).toBe(WorkflowRunStatus.completed_with_errors);
    });

    it('does NOT finalize while matched items remain', async () => {
      prisma.workflowRunItem.count.mockResolvedValue(3); // items still pending
      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));
      expect(prisma.workflowRun.updateMany).not.toHaveBeenCalled();
    });

    it('only audits/clears the cache once the conditional updateMany actually wins (fin.count > 0)', async () => {
      prisma.workflowRunItem.count.mockResolvedValue(0);
      prisma.workflowRun.updateMany.mockResolvedValue({ count: 0 } as any); // another batch already finalized it

      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));

      expect(executor.clearRunCache).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Cooperative cancellation mid-batch
  // ---------------------------------------------------------------------------

  describe('cooperative cancellation', () => {
    it('bails out of remaining items once a periodic check (every 25 items) observes the run was cancelled', async () => {
      const itemIds = Array.from({ length: 26 }, (_, i) => `item-${i}`);
      let call = 0;
      (prisma.workflowRun.findUnique as jest.Mock).mockImplementation(async () => {
        call += 1;
        // First call resolves the run for the batch; the periodic check at i=25
        // (the second findUnique call) reports cancelled.
        if (call === 1) return makeRun();
        return { status: WorkflowRunStatus.cancelled };
      });

      await handler.process(makeJob({ runId: RUN_ID, itemIds }));

      // Exactly 25 items (indices 0..24) should have been processed before the
      // cancellation check at i=25 short-circuits the loop.
      expect(executor.execute).toHaveBeenCalledTimes(25);
      // The run bails out before ever reaching maybeFinalizeRun.
      expect(prisma.workflowRun.updateMany).not.toHaveBeenCalled();
    });
  });
});
