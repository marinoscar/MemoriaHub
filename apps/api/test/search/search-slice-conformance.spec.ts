// =============================================================================
// describeSearchSliceConformance against the web app's host (RETRO-J7, #618)
// =============================================================================
//
// The same kit `packages/memoriahub-api/test/search-conformance.spec.ts` runs over the in-memory fakes, run
// here with the AI port bound to the REAL adapter (`PlatformMemoriahubAiAdapter`) over a scripted platform
// `AiService`: the embedding call and the agent's streamed, tool-calling chat pass through the adapter's
// translation (platform stream events to the port's `text` / `tool_call` / `done`, a JSON Schema tool to the
// platform's function tool), exactly as the routes run in production.
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { MemoriahubPortsModule } from '@marinoscar/memoriahub-api/core';
import { SearchAgentService, SearchModule as SearchCoreModule, SearchService } from '@marinoscar/memoriahub-api/search';
import { createFakeSearchDb, describeSearchSliceConformance, FakeSearchStore } from '@marinoscar/memoriahub-api/search/testing';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '@marinoscar/memoriahub-api/testing';

import { PlatformMemoriahubAiAdapter } from '../../src/platform-memoriahub/ai/platform-memoriahub-ai.adapter';

async function searchSliceOverTheWebHost() {
  const fakes = createFakeMemoriahubPorts();
  const store = new FakeSearchStore();
  Object.assign(fakes.prisma, createFakeSearchDb(store));
  fakes.settings.registerNamespace({ scope: 'system', name: 'ai', schema: z.record(z.string(), z.unknown()), defaults: {} });

  // The platform AiService, scripted: one embedding of the size the table holds, one streamed answer.
  const calls: Array<{ method: string; kind: string; userId?: string; feature: string }> = [];
  let toolCall: Record<string, unknown> | null = null;
  const clientFor = (kind: 'user' | 'system', userId: string | undefined, feature: string) => ({
    embed: async (req: { input: string | string[]; model: string }) => {
      calls.push({ method: 'embed', kind, ...(userId ? { userId } : {}), feature });
      const inputs = Array.isArray(req.input) ? req.input : [req.input];
      return { provider: 'openai', model: req.model, dimensions: 1536, vectors: inputs.map(() => Array.from({ length: 1536 }, () => 0.1)) };
    },
    openStream: async () => {
      calls.push({ method: 'openStream', kind, ...(userId ? { userId } : {}), feature });
      const scripted = toolCall;
      toolCall = null;
      return (async function* () {
        yield { type: 'output_text.delta', delta: 'Looking' };
        if (scripted) {
          yield { type: 'output_item.done', item: { type: 'function_call', callId: 'c1', name: 'search_media', arguments: JSON.stringify(scripted) } };
        }
        yield { type: 'response.completed', response: { output: [], usage: { inputTokens: 1, outputTokens: 1 } } };
      })();
    },
  });
  const ai = {
    forUser: (userId: string, scope: { feature: string }) => clientFor('user', userId, scope.feature),
    forSystem: (scope: { feature: string }) => clientFor('system', undefined, scope.feature),
  };

  const moduleRef = await Test.createTestingModule({
    imports: [
      MemoriahubPortsModule.forRoot({ ports: { ...fakeMemoriahubBindings(fakes), ai: { useValue: new PlatformMemoriahubAiAdapter(ai as never) } } }),
      SearchCoreModule.forRoot(),
    ],
  }).compile();

  const seedScope = (id: string, members: Record<string, 'viewer' | 'editor' | 'admin'>) => fakes.access.addGroup(id, 'Library Alpha', members);
  const selection = async (key: string, value: { provider: string; model: string } | null) => {
    await fakes.settings.patchSystem('ai', { features: value ? { [key]: value } : {} }, { actorUserId: 'admin' });
  };

  return {
    search: {
      service: moduleRef.get(SearchService),
      store,
      seedScope,
      setEmbeddingSelection: (value: { provider: string; model: string } | null) => selection('embedding', value),
      aiCalls: () => calls,
    },
    agent: {
      service: moduleRef.get(SearchAgentService),
      store,
      seedScope,
      setSearchSelection: (value: { provider: string; model: string } | null) => selection('search', value),
      // The stream carries ONE tool call (a second round answers text only), as a model that is done searching does.
      scriptToolCall: (args: Record<string, unknown>) => {
        toolCall = args;
      },
      aiCalls: () => calls,
    },
  };
}

describeSearchSliceConformance({ describe, it, expect }, { name: 'web app host', create: searchSliceOverTheWebHost });
