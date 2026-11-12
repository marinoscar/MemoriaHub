import { Module } from '@nestjs/common';
import {
  WorkflowRunsController,
  WorkflowsAdminController,
  WorkflowsController,
  WorkflowsModule as WorkflowsSliceModule,
} from '@marinoscar/memoriahub-api/workflows';

import { PrismaModule } from '../prisma/prisma.module';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { MediaModule } from '../media/media.module';
import { FaceModule } from '../face/face.module';
import { BurstModule } from '../burst/burst.module';
import { DedupModule } from '../dedup/dedup.module';
import { LocationInferenceModule } from '../location-inference/location-inference.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { WorkflowActionsHandler } from './actions/workflow-actions.handler';
import { registerReviewCatalog } from './registry/review-catalog';
import { WorkflowTriggerListener } from './runs/workflow-trigger.listener';
import { WorkflowRunsRetentionHandler } from './runs/workflow-runs-retention.handler';
import { WorkflowRunObserverModule } from './workflow-run-observer.module';

// The review-queue half of the Media Item catalog (burst, duplicate and location-suggestion fields and actions):
// the slice's built-in catalog knows no review queue, so the app registers these once, in catalog order.
registerReviewCatalog();

/**
 * The web app's binding of the workflows slice (RETRO-J9, #622). Media Workflow Automation (epic #138: the
 * definition, the condition compiler, the run lifecycle, the queue handlers `workflow_evaluate`,
 * `workflow_execute_batch` (node-claimable), `workflow_evaluate_item` and the two tick handlers, the
 * enqueue-only crons, the three controllers' classes) lives in `@marinoscar/memoriahub-api/workflows`. This
 * module mounts the controllers and supplies what the slice leaves to its host:
 *
 *   - `WorkflowActionsHandler`: applies every action, reusing the media, face, burst, duplicate and location
 *     services verbatim, registered with the slice's action handler registry;
 *   - the review-queue field and action catalog (`registerReviewCatalog`);
 *   - `WorkflowTriggerListener`: the two upstream events, bound to the slice's settlement service;
 *   - `WorkflowRunObserverModule` (global; binds `WORKFLOW_RUN_OBSERVER` to `AppWorkflowRunObserver`): the webhook events and the run-completed notification;
 *   - `WorkflowRunsRetentionHandler`: the nightly `workflow_history_purge`, bound to the platform's retention policy.
 *
 * The modules imported here own the services the actions reuse (each re-exports the injected service); none of
 * them imports WorkflowsModule, so no forwardRef is required. The `workflow_run_completed` producer is the
 * slice's (RETRO-J10), reached through `WorkflowRunObserverModule`.
 */
@Module({
  imports: [
    WorkflowsSliceModule.forRoot(),
    WorkflowRunObserverModule,
    PrismaModule,
    OwnerAccessModule,
    MediaModule,
    FaceModule,
    BurstModule,
    DedupModule,
    LocationInferenceModule,
    EnrichmentModule,
  ],
  controllers: [WorkflowsController, WorkflowRunsController, WorkflowsAdminController],
  providers: [
    WorkflowActionsHandler,
    WorkflowTriggerListener,
    WorkflowRunsRetentionHandler,
  ],
  exports: [WorkflowsSliceModule],
})
export class WorkflowsModule {}
