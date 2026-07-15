import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AiProviderRegistry } from './providers/ai-provider.registry';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { encryptSecret, decryptSecret } from '../common/crypto/secret-cipher';
import {
  UpsertAiCredentialsDto,
  TestAiProviderDto,
  SetSearchFeatureDto,
  SetTaggingFeatureDto,
  SetEmbeddingFeatureDto,
  SetEnhanceFeatureDto,
  TestEmbeddingDto,
} from './dto/ai-credentials.dto';

@Injectable()
export class AiSettingsService {
  private readonly logger = new Logger(AiSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AiProviderRegistry,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  /** Return the AI settings summary (no plaintext keys, no ciphertext) */
  async getSettings() {
    const creds = await this.prisma.aiProviderCredential.findMany({
      select: {
        provider: true,
        last4: true,
        baseUrl: true,
        enabled: true,
        updatedAt: true,
      },
      orderBy: { provider: 'asc' },
    });

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
      },
    };
  }

  /** Upsert credential for a provider */
  async upsertCredential(
    provider: string,
    dto: UpsertAiCredentialsDto,
    userId: string,
  ) {
    const last4 = dto.apiKey.slice(-4);
    const encryptedKey = encryptSecret(dto.apiKey);

    const cred = await this.prisma.aiProviderCredential.upsert({
      where: { provider },
      create: {
        provider,
        encryptedKey,
        last4,
        baseUrl: dto.baseUrl ?? null,
        enabled: dto.enabled ?? true,
        updatedByUserId: userId,
      },
      update: {
        encryptedKey,
        last4,
        baseUrl: dto.baseUrl ?? null,
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        updatedByUserId: userId,
      },
    });

    this.logger.log(
      `AI credential upserted for provider "${provider}" by user ${userId}`,
    );

    return {
      provider: cred.provider,
      configured: true,
      enabled: cred.enabled,
      last4: cred.last4,
      baseUrl: cred.baseUrl ?? null,
    };
  }

  /** Delete credential for a provider */
  async deleteCredential(provider: string, userId: string) {
    const existing = await this.prisma.aiProviderCredential.findUnique({
      where: { provider },
    });
    if (!existing) {
      throw new NotFoundException(
        `No credential configured for provider: ${provider}`,
      );
    }

    await this.prisma.aiProviderCredential.delete({ where: { provider } });
    this.logger.log(
      `AI credential deleted for provider "${provider}" by user ${userId}`,
    );
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

    // Credential is optional: pass key only when a row exists AND is enabled.
    const cred = await this.prisma.aiProviderCredential.findUnique({
      where: { provider: providerKey },
    });

    let creds: { apiKey: string; baseUrl?: string };
    if (cred && cred.enabled) {
      creds = { apiKey: decryptSecret(cred.encryptedKey), baseUrl: cred.baseUrl ?? undefined };
    } else if (cred) {
      // Row exists but provider is disabled — pass empty key so curated list is used.
      creds = { apiKey: '', baseUrl: cred.baseUrl ?? undefined };
    } else {
      // No credential row — return curated/static list without a key.
      creds = { apiKey: '' };
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
   * Resolve decrypted credentials for a provider.
   * Used internally by the chat/search service.
   * Never returns key to HTTP callers.
   */
  async resolveCredentials(providerKey: string) {
    const cred = await this.prisma.aiProviderCredential.findUnique({
      where: { provider: providerKey },
    });
    if (!cred) {
      throw new BadRequestException(
        `Provider "${providerKey}" is not configured`,
      );
    }
    if (!cred.enabled) {
      throw new BadRequestException(
        `Provider "${providerKey}" is disabled`,
      );
    }
    const apiKey = decryptSecret(cred.encryptedKey);
    return { apiKey, baseUrl: cred.baseUrl ?? undefined };
  }
}
