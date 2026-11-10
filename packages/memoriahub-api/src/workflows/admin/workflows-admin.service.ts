import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { MEMORIAHUB_PRISMA, MEMORIAHUB_SETTINGS, type MemoriahubSettingsPort } from '../../ports/index.js';
import type { WorkflowsDb } from '../data/workflows-db.js';
import { WorkflowRunService } from '../runs/workflow-run.service.js';
import { isWorkflowsEnabled, readWorkflowSettings, type ResolvedWorkflowSettings as ResolvedSettings } from '../settings/workflows-settings.js';
import { OWNER_NAME_SELECT, libraryName } from './owner-name.js';
import {
  WORKFLOW_RUN_STATUS,
  type WorkflowRunRow as WorkflowRun,
  type WorkflowRunStatusKey as WorkflowRunStatus,
} from '../workflows.constants.js';

/** Non-terminal run statuses considered "currently running" for the KPI strip. */
const RUNNING_STATUSES: WorkflowRunStatus[] = [
  WORKFLOW_RUN_STATUS.evaluating,
  WORKFLOW_RUN_STATUS.running,
];

/** Terminal statuses that count as a failure in the KPI strip. */
const FAILURE_STATUSES: WorkflowRunStatus[] = [
  WORKFLOW_RUN_STATUS.failed,
  WORKFLOW_RUN_STATUS.completed_with_errors,
];

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Media Workflow Automation — admin control-plane oversight (issue #143).
 *
 * Cross-circle read + override surface for the `/admin/settings/workflows`
 * page: list every workflow/run across all circles, a small KPI aggregate, an
 * admin override that force-disables a workflow, and an admin cancel of a
 * runaway run (delegated to the Phase 2 cancel path in WorkflowRunService).
 *
 * All aggregates are bounded/indexed: per-workflow totals come from a single
 * `workflowRun.groupBy` (never an unbounded scan of `workflow_run_items`), and
 * the latest-run-per-workflow lookup uses the `(workflowId, createdAt)` index
 * via `distinct`. There are NO byte-valued fields on any workflow entity, so
 * the BigInt-serialization gotcha does not apply here (matched/actioned counts
 * are plain `Int`s).
 */
@Injectable()
export class WorkflowsAdminService {
  private readonly logger = new Logger(WorkflowsAdminService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: WorkflowsDb,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly runService: WorkflowRunService,
  ) {}

  // ---------------------------------------------------------------------------
  // Feature gate
  // ---------------------------------------------------------------------------

  private async assertFeatureEnabled(): Promise<ResolvedSettings> {
    const settings = await readWorkflowSettings(this.settings);
    if (!isWorkflowsEnabled(settings)) {
      throw new NotFoundException('Workflows feature is not enabled');
    }
    return settings;
  }

  // ---------------------------------------------------------------------------
  // GET /admin/workflows
  // ---------------------------------------------------------------------------

  /** Lists every workflow across every circle with its last run and lifetime totals. */
  async listWorkflows(query: {
    page: number;
    pageSize: number;
    circleId?: string;
    trigger?: string;
    enabled?: boolean;
  }) {
    await this.assertFeatureEnabled();

    const { page, pageSize, circleId, trigger, enabled } = query;
    const where: Record<string, unknown> = {
      ...(circleId ? { circleId } : {}),
      ...(trigger ? { trigger } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    };

    const [workflows, totalItems] = await this.prisma.$transaction([
      this.prisma.workflow.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          ...OWNER_NAME_SELECT,
          createdBy: { select: { id: true, email: true, displayName: true } },
        },
      }),
      this.prisma.workflow.count({ where }),
    ]);

    const ids = workflows.map((w) => w.id);

    // Latest run per workflow — one query, served by (workflowId, createdAt).
    const latestRuns = ids.length
      ? await this.prisma.workflowRun.findMany({
          where: { workflowId: { in: ids } },
          orderBy: [{ workflowId: 'asc' }, { createdAt: 'desc' }],
          distinct: ['workflowId'],
          select: {
            workflowId: true,
            status: true,
            triggerType: true,
            matchedCount: true,
            processedCount: true,
            succeededCount: true,
            failedCount: true,
            skippedCount: true,
            createdAt: true,
            finishedAt: true,
          },
        })
      : [];
    const lastByWorkflow = new Map(latestRuns.map((r) => [r.workflowId, r]));

    // Matched/actioned totals per workflow — one bounded groupBy over
    // workflow_runs (NOT workflow_run_items).
    const totals = ids.length
      ? await this.prisma.workflowRun.groupBy({
          by: ['workflowId'],
          where: { workflowId: { in: ids } },
          _sum: { matchedCount: true, succeededCount: true },
          _count: { _all: true },
        })
      : [];
    const totalsByWorkflow = new Map(totals.map((t) => [t.workflowId, t]));

    const items = workflows.map((w) => {
      const lr = lastByWorkflow.get(w.id);
      const tot = totalsByWorkflow.get(w.id);
      return {
        id: w.id,
        circle: libraryName(w) === null ? null : { id: w.circleId, name: libraryName(w) as string },
        name: w.name,
        subjectType: w.subjectType,
        trigger: w.trigger,
        enabled: w.enabled,
        cronExpression: w.cronExpression,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        createdBy: w.createdBy
          ? { id: w.createdBy.id, email: w.createdBy.email, displayName: w.createdBy.displayName }
          : null,
        lastRun: lr
          ? {
              status: lr.status,
              triggerType: lr.triggerType,
              createdAt: lr.createdAt,
              finishedAt: lr.finishedAt,
              matchedCount: lr.matchedCount,
              processedCount: lr.processedCount,
              succeededCount: lr.succeededCount,
              failedCount: lr.failedCount,
              skippedCount: lr.skippedCount,
            }
          : null,
        totals: {
          runs: tot?._count._all ?? 0,
          matched: tot?._sum.matchedCount ?? 0,
          actioned: tot?._sum.succeededCount ?? 0,
        },
      };
    });

    return {
      items,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // GET /admin/workflows/stats — KPI strip aggregate
  // ---------------------------------------------------------------------------

  /** The KPI strip of the last seven days. */
  async getStats() {
    await this.assertFeatureEnabled();

    const cutoff = new Date(Date.now() - SEVEN_DAYS_MS);

    const [runsLast7Days, actionedAgg, failures, currentlyRunning] = await this.prisma.$transaction([
      this.prisma.workflowRun.count({ where: { createdAt: { gte: cutoff } } }),
      this.prisma.workflowRun.aggregate({
        _sum: { succeededCount: true },
        where: { createdAt: { gte: cutoff } },
      }),
      this.prisma.workflowRun.count({
        where: { createdAt: { gte: cutoff }, status: { in: FAILURE_STATUSES } },
      }),
      // Served by the (status, updatedAt) index — no time bound (a run started
      // >7d ago and still running should still show as currently running).
      this.prisma.workflowRun.count({ where: { status: { in: RUNNING_STATUSES } } }),
    ]);

    return {
      windowDays: 7,
      runsLast7Days,
      itemsActioned: actionedAgg._sum.succeededCount ?? 0,
      failures,
      currentlyRunning,
    };
  }

  // ---------------------------------------------------------------------------
  // GET /admin/workflow-runs
  // ---------------------------------------------------------------------------

  /** Lists every run across every circle. */
  async listRuns(query: {
    page: number;
    pageSize: number;
    status?: WorkflowRunStatus;
    circleId?: string;
    workflowId?: string;
  }) {
    await this.assertFeatureEnabled();

    const { page, pageSize, status, circleId, workflowId } = query;
    const where: Record<string, unknown> = {
      ...(status ? { status } : {}),
      ...(circleId ? { circleId } : {}),
      ...(workflowId ? { workflowId } : {}),
    };

    const [runs, totalItems] = await this.prisma.$transaction([
      this.prisma.workflowRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          workflow: { select: { id: true, name: true } },
          ...OWNER_NAME_SELECT,
        },
      }),
      this.prisma.workflowRun.count({ where }),
    ]);

    return {
      items: runs.map((r) => this.serializeRun(r)),
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // POST /admin/workflows/:id/disable — admin override
  // ---------------------------------------------------------------------------

  /** Force-disables a workflow regardless of circle membership. */
  async disableWorkflow(id: string, actorUserId: string) {
    await this.assertFeatureEnabled();

    const workflow = await this.prisma.workflow.findUnique({ where: { id } });
    if (!workflow) throw new NotFoundException(`Workflow ${id} not found`);

    const updated = await this.prisma.workflow.update({
      where: { id },
      data: { enabled: false },
    });

    this.logger.log({
      event: 'workflow.admin_disabled',
      workflowId: id,
      circleId: workflow.circleId,
      actorUserId,
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action: 'workflow:admin_disabled',
        targetType: 'workflow',
        targetId: id,
        meta: { circleId: workflow.circleId } as unknown,
      },
    });

    return { id: updated.id, enabled: updated.enabled };
  }

  // ---------------------------------------------------------------------------
  // POST /admin/workflow-runs/:id/cancel — admin override (Phase 2 cancel path)
  // ---------------------------------------------------------------------------

  /** Cancels a runaway run app-wide. */
  async cancelRun(runId: string, user: { id: string }) {
    await this.assertFeatureEnabled();
    return this.runService.adminCancelRun(runId, user.id);
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  private serializeRun(
    run: WorkflowRun & {
      workflow?: { id: string; name: string } | null;
      ownerGroup?: { name: string } | null;
      ownerUser?: { displayName: string | null; providerDisplayName: string | null; email: string } | null;
    },
  ) {
    return {
      id: run.id,
      workflowId: run.workflowId,
      workflow: run.workflow ? { id: run.workflow.id, name: run.workflow.name } : null,
      circleId: run.circleId,
      circle: libraryName(run as unknown as Record<string, unknown>) === null ? null : { id: run.circleId, name: libraryName(run as unknown as Record<string, unknown>) as string },
      status: run.status,
      triggerType: run.triggerType,
      matchedCount: run.matchedCount,
      truncated: run.truncated,
      processedCount: run.processedCount,
      succeededCount: run.succeededCount,
      failedCount: run.failedCount,
      skippedCount: run.skippedCount,
      startedById: run.startedById,
      approvedById: run.approvedById,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      approvedAt: run.approvedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      lastError: run.lastError,
    };
  }
}
