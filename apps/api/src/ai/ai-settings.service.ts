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
      features: ai?.features ?? { search: { provider: null, model: null } },
      conversations: ai?.conversations ?? {
        archiveAfterDays: 30,
        deleteAfterArchiveDays: 30,
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
