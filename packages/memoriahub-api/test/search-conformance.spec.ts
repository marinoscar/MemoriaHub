// =============================================================================
// describeSearchSliceConformance against the search slice over the in-memory fakes (RETRO-J7, #618)
// =============================================================================
//
// The services are RESOLVED from the real Nest module (`SearchModule.forRoot()` over
// `MemoriahubPortsModule.forRoot`), so the run also proves the slice's wiring: every provider resolves
// from the ports alone.
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { z } from 'zod';

import { MemoriahubPortsModule } from '../src/core/index.js';
import { SearchAgentService, SearchModule, SearchService } from '../src/search/index.js';
import { createFakeSearchDb, describeSearchSliceConformance, FakeSearchStore } from '../src/search/testing/index.js';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '../src/testing/index.js';

async function searchSliceOverFakes() {
  const fakes = createFakeMemoriahubPorts();
  const store = new FakeSearchStore();
  Object.assign(fakes.prisma, createFakeSearchDb(store));
  fakes.settings.registerNamespace({ scope: 'system', name: 'ai', schema: z.record(z.string(), z.unknown()), defaults: {} });
  // A model that answers the 1536-d vectors `media_item_embedding` holds.
  fakes.ai.vector = Array.from({ length: 1536 }, () => 0.1);

  const moduleRef = await Test.createTestingModule({
    imports: [MemoriahubPortsModule.forRoot({ ports: fakeMemoriahubBindings(fakes) }), SearchModule.forRoot()],
  }).compile();

  const seedScope = (id: string, members: Record<string, 'viewer' | 'editor' | 'admin'>) => fakes.access.addGroup(id, 'Library Alpha', members);
  const aiCalls = () => fakes.ai.calls.map((call) => ({ method: call.method, kind: call.kind, ...(call.userId ? { userId: call.userId } : {}), feature: call.scope.feature }));
  const selection = async (key: string, value: { provider: string; model: string } | null) => {
    await fakes.settings.patchSystem('ai', { features: value ? { [key]: value } : {} }, { actorUserId: 'admin' });
  };

  return {
    search: {
      service: moduleRef.get(SearchService),
      store,
      seedScope,
      setEmbeddingSelection: (value: { provider: string; model: string } | null) => selection('embedding', value),
      aiCalls,
    },
    agent: {
      service: moduleRef.get(SearchAgentService),
      store,
      seedScope,
      setSearchSelection: (value: { provider: string; model: string } | null) => selection('search', value),
      scriptToolCall: (args: Record<string, unknown>) => {
        fakes.ai.streamTexts = [];
        fakes.ai.streamToolCalls = [{ id: 'call-1', name: 'search_media', arguments: JSON.stringify(args) }];
      },
      aiCalls,
    },
  };
}

describeSearchSliceConformance({ describe, it, expect }, { name: 'in-memory fakes', create: searchSliceOverFakes });
