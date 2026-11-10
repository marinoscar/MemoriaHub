// =============================================================================
// describeMediaSliceConformance against the web app's host (RETRO-J5, #613)
// =============================================================================
//
// The same kit `packages/memoriahub-api/test/media-conformance.spec.ts` runs over the in-memory fakes,
// run here with the services RESOLVED from the Nest module graph the app uses (`MediaModule.forRoot()` over
// `MemoriahubPortsModule.forRoot`) and the notification port bound to the REAL adapter
// (`PlatformMemoriahubNotifyAdapter`) over the platform notifications double, so the counted write the
// producer makes is the one the platform would fold: the permanent event key, the library as the scope,
// the 15-minute window. The titles the bell renders come from MemoriaHub's own event registry.
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { MemoriahubPortsModule } from '@marinoscar/memoriahub-api/core';
import {
  MediaModule as MediaCoreModule,
  MediaSyncService,
  MediaTouchService,
  UploadEnrichmentRegistry,
  UploadEnrichmentService,
  UploadNotificationService,
} from '@marinoscar/memoriahub-api/media';
import { describeMediaSliceConformance } from '@marinoscar/memoriahub-api/media/testing';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '@marinoscar/memoriahub-api/testing';

import { PlatformMemoriahubNotifyAdapter } from '../../src/platform-memoriahub/notify/platform-memoriahub-notify.adapter';
import { createPlatformNotificationsMock } from '../mocks/platform-notifications.mock';

async function mediaSliceOverTheWebHost() {
  const fakes = createFakeMemoriahubPorts();
  const platform = createPlatformNotificationsMock();
  const batches: string[][] = [];
  let failNext = false;
  Object.assign(fakes.prisma, {
    mediaItem: {
      updateMany: async (args: { where: { id: { in: string[] } } }) => {
        if (failNext) {
          failNext = false;
          throw new Error('database unavailable');
        }
        batches.push(args.where.id.in);
        return { count: args.where.id.in.length };
      },
    },
    mediaSyncDevice: { findFirst: async () => null },
    user: { findUnique: async () => ({ displayName: 'Person A', providerDisplayName: null, email: 'a@example.test' }) },
  });

  const moduleRef = await Test.createTestingModule({
    imports: [
      MemoriahubPortsModule.forRoot({
        ports: { ...fakeMemoriahubBindings(fakes), notify: { useValue: new PlatformMemoriahubNotifyAdapter(platform.mock as never) } },
      }),
      MediaCoreModule.forRoot(),
    ],
  }).compile();

  return {
    touch: {
      service: moduleRef.get(MediaTouchService),
      writtenBatches: () => batches,
      failNextWrite: () => {
        failNext = true;
      },
    },
    fanout: { registry: moduleRef.get(UploadEnrichmentRegistry), service: moduleRef.get(UploadEnrichmentService) },
    upload: {
      service: moduleRef.get(UploadNotificationService),
      seedLibrary: (id: string, members: ReadonlyArray<{ userId: string; role: 'viewer' | 'editor' | 'admin' }>) =>
        fakes.access.addGroup(id, 'Library Alpha', Object.fromEntries(members.map((m) => [m.userId, m.role]))),
      // The adapter detaches the write; let it land.
      countedWrites: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return platform.calls('notifyCounted').map((call) => ({
          eventKey: call.eventKey,
          userId: call.userId,
          scopeId: call.circleId as string | undefined,
          windowMs: call.windowMs as number | null,
        }));
      },
    },
    mediaSync: { service: moduleRef.get(MediaSyncService) },
  };
}

describeMediaSliceConformance({ describe, it, expect }, { name: 'web app host', create: mediaSliceOverTheWebHost });

describe('upload_completed titles (the host registry renders what the producer writes)', () => {
  it("the uploader's row reads '{count} item(s) uploaded to {library}' and the others' '{uploader} added {count} photo(s) to {library}'", async () => {
    const fakes = createFakeMemoriahubPorts();
    const platform = createPlatformNotificationsMock();
    Object.assign(fakes.prisma, {
      user: { findUnique: async () => ({ displayName: 'Person A', providerDisplayName: null, email: 'a@example.test' }) },
    });
    fakes.access.addGroup('lib-1', 'Family', { uploader: 'editor', viewer: 'viewer' });
    const moduleRef = await Test.createTestingModule({
      imports: [
        MemoriahubPortsModule.forRoot({
          ports: { ...fakeMemoriahubBindings(fakes), notify: { useValue: new PlatformMemoriahubNotifyAdapter(platform.mock as never) } },
        }),
        MediaCoreModule.forRoot(),
      ],
    }).compile();

    await moduleRef.get(UploadNotificationService).recordUpload({ circleId: 'lib-1', uploaderId: 'uploader' });
    await new Promise((resolve) => setImmediate(resolve));

    const calls = platform.calls('notifyCounted');
    const own = calls.find((c) => c.userId === 'uploader')!;
    const other = calls.find((c) => c.userId === 'viewer')!;
    expect(own.buildTitle(1)).toBe('1 item uploaded to Family');
    expect(own.buildTitle(4)).toBe('4 items uploaded to Family');
    expect(other.buildTitle(3)).toBe('Person A added 3 photos to Family');
  });
});
