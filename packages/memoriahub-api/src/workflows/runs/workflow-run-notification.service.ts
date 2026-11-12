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
//   re-enableable per user via `user_settings.memoriahubNotifications.workflowMicroRuns`
//   (absent ⇒ false, the one inverted default in that namespace — see
//   memoriahub-notification-preferences.ts). The check is therefore per RECIPIENT and
//   moves below the recipient resolution; the skip still lives here, not at the
//   call sites, so no terminal path can forget it: the producer is handed a
//   runId and decides for itself.
//
//   Note this is a SEPARATE preference from the `workflow_run_completed` type
//   toggle (`workflows.run_completed`), which the platform dispatcher enforces. Both must
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

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  MEMORIAHUB_NOTIFY,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubNotifyPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import type { WorkflowsDb } from '../data/workflows-db.js';
import { WORKFLOW_RUN_STATUS, WORKFLOW_TRIGGER } from '../workflows.constants.js';

/**
 * The event key of the per-run notification. PERMANENT: an inbox row and a user preference name it.
 *
 * @stability experimental
 */
export const WORKFLOW_RUN_COMPLETED_EVENT_KEY = 'workflows.run_completed';

/**
 * The user settings namespace holding MemoriaHub-only notification preferences. Permanent.
 *
 * @stability experimental
 */
export const MEMORIAHUB_NOTIFICATIONS_USER_NAMESPACE = 'memoriahubNotifications';

/** The three terminal statuses that produce a notification. */
const NOTIFIABLE_STATUSES: ReadonlySet<string> = new Set([
  WORKFLOW_RUN_STATUS.completed,
  WORKFLOW_RUN_STATUS.completed_with_errors,
  WORKFLOW_RUN_STATUS.failed,
]);

/**
 * `workflow_run_completed`: one notification per finished run to the person who started it (the workflow's
 * creator for a scheduled run), re-reading the run so a caller that lost the finalize race produces nothing.
 * `on_media_enriched` micro-runs are skipped unless the recipient opted in
 * (`memoriahubNotifications.workflowMicroRuns`, absent means off). Best-effort: it never throws.
 *
 * @stability experimental
 */
@Injectable()
export class WorkflowRunNotificationService {
  private readonly logger = new Logger(WorkflowRunNotificationService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: WorkflowsDb,
    @Inject(MEMORIAHUB_NOTIFY) private readonly notify: MemoriahubNotifyPort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
  ) {}

  /**
   * Fire-and-forget entry point for the terminal paths. Swallows everything.
   *
   * @param runId - the finished run.
   */
  notifyRunFinishedAsync(runId: string): void {
    void this.notifyRunFinished(runId).catch((err) => {
      this.logger.warn(
        `workflow_run_completed notification for run ${runId} failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    });
  }

  /**
   * Re-reads the run rather than trusting caller-supplied counters. The call sites finalize with a
   * conditional `updateMany`, so the authoritative status and counts only exist in the row, and re-reading
   * also means a caller that lost the finalize race cannot produce a second notification, because the
   * status and trigger checks below are evaluated against the same single row.
   *
   * @param runId - the finished run.
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
      run.triggerType === WORKFLOW_TRIGGER.scheduled
        ? (run.workflow.createdById ?? run.startedById)
        : (run.startedById ?? run.workflow.createdById);
    if (!recipient) return;

    // Volume guard: off unless THIS recipient opted in; the check is deliberately after recipient
    // resolution, since the preference belongs to the person who would be notified.
    if (run.triggerType === WORKFLOW_TRIGGER.on_media_enriched && !(await this.allowsWorkflowMicroRuns(recipient))) {
      return;
    }

    // After the run's terminal write committed (the call sites finalize first).
    this.notify.notify(WORKFLOW_RUN_COMPLETED_EVENT_KEY, recipient, {
      runId: run.id,
      circleId: run.circleId,
      workflowName: run.workflow.name,
      status: run.status,
      succeededCount: run.succeededCount,
      failedCount: run.failedCount,
    });
  }

  /**
   * Whether the user opted into workflow micro-run notifications. Fails closed (false): a failed read must
   * not start notifying someone who never asked.
   */
  private async allowsWorkflowMicroRuns(userId: string): Promise<boolean> {
    try {
      const prefs = await this.settings.readUser<{ workflowMicroRuns?: boolean } | undefined>(
        userId,
        MEMORIAHUB_NOTIFICATIONS_USER_NAMESPACE,
      );
      return prefs?.workflowMicroRuns === true;
    } catch {
      return false;
    }
  }
}
