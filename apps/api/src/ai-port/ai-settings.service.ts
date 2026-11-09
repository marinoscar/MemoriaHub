import { Injectable, BadRequestException } from '@nestjs/common';
import { AiProviderRegistry } from './legacy-ai-provider.registry';
import { AiDeploymentKeySource } from './ai-deployment-key-source';
import {
  TestAiProviderDto,
  SetSearchFeatureDto,
  SetTaggingFeatureDto,
  SetEmbeddingFeatureDto,
  SetEnhanceFeatureDto,
  SetMemoriesFeatureDto,
  SetTranscriptionFeatureDto,
  TestEmbeddingDto,
} from './dto/ai-credentials.dto';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

@Injectable()
export class AiSettingsService {
  constructor(
    private readonly keys: AiDeploymentKeySource,
    private readonly registry: AiProviderRegistry,
    private readonly systemSettings: AppSystemSettingsService,
  ) {}

  /**
   * Return the AI settings summary (no plaintext keys, no ciphertext). Since RETRO-E3 (#605) a
   * provider's status comes from the platform credential store when it holds a key there, else
   * from the legacy row (`AiDeploymentKeySource`).
   */
  async getSettings() {
    const statuses = await this.keys.list(this.registry.keys());
    const creds = statuses.filter((c) => c.configured);
    const sysSettings = await this.systemSettings.getSettings();
    const ai = sysSettings.ai;

    return {
      providers: creds.map(c => ({
        provider: c.provider,
        configured: true,
        enabled: c.enabled,
        last4: c.last4,
        baseUrl: c.baseUrl ?? null,
        updatedAt: c.updatedAt,
      })),
      // Surface known providers that aren't configured yet
      knownProviders: this.registry
        .keys()
        .filter(k => !creds.find(c => c.provider === k))
        .map(k => ({
          provider: k,
          configured: false,
          enabled: false,
          last4: null,
          baseUrl: null,
        })),
      features: ai?.features ?? {
        search: { provider: null, model: null },
        tagging: { provider: null, model: null },
        embedding: { provider: null, model: null },
        enhance: null,
        memories: null,
      },
    };
  }

  /** Test provider connectivity */
  async testProvider(dto: TestAiProviderDto) {
    const creds = await this.resolveCredentials(dto.provider);
    const provider = this.registry.get(dto.provider);
    return provider.testModel(creds, dto.model);
  }

  /** List models for a provider (works even without a configured credential) */
  async listModels(providerKey: string) {
    // Validate the provider key — registry.get throws for unknown providers.
    const provider = this.registry.get(providerKey);

    // Credential is optional: pass the key only when one is stored AND the provider is enabled;
    // otherwise the curated list is used (empty key).
    const status = await this.keys.status(providerKey);
    let creds: { apiKey: string; baseUrl?: string };
    if (status.configured && status.enabled) {
      creds = await this.keys.resolve(providerKey);
    } else {
      creds = { apiKey: '', ...(status.baseUrl ? { baseUrl: status.baseUrl } : {}) };
    }

    return provider.listModels(creds);
  }

  /**
   * List embedding models for a provider.
   * Returns an empty array for providers that do not support embeddings.
   */
  async listEmbeddingModels(providerKey: string): Promise<string[]> {
    // Validate the provider key — registry.get throws for unknown providers.
    const provider = this.registry.get(providerKey);
    if (typeof (provider as any).listEmbeddingModels !== 'function') {
      return [];
    }
    return (provider as any).listEmbeddingModels() as string[];
  }

  /**
   * List speech-to-text models for a provider (epic #452, issue #454).
   * Returns an empty array for providers with no audio capability.
   */
  async listTranscriptionModels(providerKey: string): Promise<string[]> {
    // Validate the provider key — registry.get throws for unknown providers.
    const provider = this.registry.get(providerKey);
    if (typeof (provider as any).listTranscriptionModels !== 'function') {
      return [];
    }
    return (provider as any).listTranscriptionModels() as string[];
  }

  /**
   * List image-edit (enhancement) models for a provider.
   * Returns an empty array for providers that do not support image editing.
   */
  async listImageModels(providerKey: string): Promise<string[]> {
    // Validate the provider key — registry.get throws for unknown providers.
    const provider = this.registry.get(providerKey);
    if (typeof (provider as any).listImageModels !== 'function') {
      return [];
    }
    return (provider as any).listImageModels() as string[];
  }

  /**
   * Test embedding connectivity.
   * If provider/model are omitted, falls back to the configured embedding feature.
   * Returns { ok: boolean, provider?, model?, dimensions?, warning?, error? }.
   */
  async testEmbedding(dto: TestEmbeddingDto): Promise<{
    ok: boolean;
    provider?: string;
    model?: string;
    dimensions?: number;
    warning?: string;
    error?: string;
  }> {
    const STORAGE_DIMENSIONS = 1536;

    // Resolve provider + model
    let providerKey = dto.provider;
    let model = dto.model;

    if (!providerKey || !model) {
      const configured = await this.resolveEmbeddingConfig();
      if (!configured) {
        return { ok: false, error: 'No embedding provider/model configured' };
      }
      providerKey = providerKey ?? configured.provider;
      model = model ?? configured.model;
    }

    // Resolve credentials
    let creds: { apiKey: string; baseUrl?: string };
    try {
      creds = await this.resolveCredentials(providerKey);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, provider: providerKey, model, error: message };
    }

    // Check provider supports embedText
    const provider = this.registry.get(providerKey);
    if (typeof provider.embedText !== 'function') {
      return {
        ok: false,
        provider: providerKey,
        model,
        error: `Provider "${providerKey}" does not support text embeddings`,
      };
    }

    // Call embedText
    try {
      const vector = await provider.embedText(creds, model, 'embedding connectivity test');
      const dimensions = vector.length;

      const result: {
        ok: boolean;
        provider: string;
        model: string;
        dimensions: number;
        warning?: string;
      } = { ok: true, provider: providerKey, model, dimensions };

      if (dimensions !== STORAGE_DIMENSIONS) {
        result.warning =
          `Model returned ${dimensions}-d vectors but storage expects ${STORAGE_DIMENSIONS}-d; ` +
          `embeddings from this model cannot be stored. Use text-embedding-3-small.`;
      }

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, provider: providerKey, model, error: message };
    }
  }

  /** Update search feature settings in system settings */
  async setSearchFeature(dto: SetSearchFeatureDto, userId: string) {
    await this.systemSettings.patchSettings(
      {
        ai: {
          features: {
            search: { provider: dto.provider, model: dto.model },
          },
        },
      } as any,
      userId,
    );
    return { provider: dto.provider, model: dto.model };
  }

  /** Update tagging feature settings in system settings */
  async setTaggingFeature(dto: SetTaggingFeatureDto, userId: string) {
    await this.systemSettings.patchSettings(
      {
        ai: {
          features: {
            tagging: { provider: dto.provider, model: dto.model },
          },
        },
      } as any,
      userId,
    );
    return { provider: dto.provider, model: dto.model };
  }

  /** Update embedding feature settings in system settings */
  async setEmbeddingFeature(dto: SetEmbeddingFeatureDto, userId: string) {
    await this.systemSettings.patchSettings(
      {
        ai: {
          features: {
            embedding: { provider: dto.provider, model: dto.model },
          },
        },
      } as any,
      userId,
    );
    return { provider: dto.provider, model: dto.model };
  }

  /** Update enhancement feature settings in system settings */
  async setEnhanceFeature(dto: SetEnhanceFeatureDto, userId: string) {
    // Persist null when either field is cleared — mirrors the ai.features.enhance
    // nullable-object shape (a partial provider/model pair is not a valid selection).
    const value =
      dto.provider && dto.model
        ? { provider: dto.provider, model: dto.model }
        : null;
    await this.systemSettings.patchSettings(
      {
        ai: {
          features: {
            enhance: value,
          },
        },
      } as any,
      userId,
    );
    return value;
  }

  /**
   * Update the Memories title/subtitle/narrative feature config (epic #300).
   *
   * Same nullable-object shape as ai.features.enhance — a partial provider/model
   * pair is not a valid selection, so clearing either field clears the whole
   * setting and Memories falls back to deterministic template titles.
   *
   * Unlike the older search/tagging/embedding setters, a non-null selection is
   * validated against the credential store up front: selecting a provider that
   * has no enabled credential can only ever fail later, inside a background
   * `memory_generation` job where the admin would never see the error.
   */
  async setMemoriesFeature(dto: SetMemoriesFeatureDto, userId: string) {
    const value =
      dto.provider && dto.model
        ? { provider: dto.provider, model: dto.model }
        : null;

    if (value) {
      await this.assertProviderUsable(value.provider);
    }

    await this.systemSettings.patchSettings(
      {
        ai: {
          features: {
            memories: value,
          },
        },
      } as any,
      userId,
    );
    return value;
  }

  /**
   * Update the video-transcription feature config (epic #452, issue #454).
   *
   * Same nullable-object shape and up-front credential validation as
   * `setMemoriesFeature` above, for the same reason: a bad selection here
   * would otherwise only ever surface inside an unattended
   * `video_auto_tagging` job, where the admin never sees the error.
   */
  async setTranscriptionFeature(dto: SetTranscriptionFeatureDto, userId: string) {
    const value =
      dto.provider && dto.model
        ? { provider: dto.provider, model: dto.model }
        : null;

    if (value) {
      await this.assertProviderUsable(value.provider);
    }

    await this.systemSettings.patchSettings(
      {
        ai: {
          features: {
            transcription: value,
          },
        },
      } as any,
      userId,
    );
    return value;
  }

  /**
   * Resolve the active transcription provider + model from system settings.
   * Returns null when unset — callers run visual-only rather than failing
   * (epic #452, issue #454).
   */
  async resolveTranscriptionConfig(): Promise<{ provider: string; model: string } | null> {
    const sysSettings = await this.systemSettings.getSettings();
    const transcription = (sysSettings.ai?.features as any)?.transcription;
    if (!transcription?.provider || !transcription?.model) {
      return null;
    }
    return { provider: transcription.provider, model: transcription.model };
  }

  /**
   * Throw a 400 unless the provider has a configured AND enabled credential.
   * Deliberately does not decrypt the key — existence and the enabled flag are
   * all a feature-selection write needs to know.
   */
  private async assertProviderUsable(providerKey: string): Promise<void> {
    const status = await this.keys.status(providerKey);
    if (!status.configured) {
      throw new BadRequestException(
        `Provider "${providerKey}" is not configured`,
      );
    }
    if (!status.enabled) {
      throw new BadRequestException(`Provider "${providerKey}" is disabled`);
    }
  }

  /**
   * Resolve the active Memories provider + model from system settings.
   * Returns null when unset — callers fall back to template titles (#306).
   */
  async resolveMemoriesConfig(): Promise<{ provider: string; model: string } | null> {
    const sysSettings = await this.systemSettings.getSettings();
    const memories = sysSettings.ai?.features?.memories;
    if (!memories?.provider || !memories?.model) {
      return null;
    }
    return { provider: memories.provider, model: memories.model };
  }

  /**
   * Resolve the active embedding provider + model from system settings.
   * Returns null when either provider or model is unset.
   * Used internally by enrichment services that need to generate text embeddings.
   */
  async resolveEmbeddingConfig(): Promise<{ provider: string; model: string } | null> {
    const sysSettings = await this.systemSettings.getSettings();
    const embedding = sysSettings.ai?.features?.embedding;
    if (!embedding?.provider || !embedding?.model) {
      return null;
    }
    return { provider: embedding.provider, model: embedding.model };
  }

  /**
   * Resolve decrypted credentials for a provider: the platform deployment key first, then the
   * legacy row (PLATFORM-ADOPTION-SHIM(#605), `AiDeploymentKeySource`). Used internally by the
   * AI call sites and the worker-node credential broker. Never returns a key to HTTP callers.
   */
  async resolveCredentials(providerKey: string) {
    return this.keys.resolve(providerKey);
  }

  /** Presentation-safe key status for one provider (no key material). */
  async credentialStatus(providerKey: string) {
    return this.keys.status(providerKey);
  }
}
