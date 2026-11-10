import { Injectable, BadRequestException } from '@nestjs/common';
import { AiService } from '@marinoscar/platform-api/ai';

import { PrismaService } from '../prisma/prisma.service';
import { AiDeploymentKeySource } from './ai-deployment-key-source';
import { EMBEDDING_STORAGE_DIMENSIONS, MEMORIAHUB_AI_FEATURES } from './ai-features';
import { systemScope, visionCallOptions } from './ai-calls';
import { MemoriaHubAiSettings } from './memoriahub-ai-settings';
import { MEMORIAHUB_AI_PROVIDER_IDS } from '../platform/ai/ai-providers';
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

// =============================================================================
// The admin view of MemoriaHub's AI feature selections (RETRO-E2, #601)
// =============================================================================
//
// What `/api/admin/memoriahub-ai/*` and the Doctor's AI checks read and write: the feature
// selections (`ai.features.*`), a provider's key STATUS, the model lists a selection picks from,
// and the two connectivity probes. Every model call here goes through the platform `AiService`
// (`forSystem`, so the probe uses the key a real job would use), never a provider SDK.
//
// MODEL LISTS come from the platform catalogue (`ai_models`: the enabled models that declare the
// capability); until an administrator has refreshed the catalogue the curated starter lists below
// keep the pickers usable. A saved model must be ENABLED in the catalogue to run (the platform's
// model gate), which is why the pickers offer only those once the catalogue has rows.
// =============================================================================

/** Shown when the catalogue has no model for the capability yet (never synced). */
const CURATED_MODELS: Readonly<Record<'chat' | 'embedding' | 'image' | 'transcription', Readonly<Record<string, readonly string[]>>>> = {
  chat: {
    openai: ['gpt-5.4', 'gpt-5.5'],
    anthropic: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  },
  embedding: { openai: ['text-embedding-3-small', 'text-embedding-3-large'] },
  image: { openai: ['gpt-image-1'] },
  transcription: { openai: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'] },
};

/** The platform capability each model list filters on. */
const LIST_CAPABILITY = {
  chat: 'responses',
  embedding: 'embeddings',
  image: 'image_edit',
  transcription: 'audio_transcription',
} as const;

type ModelListKind = keyof typeof LIST_CAPABILITY;

const OPENAI_TEST_MAX_TOKENS = 1024;
const ANTHROPIC_TEST_MAX_TOKENS = 1;

/**
 * Returns true for OpenAI chat model ids with a GPT major.minor of 5.4 or
 * greater that are not a non-text modality (embeddings, audio, realtime, TTS,
 * image generation, moderation, search). Mini and nano variants are included.
 */
export function isEligibleOpenAiModel(id: string): boolean {
  if (
    /embedding|audio|realtime|tts|whisper|transcribe|image|dall-?e|moderation|search/i.test(id)
  ) {
    return false;
  }
  const m = /^gpt-(\d+)(?:\.(\d+))?/i.exec(id);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = m[2] ? parseInt(m[2], 10) : 0;
  return major > 5 || (major === 5 && minor >= 4);
}

@Injectable()
export class AiSettingsService {
  constructor(
    private readonly keys: AiDeploymentKeySource,
    private readonly systemSettings: AppSystemSettingsService,
    private readonly selections: MemoriaHubAiSettings,
    private readonly ai: AiService,
    private readonly prisma: PrismaService,
  ) {}

  private readonly providerIds: readonly string[] = MEMORIAHUB_AI_PROVIDER_IDS;

  /**
   * Return the AI settings summary (no plaintext keys, no ciphertext). A provider's status comes
   * from the platform credential store when it holds a key there, else from the legacy row
   * (`AiDeploymentKeySource`, RETRO-E3).
   */
  async getSettings() {
    const statuses = await this.keys.list([...this.providerIds]);
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
      knownProviders: this.providerIds
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
        transcription: null,
      },
    };
  }

  /**
   * Test one provider and model on the call path a real job takes (`AiService.forSystem`: the
   * organization's or the deployment's key). `{ ok, error? }`; spends one small provider call.
   */
  async testProvider(dto: TestAiProviderDto): Promise<{ ok: boolean; error?: string }> {
    this.assertKnownProvider(dto.provider);
    try {
      await this.ai.forSystem(systemScope(MEMORIAHUB_AI_FEATURES.memoryTitles)).respond({
        provider: dto.provider,
        model: dto.model,
        input: 'hi',
        maxOutputTokens: dto.provider === 'anthropic' ? ANTHROPIC_TEST_MAX_TOKENS : OPENAI_TEST_MAX_TOKENS,
        ...(dto.provider === 'openai' ? { reasoning: visionCallOptions('openai', dto.model).reasoning } : {}),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error && err.message ? err.message : 'Unknown error' };
    }
  }

  /** The model ids a provider offers for one kind of feature (empty when it has none). */
  async listModelsFor(providerKey: string, kind: ModelListKind): Promise<string[]> {
    this.assertKnownProvider(providerKey);
    const capability = LIST_CAPABILITY[kind];
    const rows = await this.prisma.aiModel.findMany({
      where: { provider: providerKey, enabled: true },
      select: { modelId: true, capabilities: true },
    });
    let ids = rows
      .filter((row) => {
        const caps = (row.capabilities as { capabilities?: unknown } | null)?.capabilities;
        return Array.isArray(caps) && caps.includes(capability);
      })
      .map((row) => row.modelId);
    if (kind === 'chat' && providerKey === 'openai') ids = ids.filter(isEligibleOpenAiModel);
    if (ids.length > 0) return ids.sort();
    return [...(CURATED_MODELS[kind][providerKey] ?? [])];
  }

  /** List chat models for a provider (works even before the catalogue was refreshed). */
  listModels(providerKey: string) {
    return this.listModelsFor(providerKey, 'chat');
  }

  /** Embedding models; empty for a provider without the capability. */
  listEmbeddingModels(providerKey: string): Promise<string[]> {
    return this.listModelsFor(providerKey, 'embedding');
  }

  /** Speech-to-text models; empty for a provider without the capability. */
  listTranscriptionModels(providerKey: string): Promise<string[]> {
    return this.listModelsFor(providerKey, 'transcription');
  }

  /** Image-edit (enhancement) models; empty for a provider without the capability. */
  listImageModels(providerKey: string): Promise<string[]> {
    return this.listModelsFor(providerKey, 'image');
  }

  private assertKnownProvider(providerKey: string): void {
    if (!this.providerIds.includes(providerKey)) {
      throw new BadRequestException(`Unknown AI provider: ${providerKey}`);
    }
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
    let providerKey = dto.provider;
    let model = dto.model;

    if (!providerKey || !model) {
      const configured = await this.selections.selection('embedding');
      if (!configured) {
        return { ok: false, error: 'No embedding provider/model configured' };
      }
      providerKey = providerKey ?? configured.provider;
      model = model ?? configured.model;
    }

    try {
      const result = await this.ai
        .forSystem(systemScope(MEMORIAHUB_AI_FEATURES.semanticEmbedding))
        .embed({ provider: providerKey, model, input: 'embedding connectivity test' });
      const dimensions = (result.vectors[0] ?? []).length;

      const out: {
        ok: boolean;
        provider: string;
        model: string;
        dimensions: number;
        warning?: string;
      } = { ok: true, provider: providerKey, model, dimensions };

      if (dimensions !== EMBEDDING_STORAGE_DIMENSIONS) {
        out.warning =
          `Model returned ${dimensions}-d vectors but storage expects ${EMBEDDING_STORAGE_DIMENSIONS}-d; ` +
          `embeddings from this model cannot be stored. Use text-embedding-3-small.`;
      }

      return out;
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

  /** Presentation-safe key status for one provider (no key material). */
  async credentialStatus(providerKey: string) {
    return this.keys.status(providerKey);
  }
}
