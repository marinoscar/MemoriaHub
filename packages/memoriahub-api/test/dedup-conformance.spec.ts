// =============================================================================
// describeDedupSliceConformance against the dedup slice over the in-memory fakes (RETRO-J10, #624)
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';

import { MemoriahubPortsModule } from '../src/core/index.js';
import { DedupModule } from '../src/dedup/index.js';
import { describeDedupSliceConformance } from '../src/dedup/testing/index.js';
import { UploadEnrichmentRegistry, UploadEnrichmentService } from '../src/media/index.js';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '../src/testing/index.js';

async function dedupOverFakes() {
  const fakes = createFakeMemoriahubPorts();
  let enabled = true;
  const queued: Array<{ type: string; priority?: number }> = [];
  const enqueue = fakes.jobs.enqueue.bind(fakes.jobs);
  fakes.jobs.enqueue = async (input) => {
    queued.push({ type: input.type, priority: input.priority });
    return enqueue(input);
  };
  const settings = fakes.settings as unknown as { readSystem: (name: string) => Promise<{ value: unknown; version: number }> };
  const readSystem = settings.readSystem.bind(settings);
  settings.readSystem = async (name: string) => (name === 'features' ? { value: { duplicateDetection: enabled }, version: 1 } : readSystem(name));

  const moduleRef = await Test.createTestingModule({
    imports: [MemoriahubPortsModule.forRoot({ ports: fakeMemoriahubBindings(fakes) }), DedupModule.forRoot()],
  }).compile();
  // The registration runs in `onModuleInit`.
  await moduleRef.init();

  return {
    registry: moduleRef.get(UploadEnrichmentRegistry),
    fanout: moduleRef.get(UploadEnrichmentService),
    setFeature: (value: boolean) => {
      enabled = value;
    },
    queuedJobs: () => queued,
  };
}

describeDedupSliceConformance({ describe, it, expect }, { name: 'in-memory fakes', create: dedupOverFakes });

describe('DedupModule.forRoot', () => {
  it('is one module however many times a host calls it', () => {
    expect(DedupModule.forRoot()).toBe(DedupModule.forRoot());
  });
});
