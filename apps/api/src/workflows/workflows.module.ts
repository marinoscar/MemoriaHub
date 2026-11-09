import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { MediaModule } from '../media/media.module';
import { FaceModule } from '../face/face.module';
import { BurstModule } from '../burst/burst.module';
import { DedupModule } from '../dedup/dedup.module';
import { LocationInferenceModule } from '../location-inference/location-inference.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { NotificationProducersModule } from '../notification-producers/notification-producers.module';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { WorkflowDefinitionValidator } from './definition/workflow-definition.validator';
import { WorkflowConditionCompiler } from './compiler/workflow-condition.compiler';
import { WorkflowActionExecutor } from './actions/workflow-action.executor';
import { WorkflowRunsController } from './runs/workflow-runs.controller';
import { WorkflowRunService } from './runs/workflow-run.service';
import { WorkflowEvaluateHandler } from './runs/workflow-evaluate.handler';
import { WorkflowExecuteBatchHandler } from './runs/workflow-execute-batch.handler';
import { WorkflowRunsRetentionHandler } from './runs/workflow-runs-retention.handler';
import { WorkflowScheduleTask } from './runs/workflow-schedule.task';
import { WorkflowEvaluateItemHandler } from './runs/workflow-evaluate-item.handler';
import { WorkflowMicroRunFinalizeTask } from './runs/workflow-micro-run-finalize.task';
import { WorkflowMicroRunFinalizeHandler } from './runs/workflow-micro-run-finalize.handler';
import { WorkflowScheduleTickHandler } from './runs/workflow-schedule-tick.handler';
import { WorkflowTriggerListener } from './runs/workflow-trigger.listener';
import { WorkflowsAdminController } from './admin/workflows-admin.controller';
import { WorkflowsAdminService } from './admin/workflows-admin.service';

/**
 * Media Workflow Automation — Phase 2 action library (issue #140).
 *
 * Phase 1 covered definition, validation, compilation, and preview. This phase
 * adds the injectable WorkflowActionExecutor (the "Then" half); the run
 * lifecycle / queue handlers / HTTP endpoints are a separate turn.
 *
 * The executor reuses domain services verbatim, so this module imports the
 * modules that own them (each re-exports the injected service):
 *   - MediaModule            → MediaService, MediaEnrichmentService
 *   - FaceModule             → PeopleService
 *   - BurstModule            → BurstService
 *   - DedupModule            → DuplicateService
 *   - LocationInferenceModule → LocationSuggestionService
 *   - EnrichmentModule       → EnrichmentJobService
 *   - OwnerAccessModule          → OwnerAccessService
 * None of these import WorkflowsModule, so no forwardRef is required.
 *
 * NotificationProducersModule (epic #240, issue #247; RETRO-D3) supplies
 * WorkflowRunNotificationService to the run handlers that finalize a run
 * (`workflows.run_completed`). NotificationProducersModule imports NOTHING, so this edge
 * cannot close a cycle — and note MediaModule imports it too, which is fine:
 * two producers pointing at the same leaf module, not a loop.
 */
@Module({
  imports: [
    PrismaModule,
    
    OwnerAccessModule,
    MediaModule,
    FaceModule,
    BurstModule,
    DedupModule,
    LocationInferenceModule,
    EnrichmentModule,
    NotificationProducersModule,
  ],
  controllers: [WorkflowsController, WorkflowRunsController, WorkflowsAdminController],
  providers: [
    WorkflowsService,
    WorkflowsAdminService,
    WorkflowDefinitionValidator,
    WorkflowConditionCompiler,
    WorkflowActionExecutor,
    WorkflowRunService,
    WorkflowEvaluateHandler,
    WorkflowExecuteBatchHandler,
    WorkflowRunsRetentionHandler,
    WorkflowScheduleTask,
    WorkflowEvaluateItemHandler,
    WorkflowMicroRunFinalizeTask,
    // RETRO-C9 (#612): the two every-minute crons only enqueue; these do the work.
    WorkflowScheduleTickHandler,
    WorkflowMicroRunFinalizeHandler,
    WorkflowTriggerListener,
  ],
  exports: [WorkflowDefinitionValidator, WorkflowConditionCompiler, WorkflowActionExecutor],
})
export class WorkflowsModule {}
