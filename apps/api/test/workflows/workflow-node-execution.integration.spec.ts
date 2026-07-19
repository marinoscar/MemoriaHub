/**
 * Media Workflow Automation — Phase 6 node-execution integration (DB-gated,
 * issue #144).
 *
 * Exercises the FULL HTTP node data-plane for `workflow_execute_batch`:
 *   1. `POST /api/nodes/:id/claim` — a registered node claims a job and
 *      receives the frozen action list via `params.actions`.
 *   2. `POST /api/nodes/:id/jobs/:jobId/result` — the node submits an
 *      (advisory) result, which routes through `NodesService.submitJobResult`
 *      -> the REAL, DI-registered `WorkflowExecuteBatchHandler.persistNodeResult`
 *      -> `EnrichmentTerminalService.completeSucceeded`, exactly as production
 *      does. Only PrismaService is mocked (jest-mock-extended) — every other
 *      service in the chain (compiler, executor, media/circle services, nodes
 *      service, terminal service) is the real DI-wired instance, mirroring the
 *      pattern in workflow-runs.integration.spec.ts.
 *
 * NOTE: `mockPermissions` (test/fixtures/test-data.factory.ts) has no
 * `jobs:read` / `jobs:write` entries, so `createMockContributorUser` alone
 * cannot authenticate against `/api/nodes/*` (every route there requires
 * `jobs:write`). `grantNodePermissions` below layers those two permissions
 * onto the JWT-resolved user row directly, without touching the shared
 * fixture (a real deployment would instead mint a dedicated `nod_`/PAT
 * credential for this — see docs/specs/distributed-nodes.md).
 */

import request from 'supertest';
import { randomUUID } from 'crypto';
import { EnrichmentJob } from '@prisma/client';
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
import { WorkflowExecuteBatchHandler } from '../../src/workflows/runs/workflow-execute-batch.handler';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CIRCLE_ID = '990e8400-e29b-41d4-a716-446655440101';
const WORKFLOW_ID = '990e8400-e29b-41d4-a716-446655440102';
const NODE_ID = '990e8400-e29b-41d4-a716-446655440103';

// ---------------------------------------------------------------------------
// Shared helpers (mirrors test/workflows/workflow-runs.integration.spec.ts)
// ---------------------------------------------------------------------------

function setupCircleMocks(context: TestContext, userId: string, circleId: string, role: string): void {
  context.prismaMock.circle.findUnique.mockImplementation(async ({ where }: any) =>
    where.id === circleId ? { id: where.id } : null,
  );
  context.prismaMock.circleMember.findUnique.mockImplementation(async ({ where }: any) =>
    where.circleId_userId?.circleId === circleId
      ? { circleId, userId, role, joinedAt: new Date() }
      : null,
  );
}

function setupWorkflowsSettings(context: TestContext, overrides: Record<string, unknown> = {}): void {
  context.prismaMock.systemSettings.findUnique.mockResolvedValue({
    id: 'settings-1',
    key: 'global',
    value: {
      ...DEFAULT_SYSTEM_SETTINGS,
      features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: true },
      workflows: { ...DEFAULT_SYSTEM_SETTINGS.workflows, ...overrides },
    },
    version: 1,
    updatedAt: new Date(),
    updatedByUserId: null,
    updatedByUser: null,
  } as any);
  const settingsService = context.module.get(SystemSettingsService);
  (settingsService as any).settingsCache = null;
}

/** Grants the actor a role holding the given system permissions, resolved via
 * userRole.findMany — the query WorkflowExecuteBatchHandler.loadActorPermissions
 * uses, independent of the JWT-auth permission resolution below. */
function setupActorPermissions(context: TestContext, perms: string[]): void {
  context.prismaMock.userRole.findMany.mockResolvedValue([
    { role: { rolePermissions: perms.map((name) => ({ permission: { name } })) } },
  ] as any);
}

/**
 * Layers `jobs:write` + `jobs:read` onto the JWT-resolved user row for
 * `userId`, on top of whatever `createMockContributorUser` already set up —
 * see the file-header note on why this can't come from `rolePermissionsMap`.
 */
function grantNodePermissions(context: TestContext, userId: string): void {
  const base = (context.prismaMock.user.findUnique as jest.Mock).getMockImplementation();
  (context.prismaMock.user.findUnique as jest.Mock).mockImplementation(async (args: any) => {
    const result = base ? await base(args) : null;
    if (!result || result.id !== userId) return result;
    return {
      ...result,
      userRoles: result.userRoles.map((ur: any) => ({
        ...ur,
        role: {
          ...ur.role,
          rolePermissions: [
            ...ur.role.rolePermissions,
            { permission: { id: randomUUID(), name: 'jobs:write' } },
            { permission: { id: randomUUID(), name: 'jobs:read' } },
          ],
        },
      })),
    };
  });
}

function makeRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    workflowId: WORKFLOW_ID,
    circleId: CIRCLE_ID,
    status: 'running',
    triggerType: 'manual',
    definitionSnapshot: {
      version: 1,
      subject: 'media_item',
      match: 'all',
      conditions: [],
      actions: [{ type: 'set_favorite', value: true }],
    },
    matchedCount: 1,
    truncated: false,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedById: 'user-1',
    approvedById: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    approvedAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    lastError: null,
    ...overrides,
  };
}

/** A worker_nodes row owned by `ownerId`, eligible for workflow_execute_batch. */
function makeNodeRow(ownerId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: NODE_ID,
    name: 'test-node',
    hostname: 'test-host',
    platform: 'linux',
    cliVersion: '1.0.0',
    eligibleTypes: ['workflow_execute_batch'],
    concurrency: 1,
    status: 'online',
    capabilities: null,
    registeredAt: new Date(),
    lastHeartbeatAt: new Date(),
    createdById: ownerId,
    ...overrides,
  };
}

/** An enrichment_jobs row shaped like the one the run engine enqueues. */
function makeWorkflowJob(overrides: Record<string, unknown> = {}): EnrichmentJob {
  return {
    id: randomUUID(),
    type: 'workflow_execute_batch',
    mediaItemId: null,
    circleId: CIRCLE_ID,
    status: 'running',
    reason: 'rerun',
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: {},
    attempts: 1,
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: NODE_ID,
    leaseExpiresAt: new Date(Date.now() + 30 * 60_000),
    executor: 'node',
    ...overrides,
  } as unknown as EnrichmentJob;
}

/** Wires the Prisma calls the real `set_favorite` action path needs:
 * CircleMembershipService.assertCircleAccess (via setupCircleMocks),
 * MediaService.assertAllInCircle (mediaItem.findMany), and
 * MediaService.bulkUpdateMedia's write (mediaItem.updateMany). */
function mockSetFavoriteAction(context: TestContext, itemId: string): void {
  context.prismaMock.mediaItem.findMany.mockResolvedValue([{ id: itemId }] as any);
  context.prismaMock.mediaItem.updateMany.mockResolvedValue({ count: 1 } as any);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Workflow Node Execution Integration (DB-gated, issue #144)', () => {
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
    context.prismaMock.auditEvent.create.mockResolvedValue({} as any);
  });

  // =========================================================================
  // 1. Claim -> node result submission -> run counters advance like server
  //    execution (and the node's advisory intent is proven to be ignored).
  // =========================================================================

  describe('claim then submit result advances run counters identically to server execution', () => {
    it('drives the batch through the real persistNodeResult pipeline, ignoring the node-declared advisory outcome', async () => {
      const nodeOwner = await createMockContributorUser(context);
      grantNodePermissions(context, nodeOwner.id);
      setupCircleMocks(context, nodeOwner.id, CIRCLE_ID, 'collaborator');
      setupActorPermissions(context, ['media:write']);
      context.prismaMock.workerNode.findUnique.mockResolvedValue(makeNodeRow(nodeOwner.id) as any);

      const itemId = randomUUID();
      const run = makeRunRow({ approvedById: nodeOwner.id, startedById: nodeOwner.id });
      context.prismaMock.workflowRun.findUnique.mockResolvedValue(run as any);

      const job = makeWorkflowJob({ payload: { runId: run.id, itemIds: [itemId] } });
      // Claim SQL ($queryRaw, FOR UPDATE SKIP LOCKED) returns the one claimable row.
      (context.prismaMock.$queryRaw as jest.Mock).mockResolvedValue([job]);

      // --- 1a. POST /api/nodes/:id/claim ------------------------------------
      const claimResponse = await request(context.app.getHttpServer())
        .post(`/api/nodes/${NODE_ID}/claim`)
        .set(authHeader(nodeOwner.accessToken))
        .send({})
        .expect(201);

      expect(claimResponse.body.data.jobs).toHaveLength(1);
      const claimedEntry = claimResponse.body.data.jobs[0];
      expect(claimedEntry.job.id).toBe(job.id);
      // resolveJobParams folds the run's frozen action list into params.actions.
      expect((claimedEntry.params as any).actions).toEqual(run.definitionSnapshot.actions);
      expect((claimedEntry.params as any).runId).toBe(run.id);
      expect((claimedEntry.params as any).itemIds).toEqual([itemId]);
      expect(claimedEntry.inputUrl).toBeNull(); // global job, no mediaItemId

      // --- 1b. Node "computes" and submits a DELIBERATELY WRONG advisory ----
      // result (declares 'skipped'), proving persistNodeResult recomputes the
      // true outcome from job.payload rather than trusting the node.
      context.prismaMock.enrichmentJob.findUnique.mockResolvedValue(job as any); // held-by-node guard
      mockSetFavoriteAction(context, itemId);
      context.prismaMock.mediaItem.findFirst.mockResolvedValue({ id: itemId } as any); // drift revalidation: still matches
      context.prismaMock.workflowRunItem.updateMany.mockResolvedValue({ count: 1 } as any);
      context.prismaMock.workflowRunItem.count.mockResolvedValue(0); // nothing left 'matched' -> finalize
      context.prismaMock.workflowRunItem.groupBy.mockResolvedValue([
        { status: 'applied', _count: { _all: 1 } },
      ] as any);
      context.prismaMock.workflowRun.updateMany.mockResolvedValue({ count: 1 } as any);
      context.prismaMock.workflowRun.update.mockResolvedValue({} as any);

      const resultResponse = await request(context.app.getHttpServer())
        .post(`/api/nodes/${NODE_ID}/jobs/${job.id}/result`)
        .set(authHeader(nodeOwner.accessToken))
        .send({
          type: 'workflow_execute_batch',
          result: {
            runId: run.id,
            items: [{ mediaItemId: itemId, actionResults: [{ type: 'set_favorite', status: 'skipped' }] }],
          },
        })
        .expect(201);

      expect(resultResponse.body.data.ok).toBe(true);

      // Run counters reflect the REAL server-side outcome (applied — set_favorite
      // succeeded via the real MediaService.bulkUpdateMedia path), NOT the node's
      // advisory 'skipped' declaration.
      const counterUpdate = (context.prismaMock.workflowRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.succeededCount,
      );
      expect(counterUpdate).toBeDefined();
      expect(counterUpdate![0].data.succeededCount).toEqual({ increment: 1 });

      const itemFinalize = (context.prismaMock.workflowRunItem.updateMany as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(itemFinalize![0].data.status).toBe('applied');

      const runFinalize = (context.prismaMock.workflowRun.updateMany as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(runFinalize![0].data.status).toBe('completed');

      // The job itself completed via the shared terminal service.
      const jobFinalize = (context.prismaMock.enrichmentJob.update as jest.Mock).mock.calls.find(
        (c) => c[0].where.id === job.id,
      );
      expect(jobFinalize![0].data.status).toBe('succeeded');
    });
  });

  // =========================================================================
  // 2. Lease-expiry reap -> server re-claim -> no double-apply.
  // =========================================================================

  describe('lease-expiry reap -> server re-claim -> no double-apply', () => {
    it('rejects a late node result submission once the job is no longer held by that node (already reaped/re-claimed/completed)', async () => {
      const nodeOwner = await createMockContributorUser(context);
      grantNodePermissions(context, nodeOwner.id);
      context.prismaMock.workerNode.findUnique.mockResolvedValue(makeNodeRow(nodeOwner.id) as any);

      const itemId = randomUUID();
      const runId = randomUUID();
      const jobId = randomUUID();

      // The job was originally claimed by this node, but by the time the late
      // result arrives the lease reaper (or a fresh server claim) has already
      // moved it past this node's ownership: claimedByNodeId is no longer
      // NODE_ID (requeued to the server / a different claimant) and the row is
      // no longer 'running' under this node's lease.
      context.prismaMock.enrichmentJob.findUnique.mockResolvedValue(
        makeWorkflowJob({
          id: jobId,
          payload: { runId, itemIds: [itemId] },
          claimedByNodeId: null, // reaped and re-claimed elsewhere
          status: 'succeeded', // already completed by whichever executor re-claimed it
          leaseExpiresAt: new Date(Date.now() - 60_000), // expired
        }) as any,
      );

      const handler = context.module.get(WorkflowExecuteBatchHandler);
      const persistSpy = jest.spyOn(handler, 'persistNodeResult');

      const response = await request(context.app.getHttpServer())
        .post(`/api/nodes/${NODE_ID}/jobs/${jobId}/result`)
        .set(authHeader(nodeOwner.accessToken))
        .send({
          type: 'workflow_execute_batch',
          result: {
            runId,
            items: [{ mediaItemId: itemId, actionResults: [{ type: 'set_favorite', status: 'applied' }] }],
          },
        })
        .expect(409);

      expect(response.body.message ?? response.body.error).toBeDefined();
      // The guard rejects BEFORE persistNodeResult is ever invoked -- no
      // double-apply of an already-terminal item is possible via this path.
      expect(persistSpy).not.toHaveBeenCalled();
      // No run-item or run mutation was attempted either.
      expect(context.prismaMock.workflowRunItem.updateMany).not.toHaveBeenCalled();
      expect(context.prismaMock.workflowRun.updateMany).not.toHaveBeenCalled();

      persistSpy.mockRestore();
    });
  });

  // =========================================================================
  // 3. Parity: server-executed batch vs. node-submitted-result batch produce
  //    IDENTICAL workflow_run_items outcomes for the same input.
  // =========================================================================

  describe('parity between server execution and node-submitted-result execution', () => {
    it('produces identical per-item outcome (status + actionResults) whether process() or persistNodeResult() drives the batch', async () => {
      const nodeOwner = await createMockContributorUser(context);
      grantNodePermissions(context, nodeOwner.id);
      setupCircleMocks(context, nodeOwner.id, CIRCLE_ID, 'collaborator');
      setupActorPermissions(context, ['media:write']);
      context.prismaMock.workerNode.findUnique.mockResolvedValue(makeNodeRow(nodeOwner.id) as any);

      const handler = context.module.get(WorkflowExecuteBatchHandler);

      // --- Server-executed run: handler.process() directly, mirroring
      // exactly what the in-process worker does with a claimed row. ---------
      const serverItemId = randomUUID();
      const serverRun = makeRunRow({ approvedById: nodeOwner.id, startedById: nodeOwner.id });
      context.prismaMock.workflowRun.findUnique.mockResolvedValue(serverRun as any);
      mockSetFavoriteAction(context, serverItemId);
      context.prismaMock.mediaItem.findFirst.mockResolvedValue({ id: serverItemId } as any);
      context.prismaMock.workflowRunItem.updateMany.mockResolvedValue({ count: 1 } as any);
      context.prismaMock.workflowRunItem.count.mockResolvedValue(0);
      context.prismaMock.workflowRunItem.groupBy.mockResolvedValue([
        { status: 'applied', _count: { _all: 1 } },
      ] as any);
      context.prismaMock.workflowRun.updateMany.mockResolvedValue({ count: 1 } as any);
      context.prismaMock.workflowRun.update.mockResolvedValue({} as any);

      await handler.process(
        makeWorkflowJob({
          payload: { runId: serverRun.id, itemIds: [serverItemId] },
          executor: 'server',
          claimedByNodeId: null,
        }) as any,
      );

      const serverFinalize = (context.prismaMock.workflowRunItem.updateMany as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(serverFinalize).toBeDefined();
      const serverOutcome = {
        status: serverFinalize![0].data.status,
        actionResults: serverFinalize![0].data.actionResults,
      };

      jest.clearAllMocks();
      // Re-establish the mocks jest.clearAllMocks() just wiped (implementations
      // set via mockImplementation survive clearAllMocks in this Jest config,
      // but resolved-value mocks do not -- reset every one used below).
      context.prismaMock.workflowRun.findUnique.mockResolvedValue(undefined as any);
      setupCircleMocks(context, nodeOwner.id, CIRCLE_ID, 'collaborator');
      setupActorPermissions(context, ['media:write']);

      // --- Node-executed run: an identical action list against a DIFFERENT
      // item, driven end-to-end through claim -> submitJobResult. -----------
      const nodeItemId = randomUUID();
      const nodeRun = makeRunRow({ approvedById: nodeOwner.id, startedById: nodeOwner.id });
      context.prismaMock.workflowRun.findUnique.mockResolvedValue(nodeRun as any);

      const nodeJob = makeWorkflowJob({ payload: { runId: nodeRun.id, itemIds: [nodeItemId] } });
      (context.prismaMock.$queryRaw as jest.Mock).mockResolvedValue([nodeJob]);

      await request(context.app.getHttpServer())
        .post(`/api/nodes/${NODE_ID}/claim`)
        .set(authHeader(nodeOwner.accessToken))
        .send({})
        .expect(201);

      context.prismaMock.enrichmentJob.findUnique.mockResolvedValue(nodeJob as any);
      mockSetFavoriteAction(context, nodeItemId);
      context.prismaMock.mediaItem.findFirst.mockResolvedValue({ id: nodeItemId } as any);
      context.prismaMock.workflowRunItem.updateMany.mockResolvedValue({ count: 1 } as any);
      context.prismaMock.workflowRunItem.count.mockResolvedValue(0);
      context.prismaMock.workflowRunItem.groupBy.mockResolvedValue([
        { status: 'applied', _count: { _all: 1 } },
      ] as any);
      context.prismaMock.workflowRun.updateMany.mockResolvedValue({ count: 1 } as any);
      context.prismaMock.workflowRun.update.mockResolvedValue({} as any);

      await request(context.app.getHttpServer())
        .post(`/api/nodes/${NODE_ID}/jobs/${nodeJob.id}/result`)
        .set(authHeader(nodeOwner.accessToken))
        .send({
          type: 'workflow_execute_batch',
          // Intentionally a DIFFERENT advisory than the server path's real
          // outcome, to prove the persisted outcome is not derived from it.
          result: {
            runId: nodeRun.id,
            items: [{ mediaItemId: nodeItemId, actionResults: [{ type: 'set_favorite', status: 'pending' }] }],
          },
        })
        .expect(201);

      const nodeFinalize = (context.prismaMock.workflowRunItem.updateMany as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(nodeFinalize).toBeDefined();
      const nodeOutcome = {
        status: nodeFinalize![0].data.status,
        actionResults: nodeFinalize![0].data.actionResults,
      };

      // Same action list + same (mocked) real-world result -> identical
      // persisted per-item outcome, regardless of which entrypoint drove it.
      expect(nodeOutcome).toEqual(serverOutcome);
    });
  });
});
