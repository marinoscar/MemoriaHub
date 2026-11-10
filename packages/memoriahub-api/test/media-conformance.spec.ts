// =============================================================================
// describeMediaSliceConformance against the media slice over the in-memory fakes (RETRO-J5, #613)
// =============================================================================
//
// The services are RESOLVED from the real Nest module (`MediaModule.forRoot()` over
// `MemoriahubPortsModule.forRoot`), so the run also proves the slice's wiring: every provider
// resolves from the ports alone, and the fan-out registry is one singleton however many times a
// host calls `forRoot()`.
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';

import { MemoriahubPortsModule } from '../src/core/index.js';
import {
  MediaModule,
  MediaSyncService,
  MediaTouchService,
  UploadEnrichmentRegistry,
  UploadEnrichmentService,
  UploadNotificationService,
} from '../src/media/index.js';
import { describeMediaSliceConformance } from '../src/media/testing/index.js';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '../src/testing/index.js';

async function mediaSliceOverFakes() {
  const fakes = createFakeMemoriahubPorts();
  // The host declares the event the producer raises (the web app does it in its notification registry).
  fakes.notify.registerEvents([
    { key: 'media.upload_completed', label: 'Uploads', description: 'Photos were added', channels: ['browser'], kind: 'counted' },
  ]);
  const batches: string[][] = [];
  let failNext = false;
  // The delegates the slice narrows the database port with.
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
    imports: [MemoriahubPortsModule.forRoot({ ports: fakeMemoriahubBindings(fakes) }), MediaModule.forRoot()],
  }).compile();

  return {
    moduleRef,
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
      countedWrites: () =>
        fakes.notify.sent
          .filter((n) => n.method === 'notifyCounted')
          .map((n) => ({
            eventKey: n.eventKey,
            userId: n.to,
            scopeId: 'lib-1',
            windowMs: 15 * 60 * 1000,
          })),
    },
    mediaSync: { service: moduleRef.get(MediaSyncService) },
  };
}

describeMediaSliceConformance(
  { describe, it, expect },
  { name: 'in-memory fakes', create: mediaSliceOverFakes },
);

describe('MediaModule.forRoot', () => {
  it('names one module however often it is called, so the registry is a singleton', () => {
    expect(MediaModule.forRoot()).toBe(MediaModule.forRoot());
  });
});
