import { Injectable } from '@nestjs/common';
import { AiProviderRegistry } from '@marinoscar/platform-api/ai';
import { Trace } from '@marinoscar/platform-api/otel-core';
import type {
  MemoriahubAiAdminPort,
  MemoriahubAiCredentialStatus,
  MemoriahubAiEmbeddingProbeResult,
  MemoriahubAiProbeResult,
  MemoriahubAiProviderCapabilities,
} from '@marinoscar/memoriahub-api/ports';

import { AiSettingsService } from '../../ai-port/ai-settings.service';

// =============================================================================
// PlatformMemoriahubAiAdminAdapter: the `MEMORIAHUB_AI_ADMIN` port over the app's AI admin service and the
// platform provider registry (RETRO-J10, #624)
// =============================================================================
//
// `testModel` and `testEmbedding` are `AiSettingsService.testProvider` / `testEmbedding`: the call path a job
// takes (`AiService.forSystem`: the organization's or the deployment's key), one small request that spends a
// few tokens and writes nothing (the documented live probes of `local-exceptions.md`). `credentialStatus` is
// the presentation-safe key status (the platform deployment key first, then any older row; it never decrypts).
// `providerCapabilities` reads the platform `AiProviderRegistry` (an adapter carries `audio.transcribe` when
// the provider can do speech to text; OpenAI only in v1); an unknown provider, or a registry that throws, is
// `null`: a check reports a misconfiguration, it never becomes one.
// =============================================================================

@Injectable()
export class PlatformMemoriahubAiAdminAdapter implements MemoriahubAiAdminPort {
  constructor(
    private readonly aiSettings: AiSettingsService,
    private readonly providers: AiProviderRegistry,
  ) {}

  @Trace()
  testModel(target: { provider: string; model: string }): Promise<MemoriahubAiProbeResult> {
    return this.aiSettings.testProvider({ provider: target.provider, model: target.model });
  }

  @Trace()
  testEmbedding(): Promise<MemoriahubAiEmbeddingProbeResult> {
    return this.aiSettings.testEmbedding({});
  }

  @Trace()
  async credentialStatus(provider: string): Promise<MemoriahubAiCredentialStatus> {
    const status = await this.aiSettings.credentialStatus(provider);
    return { configured: status.configured, enabled: status.enabled };
  }

  providerCapabilities(provider: string): MemoriahubAiProviderCapabilities | null {
    try {
      const adapter = this.providers.get(provider);
      if (!adapter) return null;
      return { transcribeAudio: typeof adapter.audio?.transcribe === 'function' };
    } catch {
      return null;
    }
  }
}
