// =============================================================================
// Workflow Run Notification Producer (epic #240, issue #247)
// =============================================================================
//
// Produces one `workflow_run_completed` row per workflow run that reaches a
// terminal outcome — `completed`, `completed_with_errors`, or `failed`. This is
// the ONE producer in #247 with no aggregation: a run is a discrete, deliberate
// thing a person started (or scheduled), and each deserves its own row.
//
// VOLUME GUARD — the on_media_enriched skip, now OPT-IN (#251).
//   `on_media_enriched` micro-runs fire continuously during an import (one
//   rolling micro-run per workflow every ~5 minutes, each terminating through
//   the same maybeFinalizeRun path as a manual run). Notifying on those would
//   drown the bell in exactly the fan-out this feature exists to prevent, so
//   #247 SKIPPED them outright. #251 keeps that as the DEFAULT and makes it
//   re-enableable per user via `user_settings.notifications.workflowMicroRuns`
//   (absent ⇒ false, the one inverted default in that namespace — see
//   NotificationPreferencesService). The check is therefore per RECIPIENT and
//   moves below the recipient resolution; the skip still lives here, not at the
//   call sites, so no terminal path can forget it: the producer is handed a
//   runId and decides for itself.
//
//   Note this is a SEPARATE preference from the `workflow_run_completed` type
//   toggle, which NotificationsService.emit() enforces on every run. Both must
//   pass for a micro-run to notify.
//
// RECIPIENT
//   The run's `startedById`. Unattended (`scheduled`) runs have no starter in
//   the human sense, so they go to the workflow's `createdById` — the same user
//   whose permissions authorize the unattended run in the first place. Each
//   falls back to the other when null (both columns are SetNull FKs), and a run
//   with neither is silently skipped: there is nobody to tell.
//
// FIRE-AND-FORGET — notifyRunFinishedAsync() returns void and never rejects
// (EmailService.sendEmailAsync shape). Call sites are inside enrichment job
// handlers whose terminal writes must never be affected by a notification.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, WorkflowRunStatus, WorkflowTrigger } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationPreferencesService } from '../notification-preferences.service';
import { NotificationsService } from '../notifications.service';

/** The three terminal statuses that produce a notification. */
const NOTIFIABLE_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  WorkflowRunStatus.completed,
  WorkflowRunStatus.completed_with_errors,
  WorkflowRunStatus.failed,
]);

@Injectable()
export class WorkflowRunNotificationService {
  private readonly logger = new Logger(WorkflowRunNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly preferences: NotificationPreferencesService,
  ) {}

  /** Fire-and-forget entry point for the terminal paths. Swallows everything. */
  notifyRunFinishedAsync(runId: string): void {
    void this.notifyRunFinished(runId).catch((err) => {
      this.logger.warn(
        `workflow_run_completed notification for run ${runId} failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    });
  }

  /**
   * Re-reads the run rather than trusting caller-supplied counters. The call
   * sites finalize with a conditional `updateMany`, so the authoritative status
   * and counts only exist in the row — and re-reading also means a caller that
   * lost the finalize race cannot produce a second notification, because the
   * status/trigger checks below are evaluated against the same single row.
   */
  async notifyRunFinished(runId: string): Promise<void> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        circleId: true,
        status: true,
        triggerType: true,
        startedById: true,
        succeededCount: true,
        failedCount: true,
        workflow: { select: { name: true, createdById: true } },
      },
    });

    if (!run) return;
    if (!NOTIFIABLE_STATUSES.has(run.status)) return;

    const recipient =
      run.triggerType === WorkflowTrigger.scheduled
        ? (run.workflow.createdById ?? run.startedById)
        : (run.startedById ?? run.workflow.createdById);
    if (!recipient) return;

    // Volume guard — see the header. Off unless THIS recipient opted in; the
    // check is deliberately after recipient resolution, since the preference
    // belongs to the person who would be notified.
    if (
      run.triggerType === WorkflowTrigger.on_media_enriched &&
      !(await this.preferences.allowsWorkflowMicroRuns(recipient))
    ) {
      return;
    }

    await this.notifications.emit({
      userId: recipient,
      circleId: run.circleId,
      type: NotificationType.workflow_run_completed,
      title:
        `Workflow '${run.workflow.name}' finished: ` +
        `${run.succeededCount} applied, ${run.failedCount} failed`,
      link: `/workflows/runs/${run.id}`,
      data: {
        runId: run.id,
        status: run.status,
        succeededCount: run.succeededCount,
        failedCount: run.failedCount,
      },
    });
  }
}
