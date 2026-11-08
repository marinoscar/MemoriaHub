import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  JobHandlerRegistry,
  runRetentionPolicyPurge,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { Prisma, WorkflowRunStatus } from '@prisma/client';

import { readRetentionPolicy } from '../../platform/jobs/run-engine-jobs';
import { AppSystemSettingsService } from '../../platform/settings/app-system-settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  WORKFLOW_RUNS_PURGE_TYPE,
  WORKFLOW_RUNS_RETENTION_KEY,
  WORKFLOW_RUNS_RETENTION_POLICY,
} from './workflow-runs.retention';

/** Fallback when `workflows.previewTtlHours` is unset. */
const DEFAULT_PREVIEW_TTL_HOURS = 24;

/** Terminal run statuses eligible for retention deletion. */
export const TERMINAL_WORKFLOW_RUN_STATUSES: WorkflowRunStatus[] = [
  WorkflowRunStatus.completed,
  WorkflowRunStatus.completed_with_errors,
  WorkflowRunStatus.failed,
  WorkflowRunStatus.cancelled,
  WorkflowRunStatus.expired,
];

/** Terminal runs finished (or, with no `finishedAt`, last touched) before `cutoff`. */
export function workflowRunsPurgeWhere(cutoff: Date): Prisma.WorkflowRunWhereInput {
  return {
    status: { in: TERMINAL_WORKFLOW_RUN_STATUSES },
    OR: [{ finishedAt: { lt: cutoff } }, { finishedAt: null, updatedAt: { lt: cutoff } }],
  };
}

/**
 * The `retention.workflowRuns` purge (RETRO-C7, #604): the native successor of
 * the old `workflow_history_purge` handler and its nightly task, under the same
 * permanent type string.
 *
 * Two steps, in this order:
 *   (a) EXPIRE STALE APPROVALS — `awaiting_approval` runs untouched for longer than
 *       `workflows.previewTtlHours` become `expired`. Runs whatever the retention
 *       switch says (it is part of the run lifecycle, not history retention), on
 *       every run of this job: the platform enqueues it nightly while the policy is
 *       enabled, which it is by default.
 *   (b) RETENTION — `runRetentionPolicyPurge` deletes terminal runs older than
 *       `retention.workflowRuns.days` in 5 000-id batches (`workflow_run_items`
 *       cascade); a logged no-op while the policy is disabled.
 *
 * SERVER-ONLY (no node-result pair).
 */
@Injectable()
export class WorkflowRunsRetentionHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(WorkflowRunsRetentionHandler.name);

  readonly type = WORKFLOW_RUNS_PURGE_TYPE;

  readonly label = 'Workflow run history purge';

  /** Deletes only; thirty minutes covers millions of rows. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 1_800_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: AppSystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    await this.expireStaleApprovals();

    const policy = await readRetentionPolicy(this.systemSettings, WORKFLOW_RUNS_RETENTION_POLICY);
    await runRetentionPolicyPurge({
      job,
      logger: this.logger,
      policy,
      setting: `retention.${WORKFLOW_RUNS_RETENTION_KEY}`,
      what: 'workflow run history purge',
      rows: 'workflow run(s)',
      selectIds: async (cutoff, take) =>
        (
          await this.prisma.workflowRun.findMany({
            where: workflowRunsPurgeWhere(cutoff),
            select: { id: true },
            orderBy: { updatedAt: 'asc' },
            take,
          })
        ).map((row) => row.id),
      deleteIds: async (ids) => (await this.prisma.workflowRun.deleteMany({ where: { id: { in: ids } } })).count,
    });
  }

  /** (a) `awaiting_approval` runs past `workflows.previewTtlHours` become `expired`. */
  async expireStaleApprovals(now: number = Date.now()): Promise<number> {
    const settings = await this.systemSettings.getSettings();
    const previewTtlHours = settings.workflows?.previewTtlHours ?? DEFAULT_PREVIEW_TTL_HOURS;
    const approvalCutoff = new Date(now - previewTtlHours * 3_600_000);
    const expired = await this.prisma.workflowRun.updateMany({
      where: { status: WorkflowRunStatus.awaiting_approval, updatedAt: { lt: approvalCutoff } },
      data: { status: WorkflowRunStatus.expired, finishedAt: new Date(now) },
    });
    if (expired.count > 0) {
      // metrics: RETRO-T3 (app.runs.finished{engine=workflow,outcome=expired})
      this.logger.log(`${this.type}: expired ${expired.count} stale approval run(s)`);
    }
    return expired.count;
  }
}
