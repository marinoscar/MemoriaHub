// =============================================================================
// describeReviewRunsSliceConformance against the review-runs slice over the in-memory fakes (RETRO-J9, #622)
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';

import { MemoriahubPortsModule } from '../src/core/index.js';
import {
  ReviewRunEvaluateHandler,
  ReviewRunExecuteBatchHandler,
  ReviewRunService,
  ReviewRunSubjectRegistry,
  ReviewRunsModule,
} from '../src/review-runs/index.js';
import { FakeReviewRunsDb, describeReviewRunsSliceConformance } from '../src/review-runs/testing/index.js';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '../src/testing/index.js';

async function reviewRunsOverFakes() {
  const fakes = createFakeMemoriahubPorts();
  const db = new FakeReviewRunsDb();
  fakes.access.addGroup('circle-1', 'Circle One', { 'user-1': 'editor' });

  const moduleRef = await Test.createTestingModule({
    imports: [MemoriahubPortsModule.forRoot({ ports: { ...fakeMemoriahubBindings(fakes), prisma: { useValue: db } } }), ReviewRunsModule.forRoot()],
  }).compile();
  await moduleRef.init();

  return {
    service: moduleRef.get(ReviewRunService),
    evaluate: moduleRef.get(ReviewRunEvaluateHandler),
    execute: moduleRef.get(ReviewRunExecuteBatchHandler),
    registry: moduleRef.get(ReviewRunSubjectRegistry),
    editor: { userId: 'user-1', perms: ['media:write'] },
    deleter: { userId: 'user-1', perms: ['media:write', 'media:delete'] },
    queuedJobs: () => fakes.jobs.jobs.map((j) => ({ type: j.type, payload: j.payload as Record<string, unknown> })),
    readRun: (runId: string) => db.reviewRun.findUnique({ where: { id: runId } }),
    registeredJobTypes: () => [...fakes.jobs.registered.keys()],
  };
}

describeReviewRunsSliceConformance({ describe, it, expect }, { name: 'in-memory fakes', create: reviewRunsOverFakes });

describe('ReviewRunsModule.forRoot', () => {
  it('is one module however many times a host calls it', () => {
    expect(ReviewRunsModule.forRoot()).toBe(ReviewRunsModule.forRoot());
  });
});
