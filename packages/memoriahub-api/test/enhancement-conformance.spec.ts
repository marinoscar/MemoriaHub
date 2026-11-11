// =============================================================================
// describeEnhancementSliceConformance against the slice over the in-memory fakes (RETRO-J10, #624)
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';

import { MemoriahubPortsModule } from '../src/core/index.js';
import {
  ENHANCEMENT_IMAGE_TOOLS,
  ENHANCEMENT_KEY_STATUS,
  ENHANCEMENT_STORAGE_ORG,
  EnhancementModule,
  PictureEnhancementHandler,
  PictureEnhancementPurgeHandler,
  PictureEnhancementPurgeTask,
} from '../src/enhancement/index.js';
import { describeEnhancementSliceConformance } from '../src/enhancement/testing/index.js';
import { MEDIA_OBJECT_REPROCESSOR, MEDIA_THUMBNAIL_PRUNER, MediaMetadataSyncService } from '../src/media/index.js';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '../src/testing/index.js';

// `EnhancementModule.forRoot` is cached (one module per host), so the option closure reads this variable.
let housekeepingEnabled = true;

async function enhancementOverFakes() {
  const fakes = createFakeMemoriahubPorts();
  const housekeeping: string[] = [];
  const enqueueHousekeeping = fakes.jobs.enqueueHousekeeping.bind(fakes.jobs);
  fakes.jobs.enqueueHousekeeping = async (input) => {
    housekeeping.push(input.type);
    return enqueueHousekeeping(input);
  };

  const moduleRef = await Test.createTestingModule({
    imports: [
      MemoriahubPortsModule.forRoot({ ports: fakeMemoriahubBindings(fakes) }),
      EnhancementModule.forRoot({
        providers: [
          // The host's: the location-aware metadata sync, the post-upload processing, the native image libraries.
          { provide: MediaMetadataSyncService, useValue: {} },
          { provide: MEDIA_OBJECT_REPROCESSOR, useValue: { reprocessNow: async () => undefined } },
          { provide: MEDIA_THUMBNAIL_PRUNER, useValue: { pruneSupersededThumbnails: async () => 0 } },
          { provide: ENHANCEMENT_IMAGE_TOOLS, useValue: {} },
          { provide: ENHANCEMENT_KEY_STATUS, useValue: { status: async () => ({ configured: true, enabled: true }) } },
          { provide: ENHANCEMENT_STORAGE_ORG, useValue: { get: async () => 'org-1' } },
        ],
        housekeepingEnabled: () => housekeepingEnabled,
      }),
    ],
  }).compile();
  await moduleRef.init();

  const task = moduleRef.get(PictureEnhancementPurgeTask);
  return {
    handlers: [moduleRef.get(PictureEnhancementHandler), moduleRef.get(PictureEnhancementPurgeHandler)],
    registered: (type: string) => fakes.jobs.isRegistered(type),
    runPurgeCron: () => task.handleScheduledPurge(),
    housekeepingEnqueued: () => housekeeping,
    setHousekeepingEnabled: (enabled: boolean) => {
      housekeepingEnabled = enabled;
    },
  };
}

describeEnhancementSliceConformance({ describe, it, expect }, { name: 'in-memory fakes', create: enhancementOverFakes });

describe('EnhancementModule.forRoot', () => {
  it('is one module however many times a host calls it', () => {
    const options = { providers: [] };
    expect(EnhancementModule.forRoot(options)).toBe(EnhancementModule.forRoot(options));
  });
});
