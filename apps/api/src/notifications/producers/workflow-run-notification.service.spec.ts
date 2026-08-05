/**
 * Unit tests for WorkflowRunNotificationService (epic #240, issue #247).
 *
 * Covers the acceptance list verbatim:
 *  - an `on_media_enriched` micro-run emits NOTHING (the v1 suppression)
 *  - `completed`, `completed_with_errors`, and `failed` each produce a row;
 *    non-terminal statuses (`evaluating`, `awaiting_approval`, `running`,
 *    `cancelled`, `expired`) do not
 *  - recipient is `started_by_id`, falling back to the workflow's
 *    `created_by_id` for `scheduled` runs — and the reverse fallback
 *    (starter falls back to workflow creator) for manual/on_media_enriched
 *  - a run with NEITHER a starter nor a workflow creator is silently skipped
 *  - per-run rows — two runs produce two DISCRETE `emit()` calls, never
 *    folded/aggregated (this is the one #247 producer with no aggregation)
 *  - best-effort: never throws when the underlying write rejects
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotificationType, WorkflowRunStatus, WorkflowTrigger } from '@prisma/client';

import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications.service';
import { WorkflowRunNotificationService } from './workflow-run-notification.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RUN_ID = 'run-111';
const CIRCLE_ID = 'circle-abc';
const STARTER_ID = 'user-starter';
const CREATOR_ID = 'user-creator';

function makeRunRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RUN_ID,
    circleId: CIRCLE_ID,
    status: WorkflowRunStatus.completed,
    triggerType: WorkflowTrigger.manual,
    startedById: STARTER_ID,
    succeededCount: 10,
    failedCount: 0,
    workflow: { name: 'Archive old screenshots', createdById: CREATOR_ID },
    ...overrides,
  };
}

describe('WorkflowRunNotificationService', () => {
  let service: WorkflowRunNotificationService;
  let mockPrisma: MockPrismaService;
  let mockNotifications: { emit: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockNotifications = { emit: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowRunNotificationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();

    service = module.get<WorkflowRunNotificationService>(WorkflowRunNotificationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // v1 volume guard: on_media_enriched micro-runs are suppressed
  // -------------------------------------------------------------------------

  describe('on_media_enriched suppression (v1 volume guard)', () => {
    it('an on_media_enriched run that reaches "completed" emits NOTHING', async () => {
      (mockPrisma.workflowRun.findUnique as jest.Mock).mockResolvedValue(
        makeRunRow({ triggerType: WorkflowTrigger.on_media_enriched }),
      );

      await service.notifyRunFinished(RUN_ID);

      expect(mockNotifications.emit).not.toHaveBeenCalled();
    });

    it('an on_media_enriched run that reaches "failed" ALSO emits nothing (the skip is trigger-based, not status-based)', async () => {
      (mockPrisma.workflowRun.findUnique as jest.Mock).mockResolvedValue(
        makeRunRow({
          triggerType: WorkflowTrigger.on_media_enriched,
          status: WorkflowRunStatus.failed,
        }),
      );

      await service.notifyRunFinished(RUN_ID);

      expect(mockNotifications.emit).not.toHaveBeenCalled();
    });

    it('a MANUAL run with the same terminal status DOES emit (proves the skip is trigger-specific)', async () => {
      (mockPrisma.workflowRun.findUnique as jest.Mock).mockResolvedValue(
        makeRunRow({ triggerType: WorkflowTrigger.manual, status: WorkflowRunStatus.failed }),
      );

      await service.notifyRunFinished(RUN_ID);

      expect(mockNotifications.emit).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Terminal status gate
  // -------------------------------------------------------------------------

  describe('terminal status gate', () => {
    const terminal = [
      WorkflowRunStatus.completed,
      WorkflowRunStatus.completed_with_errors,
      WorkflowRunStatus.failed,
    ];
    const nonTerminal = [
      WorkflowRunStatus.evaluating,
      WorkflowRunStatus.awaiting_approval,
      WorkflowRunStatus.running,
      WorkflowRunStatus.cancelled,
      WorkflowRunStatus.expired,
    ];

    for (const status of terminal) {
      it(`emits for status='${status}'`, async () => {
        (mockPrisma.workflowRun.findUnique as jest.Mock).mockResolvedValue(makeRunRow({ status }));

        await service.notifyRunFinished(RUN_ID);

        expect(mockNotifications.emit).toHaveBeenCalledTimes(1);
      });
    }

    for (const status of nonTerminal) {
      it(`does NOT emit for non-terminal status='${status}'`, async () => {
        (mockPrisma.workflowRun.findUnique as jest.Mock).mockResolvedValue(makeRunRow({ status }));

        await service.notifyRunFinished(RUN_ID);

        expect(mockNotifications.emit).not.toHaveBeenCalled();
      });
    }

    it('a run that no longer exists (hard-deleted) emits nothing', async () => {
      (mockPrisma.workflowRun.findUnique as jest.Mock).mockResolvedValue(null);

      await service.notifyRunFinished(RUN_ID);

      expect(mockNotifications.emit).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Recipient resolution
  // -------------------------------------------------------------------------

  describe('recipient resolution', () => {
    it('a MANUAL run notifies startedById', async () => {
      (mockPrisma.workflowRun.findUnique as jest.Mock).mockResolvedValue(
        makeRunRow({ triggerType: WorkflowTrigger.manual, startedById: STARTER_ID }),
      );

      await service.notifyRunFinished(RUN_ID);

      expect(mockNotifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: STARTER_ID }),
      );
    });

    it('a SCHEDULED run notifies the workflow createdById, even when startedById is also set', async () => {
      (mockPrisma.workflowRun.findUnique as jest.Mock).mockResolvedValue(
        makeRunRow({
          triggerType: WorkflowTrigger.scheduled,
          startedById: STARTER_ID,
          workflow: { name: 'Nightly cleanup', createdById: CREATOR_ID },
        }),
      );

      await service.notifyRunFinished(RUN_ID);

      expect(mockNotifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: CREATOR_ID }),
      );
    });

    it('a SCHEDULED run with no createdById falls back to startedById', async () => {
      (mockPrisma.workflowRun.findUnique as jest.Mock).mockResolvedValue(
        makeRunRow({
          triggerType: WorkflowTrigger.scheduled,
          startedById: STARTER_ID,
          workflow: { name: 'Nightly cleanup', createdById: null },
        }),
      );

      await service.notifyRunFinished(RUN_ID);

      expect(mockNotifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: STARTER_ID }),
      );
    });

    it('a MANUAL run with no startedById falls back to the workflow createdById', async () => {
      (mockPrisma.workflowRun.findUnique as jest.Mock).mockResolvedValue(
        makeRunRow({
          triggerType: WorkflowTrigger.manual,
          startedById: null,
          workflow: { name: 'Archive old screenshots', createdById: CREATOR_ID },
        }),
      );

      await service.notifyRunFinished(RUN_ID);

      expect(mockNotifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: CREATOR_ID }),
      );
    });

    it('a run with NEITHER a starter nor a workflow creator is silently skipped', async () => {
      (mockPrisma.workflowRun.findUnique as jest.Mock).mockResolvedValue(
        makeRunRow({
          triggerType: WorkflowTrigger.manual,
          startedById: null,
          workflow: { name: 'Orphaned workflow', createdById: null },
        }),
      );

      await service.notifyRunFinished(RUN_ID);

      expect(mockNotifications.emit).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Per-run rows — no aggregation
  // -------------------------------------------------------------------------

  describe('per-run rows, never aggregated', () => {
    it('two separate finished runs produce two separate emit() calls, each with its own runId/link/data', async () => {
      (mockPrisma.workflowRun.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeRunRow({ id: 'run-A', succeededCount: 5, failedCount: 1 }))
        .mockResolvedValueOnce(
          makeRunRow({ id: 'run-B', succeededCount: 20, failedCount: 0 }),
        );

      await service.notifyRunFinished('run-A');
      await service.notifyRunFinished('run-B');

      expect(mockNotifications.emit).toHaveBeenCalledTimes(2);
      expect(mockNotifications.emit).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          type: NotificationType.workflow_run_completed,
          link: '/workflows/runs/run-A',
          data: expect.objectContaining({ runId: 'run-A', succeededCount: 5, failedCount: 1 }),
        }),
      );
      expect(mockNotifications.emit).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          link: '/workflows/runs/run-B',
          data: expect.objectContaining({ runId: 'run-B', succeededCount: 20, failedCount: 0 }),
        }),
      );
    });

    it('title reports the workflow name and succeeded/failed counts', async () => {
      (mockPrisma.workflowRun.findUnique as jest.Mock).mockResolvedValue(
        makeRunRow({ succeededCount: 7, failedCount: 2 }),
      );

      await service.notifyRunFinished(RUN_ID);

      expect(mockNotifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Workflow 'Archive old screenshots' finished: 7 applied, 2 failed",
          circleId: CIRCLE_ID,
        }),
      );
    });

    it('re-reads the run rather than trusting a caller-supplied status/counts (single source of truth)', async () => {
      (mockPrisma.workflowRun.findUnique as jest.Mock).mockResolvedValue(makeRunRow());

      await service.notifyRunFinished(RUN_ID);

      expect(mockPrisma.workflowRun.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: RUN_ID } }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: best-effort, never throws
  // -------------------------------------------------------------------------

  describe('best-effort contract', () => {
    it('notifyRunFinishedAsync() never throws even when the run re-read rejects', async () => {
      (mockPrisma.workflowRun.findUnique as jest.Mock).mockRejectedValue(new Error('db down'));

      expect(() => service.notifyRunFinishedAsync(RUN_ID)).not.toThrow();

      await Promise.resolve();
      await Promise.resolve();
    });

    it('notifyRunFinishedAsync() never throws even when emit() itself rejects', async () => {
      (mockPrisma.workflowRun.findUnique as jest.Mock).mockResolvedValue(makeRunRow());
      mockNotifications.emit.mockRejectedValue(new Error('write failed'));

      expect(() => service.notifyRunFinishedAsync(RUN_ID)).not.toThrow();

      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
