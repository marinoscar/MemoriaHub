// =============================================================================
// describeSocialMediaSliceConformance against the slice over the in-memory fakes (RETRO-J10, #624)
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';

import { MemoriahubPortsModule } from '../src/core/index.js';
import { VideoFrameExtractionService } from '../src/face/index.js';
import { UploadEnrichmentRegistry, UploadEnrichmentService } from '../src/media/index.js';
import { SOCIAL_MEDIA_POST_DETECTION, SocialMediaModule } from '../src/social-media/index.js';
import { describeSocialMediaSliceConformance } from '../src/social-media/testing/index.js';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '../src/testing/index.js';

async function socialMediaOverFakes() {
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
  settings.readSystem = async (name: string) => (name === 'features' ? { value: { socialMediaDetection: enabled }, version: 1 } : readSystem(name));

  const pending: string[] = [];
  (fakes.prisma as unknown as Record<string, unknown>)['mediaSocialStatus'] = {
    upsert: async (args: { where: { mediaItemId: string } }) => {
      pending.push(args.where.mediaItemId);
      return {};
    },
  };
  const postDetection: string[] = [];

  const moduleRef = await Test.createTestingModule({
    imports: [
      MemoriahubPortsModule.forRoot({ ports: fakeMemoriahubBindings(fakes) }),
      SocialMediaModule.forRoot({
        providers: [
          { provide: VideoFrameExtractionService, useValue: {} },
          {
            provide: SOCIAL_MEDIA_POST_DETECTION,
            useValue: {
              enqueueVideoPostDetectionEnrichment: async (item: { id: string }) => {
                postDetection.push(item.id);
              },
            },
          },
        ],
      }),
    ],
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
    postDetectionItems: () => postDetection,
    pendingStatusItems: () => pending,
  };
}

describeSocialMediaSliceConformance({ describe, it, expect }, { name: 'in-memory fakes', create: socialMediaOverFakes });

describe('SocialMediaModule.forRoot', () => {
  it('is one module however many times a host calls it', () => {
    const options = { providers: [] };
    expect(SocialMediaModule.forRoot(options)).toBe(SocialMediaModule.forRoot(options));
  });
});
