// =============================================================================
// describeTaggingSliceConformance against the tagging slice over the in-memory fakes (RETRO-J7, #618)
// =============================================================================
//
// The services are RESOLVED from the real Nest module (`TaggingModule.forRoot()` over
// `MemoriahubPortsModule.forRoot`) and the module is initialised, so the run also proves the slice's
// wiring: every provider resolves from the ports alone, both handlers register through the jobs port
// and the photo fan-out registers with the media slice's registry.
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { z } from 'zod';

import { MemoriahubPortsModule } from '../src/core/index.js';
import type { MemoriahubEnqueueInput } from '../src/ports/index.js';
import { UploadEnrichmentRegistry, UploadEnrichmentService } from '../src/media/index.js';
import {
  AutoTaggingHandler,
  AutoTaggingService,
  TagLabelsService,
  TaggingBackfillService,
  TaggingModule,
  VideoAutoTaggingHandler,
} from '../src/tagging/index.js';
import {
  createFakeTaggingDb,
  describeTaggingSliceConformance,
  FakeTaggingStore,
} from '../src/tagging/testing/index.js';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '../src/testing/index.js';

async function taggingSliceOverFakes() {
  const fakes = createFakeMemoriahubPorts();
  const store = new FakeTaggingStore();
  Object.assign(fakes.prisma, createFakeTaggingDb(store));

  // The host declares the namespaces the slice reads (the web app does it in `app-registrations/settings.ts`).
  for (const name of ['features', 'autoTagging', 'ai']) {
    fakes.settings.registerNamespace({ scope: 'system', name, schema: z.record(z.string(), z.unknown()), defaults: {} });
  }

  const enqueued: MemoriahubEnqueueInput[] = [];
  const enqueue = fakes.jobs.enqueue.bind(fakes.jobs);
  fakes.jobs.enqueue = async (input) => {
    enqueued.push(input);
    return enqueue(input);
  };

  const moduleRef = await Test.createTestingModule({
    imports: [MemoriahubPortsModule.forRoot({ ports: fakeMemoriahubBindings(fakes) }), TaggingModule.forRoot()],
  }).compile();
  await moduleRef.init();

  return {
    persist: { service: moduleRef.get(AutoTaggingService), store },
    jobs: {
      handlers: [moduleRef.get(AutoTaggingHandler), moduleRef.get(VideoAutoTaggingHandler)],
      registered: (type: string) => fakes.jobs.isRegistered(type),
    },
    fanout: {
      registry: moduleRef.get(UploadEnrichmentRegistry),
      service: moduleRef.get(UploadEnrichmentService),
      store,
      setAutoTagging: async (on: boolean) => {
        await fakes.settings.patchSystem('features', { autoTagging: on }, { actorUserId: 'admin' });
      },
      enqueued: () => enqueued,
    },
    backfill: {
      service: moduleRef.get(TaggingBackfillService),
      store,
      enqueued: () => enqueued,
    },
    vocabulary: { service: moduleRef.get(TagLabelsService) },
  };
}

describeTaggingSliceConformance({ describe, it, expect }, { name: 'in-memory fakes', create: taggingSliceOverFakes });
