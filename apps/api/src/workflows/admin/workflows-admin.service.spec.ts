/**
 * Unit tests for WorkflowsAdminService (issue #143).
 *
 * Covers:
 *   - assertFeatureEnabled: every public method 404s when features.workflows
 *     is off (or WORKFLOWS_ENABLED=false overrides it), before touching Prisma.
 *   - listWorkflows: filter composition (circleId/trigger/enabled), pagination
 *     meta, and the join/serialization of latest-run + totals-by-workflow.
 *   - getStats: the 7-day KPI aggregate shape.
 *   - listRuns: filter composition and run serialization.
 *   - disableWorkflow: 404 when missing, sets enabled=false, writes the
 *     `workflow:admin_disabled` audit event.
 *   - cancelRun: delegates to WorkflowRunService.adminCancelRun after the
 *     feature gate.
 *
 * No database required — PrismaService and WorkflowRunService are mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { WorkflowRunStatus, WorkflowTrigger } from '@prisma/client';
import { randomUUID } from 'crypto';
import { WorkflowsAdminService } from './workflows-admin.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { WorkflowRunService } from '../runs/workflow-run.service';
import { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { DEFAULT_SYSTEM_SETTINGS } from '../../common/types/settings.types';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';

const WORKFLOW_ID = randomUUID();
const CIRCLE_ID = randomUUID();
const RUN_ID = randomUUID();
const USER_ID = randomUUID();

function settingsWithWorkflows(enabled = true) {
  return {
    ...DEFAULT_SYSTEM_SETTINGS,
    features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: enabled },
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    updatedBy: null,
    version: 1,
  };
}

function makeUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: USER_ID,
    email: 'admin@example.com',
    roles: ['Admin'],
    permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ, PERMISSIONS.JOBS_WRITE],
    isActive: true,
    ...overrides,
  };
}

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    circleId: CIRCLE_ID,
    name: 'Screenshot cleanup',
    subjectType: 'media_item',
    trigger: WorkflowTrigger.manual,
    enabled: true,
    cronExpression: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    circle: { id: CIRCLE_ID, name: 'Family circle' },
    createdBy: { id: USER_ID, email: 'admin@example.com', displayName: 'Admin' },
    ...overrides,
  };
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    workflowId: WORKFLOW_ID,
    circleId: CIRCLE_ID,
    status: WorkflowRunStatus.running,
    triggerType: 'manual',
    matchedCount: 100,
    truncated: false,
    processedCount: 50,
    succeededCount: 40,
    failedCount: 10,
    skippedCount: 0,
    startedById: USER_ID,
    approvedById: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:05:00Z'),
    approvedAt: null,
    startedAt: new Date('2026-01-01T00:01:00Z'),
    finishedAt: null,
    lastError: null,
    workflow: { id: WORKFLOW_ID, name: 'Screenshot cleanup' },
    circle: { id: CIRCLE_ID, name: 'Family circle' },
    ...overrides,
  };
}

describe('WorkflowsAdminService', () => {
  let service: WorkflowsAdminService;
  let prisma: MockPrismaService;
  let systemSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettings'>>;
  let runService: jest.Mocked<Pick<WorkflowRunService, 'adminCancelRun'>>;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(async () => {
    prisma = createMockPrismaService();
    systemSettings = { getSettings: jest.fn().mockResolvedValue(settingsWithWorkflows()) };
    runService = { adminCancelRun: jest.fn() };

    prisma.$transaction.mockImplementation(async (arg: any) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg(prisma);
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowsAdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemSettingsService, useValue: systemSettings },
        { provide: WorkflowRunService, useValue: runService },
      ],
    }).compile();

    service = module.get<WorkflowsAdminService>(WorkflowsAdminService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  // ===========================================================================
  // Feature gate — every public method
  // ===========================================================================

  describe('feature gate', () => {
    it('listWorkflows throws NotFoundException when features.workflows is off', async () => {
      systemSettings.getSettings.mockResolvedValue(settingsWithWorkflows(false) as any);

      await expect(
        service.listWorkflows({ page: 1, pageSize: 20 }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.workflow.findMany).not.toHaveBeenCalled();
    });

    it('getStats throws NotFoundException when features.workflows is off', async () => {
      systemSettings.getSettings.mockResolvedValue(settingsWithWorkflows(false) as any);

      await expect(service.getStats()).rejects.toThrow(NotFoundException);
      expect(prisma.workflowRun.count).not.toHaveBeenCalled();
    });

    it('listRuns throws NotFoundException when features.workflows is off', async () => {
      systemSettings.getSettings.mockResolvedValue(settingsWithWorkflows(false) as any);

      await expect(
        service.listRuns({ page: 1, pageSize: 20 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('disableWorkflow throws NotFoundException when features.workflows is off', async () => {
      systemSettings.getSettings.mockResolvedValue(settingsWithWorkflows(false) as any);

      await expect(service.disableWorkflow(WORKFLOW_ID, USER_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.workflow.findUnique).not.toHaveBeenCalled();
    });

    it('cancelRun throws NotFoundException when features.workflows is off', async () => {
      systemSettings.getSettings.mockResolvedValue(settingsWithWorkflows(false) as any);

      await expect(service.cancelRun(RUN_ID, makeUser())).rejects.toThrow(NotFoundException);
      expect(runService.adminCancelRun).not.toHaveBeenCalled();
    });

    it('is also disabled via the WORKFLOWS_ENABLED=false env kill-switch even when the setting is on', async () => {
      process.env['WORKFLOWS_ENABLED'] = 'false';
      systemSettings.getSettings.mockResolvedValue(settingsWithWorkflows(true) as any);

      await expect(service.getStats()).rejects.toThrow(NotFoundException);
    });
  });

  // ===========================================================================
  // listWorkflows
  // ===========================================================================

  describe('listWorkflows', () => {
    beforeEach(() => {
      (prisma.workflow.findMany as jest.Mock).mockResolvedValue([makeWorkflow()]);
      (prisma.workflow.count as jest.Mock).mockResolvedValue(1);
      (prisma.workflowRun.findMany as jest.Mock).mockResolvedValue([
        {
          workflowId: WORKFLOW_ID,
          status: WorkflowRunStatus.completed,
          triggerType: 'manual',
          matchedCount: 10,
          processedCount: 10,
          succeededCount: 8,
          failedCount: 2,
          skippedCount: 0,
          createdAt: new Date('2026-01-03T00:00:00Z'),
          finishedAt: new Date('2026-01-03T00:05:00Z'),
        },
      ]);
      (prisma.workflowRun.groupBy as jest.Mock).mockResolvedValue([
        {
          workflowId: WORKFLOW_ID,
          _sum: { matchedCount: 30, succeededCount: 20 },
          _count: { _all: 3 },
        },
      ]);
    });

    it('applies circleId/trigger/enabled filters to the where clause', async () => {
      await service.listWorkflows({
        page: 1,
        pageSize: 20,
        circleId: CIRCLE_ID,
        trigger: WorkflowTrigger.scheduled,
        enabled: true,
      });

      expect(prisma.workflow.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { circleId: CIRCLE_ID, trigger: WorkflowTrigger.scheduled, enabled: true },
        }),
      );
      expect(prisma.workflow.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { circleId: CIRCLE_ID, trigger: WorkflowTrigger.scheduled, enabled: true },
        }),
      );
    });

    it('omits filter keys entirely when not provided (no accidental undefined filtering)', async () => {
      await service.listWorkflows({ page: 1, pageSize: 20 });

      expect(prisma.workflow.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });

    it('applies pagination skip/take from page/pageSize', async () => {
      await service.listWorkflows({ page: 3, pageSize: 10 });

      expect(prisma.workflow.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });

    it('returns pagination meta computed from totalItems/pageSize', async () => {
      (prisma.workflow.count as jest.Mock).mockResolvedValue(45);

      const result = await service.listWorkflows({ page: 2, pageSize: 20 });

      expect(result.meta).toEqual({ page: 2, pageSize: 20, totalItems: 45, totalPages: 3 });
    });

    it('joins the latest run and totals onto each workflow item', async () => {
      const result = await service.listWorkflows({ page: 1, pageSize: 20 });

      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item.id).toBe(WORKFLOW_ID);
      expect(item.circle).toEqual({ id: CIRCLE_ID, name: 'Family circle' });
      expect(item.createdBy).toEqual({
        id: USER_ID,
        email: 'admin@example.com',
        displayName: 'Admin',
      });
      expect(item.lastRun).toMatchObject({
        status: WorkflowRunStatus.completed,
        succeededCount: 8,
        failedCount: 2,
      });
      expect(item.totals).toEqual({ runs: 3, matched: 30, actioned: 20 });
    });

    it('defaults lastRun to null and totals to zeros when a workflow has never run', async () => {
      (prisma.workflowRun.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.workflowRun.groupBy as jest.Mock).mockResolvedValue([]);

      const result = await service.listWorkflows({ page: 1, pageSize: 20 });

      expect(result.items[0].lastRun).toBeNull();
      expect(result.items[0].totals).toEqual({ runs: 0, matched: 0, actioned: 0 });
    });

    it('handles a null circle and null createdBy gracefully', async () => {
      (prisma.workflow.findMany as jest.Mock).mockResolvedValue([
        makeWorkflow({ circle: null, createdBy: null }),
      ]);

      const result = await service.listWorkflows({ page: 1, pageSize: 20 });

      expect(result.items[0].circle).toBeNull();
      expect(result.items[0].createdBy).toBeNull();
    });

    it('skips the latest-run and totals queries entirely when the page is empty', async () => {
      (prisma.workflow.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.workflow.count as jest.Mock).mockResolvedValue(0);

      const result = await service.listWorkflows({ page: 1, pageSize: 20 });

      expect(result.items).toEqual([]);
      expect(prisma.workflowRun.findMany).not.toHaveBeenCalled();
      expect(prisma.workflowRun.groupBy).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // getStats
  // ===========================================================================

  describe('getStats', () => {
    it('returns the 7-day KPI aggregate shape', async () => {
      (prisma.workflowRun.count as jest.Mock)
        .mockResolvedValueOnce(12) // runsLast7Days
        .mockResolvedValueOnce(3) // failures
        .mockResolvedValueOnce(2); // currentlyRunning
      (prisma.workflowRun.aggregate as jest.Mock).mockResolvedValue({
        _sum: { succeededCount: 87 },
      });

      const stats = await service.getStats();

      expect(stats).toEqual({
        windowDays: 7,
        runsLast7Days: 12,
        itemsActioned: 87,
        failures: 3,
        currentlyRunning: 2,
      });
    });

    it('defaults itemsActioned to 0 when the aggregate sum is null (no runs in window)', async () => {
      (prisma.workflowRun.count as jest.Mock).mockResolvedValue(0);
      (prisma.workflowRun.aggregate as jest.Mock).mockResolvedValue({
        _sum: { succeededCount: null },
      });

      const stats = await service.getStats();

      expect(stats.itemsActioned).toBe(0);
    });

    it('scopes the currently-running count to evaluating and running statuses with no time bound', async () => {
      (prisma.workflowRun.count as jest.Mock).mockResolvedValue(0);
      (prisma.workflowRun.aggregate as jest.Mock).mockResolvedValue({ _sum: {} });

      await service.getStats();

      const runningCall = (prisma.workflowRun.count as jest.Mock).mock.calls.find(([arg]) =>
        arg?.where?.status?.in?.includes(WorkflowRunStatus.running),
      );
      expect(runningCall).toBeDefined();
      expect(runningCall![0].where.status.in).toEqual(
        expect.arrayContaining([WorkflowRunStatus.evaluating, WorkflowRunStatus.running]),
      );
      expect(runningCall![0].where.createdAt).toBeUndefined();
    });
  });

  // ===========================================================================
  // listRuns
  // ===========================================================================

  describe('listRuns', () => {
    beforeEach(() => {
      (prisma.workflowRun.findMany as jest.Mock).mockResolvedValue([makeRun()]);
      (prisma.workflowRun.count as jest.Mock).mockResolvedValue(1);
    });

    it('applies status/circleId/workflowId filters to the where clause', async () => {
      await service.listRuns({
        page: 1,
        pageSize: 20,
        status: WorkflowRunStatus.failed,
        circleId: CIRCLE_ID,
        workflowId: WORKFLOW_ID,
      });

      expect(prisma.workflowRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: WorkflowRunStatus.failed, circleId: CIRCLE_ID, workflowId: WORKFLOW_ID },
        }),
      );
    });

    it('serializes each run with workflow and circle summaries', async () => {
      const result = await service.listRuns({ page: 1, pageSize: 20 });

      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item.id).toBe(RUN_ID);
      expect(item.workflow).toEqual({ id: WORKFLOW_ID, name: 'Screenshot cleanup' });
      expect(item.circle).toEqual({ id: CIRCLE_ID, name: 'Family circle' });
      expect(item.status).toBe(WorkflowRunStatus.running);
      expect(item.matchedCount).toBe(100);
      expect(item.succeededCount).toBe(40);
      expect(item.failedCount).toBe(10);
    });

    it('returns pagination meta', async () => {
      (prisma.workflowRun.count as jest.Mock).mockResolvedValue(41);

      const result = await service.listRuns({ page: 1, pageSize: 20 });

      expect(result.meta).toEqual({ page: 1, pageSize: 20, totalItems: 41, totalPages: 3 });
    });

    it('handles a null workflow/circle relation gracefully', async () => {
      (prisma.workflowRun.findMany as jest.Mock).mockResolvedValue([
        makeRun({ workflow: null, circle: null }),
      ]);

      const result = await service.listRuns({ page: 1, pageSize: 20 });

      expect(result.items[0].workflow).toBeNull();
      expect(result.items[0].circle).toBeNull();
    });
  });

  // ===========================================================================
  // disableWorkflow — admin override
  // ===========================================================================

  describe('disableWorkflow', () => {
    it('throws NotFoundException when the workflow does not exist', async () => {
      (prisma.workflow.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.disableWorkflow(WORKFLOW_ID, USER_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.workflow.update).not.toHaveBeenCalled();
    });

    it('sets enabled=false on the workflow', async () => {
      (prisma.workflow.findUnique as jest.Mock).mockResolvedValue(makeWorkflow({ enabled: true }));
      (prisma.workflow.update as jest.Mock).mockResolvedValue(
        makeWorkflow({ enabled: false }),
      );

      const result = await service.disableWorkflow(WORKFLOW_ID, USER_ID);

      expect(prisma.workflow.update).toHaveBeenCalledWith({
        where: { id: WORKFLOW_ID },
        data: { enabled: false },
      });
      expect(result).toEqual({ id: WORKFLOW_ID, enabled: false });
    });

    it('writes a workflow:admin_disabled audit event with the actor and circleId', async () => {
      (prisma.workflow.findUnique as jest.Mock).mockResolvedValue(makeWorkflow());
      (prisma.workflow.update as jest.Mock).mockResolvedValue(makeWorkflow({ enabled: false }));

      await service.disableWorkflow(WORKFLOW_ID, USER_ID);

      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: USER_ID,
          action: 'workflow:admin_disabled',
          targetType: 'workflow',
          targetId: WORKFLOW_ID,
          meta: { circleId: CIRCLE_ID },
        }),
      });
    });
  });

  // ===========================================================================
  // cancelRun — admin override
  // ===========================================================================

  describe('cancelRun', () => {
    it('delegates to WorkflowRunService.adminCancelRun with the run id and actor id', async () => {
      runService.adminCancelRun.mockResolvedValue({
        runId: RUN_ID,
        status: WorkflowRunStatus.cancelled,
      });
      const user = makeUser();

      const result = await service.cancelRun(RUN_ID, user);

      expect(runService.adminCancelRun).toHaveBeenCalledWith(RUN_ID, user.id);
      expect(result).toEqual({ runId: RUN_ID, status: WorkflowRunStatus.cancelled });
    });

    it('checks the feature gate BEFORE delegating to the run service', async () => {
      systemSettings.getSettings.mockResolvedValue(settingsWithWorkflows(false) as any);

      await expect(service.cancelRun(RUN_ID, makeUser())).rejects.toThrow(NotFoundException);
      expect(runService.adminCancelRun).not.toHaveBeenCalled();
    });

    it('propagates errors from the run service (e.g. run already finished)', async () => {
      runService.adminCancelRun.mockRejectedValue(new Error('Run already finished'));

      await expect(service.cancelRun(RUN_ID, makeUser())).rejects.toThrow(
        'Run already finished',
      );
    });
  });
});
