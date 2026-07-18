/**
 * Unit tests for WorkflowScheduleTask (Media Workflow Automation Phase 4,
 * issue #142).
 *
 * Covers:
 *   - master switches: features.workflows off, workflows.triggers.scheduled
 *     off -> no-op (no DB query for due workflows).
 *   - due-scan: finds due `scheduled` + enabled workflows and starts an
 *     unattended run for each, then rolls nextRunAt forward.
 *   - overlap guard: a workflow with an already-active run (evaluating /
 *     awaiting_approval / running) is skipped and nextRunAt is still rolled
 *     forward (never re-fires every tick).
 *   - concurrency guard: starting a run would exceed workflows.maxConcurrentRuns
 *     app-wide -> skipped and rolled forward, not queued.
 *   - a per-workflow failure never aborts the tick for the remaining due
 *     workflows, and still rolls that workflow's nextRunAt forward.
 *
 * No database required -- PrismaService and the injected services are mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { WorkflowRunStatus, WorkflowTrigger } from '@prisma/client';
import { randomUUID } from 'crypto';
import { WorkflowScheduleTask } from './workflow-schedule.task';
import { WorkflowRunService } from './workflow-run.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../../common/types/settings.types';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const WORKFLOW_ID = randomUUID();
const CIRCLE_ID = randomUUID();

function settingsWithWorkflows(overrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_SYSTEM_SETTINGS,
    features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: true },
    workflows: { ...DEFAULT_SYSTEM_SETTINGS.workflows, ...overrides },
  };
}

function makeDueWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    circleId: CIRCLE_ID,
    name: 'Nightly purge',
    trigger: WorkflowTrigger.scheduled,
    enabled: true,
    cronExpression: '0 3 * * *',
    nextRunAt: new Date('2026-01-01T03:00:00.000Z'),
    definition: {
      version: 1,
      subject: 'media_item',
      match: 'all',
      conditions: [],
      actions: [{ type: 'move_to_trash' }],
    },
    createdById: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('WorkflowScheduleTask', () => {
  let task: WorkflowScheduleTask;
  let prisma: MockPrismaService;
  let systemSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettings'>>;
  let runService: jest.Mocked<Pick<WorkflowRunService, 'startUnattendedRun'>>;

  beforeEach(async () => {
    prisma = createMockPrismaService();
    systemSettings = {
      getSettings: jest.fn().mockResolvedValue(settingsWithWorkflows()),
    };
    runService = {
      startUnattendedRun: jest.fn().mockResolvedValue({ runId: randomUUID() }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowScheduleTask,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemSettingsService, useValue: systemSettings },
        { provide: WorkflowRunService, useValue: runService },
      ],
    }).compile();

    task = module.get(WorkflowScheduleTask);

    // Default: no runs active anywhere (overlap + concurrency both clear).
    prisma.workflowRun.count.mockResolvedValue(0);
    prisma.workflow.update.mockResolvedValue({} as any);
  });

  // ---------------------------------------------------------------------------
  // Master switches
  // ---------------------------------------------------------------------------

  describe('master switches', () => {
    it('no-ops when features.workflows is disabled (no due-workflow query)', async () => {
      systemSettings.getSettings.mockResolvedValue({
        ...DEFAULT_SYSTEM_SETTINGS,
        features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: false },
      } as any);

      await task.handleTick();

      expect(prisma.workflow.findMany).not.toHaveBeenCalled();
      expect(runService.startUnattendedRun).not.toHaveBeenCalled();
    });

    it('no-ops when workflows.triggers.scheduled is explicitly false', async () => {
      systemSettings.getSettings.mockResolvedValue(
        settingsWithWorkflows({ triggers: { onEnrichment: true, scheduled: false } }) as any,
      );

      await task.handleTick();

      expect(prisma.workflow.findMany).not.toHaveBeenCalled();
      expect(runService.startUnattendedRun).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Due-scan happy path
  // ---------------------------------------------------------------------------

  describe('due-scan', () => {
    it('does nothing further when there are no due workflows', async () => {
      prisma.workflow.findMany.mockResolvedValue([] as any);

      await task.handleTick();

      expect(runService.startUnattendedRun).not.toHaveBeenCalled();
      expect(prisma.workflow.update).not.toHaveBeenCalled();
    });

    it('starts a straight-to-execution unattended run for a due workflow and rolls nextRunAt forward', async () => {
      const workflow = makeDueWorkflow();
      prisma.workflow.findMany.mockResolvedValue([workflow] as any);

      await task.handleTick();

      expect(runService.startUnattendedRun).toHaveBeenCalledWith(
        workflow,
        WorkflowTrigger.scheduled,
      );
      expect(prisma.workflow.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: WORKFLOW_ID },
          data: { nextRunAt: expect.any(Date) },
        }),
      );
      // The daily 3am cron's next fire must be strictly after the stale nextRunAt.
      const rolledTo = (prisma.workflow.update as jest.Mock).mock.calls[0][0].data.nextRunAt;
      expect(rolledTo.getTime()).toBeGreaterThan(workflow.nextRunAt.getTime());
    });

    it('queries only enabled + scheduled workflows whose nextRunAt has elapsed', async () => {
      prisma.workflow.findMany.mockResolvedValue([] as any);

      await task.handleTick();

      expect(prisma.workflow.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            trigger: WorkflowTrigger.scheduled,
            enabled: true,
            nextRunAt: { lte: expect.any(Date) },
          }),
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Overlap guard
  // ---------------------------------------------------------------------------

  describe('overlap guard', () => {
    it('skips a workflow that already has an active (non-terminal) run and still rolls nextRunAt forward', async () => {
      const workflow = makeDueWorkflow();
      prisma.workflow.findMany.mockResolvedValue([workflow] as any);
      // First count() call inside processDueWorkflow is the per-workflow overlap check.
      prisma.workflowRun.count.mockResolvedValueOnce(1); // overlapping active run exists

      await task.handleTick();

      expect(runService.startUnattendedRun).not.toHaveBeenCalled();
      expect(prisma.workflow.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: WORKFLOW_ID },
          data: { nextRunAt: expect.any(Date) },
        }),
      );
    });

    it('checks overlap against the active statuses (evaluating / awaiting_approval / running)', async () => {
      const workflow = makeDueWorkflow();
      prisma.workflow.findMany.mockResolvedValue([workflow] as any);
      prisma.workflowRun.count.mockResolvedValueOnce(0);

      await task.handleTick();

      const overlapCall = (prisma.workflowRun.count as jest.Mock).mock.calls[0][0];
      expect(overlapCall.where.workflowId).toBe(WORKFLOW_ID);
      expect(overlapCall.where.status.in).toEqual(
        expect.arrayContaining([
          WorkflowRunStatus.evaluating,
          WorkflowRunStatus.awaiting_approval,
          WorkflowRunStatus.running,
        ]),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrency guard
  // ---------------------------------------------------------------------------

  describe('concurrency guard', () => {
    it('skips starting a run when the app-wide active-run count already meets workflows.maxConcurrentRuns', async () => {
      systemSettings.getSettings.mockResolvedValue(
        settingsWithWorkflows({ maxConcurrentRuns: 2 }) as any,
      );
      const workflow = makeDueWorkflow();
      prisma.workflow.findMany.mockResolvedValue([workflow] as any);
      prisma.workflowRun.count
        .mockResolvedValueOnce(0) // overlap check: clear for this workflow
        .mockResolvedValueOnce(2); // app-wide concurrency check: at the cap

      await task.handleTick();

      expect(runService.startUnattendedRun).not.toHaveBeenCalled();
      expect(prisma.workflow.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { nextRunAt: expect.any(Date) } }),
      );
    });

    it('starts the run once the app-wide active-run count is below workflows.maxConcurrentRuns', async () => {
      systemSettings.getSettings.mockResolvedValue(
        settingsWithWorkflows({ maxConcurrentRuns: 2 }) as any,
      );
      const workflow = makeDueWorkflow();
      prisma.workflow.findMany.mockResolvedValue([workflow] as any);
      prisma.workflowRun.count
        .mockResolvedValueOnce(0) // overlap check
        .mockResolvedValueOnce(1); // below the cap of 2

      await task.handleTick();

      expect(runService.startUnattendedRun).toHaveBeenCalledWith(
        workflow,
        WorkflowTrigger.scheduled,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Resilience
  // ---------------------------------------------------------------------------

  describe('resilience', () => {
    it('rolls a failing workflow forward and still processes the remaining due workflows', async () => {
      const failing = makeDueWorkflow({ id: randomUUID() });
      const healthy = makeDueWorkflow({ id: randomUUID() });
      prisma.workflow.findMany.mockResolvedValue([failing, healthy] as any);
      prisma.workflowRun.count.mockResolvedValue(0);
      runService.startUnattendedRun
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ runId: randomUUID() });

      await expect(task.handleTick()).resolves.not.toThrow();

      expect(runService.startUnattendedRun).toHaveBeenCalledTimes(2);
      // Both workflows' nextRunAt should have been rolled forward (failing one
      // via the catch-block fallback, healthy one via the normal path).
      const updatedIds = (prisma.workflow.update as jest.Mock).mock.calls.map(
        (c) => c[0].where.id,
      );
      expect(updatedIds).toEqual(expect.arrayContaining([failing.id, healthy.id]));
    });

    it('never throws even when the settings lookup itself fails', async () => {
      systemSettings.getSettings.mockRejectedValue(new Error('settings unavailable'));

      await expect(task.handleTick()).resolves.not.toThrow();
      expect(prisma.workflow.findMany).not.toHaveBeenCalled();
    });
  });
});
