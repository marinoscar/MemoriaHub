// =============================================================================
// describeLocationSliceConformance against the location slice over the in-memory fakes (RETRO-J10, #624)
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';

import { MemoriahubPortsModule } from '../src/core/index.js';
import { LocationGroupRebuildService, LocationGroupResolverService, LocationModule } from '../src/location/index.js';
import { describeLocationSliceConformance, type SeededLocationGroup } from '../src/location/testing/index.js';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '../src/testing/index.js';

async function locationOverFakes() {
  const fakes = createFakeMemoriahubPorts();
  const enqueued: Array<{ type: string; priority?: number; skipDedup?: boolean }> = [];
  const enqueue = fakes.jobs.enqueue.bind(fakes.jobs);
  fakes.jobs.enqueue = async (input) => {
    enqueued.push({ type: input.type, priority: input.priority, skipDedup: input.skipDedup });
    return enqueue(input);
  };
  let groups: SeededLocationGroup[] = [];
  let featureEnabled = true;
  Object.assign(fakes.prisma, {
    locationGroup: {
      findMany: async () =>
        groups.map((group) => ({
          level: group.level,
          countryCode: group.countryCode,
          canonicalName: group.canonicalName,
          centerLat: group.centerLat ?? null,
          centerLng: group.centerLng ?? null,
          radiusKm: group.radiusKm ?? null,
          aliases: (group.aliases ?? []).map((normalizedValue) => ({ level: group.level, countryCode: group.countryCode, normalizedValue })),
        })),
    },
    job: { findUnique: async () => ({ status: 'pending' }) },
  });
  const settings = fakes.settings as unknown as { readSystem: (name: string) => Promise<{ value: unknown; version: number }> };
  const readSystem = settings.readSystem.bind(settings);
  settings.readSystem = async (name: string) => {
    if (name === 'features') return { value: { locationGrouping: featureEnabled }, version: 1 };
    if (name === 'locationGrouping') return { value: { radiusCaptureEnabled: true, maxRadiusKm: 50 }, version: 1 };
    return readSystem(name);
  };

  const moduleRef = await Test.createTestingModule({
    imports: [MemoriahubPortsModule.forRoot({ ports: fakeMemoriahubBindings(fakes) }), LocationModule.forRoot()],
  }).compile();

  const resolver = moduleRef.get(LocationGroupResolverService);
  return {
    resolver: {
      resolver,
      seed: (next: ReadonlyArray<SeededLocationGroup>, options?: { featureEnabled?: boolean }) => {
        groups = [...next];
        featureEnabled = options?.featureEnabled ?? true;
        resolver.invalidate();
      },
    },
    rebuild: {
      service: moduleRef.get(LocationGroupRebuildService),
      queuedJobs: () => enqueued,
    },
  };
}

describeLocationSliceConformance({ describe, it, expect }, { name: 'in-memory fakes', create: locationOverFakes });

describe('LocationModule.forRoot', () => {
  it('is one module however many times a host calls it', () => {
    expect(LocationModule.forRoot()).toBe(LocationModule.forRoot());
  });
});
