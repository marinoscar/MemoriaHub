// =============================================================================
// describeBurstSliceConformance against the burst slice over the in-memory fakes (RETRO-J10, #624)
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';

import { MemoriahubPortsModule } from '../src/core/index.js';
import { BurstModule } from '../src/burst/index.js';
import { describeBurstSliceConformance } from '../src/burst/testing/index.js';
import { UploadEnrichmentRegistry, UploadEnrichmentService } from '../src/media/index.js';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '../src/testing/index.js';

async function burstOverFakes() {
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
  settings.readSystem = async (name: string) => (name === 'features' ? { value: { burstDetection: enabled }, version: 1 } : readSystem(name));

  const moduleRef = await Test.createTestingModule({
    imports: [MemoriahubPortsModule.forRoot({ ports: fakeMemoriahubBindings(fakes) }), BurstModule.forRoot()],
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

describeBurstSliceConformance({ describe, it, expect }, { name: 'in-memory fakes', create: burstOverFakes });

describe('BurstModule.forRoot', () => {
  it('is one module however many times a host calls it', () => {
    expect(BurstModule.forRoot()).toBe(BurstModule.forRoot());
  });
});
