/**
 * Media Workflow Automation — Phase 4 Trigger Integration (DB-gated, issue
 * #142)
 *
 * NOTE: same pattern as workflows.integration.spec.ts (Phase 1) and
 * workflow-runs.integration.spec.ts (Phase 2) — useMockDatabase: true (mocked
 * Prisma via jest-mock-extended), no live PostgreSQL connection required.
 *
 * Phase 4 adds two UNATTENDED trigger types on top of the Phase 2 evaluate +
 * execute machinery: on_media_enriched (settlement-driven, via
 * WorkflowTriggerListener + WorkflowEvaluateItemHandler + rolling micro-runs
 * finalized by WorkflowMicroRunFinalizeTask) and scheduled (cron-driven, via
 * WorkflowScheduleTask). Both start a run through
 * WorkflowRunService.startUnattendedRun, which skips awaiting_approval
 * entirely (see workflow-run.service.ts's shouldBypassApproval docblock).
 *
 * Since there is no BullMQ-style real queue, and no real @Cron tick wait
 * (both @Cron tasks and the real EventEmitter2 ARE registered in this app's
 * DI graph via ScheduleModule.forRoot()/EventEmitterModule.forRoot(), but
 * waiting a full minute per test is impractical), each scenario drives the
 * EVENT LISTENER / TASK / QUEUE HANDLER methods directly against synthesized
 * Prisma rows and enrichment_jobs payloads — mirroring exactly what the real
 * event bus / cron ticks / worker would do, the same precedent
 * workflow-runs.integration.spec.ts uses for workflow_evaluate /
 * workflow_execute_batch.
 */

import request from 'supertest';
import { randomUUID } from 'crypto';
import { JobReason } from '@prisma/client';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockContributorUser, authHeader } from '../helpers/auth-mock.helper';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { WorkflowTriggerListener } from '../../src/workflows/runs/workflow-trigger.listener';
import { WorkflowEvaluateItemHandler } from '../../src/workflows/runs/workflow-evaluate-item.handler';
import { WorkflowMicroRunFinalizeTask } from '../../src/workflows/runs/workflow-micro-run-finalize.task';
import { WorkflowScheduleTask } from '../../src/workflows/runs/workflow-schedule.task';
import { WorkflowExecuteBatchHandler } from '../../src/workflows/runs/workflow-execute-batch.handler';
import { ObjectProcessedEvent } from '../../src/storage/processing/events/object-processed.event';
import { EnrichmentJobSettledEvent } from '../../src/enrichment/events/enrichment-job-settled.event';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CIRCLE_ID = '990e8400-e29b-41d4-a716-446655440001';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupCircleMocks(
  context: TestContext,
  userId: string,
  circleId: string,
  role: string,
): void {
  context.prismaMock.circle.findUnique.mockResolvedValue({ id: circleId });
  context.prismaMock.circleMember.findUnique.mockResolvedValue({
    circleId,
    userId,
    role,
    joinedAt: new Date(),
  });
}

/**
 * Enable features.workflows and populate the workflows.* settings block,
 * busting SystemSettingsService's 5s in-process cache — same pattern as the
 * Phase 1/2 integration specs.
 */
function setupWorkflowsSettings(
  context: TestContext,
  workflowsOverrides: Record<string, unknown> = {},
): void {
  context.prismaMock.systemSettings.findUnique.mockResolvedValue({
    id: 'settings-1',
    key: 'global',
    value: {
      ...DEFAULT_SYSTEM_SETTINGS,
      features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: true },
      workflows: { ...DEFAULT_SYSTEM_SETTINGS.workflows, ...workflowsOverrides },
    },
    version: 1,
    updatedAt: new Date(),
    updatedByUserId: null,
    updatedByUser: null,
  } as any);

  const settingsService = context.module.get(SystemSettingsService);
  (settingsService as any).settingsCache = null;
}

/** Grants any actor userId the given system permissions, for
 * WorkflowRunService.loadUserPermissions / WorkflowExecuteBatchHandler.loadActorPermissions
 * (both queried via userRole.findMany, independent of JWT-auth resolution). */
function setupActorPermissions(context: TestContext, perms: string[]): void {
  context.prismaMock.userRole.findMany.mockResolvedValue([
    { role: { rolePermissions: perms.map((name) => ({ permission: { name } })) } },
  ] as any);
}

/** Fake enrichment_jobs row shaped like the one the run engine enqueues. */
function makeEnrichmentJob(type: string, payload: Record<string, unknown>) {
  return {
    id: randomUUID(),
    type,
    mediaItemId: null,
    circleId: CIRCLE_ID,
    status: 'running',
    reason: 'rerun',
    priority: 0,
    payload,
    attempts: 1,
    createdAt: new Date(),
  } as any;
}

const moveToTrashDefinition = {
  version: 1,
  subject: 'media_item',
  match: 'all',
  conditions: [], // metadata-only dependency
  actions: [{ type: 'move_to_trash' }],
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Workflow Triggers Integration — Phase 4 (DB-gated)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();
    setupWorkflowsSettings(context);
    context.prismaMock.enrichmentJob.findFirst.mockResolvedValue(null);
    context.prismaMock.enrichmentJob.create.mockImplementation(
      async ({ data }: any) => ({ id: randomUUID(), ...data }) as any,
    );
    context.prismaMock.auditEvent.create.mockResolvedValue({} as any);
  });

  // =========================================================================
  // hard_delete rejected at definition-validation time for BOTH unattended
  // trigger types (POST /api/workflows)
  // =========================================================================

  describe('hard_delete rejected for unattended triggers at creation time', () => {
    it.each(['on_media_enriched', 'scheduled'])(
      'returns 400 for trigger "%s" with a hard_delete action',
      async (trigger) => {
        const contributor = await createMockContributorUser(context);
        setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');
        context.prismaMock.workflow.count.mockResolvedValue(0);

        const body: Record<string, unknown> = {
          circleId: CIRCLE_ID,
          name: `Auto purge (${trigger})`,
          trigger,
          definition: {
            version: 1,
            subject: 'media_item',
            match: 'all',
            conditions: [],
            actions: [{ type: 'hard_delete' }],
          },
        };
        if (trigger === 'scheduled') body.cronExpression = '0 3 * * *';

        const response = await request(context.app.getHttpServer())
          .post('/api/workflows')
          .set(authHeader(contributor.accessToken))
          .send(body)
          .expect(400);

        expect(response.body.message ?? response.body.error?.message ?? '').toEqual(
          expect.stringMatching(/only allowed on manual-trigger workflows/),
        );
        expect(context.prismaMock.workflow.create).not.toHaveBeenCalled();
      },
    );
  });

  // =========================================================================
  // on_media_enriched — end-to-end: settlement -> auto-evaluation ->
  // micro-run -> finalize -> execute batch applies the action
  // =========================================================================

  describe('on_media_enriched trigger — end-to-end', () => {
    it('a metadata-settled upload auto-evaluates, opens a micro-run, and the finalized micro-run trashes the matched item', async () => {
      setupWorkflowsSettings(context, { triggers: { onEnrichment: true, scheduled: true } });
      setupActorPermissions(context, ['media:write']);

      const workflowId = randomUUID();
      const mediaItemId = randomUUID();
      const storageObjectId = randomUUID();
      const creatorId = randomUUID();

      // -----------------------------------------------------------------------
      // 1. WorkflowTriggerListener reacts to the metadata (OBJECT_PROCESSED)
      //    settlement signal for a no-condition (metadata-only-dependency)
      //    on_media_enriched workflow, and enqueues workflow_evaluate_item.
      // -----------------------------------------------------------------------
      context.prismaMock.workflow.findMany.mockResolvedValue([
        { id: workflowId, definition: moveToTrashDefinition },
      ] as any);
      context.prismaMock.mediaItem.findUnique.mockImplementation(async ({ where }: any) => {
        if (where?.storageObjectId === storageObjectId) {
          return { id: mediaItemId, circleId: CIRCLE_ID };
        }
        if (where?.id === mediaItemId) {
          return { type: 'photo', burstGroupId: null, duplicateGroupId: null, socialMediaSource: null };
        }
        return null;
      });
      context.prismaMock.mediaTagStatus.findUnique.mockResolvedValue(null);
      context.prismaMock.mediaFaceStatus.findUnique.mockResolvedValue(null);
      context.prismaMock.locationSuggestion.findUnique.mockResolvedValue(null);
      context.prismaMock.enrichmentJob.findMany.mockResolvedValue([] as any);

      const listener = context.module.get(WorkflowTriggerListener);
      await listener.handleObjectProcessed(new ObjectProcessedEvent(storageObjectId));

      const evalItemCall = (context.prismaMock.enrichmentJob.create as jest.Mock).mock.calls.find(
        (c) => c[0].data.type === 'workflow_evaluate_item',
      );
      expect(evalItemCall).toBeDefined();
      expect(evalItemCall[0].data.payload).toEqual({ workflowId, mediaItemId });

      // -----------------------------------------------------------------------
      // 2. Drive WorkflowEvaluateItemHandler directly against the synthesized
      //    job -- the item matches (no conditions) and opens a fresh micro-run.
      // -----------------------------------------------------------------------
      context.prismaMock.workflow.findUnique.mockResolvedValue({
        id: workflowId,
        circleId: CIRCLE_ID,
        enabled: true,
        trigger: 'on_media_enriched',
        definition: moveToTrashDefinition,
        createdById: creatorId,
      } as any);
      context.prismaMock.workflowRunItem.findFirst.mockResolvedValue(null); // evaluate-once guard clear
      context.prismaMock.mediaItem.findFirst.mockResolvedValue({ id: mediaItemId } as any); // condition match
      context.prismaMock.$transaction.mockImplementation((cb: any) => cb(context.prismaMock));
      context.prismaMock.$queryRaw.mockResolvedValue([] as any);
      context.prismaMock.workflowRun.findFirst.mockResolvedValue(null); // no open micro-run yet

      const microRunId = randomUUID();
      const microRunStartedAt = new Date(Date.now() - 6 * 60_000); // 6 min ago (past the 5-min window)
      context.prismaMock.workflowRun.create.mockResolvedValue({
        id: microRunId,
        startedAt: microRunStartedAt,
      } as any);
      context.prismaMock.workflowRunItem.create.mockResolvedValue({} as any);

      const evalItemHandler = context.module.get(WorkflowEvaluateItemHandler);
      await evalItemHandler.process(makeEnrichmentJob('workflow_evaluate_item', evalItemCall[0].data.payload));

      expect(context.prismaMock.workflowRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workflowId,
            circleId: CIRCLE_ID,
            status: 'running',
            triggerType: 'on_media_enriched',
            startedById: creatorId,
            matchedCount: 1,
          }),
        }),
      );
      expect(context.prismaMock.workflowRunItem.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { runId: microRunId, mediaItemId, status: 'matched' } }),
      );

      // -----------------------------------------------------------------------
      // 3. WorkflowMicroRunFinalizeTask's tick claims the (now past-window)
      //    micro-run and enqueues its execute-batch job.
      // -----------------------------------------------------------------------
      context.prismaMock.workflowRun.findMany.mockResolvedValue([
        {
          id: microRunId,
          workflowId,
          circleId: CIRCLE_ID,
          triggerType: 'on_media_enriched',
          status: 'running',
          approvedAt: null,
          startedAt: microRunStartedAt,
          definitionSnapshot: moveToTrashDefinition,
        },
      ] as any);
      context.prismaMock.workflowRun.updateMany.mockResolvedValue({ count: 1 } as any); // race-safe claim
      context.prismaMock.workflowRunItem.count.mockResolvedValue(1); // 1 matched item
      context.prismaMock.workflowRunItem.findMany.mockResolvedValue([{ mediaItemId }] as any);

      const finalizeTask = context.module.get(WorkflowMicroRunFinalizeTask);
      await finalizeTask.handleTick();

      const executeCall = (context.prismaMock.enrichmentJob.create as jest.Mock).mock.calls.find(
        (c) => c[0].data.type === 'workflow_execute_batch',
      );
      expect(executeCall).toBeDefined();
      expect((executeCall[0].data.payload as any).runId).toBe(microRunId);
      expect((executeCall[0].data.payload as any).itemIds).toEqual([mediaItemId]);

      // -----------------------------------------------------------------------
      // 4. Drive WorkflowExecuteBatchHandler directly -- the item is trashed
      //    (move_to_trash) with NO awaiting_approval detour anywhere in this
      //    chain (Fix-1: unattended runs skip approval entirely), and the
      //    micro-run finalizes to 'completed'.
      // -----------------------------------------------------------------------
      context.prismaMock.workflowRun.findUnique.mockResolvedValue({
        id: microRunId,
        workflowId,
        circleId: CIRCLE_ID,
        status: 'running',
        triggerType: 'on_media_enriched',
        definitionSnapshot: moveToTrashDefinition,
        matchedCount: 1,
        approvedById: null,
        startedById: creatorId,
      } as any);
      context.prismaMock.workflowRunItem.updateMany.mockResolvedValue({ count: 1 } as any); // per-item claim
      context.prismaMock.mediaItem.findFirst.mockResolvedValue({ id: mediaItemId } as any); // drift re-validation
      context.prismaMock.mediaItem.deleteMany.mockResolvedValue({ count: 1 } as any); // bulkDelete apply
      context.prismaMock.workflowRunItem.count.mockResolvedValue(0); // none left matched -> finalize
      context.prismaMock.workflowRunItem.groupBy.mockResolvedValue([
        { status: 'applied', _count: { _all: 1 } },
      ] as any);

      const executeBatchHandler = context.module.get(WorkflowExecuteBatchHandler);
      await executeBatchHandler.process(
        makeEnrichmentJob('workflow_execute_batch', executeCall[0].data.payload),
      );

      const finalizeUpdate = (context.prismaMock.workflowRun.updateMany as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status === 'completed',
      );
      expect(finalizeUpdate).toBeDefined();
      // Never transitioned through awaiting_approval anywhere in this chain.
      expect(
        (context.prismaMock.workflowRun.update as jest.Mock).mock.calls.some(
          (c) => c[0].data?.status === 'awaiting_approval',
        ),
      ).toBe(false);
    });

    it('features.workflows disabled -> the metadata settlement signal never enqueues workflow_evaluate_item', async () => {
      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: { ...DEFAULT_SYSTEM_SETTINGS }, // features.workflows defaults to false
        version: 1,
        updatedAt: new Date(),
        updatedByUserId: null,
        updatedByUser: null,
      } as any);
      const settingsService = context.module.get(SystemSettingsService);
      (settingsService as any).settingsCache = null;

      const storageObjectId = randomUUID();
      context.prismaMock.mediaItem.findUnique.mockResolvedValue({
        id: randomUUID(),
        circleId: CIRCLE_ID,
      } as any);

      const listener = context.module.get(WorkflowTriggerListener);
      await listener.handleObjectProcessed(new ObjectProcessedEvent(storageObjectId));

      expect(context.prismaMock.workflow.findMany).not.toHaveBeenCalled();
      expect(
        (context.prismaMock.enrichmentJob.create as jest.Mock).mock.calls.some(
          (c) => c[0].data.type === 'workflow_evaluate_item',
        ),
      ).toBe(false);
    });

    it('workflows.triggers.onEnrichment=false -> the metadata settlement signal never enqueues workflow_evaluate_item even though a workflow exists', async () => {
      setupWorkflowsSettings(context, { triggers: { onEnrichment: false, scheduled: true } });

      const workflowId = randomUUID();
      const mediaItemId = randomUUID();
      const storageObjectId = randomUUID();
      context.prismaMock.workflow.findMany.mockResolvedValue([
        { id: workflowId, definition: moveToTrashDefinition },
      ] as any);
      context.prismaMock.mediaItem.findUnique.mockResolvedValue({
        id: mediaItemId,
        circleId: CIRCLE_ID,
      } as any);

      const listener = context.module.get(WorkflowTriggerListener);
      await listener.handleObjectProcessed(new ObjectProcessedEvent(storageObjectId));

      // Master switch short-circuits before the workflow lookup even runs.
      expect(context.prismaMock.workflow.findMany).not.toHaveBeenCalled();
      expect(
        (context.prismaMock.enrichmentJob.create as jest.Mock).mock.calls.some(
          (c) => c[0].data.type === 'workflow_evaluate_item',
        ),
      ).toBe(false);
    });
  });

  // =========================================================================
  // scheduled trigger — end-to-end: overlap skip, concurrency skip, happy path
  // =========================================================================

  describe('scheduled trigger — end-to-end', () => {
    function makeDueWorkflow(overrides: Record<string, unknown> = {}) {
      return {
        id: randomUUID(),
        circleId: CIRCLE_ID,
        name: 'Nightly purge',
        trigger: 'scheduled',
        enabled: true,
        cronExpression: '0 3 * * *',
        nextRunAt: new Date(Date.now() - 60_000), // already due
        definition: moveToTrashDefinition,
        createdById: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      };
    }

    it('overlap guard: skips starting a run when one is already active for the workflow, still rolls nextRunAt forward', async () => {
      const workflow = makeDueWorkflow();
      context.prismaMock.workflow.findMany.mockResolvedValue([workflow] as any);
      context.prismaMock.workflowRun.count.mockResolvedValueOnce(1); // overlap: active run exists
      context.prismaMock.workflow.update.mockResolvedValue({} as any);

      const scheduleTask = context.module.get(WorkflowScheduleTask);
      await scheduleTask.handleTick();

      expect(context.prismaMock.workflowRun.create).not.toHaveBeenCalled();
      const updateCall = (context.prismaMock.workflow.update as jest.Mock).mock.calls.find(
        (c) => c[0].where.id === workflow.id,
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[0].data.nextRunAt.getTime()).toBeGreaterThan(workflow.nextRunAt.getTime());
    });

    it('concurrency guard: skips starting a run once the app-wide active-run count meets workflows.maxConcurrentRuns, still rolls nextRunAt forward', async () => {
      setupWorkflowsSettings(context, { maxConcurrentRuns: 2 });
      const workflow = makeDueWorkflow();
      context.prismaMock.workflow.findMany.mockResolvedValue([workflow] as any);
      context.prismaMock.workflowRun.count
        .mockResolvedValueOnce(0) // overlap check: clear
        .mockResolvedValueOnce(2); // app-wide concurrency check: at the cap
      context.prismaMock.workflow.update.mockResolvedValue({} as any);

      const scheduleTask = context.module.get(WorkflowScheduleTask);
      await scheduleTask.handleTick();

      expect(context.prismaMock.workflowRun.create).not.toHaveBeenCalled();
      expect(context.prismaMock.workflow.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: workflow.id } }),
      );
    });

    it('happy path: starts a due workflow straight to execution (no awaiting_approval stop) and advances nextRunAt', async () => {
      setupActorPermissions(context, ['media:write']);
      const workflow = makeDueWorkflow();
      context.prismaMock.workflow.findMany.mockResolvedValue([workflow] as any);
      context.prismaMock.workflowRun.count.mockResolvedValue(0); // overlap + concurrency both clear
      const createdRunId = randomUUID();
      context.prismaMock.workflowRun.create.mockResolvedValue({
        id: createdRunId,
        circleId: CIRCLE_ID,
        status: 'evaluating',
      } as any);
      context.prismaMock.workflow.update.mockResolvedValue({} as any);

      const scheduleTask = context.module.get(WorkflowScheduleTask);
      await scheduleTask.handleTick();

      const runCreateCall = (context.prismaMock.workflowRun.create as jest.Mock).mock.calls[0];
      expect(runCreateCall[0].data).toMatchObject({
        workflowId: workflow.id,
        circleId: CIRCLE_ID,
        status: 'evaluating',
        triggerType: 'scheduled',
      });
      // startUnattendedRun enqueues workflow_evaluate exactly like a manual run
      // -- the unattended-vs-manual distinction only affects the LATER
      // approval-bypass decision inside WorkflowEvaluateHandler, not evaluate
      // enqueueing itself.
      const evalCall = (context.prismaMock.enrichmentJob.create as jest.Mock).mock.calls.find(
        (c) => c[0].data.type === 'workflow_evaluate',
      );
      expect(evalCall).toBeDefined();
      expect((evalCall[0].data.payload as any).runId).toBe(createdRunId);
      expect(context.prismaMock.workflow.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: workflow.id },
          data: { nextRunAt: expect.any(Date) },
        }),
      );
    });
  });
});
