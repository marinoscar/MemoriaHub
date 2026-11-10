// =============================================================================
// describeTaggingSliceConformance against the web app's host (RETRO-J7, #618)
// =============================================================================
//
// The same kit `packages/memoriahub-api/test/tagging-conformance.spec.ts` runs over the in-memory fakes,
// run here with the jobs port bound to the REAL adapter (`PlatformMemoriahubJobsAdapter`) over the platform
// queue stand-in: both handlers register through it, so the node-pair refusal, the type strings, the
// execution profiles and the `tagging` throttle bucket are the ones the platform queue would hold.
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { MemoriahubPortsModule } from '@marinoscar/memoriahub-api/core';
import { UploadEnrichmentRegistry, UploadEnrichmentService } from '@marinoscar/memoriahub-api/media';
import {
  AutoTaggingHandler,
  AutoTaggingService,
  TagLabelsService,
  TaggingBackfillService,
  TaggingModule as TaggingCoreModule,
  VideoAutoTaggingHandler,
} from '@marinoscar/memoriahub-api/tagging';
import {
  createFakeTaggingDb,
  describeTaggingSliceConformance,
  FakeTaggingStore,
} from '@marinoscar/memoriahub-api/tagging/testing';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '@marinoscar/memoriahub-api/testing';

import { PlatformMemoriahubJobsAdapter } from '../../src/platform-memoriahub/jobs/platform-memoriahub-jobs.adapter';
import { buildJobsStandIns } from '../platform-memoriahub/platform-stand-ins';

async function taggingSliceOverTheWebHost() {
  const fakes = createFakeMemoriahubPorts();
  const store = new FakeTaggingStore();
  Object.assign(fakes.prisma, createFakeTaggingDb(store));
  for (const name of ['features', 'autoTagging', 'ai']) {
    fakes.settings.registerNamespace({ scope: 'system', name, schema: z.record(z.string(), z.unknown()), defaults: {} });
  }

  const stand = buildJobsStandIns();
  const jobs = new PlatformMemoriahubJobsAdapter(
    stand.queue as never,
    stand.registry,
    stand.throttle,
    stand.scope as never,
    stand.queue as never,
    stand.events,
    stand.defaultOrg as never,
  );

  const moduleRef = await Test.createTestingModule({
    imports: [
      MemoriahubPortsModule.forRoot({ ports: { ...fakeMemoriahubBindings(fakes), jobs: { useValue: jobs } } }),
      TaggingCoreModule.forRoot(),
    ],
  }).compile();
  await moduleRef.init();

  const enqueued = () => stand.queue.rows.map((row) => ({ type: row.type, priority: row.priority, subjectId: row.subjectId ?? undefined, reason: row.reason }));

  return {
    persist: { service: moduleRef.get(AutoTaggingService), store },
    jobs: {
      handlers: [moduleRef.get(AutoTaggingHandler), moduleRef.get(VideoAutoTaggingHandler)],
      registered: (type: string) => jobs.isRegistered(type),
    },
    fanout: {
      registry: moduleRef.get(UploadEnrichmentRegistry),
      service: moduleRef.get(UploadEnrichmentService),
      store,
      setAutoTagging: async (on: boolean) => {
        await fakes.settings.patchSystem('features', { autoTagging: on }, { actorUserId: 'admin' });
      },
      enqueued,
    },
    backfill: { service: moduleRef.get(TaggingBackfillService), store, enqueued },
    vocabulary: { service: moduleRef.get(TagLabelsService) },
    stand,
  };
}

describeTaggingSliceConformance({ describe, it, expect }, { name: 'web app host', create: taggingSliceOverTheWebHost });

describe('the platform queue the handlers register on (web app host)', () => {
  it('holds both job types as server-only handlers on the shared `tagging` throttle bucket', async () => {
    const { stand } = await taggingSliceOverTheWebHost();

    expect(stand.registry.types()).toEqual(expect.arrayContaining(['auto_tagging', 'video_auto_tagging']));
    expect(stand.registry.serverOnlyTypes()).toEqual(expect.arrayContaining(['auto_tagging', 'video_auto_tagging']));
    expect(stand.throttle.resolveKey('auto_tagging')).toBe('tagging');
    expect(stand.throttle.resolveKey('video_auto_tagging')).toBe('tagging');
  });
});
