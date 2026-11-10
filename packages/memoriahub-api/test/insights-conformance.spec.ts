// =============================================================================
// describeInsightsSliceConformance against the insights slice over the in-memory fakes (RETRO-J10, #624)
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';

import { MemoriahubPortsModule } from '../src/core/index.js';
import { InsightsModule, InsightsService } from '../src/insights/index.js';
import { describeInsightsSliceConformance } from '../src/insights/testing/index.js';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '../src/testing/index.js';

async function insightsOverFakes() {
  const fakes = createFakeMemoriahubPorts();
  let seeded = false;
  const queryRaw = async (query: TemplateStringsArray | { strings: ReadonlyArray<string> }) => {
    if (!seeded) return [];
    const text = Array.isArray(query) ? (query as unknown as string[]).join(' ') : (query as { strings: string[] }).strings.join(' ');
    if (text.includes('GROUP BY mi.type')) return [{ type: 'photo', cnt: 2n, bytes: 300n }];
    return [
      { provider: 's3', kind: 'photo', trashed: false, bytes: 200n },
      { provider: 's3', kind: 'photo', trashed: true, bytes: 100n },
    ];
  };
  Object.assign(fakes.prisma, {
    $queryRaw: queryRaw,
    face: { count: async () => 0 },
    mediaTagStatus: { count: async () => 0 },
    insightsSnapshot: {},
    job: { findUnique: async () => ({ status: 'pending' }) },
  });
  const moduleRef = await Test.createTestingModule({
    imports: [MemoriahubPortsModule.forRoot({ ports: fakeMemoriahubBindings(fakes) }), InsightsModule.forRoot()],
  }).compile();
  return {
    service: moduleRef.get(InsightsService),
    seedLibrary: () => {
      seeded = true;
    },
    queuedJobs: () => fakes.jobs.jobs.map((job) => ({ type: job.type, subjectType: job.subjectType ?? null })),
  };
}

describeInsightsSliceConformance({ describe, it, expect }, { name: 'in-memory fakes', create: insightsOverFakes });

describe('InsightsModule.forRoot', () => {
  it('is one module however many times a host calls it', () => {
    expect(InsightsModule.forRoot()).toBe(InsightsModule.forRoot());
  });
});
