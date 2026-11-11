import { Module, type DynamicModule } from '@nestjs/common';

import { MediaModule } from '../media/index.js';
import { WorkflowsAdminService } from './admin/workflows-admin.service.js';
import { WorkflowActionExecutor, WorkflowActionHandlerRegistry } from './actions/workflow-action.executor.js';
import { WorkflowConditionCompiler } from './compiler/workflow-condition.compiler.js';
import { WorkflowDefinitionValidator } from './definition/workflow-definition.validator.js';
import { WorkflowEvaluateHandler } from './runs/workflow-evaluate.handler.js';
import { WorkflowEvaluateItemHandler } from './runs/workflow-evaluate-item.handler.js';
import { WorkflowExecuteBatchHandler } from './runs/workflow-execute-batch.handler.js';
import { WorkflowMicroRunFinalizeHandler } from './runs/workflow-micro-run-finalize.handler.js';
import { WorkflowMicroRunFinalizeTask } from './runs/workflow-micro-run-finalize.task.js';
import { WorkflowRunService } from './runs/workflow-run.service.js';
import { WorkflowScheduleTask } from './runs/workflow-schedule.task.js';
import { WorkflowScheduleTickHandler } from './runs/workflow-schedule-tick.handler.js';
import { WorkflowTriggerService } from './runs/workflow-trigger.service.js';
import { WorkflowsService } from './workflows.service.js';

/**
 * Options of {@link WorkflowsModule.forRoot}. None yet: the slice is configured through the registries
 * its owners fill (`registerWorkflowField`, `registerWorkflowAction`, `WorkflowActionHandlerRegistry`) and the
 * optional `WORKFLOW_RUN_OBSERVER` binding.
 *
 * @stability experimental
 */
export interface WorkflowsModuleOptions {
  /** Reserved. */
  readonly reserved?: never;
}

/**
 * The workflows slice (RETRO-J9, #622): Media Workflow Automation, the Subject, Trigger, If, Then rule engine
 * (epic #138). It owns the definition schema and validator, the condition compiler, the field and action
 * descriptor registries, the run lifecycle service, the four queue handlers (`workflow_evaluate`,
 * `workflow_execute_batch` (node-claimable), `workflow_evaluate_item`, and the two cron-driven tick handlers),
 * the two every-minute enqueue-only crons and the on_media_enriched settlement service. It reaches the outside
 * only through the host ports.
 *
 * What the slice does NOT own: the actions' implementation (the host registers a
 * `WorkflowActionHandler` with `WorkflowActionHandlerRegistry`, because applying an action calls the media,
 * face, burst, duplicate and location services), the review-queue half of the field and action catalog (the
 * owner of those queues registers it), the listener that turns the host's upstream events into
 * `WorkflowTriggerService.evaluateSettlement`, the webhook and notification side channels
 * (`WORKFLOW_RUN_OBSERVER`) and the nightly `workflow_history_purge` (the platform retention policy).
 * The three controllers are exported classes the host mounts in the module where its routes belong.
 *
 * Import it ONCE in the host (the registries and the handlers are singletons).
 *
 * @stability experimental
 */
@Module({})
export class WorkflowsModule {
  private static root: DynamicModule | undefined;

  /**
   * Builds the module (cached, so every call names the same instance).
   *
   * @param _options - reserved.
   */
  static forRoot(_options: WorkflowsModuleOptions = {}): DynamicModule {
    const providers = [
      WorkflowDefinitionValidator,
      WorkflowConditionCompiler,
      WorkflowActionHandlerRegistry,
      WorkflowActionExecutor,
      WorkflowsService,
      WorkflowsAdminService,
      WorkflowRunService,
      WorkflowTriggerService,
      WorkflowEvaluateHandler,
      WorkflowEvaluateItemHandler,
      WorkflowExecuteBatchHandler,
      WorkflowScheduleTickHandler,
      WorkflowMicroRunFinalizeHandler,
      WorkflowScheduleTask,
      WorkflowMicroRunFinalizeTask,
    ];
    WorkflowsModule.root ??= {
      module: WorkflowsModule,
      imports: [MediaModule.forRoot()],
      providers,
      exports: providers,
    };
    return WorkflowsModule.root;
  }
}
