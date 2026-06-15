import { Injectable } from '@nestjs/common';
import type { AiProvider } from './ai-provider.interface';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiProvider } from './openai.provider';

/**
 * Registry of all available AI providers.
 *
 * To add a new native provider: instantiate it and add to the map below.
 *
 * To add an OpenAI-compatible provider (e.g. Moonshot, Together, Ollama):
 *   no new code needed — store a credential with baseUrl pointing to the
 *   compatible endpoint and use provider key 'openai'.
 */
@Injectable()
export class AiProviderRegistry {
  private readonly providers = new Map<string, AiProvider>([
    ['anthropic', new AnthropicProvider()],
    ['openai', new OpenAiProvider()],
  ]);

  get(key: string): AiProvider {
    const provider = this.providers.get(key);
    if (!provider) throw new Error(`Unknown AI provider: ${key}`);
    return provider;
  }

  keys(): string[] {
    return [...this.providers.keys()];
  }
}
