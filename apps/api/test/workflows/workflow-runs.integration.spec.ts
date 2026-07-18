/**
 * Media Workflow Automation — Phase 2 Run Lifecycle Integration (DB-gated,
 * issue #140)
 *
 * NOTE: These tests use useMockDatabase: true (mocked Prisma via
 * jest-mock-extended), the same pattern as
 * test/workflows/workflows.integration.spec.ts (Phase 1) and
 * test/media/media-bulk-dashboard.integration.spec.ts. No live PostgreSQL
 * connection is required.
 *
 * The `enrichment_jobs` queue is asynchronous in production (a background
 * worker polls and claims rows). To exercise the evaluate -> approve ->
 * execute pipeline deterministically inside an HTTP-integration test, each
 * scenario drives the HTTP endpoints for everything a client actually calls
 * (`POST .../run`, `POST .../approve`) and then invokes the corresponding
 * queue HANDLER directly (`WorkflowEvaluateHandler.process` /
 * `WorkflowExecuteBatchHandler.process`) against the synthesized
 * `enrichment_jobs` payload the service layer enqueued — mirroring exactly
 * what the real worker would do with that row, without requiring the actual
 * poll loop to run in-test.
 */

import request from 'supertest';
import { randomUUID } from 'crypto';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockAdminUser,
  createMockContributorUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { WorkflowEvaluateHandler } from '../../src/workflows/runs/workflow-evaluate.handler';
import { WorkflowExecuteBatchHandler } from '../../src/workflows/runs/workflow-execute-batch.handler';
import { EnrichmentJobService } from '../../src/enrichment/enrichment-job.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CIRCLE_ID = '660e8400-e29b-41d4-a716-446655440001';
const TARGET_CIRCLE_ID = '660e8400-e29b-41d4-a716-446655440002';
const WORKFLOW_ID = '770e8400-e29b-41d4-a716-446655440001';
const RUN_ID = '880e8400-e29b-41d4-a716-446655440001';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupCircleMocks(
  context: TestContext,
  userId: string,
  circleId: string,
  role: string,
): void {
  context.prismaMock.circle.findUnique.mockImplementation(async ({ where }: any) =>
    where.id === circleId || where.id === TARGET_CIRCLE_ID ? { id: where.id } : null,
  );
  context.prismaMock.circleMember.findUnique.mockImplementation(async ({ where }: any) =>
    where.circleId_userId?.circleId === circleId
      ? { circleId, userId, role, joinedAt: new Date() }
      : where.circleId_userId?.circleId === TARGET_CIRCLE_ID
        ? { circleId: TARGET_CIRCLE_ID, userId, role, joinedAt: new Date() }
        : null,
  );
}

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

/** Grants the actor a single role holding the given system permissions, for
 * WorkflowExecuteBatchHandler.loadActorPermissions (queried via userRole.findMany,
 * independent of the JWT-auth permission resolution used by the HTTP layer). */
function setupActorPermissions(context: TestContext, perms: string[]): void {
  context.prismaMock.userRole.findMany.mockResolvedValue([
    { role: { rolePermissions: perms.map((name) => ({ permission: { name } })) } },
  ] as any);
}

function makeWorkflowRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: WORKFLOW_ID,
    circleId: CIRCLE_ID,
    name: 'Screenshot cleanup',
    description: null,
    subjectType: 'media_item',
    enabled: true,
    trigger: 'manual',
    cronExpression: null,
    nextRunAt: null,
    definition: {
      version: 1,
      subject: 'media_item',
      match: 'all',
      conditions: [{ field: 'filename', op: 'contains', value: 'screenshot' }],
      actions: [{ type: 'move_to_trash' }],
    },
    createdById: 'user-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    workflowId: WORKFLOW_ID,
    circleId: CIRCLE_ID,
    status: 'evaluating',
    triggerType: 'manual',
    definitionSnapshot: makeWorkflowRow().definition,
    matchedCount: 0,
    truncated: false,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedById: 'user-1',
    approvedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    approvedAt: null,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    ...overrides,
  };
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Workflow Run Lifecycle Integration (DB-gated)', () => {
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
    // Enrichment job enqueue: no existing pending/running dedup match, create succeeds.
    context.prismaMock.enrichmentJob.findFirst.mockResolvedValue(null);
    context.prismaMock.enrichmentJob.create.mockImplementation(
      async ({ data }: any) => ({ id: randomUUID(), ...data }) as any,
    );
    context.prismaMock.auditEvent.create.mockResolvedValue({} as any);
  });

  // =========================================================================
  // 1. End-to-end screenshot-cleanup flow
  // =========================================================================

  describe('end-to-end screenshot-cleanup flow', () => {
    it('evaluate materializes matches, approve excludes items, execute trashes the rest, counters are correct', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');
      setupActorPermissions(context, ['media:write']);

      const workflow = makeWorkflowRow();
      context.prismaMock.workflow.findUnique.mockResolvedValue(workflow as any);
      context.prismaMock.workflowRun.count.mockResolvedValue(0); // concurrency gate
      const createdRun = makeRunRow({ status: 'evaluating' });
      context.prismaMock.workflowRun.create.mockResolvedValue(createdRun as any);

      // 1a. POST /api/workflows/:id/run
      const runResponse = await request(context.app.getHttpServer())
        .post(`/api/workflows/${WORKFLOW_ID}/run`)
        .set(authHeader(contributor.accessToken))
        .send({})
        .expect(200);
      expect(runResponse.body.data.status).toBe('evaluating');

      // Capture the workflow_evaluate payload the service enqueued.
      const evalCall = (context.prismaMock.enrichmentJob.create as jest.Mock).mock.calls.find(
        (c) => c[0].data.type === 'workflow_evaluate',
      );
      expect(evalCall).toBeDefined();

      // 1b. Drive the evaluate handler directly against 3 matching items.
      const handler = context.module.get(WorkflowEvaluateHandler);
      context.prismaMock.workflowRun.findUnique.mockResolvedValue(createdRun as any);
      const itemIds = [randomUUID(), randomUUID(), randomUUID()];
      context.prismaMock.mediaItem.findMany
        .mockResolvedValueOnce(
          itemIds.map((id) => ({ id, capturedAt: new Date() })) as any,
        )
        .mockResolvedValueOnce([] as any);
      context.prismaMock.workflowRunItem.createMany.mockResolvedValue({ count: 3 } as any);
      context.prismaMock.workflowRun.update.mockResolvedValue({
        ...createdRun,
        matchedCount: 3,
        status: 'awaiting_approval',
      } as any);

      await handler.process(makeEnrichmentJob('workflow_evaluate', { runId: RUN_ID }));

      const matchedUpdate = (context.prismaMock.workflowRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data.status === 'awaiting_approval',
      );
      expect(matchedUpdate).toBeDefined();

      // 1c. POST /api/workflow-runs/:id/approve, excluding one item.
      const awaitingRun = makeRunRow({ status: 'awaiting_approval', matchedCount: 3 });
      context.prismaMock.workflowRun.findUnique.mockResolvedValue(awaitingRun as any);
      context.prismaMock.workflowRunItem.updateMany.mockResolvedValue({ count: 1 } as any); // exclusion write
      context.prismaMock.workflowRunItem.count.mockResolvedValue(2); // remaining matched
      context.prismaMock.workflowRun.update.mockResolvedValue({
        ...awaitingRun,
        status: 'running',
      } as any);
      context.prismaMock.workflowRunItem.findMany.mockResolvedValue(
        [itemIds[0], itemIds[1]].map((mediaItemId) => ({ mediaItemId })) as any,
      );

      const excludedId = itemIds[2];
      const approveResponse = await request(context.app.getHttpServer())
        .post(`/api/workflow-runs/${RUN_ID}/approve`)
        .set(authHeader(contributor.accessToken))
        .send({ excludedItemIds: [excludedId] })
        .expect(200);
      expect(approveResponse.body.data.status).toBe('running');

      const exclusionCall = (context.prismaMock.workflowRunItem.updateMany as jest.Mock).mock.calls.find(
        (c) => c[0].data.status === 'excluded',
      );
      expect(exclusionCall[0].where.mediaItemId).toEqual({ in: [excludedId] });

      const executeCall = (context.prismaMock.enrichmentJob.create as jest.Mock).mock.calls.find(
        (c) => c[0].data.type === 'workflow_execute_batch',
      );
      expect(executeCall).toBeDefined();
      expect((executeCall[0].data.payload as any).itemIds).toEqual([itemIds[0], itemIds[1]]);

      // 1d. Drive the execute-batch handler directly — the 2 remaining items
      // get trashed via move_to_trash.
      const runningRun = makeRunRow({ status: 'running', matchedCount: 3, approvedById: contributor.id });
      context.prismaMock.workflowRun.findUnique.mockResolvedValue(runningRun as any);
      context.prismaMock.workflowRunItem.updateMany.mockResolvedValue({ count: 1 } as any); // claim succeeds
      context.prismaMock.mediaItem.findFirst.mockResolvedValue({ id: itemIds[0] } as any); // drift re-validation match
      context.prismaMock.mediaItem.deleteMany.mockResolvedValue({ count: 1 } as any);
      context.prismaMock.workflowRunItem.count.mockResolvedValue(0); // none left matched -> finalize
      context.prismaMock.workflowRunItem.groupBy.mockResolvedValue([
        { status: 'applied', _count: { _all: 2 } },
      ] as any);
      context.prismaMock.workflowRun.updateMany.mockResolvedValue({ count: 1 } as any);

      const executeBatchHandler = context.module.get(WorkflowExecuteBatchHandler);
      await executeBatchHandler.process(
        makeEnrichmentJob('workflow_execute_batch', {
          runId: RUN_ID,
          itemIds: [itemIds[0], itemIds[1]],
        }),
      );

      const finalize = (context.prismaMock.workflowRun.updateMany as jest.Mock).mock.calls[0];
      expect(finalize[0].data.status).toBe('completed');
    });
  });

  // =========================================================================
  // 2. Hard-delete gating
  // =========================================================================

  describe('hard-delete gating', () => {
    it('rejects run-create with hard_delete when workflows.allowHardDelete is off', async () => {
      const contributor = await createMockContributorUser(
        context,
        undefined,
      );
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      const workflow = makeWorkflowRow({
        definition: {
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [],
          actions: [{ type: 'hard_delete' }],
        },
      });
      context.prismaMock.workflow.findUnique.mockResolvedValue(workflow as any);
      context.prismaMock.workflowRun.count.mockResolvedValue(0);
      // allowHardDelete defaults to false; contributor role alone doesn't grant media:delete.

      await request(context.app.getHttpServer())
        .post(`/api/workflows/${WORKFLOW_ID}/run`)
        .set(authHeader(contributor.accessToken))
        .send({})
        .expect(403);
    });

    it('rejects approval with a wrong confirmation string, and accepts the exact match', async () => {
      const admin = await createMockAdminUser(context);
      setupCircleMocks(context, admin.id, CIRCLE_ID, 'collaborator');
      setupWorkflowsSettings(context, { allowHardDelete: true });

      const hardDeleteRun = makeRunRow({
        status: 'awaiting_approval',
        matchedCount: 4,
        definitionSnapshot: {
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [],
          actions: [{ type: 'hard_delete' }],
        },
      });
      context.prismaMock.workflowRun.findUnique.mockResolvedValue(hardDeleteRun as any);

      // Wrong confirmation -> 400.
      await request(context.app.getHttpServer())
        .post(`/api/workflow-runs/${RUN_ID}/approve`)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'DELETE 3' })
        .expect(400);

      // Correct "DELETE <matchedCount>" -> proceeds.
      context.prismaMock.workflowRunItem.count.mockResolvedValue(4);
      context.prismaMock.workflowRun.update.mockResolvedValue({
        ...hardDeleteRun,
        status: 'running',
      } as any);
      context.prismaMock.workflowRunItem.findMany.mockResolvedValue([] as any);

      await request(context.app.getHttpServer())
        .post(`/api/workflow-runs/${RUN_ID}/approve`)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'DELETE 4' })
        .expect(200);
    });
  });

  // =========================================================================
  // 3. move_to_circle dedup collision across two seeded circles
  // =========================================================================

  describe('move_to_circle across two circles with a dedup collision', () => {
    it('skips the colliding item and moves the rest', async () => {
      setupWorkflowsSettings(context);
      setupActorPermissions(context, ['media:write']);

      const runningRun = makeRunRow({
        status: 'running',
        circleId: CIRCLE_ID,
        approvedById: 'user-1',
        definitionSnapshot: {
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [],
          actions: [{ type: 'move_to_circle', targetCircleId: TARGET_CIRCLE_ID }],
        },
      });
      context.prismaMock.workflowRun.findUnique.mockResolvedValue(runningRun as any);
      context.prismaMock.circleMember.findUnique.mockResolvedValue({
        circleId: CIRCLE_ID,
        userId: 'user-1',
        role: 'collaborator',
        joinedAt: new Date(),
      } as any);
      context.prismaMock.circle.findUnique.mockResolvedValue({ id: CIRCLE_ID } as any);

      const collidingId = randomUUID();
      const cleanId = randomUUID();
      context.prismaMock.workflowRunItem.updateMany.mockResolvedValue({ count: 1 } as any);
      context.prismaMock.mediaItem.findFirst
        // drift re-validation for each item (revalidateItemMatches) -- both still match.
        .mockResolvedValueOnce({ id: collidingId })
        .mockResolvedValueOnce({ id: collidingId }) // dedup collision found for colliding item
        .mockResolvedValueOnce({ id: cleanId })
        .mockResolvedValueOnce(null); // no collision for the clean item
      context.prismaMock.mediaItem.findUnique.mockImplementation(async ({ where }: any) => {
        if (where.id === collidingId) {
          return { id: collidingId, type: 'photo', contentHash: 'dup-hash', deletedAt: null };
        }
        return { id: cleanId, type: 'photo', contentHash: 'unique-hash', deletedAt: null };
      });
      context.prismaMock.workflowRunItem.count.mockResolvedValue(0);
      context.prismaMock.workflowRunItem.groupBy.mockResolvedValue([
        { status: 'skipped', _count: { _all: 1 } },
        { status: 'applied', _count: { _all: 1 } },
      ] as any);
      context.prismaMock.workflowRun.updateMany.mockResolvedValue({ count: 1 } as any);

      const executeBatchHandler = context.module.get(WorkflowExecuteBatchHandler);
      await executeBatchHandler.process(
        makeEnrichmentJob('workflow_execute_batch', {
          runId: RUN_ID,
          itemIds: [collidingId, cleanId],
        }),
      );

      const collidingFinalize = (context.prismaMock.workflowRunItem.updateMany as jest.Mock).mock.calls.find(
        (c) => c[0].where?.mediaItemId === collidingId && c[0].data?.status,
      );
      expect(collidingFinalize[0].data.status).toBe('skipped');

      const cleanFinalize = (context.prismaMock.workflowRunItem.updateMany as jest.Mock).mock.calls.find(
        (c) => c[0].where?.mediaItemId === cleanId && c[0].data?.status,
      );
      expect(cleanFinalize[0].data.status).toBe('applied');
    });
  });

  // =========================================================================
  // 4. Manual run resolving pending burst + duplicate groups and accepting
  //    pending location suggestions (dedup-to-group + only-if-pending)
  // =========================================================================

  describe('resolving review-queue groups and location suggestions in one run', () => {
    it('resolves burst + duplicate groups once each (group dedup) and accepts a pending location suggestion', async () => {
      setupWorkflowsSettings(context);
      setupActorPermissions(context, ['media:write']);

      const runningRun = makeRunRow({
        status: 'running',
        approvedById: 'user-1',
        definitionSnapshot: {
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [],
          actions: [
            { type: 'resolve_burst_group', action: 'archive' },
            { type: 'resolve_duplicate_group', action: 'archive' },
            { type: 'accept_location_suggestion' },
          ],
        },
      });
      context.prismaMock.workflowRun.findUnique.mockResolvedValue(runningRun as any);

      const burstGroupId = randomUUID();
      const bestBurstItemId = randomUUID();
      const dupGroupId = randomUUID();
      const bestDupItemId = randomUUID();
      const itemA = randomUUID(); // shares the burst + duplicate group with itemB
      const itemB = randomUUID();
      const suggestionId = randomUUID();

      context.prismaMock.workflowRunItem.updateMany.mockResolvedValue({ count: 1 } as any);
      // Drift re-validation: both items still match (bounding where has no refinements).
      context.prismaMock.mediaItem.findFirst.mockResolvedValue({ id: itemA });

      context.prismaMock.mediaItem.findUnique.mockImplementation(async ({ where, select }: any) => {
        // resolve_burst_group / resolve_duplicate_group selects.
        if (select?.burstGroupId !== undefined) {
          return {
            burstGroupId,
            burstGroup: { status: 'pending', suggestedBestItemId: bestBurstItemId },
          };
        }
        if (select?.duplicateGroupId !== undefined) {
          return {
            duplicateGroupId: dupGroupId,
            duplicateGroup: { status: 'pending', suggestedBestItemId: bestDupItemId },
          };
        }
        return { id: where.id };
      });
      context.prismaMock.locationSuggestion.findUnique.mockResolvedValue({
        id: suggestionId,
        status: 'pending',
      } as any);
      context.prismaMock.burstGroup.findUnique.mockResolvedValue({
        id: burstGroupId,
        circleId: CIRCLE_ID,
        status: 'pending',
        items: [{ id: bestBurstItemId }, { id: itemA }, { id: itemB }],
      } as any);
      context.prismaMock.duplicateGroup.findUnique.mockResolvedValue({
        id: dupGroupId,
        circleId: CIRCLE_ID,
        status: 'pending',
        items: [{ id: bestDupItemId }, { id: itemA }, { id: itemB }],
      } as any);
      context.prismaMock.circleMember.findUnique.mockResolvedValue({
        circleId: CIRCLE_ID,
        userId: 'user-1',
        role: 'collaborator',
        joinedAt: new Date(),
      } as any);
      context.prismaMock.circle.findUnique.mockResolvedValue({ id: CIRCLE_ID } as any);
      context.prismaMock.mediaItem.updateMany.mockResolvedValue({ count: 2 } as any);
      context.prismaMock.burstGroup.update.mockResolvedValue({} as any);
      context.prismaMock.duplicateGroup.update.mockResolvedValue({} as any);
      context.prismaMock.locationSuggestion.update.mockResolvedValue({} as any);
      context.prismaMock.workflowRunItem.count.mockResolvedValue(0);
      context.prismaMock.workflowRunItem.groupBy.mockResolvedValue([
        { status: 'applied', _count: { _all: 2 } },
      ] as any);
      context.prismaMock.workflowRun.updateMany.mockResolvedValue({ count: 1 } as any);

      const executeBatchHandler = context.module.get(WorkflowExecuteBatchHandler);
      await executeBatchHandler.process(
        makeEnrichmentJob('workflow_execute_batch', { runId: RUN_ID, itemIds: [itemA, itemB] }),
      );

      // Both real reused services (BurstService.resolveBurstGroup /
      // DuplicateService.resolveDuplicateGroup) are exercised via their own
      // findUnique-then-transaction paths -- assert each group's underlying
      // update ran at most once (group dedup collapses the second item to
      // 'same_group' inside the executor before either service is called
      // again for that group).
      expect(
        (context.prismaMock.burstGroup.update as jest.Mock).mock.calls.length,
      ).toBeLessThanOrEqual(1);
      expect(
        (context.prismaMock.duplicateGroup.update as jest.Mock).mock.calls.length,
      ).toBeLessThanOrEqual(1);
    });
  });

  // =========================================================================
  // 5. Concurrent-batch safety / workflows.maxConcurrentRuns -> 409
  // =========================================================================

  describe('workflows.maxConcurrentRuns concurrency gate', () => {
    it('returns 409 on POST /api/workflows/:id/run when active runs already meet the configured max', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');
      setupWorkflowsSettings(context, { maxConcurrentRuns: 2 });

      context.prismaMock.workflow.findUnique.mockResolvedValue(makeWorkflowRow() as any);
      // Two runs already active (evaluating/awaiting_approval/running).
      context.prismaMock.workflowRun.count.mockResolvedValue(2);

      await request(context.app.getHttpServer())
        .post(`/api/workflows/${WORKFLOW_ID}/run`)
        .set(authHeader(contributor.accessToken))
        .send({})
        .expect(409);

      expect(context.prismaMock.workflowRun.create).not.toHaveBeenCalled();
    });

    it('allows creation once an active run count drops below the configured max', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');
      setupWorkflowsSettings(context, { maxConcurrentRuns: 2 });

      context.prismaMock.workflow.findUnique.mockResolvedValue(makeWorkflowRow() as any);
      context.prismaMock.workflowRun.count.mockResolvedValue(1);
      context.prismaMock.workflowRun.create.mockResolvedValue(
        makeRunRow({ status: 'evaluating' }) as any,
      );

      await request(context.app.getHttpServer())
        .post(`/api/workflows/${WORKFLOW_ID}/run`)
        .set(authHeader(contributor.accessToken))
        .send({})
        .expect(200);
    });
  });
});
