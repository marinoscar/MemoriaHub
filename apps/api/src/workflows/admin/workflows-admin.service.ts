import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, WorkflowRun, WorkflowRunStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { isWorkflowsEnabled } from '../../common/types/settings.types';
import { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { WorkflowRunService } from '../runs/workflow-run.service';

/** The resolved settings object returned by SystemSettingsService.getSettings(). */
type ResolvedSettings = Awaited<ReturnType<SystemSettingsService['getSettings']>>;

/** Non-terminal run statuses considered "currently running" for the KPI strip. */
const RUNNING_STATUSES: WorkflowRunStatus[] = [
  WorkflowRunStatus.evaluating,
  WorkflowRunStatus.running,
];

/** Terminal statuses that count as a failure in the KPI strip. */
const FAILURE_STATUSES: WorkflowRunStatus[] = [
  WorkflowRunStatus.failed,
  WorkflowRunStatus.completed_with_errors,
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
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly runService: WorkflowRunService,
  ) {}

  // ---------------------------------------------------------------------------
  // Feature gate
  // ---------------------------------------------------------------------------

  private async assertFeatureEnabled(): Promise<ResolvedSettings> {
    const settings = await this.systemSettings.getSettings();
    if (!isWorkflowsEnabled(settings)) {
      throw new NotFoundException('Workflows feature is not enabled');
    }
    return settings;
  }

  // ---------------------------------------------------------------------------
  // GET /admin/workflows
  // ---------------------------------------------------------------------------

  async listWorkflows(query: {
    page: number;
    pageSize: number;
    circleId?: string;
    trigger?: Prisma.WorkflowWhereInput['trigger'];
    enabled?: boolean;
  }) {
    await this.assertFeatureEnabled();

    const { page, pageSize, circleId, trigger, enabled } = query;
    const where: Prisma.WorkflowWhereInput = {
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
          circle: { select: { id: true, name: true } },
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
        circle: w.circle ? { id: w.circle.id, name: w.circle.name } : null,
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

  async listRuns(query: {
    page: number;
    pageSize: number;
    status?: WorkflowRunStatus;
    circleId?: string;
    workflowId?: string;
  }) {
    await this.assertFeatureEnabled();

    const { page, pageSize, status, circleId, workflowId } = query;
    const where: Prisma.WorkflowRunWhereInput = {
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
          circle: { select: { id: true, name: true } },
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
        meta: { circleId: workflow.circleId } as Prisma.InputJsonValue,
      },
    });

    return { id: updated.id, enabled: updated.enabled };
  }

  // ---------------------------------------------------------------------------
  // POST /admin/workflow-runs/:id/cancel — admin override (Phase 2 cancel path)
  // ---------------------------------------------------------------------------

  async cancelRun(runId: string, user: RequestUser) {
    await this.assertFeatureEnabled();
    return this.runService.adminCancelRun(runId, user.id);
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  private serializeRun(
    run: WorkflowRun & {
      workflow?: { id: string; name: string } | null;
      circle?: { id: string; name: string } | null;
    },
  ) {
    return {
      id: run.id,
      workflowId: run.workflowId,
      workflow: run.workflow ? { id: run.workflow.id, name: run.workflow.name } : null,
      circleId: run.circleId,
      circle: run.circle ? { id: run.circle.id, name: run.circle.name } : null,
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
