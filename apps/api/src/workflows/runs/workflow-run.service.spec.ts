/**
 * Unit tests for WorkflowRunService (issue #140).
 *
 * Covers:
 *   - createRun: evaluating status + workflow_evaluate enqueue; the app-wide
 *     maxConcurrentRuns gate (ConflictException); workflow-not-found; gated
 *     action permission checks at create time.
 *   - approveRun: awaiting_approval -> running + execute-batch enqueue;
 *     non-awaiting-approval rejection; hard_delete confirmation string
 *     matching; excludedItemIds flip to 'excluded' and > 500 rejection.
 *   - cancelRun: non-terminal -> cancelled; terminal run rejection.
 *   - shouldBypassApproval: the full AND/AND/NOR gating matrix for the manual
 *     path, plus the Phase 4 (issue #142) unattended-trigger bypass rule --
 *     any triggerType !== 'manual' skips straight to execution regardless of
 *     requirePreview/gated actions, refusing only a manual_only action.
 *   - enqueueExecuteBatches: chunking by workflows.batchSize.
 *
 * No database required -- PrismaService and all injected services are mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { WorkflowRunStatus, WorkflowRunItemStatus, WorkflowTrigger } from '@prisma/client';
import { randomUUID } from 'crypto';
import { WorkflowRunService } from './workflow-run.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { CircleMembershipService } from '../../circles/circle-membership.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { MediaThumbnailService } from '../../media/media-thumbnail.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../../common/types/settings.types';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { WorkflowDefinition } from '../definition/workflow-definition.schema';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CIRCLE_ID = randomUUID();
const OTHER_CIRCLE_ID = randomUUID();
const WORKFLOW_ID = randomUUID();
const RUN_ID = randomUUID();
const USER_ID = randomUUID();

function makeUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: USER_ID,
    email: 'user@example.com',
    roles: ['Contributor'],
    permissions: [PERMISSIONS.MEDIA_WRITE],
    isActive: true,
    ...overrides,
  };
}

function screenshotDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    version: 1,
    subject: 'media_item',
    match: 'all',
    conditions: [{ field: 'filename', op: 'contains', value: 'screenshot' }],
    actions: [{ type: 'move_to_trash' }],
    ...overrides,
  } as WorkflowDefinition;
}

function makeWorkflow(overrides: Record<string, unknown> = {}) {
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
    definition: screenshotDefinition(),
    createdById: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    workflowId: WORKFLOW_ID,
    circleId: CIRCLE_ID,
    status: WorkflowRunStatus.awaiting_approval,
    triggerType: 'manual',
    definitionSnapshot: screenshotDefinition(),
    matchedCount: 10,
    truncated: false,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedById: USER_ID,
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

function settingsWithWorkflows(overrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_SYSTEM_SETTINGS,
    features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: true },
    workflows: { ...DEFAULT_SYSTEM_SETTINGS.workflows, ...overrides },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('WorkflowRunService', () => {
  let service: WorkflowRunService;
  let prisma: MockPrismaService;
  let systemSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettings'>>;
  let circleMembership: jest.Mocked<Pick<CircleMembershipService, 'assertCircleAccess'>>;
  let enrichmentJobs: jest.Mocked<Pick<EnrichmentJobService, 'enqueue'>>;
  let thumbnails: jest.Mocked<Pick<MediaThumbnailService, 'attachThumbnailUrls'>>;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    systemSettings = {
      getSettings: jest.fn().mockResolvedValue(settingsWithWorkflows()),
    };
    circleMembership = {
      assertCircleAccess: jest
        .fn()
        .mockResolvedValue({ role: 'collaborator', isSuperAdmin: false }),
    };
    enrichmentJobs = {
      enqueue: jest.fn().mockResolvedValue({ id: randomUUID() }),
    };
    thumbnails = {
      attachThumbnailUrls: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowRunService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemSettingsService, useValue: systemSettings },
        { provide: CircleMembershipService, useValue: circleMembership },
        { provide: EnrichmentJobService, useValue: enrichmentJobs },
        { provide: MediaThumbnailService, useValue: thumbnails },
      ],
    }).compile();

    service = module.get(WorkflowRunService);
  });

  // ---------------------------------------------------------------------------
  // createRun
  // ---------------------------------------------------------------------------

  describe('createRun', () => {
    it('creates a run in "evaluating" status and enqueues a workflow_evaluate job', async () => {
      prisma.workflow.findUnique.mockResolvedValue(makeWorkflow() as any);
      prisma.workflowRun.count.mockResolvedValue(0);
      prisma.workflowRun.create.mockResolvedValue(
        makeRun({ status: WorkflowRunStatus.evaluating }) as any,
      );
      prisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.createRun(WORKFLOW_ID, {}, makeUser());

      expect(result.status).toBe(WorkflowRunStatus.evaluating);
      expect(enrichmentJobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'workflow_evaluate',
          mediaItemId: null,
          circleId: CIRCLE_ID,
          payload: expect.objectContaining({ runId: result.runId }),
        }),
      );
      expect(prisma.auditEvent.create).toHaveBeenCalled();
    });

    it('throws NotFoundException when the workflow does not exist', async () => {
      prisma.workflow.findUnique.mockResolvedValue(null);

      await expect(service.createRun(WORKFLOW_ID, {}, makeUser())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ConflictException when active runs already meet workflows.maxConcurrentRuns', async () => {
      prisma.workflow.findUnique.mockResolvedValue(makeWorkflow() as any);
      // Default maxConcurrentRuns is 2.
      prisma.workflowRun.count.mockResolvedValue(2);

      await expect(service.createRun(WORKFLOW_ID, {}, makeUser())).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.workflowRun.create).not.toHaveBeenCalled();
    });

    it('allows creation when active runs are below a raised maxConcurrentRuns', async () => {
      systemSettings.getSettings.mockResolvedValue(
        settingsWithWorkflows({ maxConcurrentRuns: 5 }) as any,
      );
      prisma.workflow.findUnique.mockResolvedValue(makeWorkflow() as any);
      prisma.workflowRun.count.mockResolvedValue(4);
      prisma.workflowRun.create.mockResolvedValue(
        makeRun({ status: WorkflowRunStatus.evaluating }) as any,
      );

      await expect(service.createRun(WORKFLOW_ID, {}, makeUser())).resolves.toMatchObject({
        status: WorkflowRunStatus.evaluating,
      });
    });

    it('rejects hard_delete at create time when workflows.allowHardDelete is disabled', async () => {
      prisma.workflow.findUnique.mockResolvedValue(
        makeWorkflow({
          definition: screenshotDefinition({ actions: [{ type: 'hard_delete' }] }),
        }) as any,
      );
      prisma.workflowRun.count.mockResolvedValue(0);
      // allowHardDelete defaults to false.

      await expect(
        service.createRun(
          WORKFLOW_ID,
          {},
          makeUser({ permissions: [PERMISSIONS.MEDIA_WRITE, PERMISSIONS.MEDIA_DELETE] }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows hard_delete at create time when workflows.allowHardDelete is enabled and perms present', async () => {
      systemSettings.getSettings.mockResolvedValue(
        settingsWithWorkflows({ allowHardDelete: true }) as any,
      );
      prisma.workflow.findUnique.mockResolvedValue(
        makeWorkflow({
          definition: screenshotDefinition({ actions: [{ type: 'hard_delete' }] }),
        }) as any,
      );
      prisma.workflowRun.count.mockResolvedValue(0);
      prisma.workflowRun.create.mockResolvedValue(
        makeRun({ status: WorkflowRunStatus.evaluating }) as any,
      );

      await expect(
        service.createRun(
          WORKFLOW_ID,
          {},
          makeUser({ permissions: [PERMISSIONS.MEDIA_WRITE, PERMISSIONS.MEDIA_DELETE] }),
        ),
      ).resolves.toMatchObject({ status: WorkflowRunStatus.evaluating });
    });

    it('rejects move_to_circle at create time when the actor lacks target-circle collaborator access', async () => {
      prisma.workflow.findUnique.mockResolvedValue(
        makeWorkflow({
          definition: screenshotDefinition({
            actions: [{ type: 'move_to_circle', targetCircleId: OTHER_CIRCLE_ID }],
          }),
        }) as any,
      );
      prisma.workflowRun.count.mockResolvedValue(0);
      circleMembership.assertCircleAccess.mockImplementation(async (_u, circleId) => {
        if (circleId === OTHER_CIRCLE_ID) {
          throw new ForbiddenException('You are not a member of this circle');
        }
        return { role: 'collaborator', isSuperAdmin: false };
      });

      await expect(service.createRun(WORKFLOW_ID, {}, makeUser())).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // approveRun
  // ---------------------------------------------------------------------------

  describe('approveRun', () => {
    it('transitions awaiting_approval -> running and enqueues execute-batch jobs', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(
        makeRun({ status: WorkflowRunStatus.awaiting_approval }) as any,
      );
      prisma.workflowRun.update.mockResolvedValue(
        makeRun({ status: WorkflowRunStatus.running }) as any,
      );
      prisma.workflowRunItem.findMany.mockResolvedValue([
        { mediaItemId: randomUUID() },
        { mediaItemId: randomUUID() },
      ] as any);
      prisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.approveRun(RUN_ID, {}, makeUser());

      expect(result.status).toBe(WorkflowRunStatus.running);
      expect(enrichmentJobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'workflow_execute_batch' }),
      );
    });

    it('throws BadRequestException when the run is not awaiting_approval', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(
        makeRun({ status: WorkflowRunStatus.running }) as any,
      );

      await expect(service.approveRun(RUN_ID, {}, makeUser())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFoundException when the run does not exist', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(null);

      await expect(service.approveRun(RUN_ID, {}, makeUser())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects more than 500 excludedItemIds', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(
        makeRun({ status: WorkflowRunStatus.awaiting_approval }) as any,
      );
      const tooMany = Array.from({ length: 501 }, () => randomUUID());

      await expect(
        service.approveRun(RUN_ID, { excludedItemIds: tooMany }, makeUser()),
      ).rejects.toThrow(BadRequestException);
    });

    it('flips excludedItemIds from matched to excluded before counting remaining matches', async () => {
      prisma.workflowRun.findUnique.mockResolvedValue(
        makeRun({ status: WorkflowRunStatus.awaiting_approval, matchedCount: 3 }) as any,
      );
      prisma.workflowRunItem.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.workflowRunItem.count.mockResolvedValue(2);
      prisma.workflowRun.update.mockResolvedValue(
        makeRun({ status: WorkflowRunStatus.running }) as any,
      );
      prisma.workflowRunItem.findMany.mockResolvedValue([] as any);

      const excludedId = randomUUID();
      await service.approveRun(RUN_ID, { excludedItemIds: [excludedId] }, makeUser());

      expect(prisma.workflowRunItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            runId: RUN_ID,
            mediaItemId: { in: [excludedId] },
            status: WorkflowRunItemStatus.matched,
          }),
          data: { status: WorkflowRunItemStatus.excluded },
        }),
      );
    });

    describe('hard_delete confirmation', () => {
      function makeHardDeleteRun(matchedCount: number) {
        return makeRun({
          status: WorkflowRunStatus.awaiting_approval,
          matchedCount,
          definitionSnapshot: screenshotDefinition({ actions: [{ type: 'hard_delete' }] }),
        });
      }

      it('rejects a missing confirmation string', async () => {
        prisma.workflowRun.findUnique.mockResolvedValue(makeHardDeleteRun(7) as any);

        await expect(
          service.approveRun(
            RUN_ID,
            {},
            makeUser({ permissions: [PERMISSIONS.MEDIA_WRITE, PERMISSIONS.MEDIA_DELETE] }),
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('rejects a wrong confirmation string', async () => {
        prisma.workflowRun.findUnique.mockResolvedValue(makeHardDeleteRun(7) as any);

        await expect(
          service.approveRun(
            RUN_ID,
            { confirmation: 'DELETE 6' },
            makeUser({ permissions: [PERMISSIONS.MEDIA_WRITE, PERMISSIONS.MEDIA_DELETE] }),
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('accepts the exact "DELETE <matchedCount>" confirmation string', async () => {
        prisma.workflowRun.findUnique.mockResolvedValue(makeHardDeleteRun(7) as any);
        prisma.workflowRun.update.mockResolvedValue(
          makeRun({ status: WorkflowRunStatus.running }) as any,
        );
        prisma.workflowRunItem.findMany.mockResolvedValue([] as any);

        // allowHardDelete must also be enabled for re-authorization to pass.
        systemSettings.getSettings.mockResolvedValue(
          settingsWithWorkflows({ allowHardDelete: true }) as any,
        );

        const result = await service.approveRun(
          RUN_ID,
          { confirmation: 'DELETE 7' },
          makeUser({ permissions: [PERMISSIONS.MEDIA_WRITE, PERMISSIONS.MEDIA_DELETE] }),
        );
        expect(result.status).toBe(WorkflowRunStatus.running);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // cancelRun
  // ---------------------------------------------------------------------------

  describe('cancelRun', () => {
    it.each([
      WorkflowRunStatus.evaluating,
      WorkflowRunStatus.awaiting_approval,
      WorkflowRunStatus.running,
    ])('cancels a non-terminal run in status %s', async (status) => {
      prisma.workflowRun.findUnique.mockResolvedValue(makeRun({ status }) as any);
      prisma.workflowRun.update.mockResolvedValue(
        makeRun({ status: WorkflowRunStatus.cancelled }) as any,
      );

      const result = await service.cancelRun(RUN_ID, makeUser());
      expect(result.status).toBe(WorkflowRunStatus.cancelled);
      expect(prisma.workflowRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: WorkflowRunStatus.cancelled }),
        }),
      );
    });

    it.each([
      WorkflowRunStatus.completed,
      WorkflowRunStatus.completed_with_errors,
      WorkflowRunStatus.failed,
      WorkflowRunStatus.cancelled,
      WorkflowRunStatus.expired,
    ])('rejects cancelling an already-terminal run in status %s', async (status) => {
      prisma.workflowRun.findUnique.mockResolvedValue(makeRun({ status }) as any);

      await expect(service.cancelRun(RUN_ID, makeUser())).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.workflowRun.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // shouldBypassApproval
  // ---------------------------------------------------------------------------

  describe('shouldBypassApproval', () => {
    it('is false when definition.options.requirePreview is not explicitly false', () => {
      const def = screenshotDefinition({ options: undefined });
      const settings = settingsWithWorkflows({ requirePreview: false });
      expect(service.shouldBypassApproval(def, settings as any)).toBe(false);
    });

    it('is false when system workflows.requirePreview is not explicitly false', () => {
      const def = screenshotDefinition({ options: { requirePreview: false } });
      const settings = settingsWithWorkflows({ requirePreview: true });
      expect(service.shouldBypassApproval(def, settings as any)).toBe(false);
    });

    it('is true when both are explicitly false and no gated action is present', () => {
      const def = screenshotDefinition({
        options: { requirePreview: false },
        actions: [{ type: 'move_to_trash' }],
      });
      const settings = settingsWithWorkflows({ requirePreview: false });
      expect(service.shouldBypassApproval(def, settings as any)).toBe(true);
    });

    it('is false when a gated action (hard_delete) is present even with both flags false', () => {
      const def = screenshotDefinition({
        options: { requirePreview: false },
        actions: [{ type: 'hard_delete' }],
      });
      const settings = settingsWithWorkflows({ requirePreview: false, allowHardDelete: true });
      expect(service.shouldBypassApproval(def, settings as any)).toBe(false);
    });

    it('is false when a cross-circle action (move_to_circle) is present', () => {
      const def = screenshotDefinition({
        options: { requirePreview: false },
        actions: [{ type: 'move_to_circle', targetCircleId: OTHER_CIRCLE_ID }],
      });
      const settings = settingsWithWorkflows({ requirePreview: false });
      expect(service.shouldBypassApproval(def, settings as any)).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Phase 4 (issue #142): unattended-trigger bypass rule.
    //
    // "No approval stop" for any triggerType !== 'manual' -- there is no human
    // in the loop for scheduled/on_media_enriched runs, so requirePreview and
    // the manual gated-action refusal list (hard_delete, move_to_circle, a
    // trash-variant needing extra perms, etc.) do NOT apply. The restricted
    // action set (hard_delete rejected at definition-validation time) is the
    // safety mechanism instead -- shouldBypassApproval only defensively
    // refuses a `triggerCompatibility: 'manual_only'` action, which should be
    // unreachable post-validation.
    // -------------------------------------------------------------------------
    describe('unattended triggers (issue #142)', () => {
      it.each([WorkflowTrigger.scheduled, WorkflowTrigger.on_media_enriched])(
        'is true for trigger "%s" even when requirePreview is unset (opposite of the manual default)',
        (trigger) => {
          const def = screenshotDefinition({ options: undefined });
          const settings = settingsWithWorkflows({ requirePreview: true });
          expect(service.shouldBypassApproval(def, settings as any, trigger)).toBe(true);
        },
      );

      it.each([WorkflowTrigger.scheduled, WorkflowTrigger.on_media_enriched])(
        'is true for trigger "%s" even with a gated action present (move_to_circle) -- gating does not apply to unattended runs',
        (trigger) => {
          const def = screenshotDefinition({
            actions: [{ type: 'move_to_circle', targetCircleId: OTHER_CIRCLE_ID }],
          });
          const settings = settingsWithWorkflows();
          expect(service.shouldBypassApproval(def, settings as any, trigger)).toBe(true);
        },
      );

      it.each([WorkflowTrigger.scheduled, WorkflowTrigger.on_media_enriched])(
        'is false for trigger "%s" when a manual_only action (hard_delete) is present (defensive; unreachable post-validation)',
        (trigger) => {
          const def = screenshotDefinition({ actions: [{ type: 'hard_delete' }] });
          const settings = settingsWithWorkflows({ allowHardDelete: true });
          expect(service.shouldBypassApproval(def, settings as any, trigger)).toBe(false);
        },
      );

      it('defaults to the manual path (false, since requirePreview is not explicitly false) when triggerType is omitted', () => {
        const def = screenshotDefinition({ options: undefined });
        const settings = settingsWithWorkflows({ requirePreview: false });
        expect(service.shouldBypassApproval(def, settings as any)).toBe(false);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // enqueueExecuteBatches
  // ---------------------------------------------------------------------------

  describe('enqueueExecuteBatches', () => {
    it('chunks matched items into ceil(N / batchSize) enrichment jobs', async () => {
      const ids = Array.from({ length: 5 }, () => randomUUID());
      prisma.workflowRunItem.findMany.mockResolvedValue(
        ids.map((mediaItemId) => ({ mediaItemId })) as any,
      );

      await service.enqueueExecuteBatches(
        { id: RUN_ID, circleId: CIRCLE_ID },
        screenshotDefinition(),
        settingsWithWorkflows({ batchSize: 2 }) as any,
      );

      // 5 items / batchSize 2 -> 3 batches (2, 2, 1).
      expect(enrichmentJobs.enqueue).toHaveBeenCalledTimes(3);
      const payloads = (enrichmentJobs.enqueue as jest.Mock).mock.calls.map(
        (c) => (c[0].payload as { itemIds: string[] }).itemIds,
      );
      expect(payloads[0]).toHaveLength(2);
      expect(payloads[1]).toHaveLength(2);
      expect(payloads[2]).toHaveLength(1);
      expect(payloads.flat().sort()).toEqual([...ids].sort());
    });

    it('enqueues nothing when there are no matched items', async () => {
      prisma.workflowRunItem.findMany.mockResolvedValue([] as any);

      await service.enqueueExecuteBatches(
        { id: RUN_ID, circleId: CIRCLE_ID },
        screenshotDefinition(),
        settingsWithWorkflows() as any,
      );

      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });
  });
});
