/**
 * Unit tests for WorkflowEvaluateHandler (issue #140).
 *
 * Covers:
 *   - maxItems cap precedence: run-body override wins if smaller, then
 *     per-workflow options.maxItems, then the system ceiling
 *     workflows.maxItemsPerRun.
 *   - truncated flag set only when the cap is hit before all matches exhaust.
 *   - 0 matches -> run completed.
 *   - bypass-eligible -> run transitions straight to running and batches enqueue.
 *   - otherwise -> awaiting_approval.
 *
 * No database required -- PrismaService, SystemSettingsService,
 * WorkflowConditionCompiler, WorkflowRunService, and the handler registry are
 * all mocked. The handler is constructed directly (plain class, no other Nest
 * wiring needed) mirroring the pure-constructor style used by the Phase 1
 * compiler/validator specs.
 */

import { WorkflowRunStatus, WorkflowRunItemStatus, EnrichmentJob } from '@prisma/client';
import { randomUUID } from 'crypto';
import { WorkflowEvaluateHandler } from './workflow-evaluate.handler';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { WorkflowConditionCompiler, CompiledWorkflow } from '../compiler/workflow-condition.compiler';
import { WorkflowRunService } from './workflow-run.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../../common/types/settings.types';
import { WorkflowDefinition } from '../definition/workflow-definition.schema';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const RUN_ID = randomUUID();
const CIRCLE_ID = randomUUID();

function makeJob(payload: Record<string, unknown>): EnrichmentJob {
  return {
    id: randomUUID(),
    type: 'workflow_evaluate',
    mediaItemId: null,
    circleId: CIRCLE_ID,
    status: 'running',
    reason: 'rerun',
    priority: 20,
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
    status: WorkflowRunStatus.evaluating,
    triggerType: 'manual',
    definitionSnapshot: {
      version: 1,
      subject: 'media_item',
      match: 'all',
      conditions: [],
      actions: [{ type: 'move_to_trash' }],
    } as WorkflowDefinition,
    matchedCount: 0,
    truncated: false,
    startedById: randomUUID(),
    approvedById: null,
    ...overrides,
  };
}

/** A trivial compiled workflow with no refinements. */
function compiledNoRefinements(): CompiledWorkflow {
  return { where: { circleId: CIRCLE_ID, deletedAt: null }, dependencies: new Set(), refinements: [] };
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_SYSTEM_SETTINGS,
    workflows: { ...DEFAULT_SYSTEM_SETTINGS.workflows, ...overrides },
  };
}

/** Rows shaped like the handler's { id, capturedAt } select. */
function rows(n: number, startIndex = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `item-${startIndex + i}`,
    capturedAt: new Date(2024, 0, 1, 0, 0, startIndex + i),
  }));
}

describe('WorkflowEvaluateHandler', () => {
  let handler: WorkflowEvaluateHandler;
  let prisma: MockPrismaService;
  let registry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
  let systemSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettings'>>;
  let compiler: jest.Mocked<Pick<WorkflowConditionCompiler, 'compile'>>;
  let runService: jest.Mocked<Pick<WorkflowRunService, 'shouldBypassApproval' | 'enqueueExecuteBatches'>>;

  beforeEach(() => {
    prisma = createMockPrismaService();
    registry = { register: jest.fn() };
    systemSettings = { getSettings: jest.fn().mockResolvedValue(settings()) };
    compiler = { compile: jest.fn().mockReturnValue(compiledNoRefinements()) };
    runService = {
      shouldBypassApproval: jest.fn().mockReturnValue(false),
      enqueueExecuteBatches: jest.fn().mockResolvedValue(undefined),
    };

    handler = new WorkflowEvaluateHandler(
      registry as unknown as EnrichmentHandlerRegistry,
      prisma as unknown as PrismaService,
      systemSettings as unknown as SystemSettingsService,
      compiler as unknown as WorkflowConditionCompiler,
      runService as unknown as WorkflowRunService,
    );

    prisma.workflowRunItem.createMany.mockResolvedValue({ count: 0 } as any);
    prisma.workflowRun.update.mockResolvedValue({} as any);
    prisma.auditEvent.create.mockResolvedValue({} as any);
  });

  it('is a no-op when the run is missing', async () => {
    prisma.workflowRun.findUnique.mockResolvedValue(null);
    await handler.process(makeJob({ runId: RUN_ID }));
    expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
  });

  it('is a no-op when the run is not in "evaluating" status (idempotent re-delivery)', async () => {
    prisma.workflowRun.findUnique.mockResolvedValue(
      makeRun({ status: WorkflowRunStatus.running }) as any,
    );
    await handler.process(makeJob({ runId: RUN_ID }));
    expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
  });

  describe('maxItems cap precedence', () => {
    it('uses the system ceiling (workflows.maxItemsPerRun) when nothing else is set', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(makeRun() as any);
      systemSettings.getSettings.mockResolvedValue(settings({ maxItemsPerRun: 3 }) as any);
      // One page under the cap, then an empty page.
      prisma.mediaItem.findMany
        .mockResolvedValueOnce(rows(2) as any)
        .mockResolvedValueOnce([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      const update = (prisma.workflowRun.update as jest.Mock).mock.calls.find(
        (c) => 'matchedCount' in (c[0].data ?? {}),
      );
      expect(update[0].data.matchedCount).toBe(2);
      expect(update[0].data.truncated).toBe(false);
    });

    it('a smaller run-body maxItems overrides both the workflow option and the system ceiling', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(
        makeRun({
          definitionSnapshot: {
            version: 1,
            subject: 'media_item',
            match: 'all',
            conditions: [],
            actions: [],
            options: { maxItems: 50 },
          },
        }) as any,
      );
      systemSettings.getSettings.mockResolvedValue(settings({ maxItemsPerRun: 1000 }) as any);
      // 10 rows available, but the run-body cap of 2 should win.
      prisma.mediaItem.findMany
        .mockResolvedValueOnce(rows(10) as any)
        .mockResolvedValueOnce([] as any);

      await handler.process(makeJob({ runId: RUN_ID, maxItems: 2 }));

      const update = (prisma.workflowRun.update as jest.Mock).mock.calls.find(
        (c) => 'matchedCount' in (c[0].data ?? {}),
      );
      expect(update[0].data.matchedCount).toBe(2);
      expect(update[0].data.truncated).toBe(true);
    });

    it('per-workflow options.maxItems wins over the system ceiling when no run-body override is given', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(
        makeRun({
          definitionSnapshot: {
            version: 1,
            subject: 'media_item',
            match: 'all',
            conditions: [],
            actions: [],
            options: { maxItems: 3 },
          },
        }) as any,
      );
      systemSettings.getSettings.mockResolvedValue(settings({ maxItemsPerRun: 1000 }) as any);
      prisma.mediaItem.findMany
        .mockResolvedValueOnce(rows(10) as any)
        .mockResolvedValueOnce([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      const update = (prisma.workflowRun.update as jest.Mock).mock.calls.find(
        (c) => 'matchedCount' in (c[0].data ?? {}),
      );
      expect(update[0].data.matchedCount).toBe(3);
      expect(update[0].data.truncated).toBe(true);
    });

    it('effective cap = min(runBody, options.maxItems, systemCeiling) across all three set simultaneously', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(
        makeRun({
          definitionSnapshot: {
            version: 1,
            subject: 'media_item',
            match: 'all',
            conditions: [],
            actions: [],
            options: { maxItems: 7 }, // middle value
          },
        }) as any,
      );
      systemSettings.getSettings.mockResolvedValue(settings({ maxItemsPerRun: 100 }) as any); // largest
      prisma.mediaItem.findMany
        .mockResolvedValueOnce(rows(20) as any)
        .mockResolvedValueOnce([] as any);

      // run-body override is the smallest of the three.
      await handler.process(makeJob({ runId: RUN_ID, maxItems: 4 }));

      const update = (prisma.workflowRun.update as jest.Mock).mock.calls.find(
        (c) => 'matchedCount' in (c[0].data ?? {}),
      );
      expect(update[0].data.matchedCount).toBe(4);
      expect(update[0].data.truncated).toBe(true);
    });

    it('is NOT truncated when total matches exactly equal the cap (last page shorter than PAGE_SIZE)', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(makeRun() as any);
      systemSettings.getSettings.mockResolvedValue(settings({ maxItemsPerRun: 5 }) as any);
      prisma.mediaItem.findMany
        .mockResolvedValueOnce(rows(5) as any)
        .mockResolvedValueOnce([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      const update = (prisma.workflowRun.update as jest.Mock).mock.calls.find(
        (c) => 'matchedCount' in (c[0].data ?? {}),
      );
      expect(update[0].data.matchedCount).toBe(5);
      expect(update[0].data.truncated).toBe(false);
    });
  });

  describe('terminal run transitions', () => {
    it('0 matches -> run status completed, no approval/execute path taken', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.mediaItem.findMany.mockResolvedValue([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      const statusUpdate = (prisma.workflowRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(statusUpdate[0].data.status).toBe(WorkflowRunStatus.completed);
      expect(runService.shouldBypassApproval).not.toHaveBeenCalled();
      expect(runService.enqueueExecuteBatches).not.toHaveBeenCalled();
    });

    it('bypass-eligible -> transitions straight to running and enqueues execute batches', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.mediaItem.findMany
        .mockResolvedValueOnce(rows(2) as any)
        .mockResolvedValueOnce([] as any);
      runService.shouldBypassApproval.mockReturnValue(true);
      prisma.workflowRun.update.mockResolvedValue(
        makeRun({ status: WorkflowRunStatus.running }) as any,
      );

      await handler.process(makeJob({ runId: RUN_ID }));

      const statusUpdate = (prisma.workflowRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status === WorkflowRunStatus.running,
      );
      expect(statusUpdate).toBeDefined();
      expect(runService.enqueueExecuteBatches).toHaveBeenCalledTimes(1);
    });

    it('otherwise -> transitions to awaiting_approval', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.mediaItem.findMany
        .mockResolvedValueOnce(rows(2) as any)
        .mockResolvedValueOnce([] as any);
      runService.shouldBypassApproval.mockReturnValue(false);

      await handler.process(makeJob({ runId: RUN_ID }));

      const statusUpdate = (prisma.workflowRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(statusUpdate[0].data.status).toBe(WorkflowRunStatus.awaiting_approval);
      expect(runService.enqueueExecuteBatches).not.toHaveBeenCalled();
    });
  });
});
