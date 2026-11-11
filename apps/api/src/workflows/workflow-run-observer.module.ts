import { Global, Module } from '@nestjs/common';
import { WORKFLOW_RUN_OBSERVER } from '@marinoscar/memoriahub-api/workflows';

import { NotificationProducersModule } from '../notification-producers/notification-producers.module';
import { AppWorkflowRunObserver } from './workflow-run-observer.adapter';

/**
 * Binds `WORKFLOW_RUN_OBSERVER` for the workflows slice. Nest resolves a provider per module, and the slice's
 * handlers (`workflow_evaluate`, `workflow_execute_batch`) live in the slice's own module, so a binding made
 * in the app's WorkflowsModule is invisible to them (`@Optional()` then injects `undefined` and the webhook
 * events and the run-completed notification are silently skipped). It is global so the binding is visible to the slice's module.
 */
@Global()
@Module({
  imports: [NotificationProducersModule],
  providers: [AppWorkflowRunObserver, { provide: WORKFLOW_RUN_OBSERVER, useExisting: AppWorkflowRunObserver }],
  exports: [WORKFLOW_RUN_OBSERVER],
})
export class WorkflowRunObserverModule {}
