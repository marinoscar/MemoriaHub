import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob, Prisma, WorkflowRunStatus } from '@prisma/client';
import { EnrichmentHandler } from '../../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_PREVIEW_TTL_HOURS = 24;
const BATCH_SIZE = 5000;

/** Terminal run statuses eligible for retention deletion. */
const TERMINAL_RUN_STATUSES: WorkflowRunStatus[] = [
  WorkflowRunStatus.completed,
  WorkflowRunStatus.completed_with_errors,
  WorkflowRunStatus.failed,
  WorkflowRunStatus.cancelled,
  WorkflowRunStatus.expired,
];

/**
 * Media Workflow Automation — run history purge handler (issue #140).
 *
 * Global enrichment job (mediaItemId/circleId null) that:
 *   (a) expires stale approvals — awaiting_approval runs untouched past
 *       workflows.previewTtlHours become 'expired'; and
 *   (b) deletes terminal runs older than workflows.runHistoryRetentionDays in
 *       bounded batches (workflow_run_items cascade via FK).
 *
 * Server-only; mirrors JobHistoryPurgeHandler.
 */
@Injectable()
export class WorkflowHistoryPurgeHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'workflow_history_purge';

  private readonly logger = new Logger(WorkflowHistoryPurgeHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(_job: EnrichmentJob): Promise<void> {
    const settings = await this.systemSettings.getSettings();
    const retentionDays = settings.workflows?.runHistoryRetentionDays ?? DEFAULT_RETENTION_DAYS;
    const previewTtlHours = settings.workflows?.previewTtlHours ?? DEFAULT_PREVIEW_TTL_HOURS;

    const now = Date.now();

    // (a) Expire stale awaiting_approval runs.
    const approvalCutoff = new Date(now - previewTtlHours * 3_600_000);
    const expired = await this.prisma.workflowRun.updateMany({
      where: {
        status: WorkflowRunStatus.awaiting_approval,
        updatedAt: { lt: approvalCutoff },
      },
      data: { status: WorkflowRunStatus.expired, finishedAt: new Date() },
    });
    if (expired.count > 0) {
      this.logger.log(`workflow_history_purge: expired ${expired.count} stale approval run(s)`);
    }

    // (b) Delete terminal runs older than retention (items cascade).
    const retentionCutoff = new Date(now - retentionDays * 86_400_000);
    const where: Prisma.WorkflowRunWhereInput = {
      status: { in: TERMINAL_RUN_STATUSES },
      OR: [
        { finishedAt: { lt: retentionCutoff } },
        { finishedAt: null, updatedAt: { lt: retentionCutoff } },
      ],
    };

    let totalDeleted = 0;
    for (;;) {
      const batch = await this.prisma.workflowRun.findMany({
        where,
        select: { id: true },
        take: BATCH_SIZE,
      });
      if (batch.length === 0) break;

      const ids = batch.map((b) => b.id);
      const del = await this.prisma.workflowRun.deleteMany({ where: { id: { in: ids } } });
      totalDeleted += del.count;

      if (batch.length < BATCH_SIZE) break;
    }

    this.logger.log(
      `workflow_history_purge: deleted ${totalDeleted} terminal run(s) past cutoff (retentionDays=${retentionDays})`,
    );
  }
}
