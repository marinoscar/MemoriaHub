// =============================================================================
// describeWorkflowsSliceConformance against the workflows slice over the in-memory fakes (RETRO-J9, #622)
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';

import { MemoriahubPortsModule } from '../src/core/index.js';
import {
  WorkflowActionExecutor,
  WorkflowActionHandlerRegistry,
  WorkflowsModule,
} from '../src/workflows/index.js';
import { FakeWorkflowsDb, describeWorkflowsSliceConformance } from '../src/workflows/testing/index.js';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '../src/testing/index.js';

async function workflowsOverFakes() {
  const fakes = createFakeMemoriahubPorts();
  const db = new FakeWorkflowsDb();

  const moduleRef = await Test.createTestingModule({
    imports: [MemoriahubPortsModule.forRoot({ ports: { ...fakeMemoriahubBindings(fakes), prisma: { useValue: db } } }), WorkflowsModule.forRoot()],
  }).compile();
  await moduleRef.init();

  return {
    handlers: fakes.jobs.registered as ReadonlyMap<string, any>,
    actionHandlers: moduleRef.get(WorkflowActionHandlerRegistry),
    executor: moduleRef.get(WorkflowActionExecutor),
    seedRun: (runId: string, status: string) => db.seedRun({ id: runId, status }),
  };
}

describeWorkflowsSliceConformance({ describe, it, expect }, { name: 'in-memory fakes', create: workflowsOverFakes });

describe('WorkflowsModule.forRoot', () => {
  it('is one module however many times a host calls it', () => {
    expect(WorkflowsModule.forRoot()).toBe(WorkflowsModule.forRoot());
  });
});
