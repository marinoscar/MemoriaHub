// =============================================================================
// The workflow run observer reaches the slice's handlers (RETRO-J9 follow-up)
// =============================================================================
//
// `WORKFLOW_RUN_OBSERVER` is injected `@Optional()` by two handlers that live in the slice's own module. A
// binding that is not visible there injects `undefined` and the run webhooks and notification are silently
// skipped, so this resolves the real handlers from the real slice module and checks what they received.
// =============================================================================

import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MemoriahubPortsModule } from '@marinoscar/memoriahub-api/core';
import {
  WorkflowEvaluateHandler,
  WorkflowExecuteBatchHandler,
  WorkflowsModule as WorkflowsSliceModule,
} from '@marinoscar/memoriahub-api/workflows';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '@marinoscar/memoriahub-api/testing';

import { NotificationProducersModule } from '../../src/notification-producers/notification-producers.module';
import { WorkflowRunNotificationService } from '../../src/notification-producers/workflow-run-notification.service';
import { AppWorkflowRunObserver } from '../../src/workflows/workflow-run-observer.adapter';
import { WorkflowRunObserverModule } from '../../src/workflows/workflow-run-observer.module';

const notifyRunFinishedAsync = jest.fn();

@Module({
  providers: [{ provide: WorkflowRunNotificationService, useValue: { notifyRunFinishedAsync } }],
  exports: [WorkflowRunNotificationService],
})
class StubNotificationProducersModule {}

async function build() {
  const fakes = createFakeMemoriahubPorts();
  return Test.createTestingModule({
    imports: [
      MemoriahubPortsModule.forRoot({ ports: { ...fakeMemoriahubBindings(fakes) } }),
      WorkflowsSliceModule.forRoot(),
      WorkflowRunObserverModule,
    ],
  })
    .overrideModule(NotificationProducersModule)
    .useModule(StubNotificationProducersModule)
    .compile();
}

describe('WORKFLOW_RUN_OBSERVER wiring', () => {
  it.each([
    ['WorkflowEvaluateHandler', WorkflowEvaluateHandler],
    ['WorkflowExecuteBatchHandler', WorkflowExecuteBatchHandler],
  ])('%s receives the app observer', async (_name, handler) => {
    const moduleRef = await build();
    const instance = moduleRef.get(handler as never) as { observer?: unknown };
    expect(instance.observer).toBeInstanceOf(AppWorkflowRunObserver);
    (instance.observer as AppWorkflowRunObserver).notifyRunFinishedAsync('run-1');
    expect(notifyRunFinishedAsync).toHaveBeenCalledWith('run-1');
  });
});
