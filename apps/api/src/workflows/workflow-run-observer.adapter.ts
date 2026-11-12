import { Injectable, Optional } from '@nestjs/common';
import { WorkflowRunNotificationService, type WorkflowRunObserver } from '@marinoscar/memoriahub-api/workflows';

import { MemoriaHubWebhooks } from '../platform/webhooks/memoriahub-webhooks.service';

/**
 * The web app's {@link WorkflowRunObserver} (RETRO-J9, #622): a run's terminal and approval writes reach the
 * `workflows.run.completed` and `workflows.run.awaiting_approval` webhook events (RETRO-H4, #603) and the
 * `workflow_run_completed` notification (epic #240, issue #247). Both side channels never throw.
 */
@Injectable()
export class AppWorkflowRunObserver implements WorkflowRunObserver {
  constructor(
    private readonly runNotifications: WorkflowRunNotificationService,
    // Optional so a hand-built test module needs no webhook stub.
    @Optional() private readonly webhookEvents?: MemoriaHubWebhooks,
  ) {}

  async runFinished(runId: string): Promise<void> {
    await this.webhookEvents?.workflowRunFinished(runId);
  }

  async runAwaitingApproval(runId: string): Promise<void> {
    await this.webhookEvents?.workflowRunAwaitingApproval(runId);
  }

  notifyRunFinishedAsync(runId: string): void {
    this.runNotifications.notifyRunFinishedAsync(runId);
  }
}
