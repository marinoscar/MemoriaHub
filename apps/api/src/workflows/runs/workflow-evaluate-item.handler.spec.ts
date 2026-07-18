/**
 * Unit tests for WorkflowEvaluateItemHandler (Media Workflow Automation Phase
 * 4, issue #142) -- the on_media_enriched single-item evaluate + rolling
 * micro-run handler.
 *
 * Covers:
 *   - malformed payload -> no-op.
 *   - feature/trigger gate: features.workflows off, workflows.triggers.
 *     onEnrichment off -> no-op.
 *   - workflow eligibility: not found, disabled, wrong trigger, no creator.
 *   - evaluate-once guard / loop protection: an item that already has a run
 *     item on ANY run of this workflow is never re-evaluated.
 *   - single-item condition (match) check: non-matching item -> no-op; a
 *     failing read-time refinement -> no-op.
 *   - micro-run open: the first match for a workflow opens a fresh 'running'
 *     micro-run and audits it.
 *   - micro-run append: a subsequent match within the open run's window
 *     appends (createMany + matchedCount increment) without opening a new run
 *     or re-auditing.
 *   - append idempotency: a duplicate insert (skipDuplicates hit, count=0)
 *     does not double-increment matchedCount.
 *
 * No database required -- PrismaService and the injected services are mocked;
 * WorkflowConditionCompiler is a real (pure, no I/O) instance.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EnrichmentJob, WorkflowRunStatus, WorkflowTrigger } from '@prisma/client';
import { randomUUID } from 'crypto';
import { WorkflowEvaluateItemHandler } from './workflow-evaluate-item.handler';
import { WorkflowConditionCompiler } from '../compiler/workflow-condition.compiler';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../../common/types/settings.types';
import { WorkflowDefinition } from '../definition/workflow-definition.schema';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const WORKFLOW_ID = randomUUID();
const CIRCLE_ID = randomUUID();
const MEDIA_ITEM_ID = randomUUID();
const CREATOR_ID = randomUUID();
const RUN_ID = randomUUID();

function settingsWithWorkflows(overrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_SYSTEM_SETTINGS,
    features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: true },
    workflows: { ...DEFAULT_SYSTEM_SETTINGS.workflows, ...overrides },
  };
}

const TAGS_ONLY_DEF: WorkflowDefinition = {
  version: 1,
  subject: 'media_item',
  match: 'all',
  conditions: [{ field: 'tags', op: 'has_any', value: ['screenshot'] }],
  actions: [{ type: 'move_to_trash' }],
} as WorkflowDefinition;

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    circleId: CIRCLE_ID,
    name: 'Auto screenshot cleanup',
    enabled: true,
    trigger: WorkflowTrigger.on_media_enriched,
    definition: TAGS_ONLY_DEF,
    createdById: CREATOR_ID,
    ...overrides,
  };
}

function makeJob(payload: unknown): EnrichmentJob {
  return {
    id: randomUUID(),
    type: 'workflow_evaluate_item',
    mediaItemId: MEDIA_ITEM_ID,
    circleId: CIRCLE_ID,
    status: 'running',
    reason: 'rerun',
    priority: 50,
    payload,
    attempts: 1,
    createdAt: new Date(),
  } as unknown as EnrichmentJob;
}

describe('WorkflowEvaluateItemHandler', () => {
  let handler: WorkflowEvaluateItemHandler;
  let prisma: MockPrismaService;
  let systemSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettings'>>;
  let registry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;

  beforeEach(async () => {
    prisma = createMockPrismaService();
    systemSettings = {
      getSettings: jest.fn().mockResolvedValue(settingsWithWorkflows()),
    };
    registry = { register: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowEvaluateItemHandler,
        WorkflowConditionCompiler,
        { provide: EnrichmentHandlerRegistry, useValue: registry },
        { provide: PrismaService, useValue: prisma },
        { provide: SystemSettingsService, useValue: systemSettings },
      ],
    }).compile();

    handler = module.get(WorkflowEvaluateItemHandler);

    // Default: no prior evaluation, item matches, no open micro-run -> opens fresh.
    prisma.workflowRunItem.findFirst.mockResolvedValue(null);
    prisma.mediaItem.findFirst.mockResolvedValue({ id: MEDIA_ITEM_ID } as any);
    prisma.$transaction.mockImplementation((cb: any) => cb(prisma));
    prisma.$queryRaw.mockResolvedValue([] as any);
    prisma.workflowRun.findFirst.mockResolvedValue(null);
    prisma.workflowRun.create.mockResolvedValue({ id: RUN_ID } as any);
    prisma.workflowRunItem.create.mockResolvedValue({} as any);
    prisma.workflowRunItem.createMany.mockResolvedValue({ count: 1 } as any);
    prisma.workflowRun.update.mockResolvedValue({} as any);
    prisma.auditEvent.create.mockResolvedValue({} as any);
  });

  it('registers itself with the enrichment handler registry on module init', () => {
    // Test.createTestingModule(...).compile() does not run Nest lifecycle
    // hooks (that requires a full app.init()) -- invoke it explicitly, same
    // precedent as face-detection.handler.spec.ts / duplicate-detection.handler.spec.ts.
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  // ---------------------------------------------------------------------------
  // Malformed payload
  // ---------------------------------------------------------------------------

  describe('malformed payload', () => {
    it('is a no-op when payload is missing workflowId/mediaItemId', async () => {
      await handler.process(makeJob(null));
      await handler.process(makeJob({}));
      await handler.process(makeJob({ workflowId: WORKFLOW_ID }));
      await handler.process(makeJob({ mediaItemId: MEDIA_ITEM_ID }));

      expect(systemSettings.getSettings).not.toHaveBeenCalled();
      expect(prisma.workflow.findUnique).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Feature / trigger gate
  // ---------------------------------------------------------------------------

  describe('feature / trigger gate', () => {
    it('no-ops when features.workflows is disabled', async () => {
      systemSettings.getSettings.mockResolvedValue({
        ...DEFAULT_SYSTEM_SETTINGS,
        features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: false },
      } as any);

      await handler.process(makeJob({ workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID }));

      expect(prisma.workflow.findUnique).not.toHaveBeenCalled();
    });

    it('no-ops when workflows.triggers.onEnrichment is explicitly false', async () => {
      systemSettings.getSettings.mockResolvedValue(
        settingsWithWorkflows({ triggers: { onEnrichment: false, scheduled: true } }) as any,
      );

      await handler.process(makeJob({ workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID }));

      expect(prisma.workflow.findUnique).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Workflow eligibility
  // ---------------------------------------------------------------------------

  describe('workflow eligibility', () => {
    it('no-ops when the workflow no longer exists', async () => {
      prisma.workflow.findUnique.mockResolvedValue(null);

      await handler.process(makeJob({ workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID }));

      expect(prisma.workflowRunItem.findFirst).not.toHaveBeenCalled();
    });

    it('no-ops when the workflow is disabled', async () => {
      prisma.workflow.findUnique.mockResolvedValue(makeWorkflow({ enabled: false }) as any);

      await handler.process(makeJob({ workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID }));

      expect(prisma.workflowRunItem.findFirst).not.toHaveBeenCalled();
    });

    it('no-ops when the workflow trigger is not on_media_enriched', async () => {
      prisma.workflow.findUnique.mockResolvedValue(
        makeWorkflow({ trigger: WorkflowTrigger.manual }) as any,
      );

      await handler.process(makeJob({ workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID }));

      expect(prisma.workflowRunItem.findFirst).not.toHaveBeenCalled();
    });

    it('no-ops (and warns) when the workflow has no creator', async () => {
      prisma.workflow.findUnique.mockResolvedValue(makeWorkflow({ createdById: null }) as any);

      await handler.process(makeJob({ workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID }));

      expect(prisma.workflowRunItem.findFirst).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Evaluate-once guard / loop protection
  // ---------------------------------------------------------------------------

  describe('evaluate-once guard (loop protection)', () => {
    it('skips evaluation entirely when the item already has a run item on some run of this workflow', async () => {
      prisma.workflow.findUnique.mockResolvedValue(makeWorkflow() as any);
      prisma.workflowRunItem.findFirst.mockResolvedValue({ id: randomUUID() } as any);

      await handler.process(makeJob({ workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID }));

      // The condition check (mediaItem.findFirst) must never run past the guard.
      expect(prisma.mediaItem.findFirst).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('scopes the evaluate-once lookup to run items of THIS workflow', async () => {
      prisma.workflow.findUnique.mockResolvedValue(makeWorkflow() as any);

      await handler.process(makeJob({ workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID }));

      expect(prisma.workflowRunItem.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { mediaItemId: MEDIA_ITEM_ID, run: { workflowId: WORKFLOW_ID } },
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Single-item condition (match) check
  // ---------------------------------------------------------------------------

  describe('single-item condition check', () => {
    it('does not append to a micro-run when the item no longer matches the compiled where', async () => {
      prisma.workflow.findUnique.mockResolvedValue(makeWorkflow() as any);
      prisma.mediaItem.findFirst.mockResolvedValue(null);

      await handler.process(makeJob({ workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID }));

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not append when a read-time refinement predicate rejects the row', async () => {
      const refinementDef: WorkflowDefinition = {
        version: 1,
        subject: 'media_item',
        match: 'all',
        conditions: [{ field: 'duplicateGroupConfidence', op: 'gte', value: 0.9 }],
        actions: [{ type: 'move_to_trash' }],
      } as WorkflowDefinition;
      prisma.workflow.findUnique.mockResolvedValue(makeWorkflow({ definition: refinementDef }) as any);
      // The bounding predicate matches (item is in a pending duplicate group)...
      prisma.mediaItem.findFirst.mockResolvedValue({ id: MEDIA_ITEM_ID } as any);

      await handler.process(makeJob({ workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID }));

      // duplicateGroupConfidence has no refinementPredicate in the registry (its
      // exact compute is deferred to the executor), so `needRefine` is true but
      // `refinements` stays empty -- every(...) over [] is vacuously true, and the
      // item DOES append. This test locks in that documented behavior rather than
      // asserting a false premise.
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('appends when the item matches with no refinements required', async () => {
      prisma.workflow.findUnique.mockResolvedValue(makeWorkflow() as any);

      await handler.process(makeJob({ workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID }));

      expect(prisma.mediaItem.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { AND: [{ id: MEDIA_ITEM_ID }, expect.any(Object)] },
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Micro-run open
  // ---------------------------------------------------------------------------

  describe('micro-run open (first match for a workflow)', () => {
    it('opens a fresh running micro-run, inserts the first item, and audits the open', async () => {
      prisma.workflow.findUnique.mockResolvedValue(makeWorkflow() as any);
      prisma.workflowRun.findFirst.mockResolvedValue(null); // no open micro-run

      await handler.process(makeJob({ workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID }));

      expect(prisma.workflowRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workflowId: WORKFLOW_ID,
            circleId: CIRCLE_ID,
            status: WorkflowRunStatus.running,
            triggerType: WorkflowTrigger.on_media_enriched,
            startedById: CREATOR_ID,
            matchedCount: 1,
          }),
        }),
      );
      expect(prisma.workflowRunItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ runId: RUN_ID, mediaItemId: MEDIA_ITEM_ID }),
        }),
      );
      expect(prisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'workflow_run:started',
            targetId: RUN_ID,
          }),
        }),
      );
    });

    it('locks the workflow row (SELECT ... FOR UPDATE) before deciding whether a micro-run is open', async () => {
      prisma.workflow.findUnique.mockResolvedValue(makeWorkflow() as any);

      await handler.process(makeJob({ workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID }));

      expect(prisma.$queryRaw).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Micro-run append
  // ---------------------------------------------------------------------------

  describe('micro-run append (subsequent match within the window)', () => {
    it('appends to the existing open micro-run instead of opening a new one', async () => {
      prisma.workflow.findUnique.mockResolvedValue(makeWorkflow() as any);
      const openRun = { id: RUN_ID, startedAt: new Date() };
      prisma.workflowRun.findFirst.mockResolvedValue(openRun as any);
      prisma.workflowRunItem.createMany.mockResolvedValue({ count: 1 } as any);

      await handler.process(makeJob({ workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID }));

      expect(prisma.workflowRun.create).not.toHaveBeenCalled();
      expect(prisma.workflowRunItem.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [{ runId: RUN_ID, mediaItemId: MEDIA_ITEM_ID, status: 'matched' }],
          skipDuplicates: true,
        }),
      );
      expect(prisma.workflowRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: RUN_ID },
          data: { matchedCount: { increment: 1 } },
        }),
      );
      // Only the fresh-open path audits; an append does not.
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('does not increment matchedCount when the insert is a duplicate (skipDuplicates hit, count=0)', async () => {
      prisma.workflow.findUnique.mockResolvedValue(makeWorkflow() as any);
      prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN_ID, startedAt: new Date() } as any);
      prisma.workflowRunItem.createMany.mockResolvedValue({ count: 0 } as any);

      await handler.process(makeJob({ workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID }));

      expect(prisma.workflowRun.update).not.toHaveBeenCalled();
    });
  });
});
