import { Injectable } from '@nestjs/common';

import {
  createLegacyAdapterSet,
  LegacyAnthropicProvider,
  LegacyOpenAiProvider,
} from './legacy-ai-provider.adapter';
import type { AiProvider } from './legacy-ai-provider.types';

/**
 * Registry of MemoriaHub's legacy AI providers, keyed `openai` / `anthropic`.
 *
 * PLATFORM-ADOPTION-SHIM(#595): both providers now run on the platform's
 * framework-free adapters (`legacy-ai-provider.adapter.ts`), so no provider SDK
 * is imported in `apps/`. An OpenAI-compatible endpoint (Moonshot, Together,
 * Ollama) still needs no code: store an `openai` credential with a `baseUrl`.
 * RETRO-E2 replaces the call sites with `AiService.forUser` and deletes this.
 */
@Injectable()
export class AiProviderRegistry {
  private readonly providers: Map<string, AiProvider>;

  constructor() {
    const adapters = createLegacyAdapterSet();
    this.providers = new Map<string, AiProvider>([
      ['anthropic', new LegacyAnthropicProvider(adapters)],
      ['openai', new LegacyOpenAiProvider(adapters)],
    ]);
  }

  get(key: string): AiProvider {
    const provider = this.providers.get(key);
    if (!provider) throw new Error(`Unknown AI provider: ${key}`);
    return provider;
  }

  keys(): string[] {
    return [...this.providers.keys()];
  }
}
