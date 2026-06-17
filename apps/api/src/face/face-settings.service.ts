// =============================================================================
// Face Settings Service
// =============================================================================
//
// Manages face provider credentials and detection feature configuration.
// Mirrors AiSettingsService patterns; see apps/api/src/ai/ai-settings.service.ts.
// =============================================================================

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FaceProviderRegistry } from './providers/face-provider.registry';
import { FaceProviderCredentials } from './providers/face-provider.interface';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { encryptSecret, decryptSecret } from '../common/crypto/secret-cipher';
import {
  UpsertFaceCredentialsDto,
  TestFaceProviderDto,
  SetDetectionFeatureDto,
} from './dto/face-credentials.dto';

@Injectable()
export class FaceSettingsService {
  private readonly logger = new Logger(FaceSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: FaceProviderRegistry,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // getSettings
  // ---------------------------------------------------------------------------

  /** Return face settings summary (no plaintext keys, no ciphertext) */
  async getSettings() {
    const creds = await this.prisma.faceProviderCredential.findMany({
      select: {
        provider: true,
        last4: true,
        baseUrl: true,
        region: true,
        enabled: true,
        updatedAt: true,
      },
      orderBy: { provider: 'asc' },
    });

    const sysSettings = await this.systemSettings.getSettings();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const face = (sysSettings as any).face;

    const configuredProviderKeys = new Set(creds.map(c => c.provider));

    // Providers with a DB credential row
    const dbProviders = creds.map(c => {
      let capabilities: object | undefined;
      let requiresCredentials: boolean | undefined;
      try {
        const reg = this.registry.get(c.provider);
        capabilities = reg.capabilities;
        requiresCredentials = reg.requiresCredentials;
      } catch {
        // Provider not in registry — skip capabilities
      }
      return {
        provider: c.provider,
        configured: true,
        enabled: c.enabled,
        requiresCredentials: requiresCredentials ?? true,
        last4: c.last4 || null,
        baseUrl: c.baseUrl ?? null,
        region: c.region ?? null,
        updatedAt: c.updatedAt,
        ...(capabilities !== undefined && { capabilities }),
      };
    });

    // Registry providers with no DB row — split by requiresCredentials
    const unconfiguredKeys = this.registry
      .keys()
      .filter(k => !configuredProviderKeys.has(k));

    const keylessProviders = unconfiguredKeys
      .filter(k => !this.registry.get(k).requiresCredentials)
      .map(k => {
        const reg = this.registry.get(k);
        // For keyless providers with no DB row, expose the effective baseUrl
        // so the UI can display/edit it. compreface resolves via
        // FACE_COMPREFACE_URL env or its hard-coded docker-network default.
        const effectiveBaseUrl =
          k === 'compreface'
            ? (process.env.FACE_COMPREFACE_URL ?? 'http://compreface-core:3000')
            : null;
        return {
          provider: k,
          configured: true,
          enabled: true,
          requiresCredentials: false,
          last4: null,
          baseUrl: effectiveBaseUrl,
          region: null,
          capabilities: reg.capabilities,
        };
      });

    const knownProviders = unconfiguredKeys
      .filter(k => this.registry.get(k).requiresCredentials)
      .map(k => ({
        provider: k,
        configured: false,
        enabled: false,
        requiresCredentials: true,
        last4: null,
        baseUrl: null,
        region: null,
        capabilities: this.registry.get(k).capabilities,
      }));

    return {
      providers: [...dbProviders, ...keylessProviders],
      knownProviders,
      features: face?.features ?? {
        detection: { provider: null, model: null },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // upsertCredential
  // ---------------------------------------------------------------------------

  /** Upsert credential for a face provider */
  async upsertCredential(
    provider: string,
    dto: UpsertFaceCredentialsDto,
    userId: string,
  ) {
    // apiKey is optional (Rekognition uses env-level AWS creds)
    const rawKey = dto.apiKey ?? '';
    const last4 = rawKey ? rawKey.slice(-4) : '';
    const encryptedKey = encryptSecret(rawKey);

    const cred = await this.prisma.faceProviderCredential.upsert({
      where: { provider },
      create: {
        provider,
        encryptedKey,
        last4,
        baseUrl: dto.baseUrl ?? null,
        region: dto.region ?? null,
        enabled: dto.enabled ?? true,
        updatedByUserId: userId,
      },
      update: {
        encryptedKey,
        last4,
        baseUrl: dto.baseUrl ?? null,
        region: dto.region ?? null,
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        updatedByUserId: userId,
      },
    });

    this.logger.log(
      `Face credential upserted for provider "${provider}" by user ${userId}`,
    );

    return {
      provider: cred.provider,
      configured: true,
      enabled: cred.enabled,
      last4: cred.last4 || null,
      baseUrl: cred.baseUrl ?? null,
      region: cred.region ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // deleteCredential
  // ---------------------------------------------------------------------------

  /** Delete credential for a face provider */
  async deleteCredential(provider: string, userId: string) {
    const existing = await this.prisma.faceProviderCredential.findUnique({
      where: { provider },
    });
    if (!existing) {
      throw new NotFoundException(
        `No credential configured for face provider: ${provider}`,
      );
    }

    await this.prisma.faceProviderCredential.delete({ where: { provider } });
    this.logger.log(
      `Face credential deleted for provider "${provider}" by user ${userId}`,
    );
  }

  // ---------------------------------------------------------------------------
  // testProvider
  // ---------------------------------------------------------------------------

  /** Test face provider connectivity */
  async testProvider(dto: TestFaceProviderDto) {
    const creds = await this.resolveCredentials(dto.provider);
    const provider = this.registry.get(dto.provider);
    return provider.testConnection(creds);
  }

  // ---------------------------------------------------------------------------
  // listModels
  // ---------------------------------------------------------------------------

  /** List models for a face provider (works even without a configured credential) */
  async listModels(providerKey: string) {
    // Validate the provider key — registry.get throws for unknown providers.
    const provider = this.registry.get(providerKey);

    const cred = await this.prisma.faceProviderCredential.findUnique({
      where: { provider: providerKey },
    });

    let creds: FaceProviderCredentials;
    if (cred && cred.enabled) {
      creds = {
        apiKey: decryptSecret(cred.encryptedKey),
        baseUrl: cred.baseUrl ?? undefined,
        region: cred.region ?? undefined,
      };
    } else if (cred) {
      // Row exists but provider is disabled — pass empty key
      creds = { apiKey: '', baseUrl: cred.baseUrl ?? undefined, region: cred.region ?? undefined };
    } else {
      // No credential row — use static list without key
      creds = { apiKey: '' };
    }

    return provider.listModels(creds);
  }

  // ---------------------------------------------------------------------------
  // setDetectionFeature
  // ---------------------------------------------------------------------------

  /** Persist the active detection provider and model in system settings */
  async setDetectionFeature(dto: SetDetectionFeatureDto, userId: string) {
    await this.systemSettings.patchSettings(
      {
        face: {
          features: {
            detection: { provider: dto.provider, model: dto.model },
          },
        },
      } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      userId,
    );
    return { provider: dto.provider, model: dto.model };
  }

  // ---------------------------------------------------------------------------
  // resolveCredentials (internal — used by Phase 2 detection worker)
  // ---------------------------------------------------------------------------

  /**
   * Resolve decrypted credentials for a face provider.
   * For internal use only — never returns keys to HTTP callers.
   *
   * For providers with requiresCredentials === false (e.g. compreface, human):
   *   - Check DB for an optional credential row that stores a custom baseUrl.
   *   - If a row exists and is enabled, return its baseUrl (no apiKey needed).
   *   - If no row exists, return an empty object — the provider will fall back
   *     to FACE_COMPREFACE_URL or its hard-coded docker-network default.
   *   - Never throw "not configured" for keyless providers.
   *
   * For providers with requiresCredentials === true (e.g. rekognition):
   *   - A DB credential row MUST exist and be enabled.
   */
  async resolveCredentials(providerKey: string): Promise<FaceProviderCredentials> {
    // Validate that the provider key is known — registry.get throws for unknown keys.
    const provider = this.registry.get(providerKey);

    if (!provider.requiresCredentials) {
      // Keyless provider: optionally read a stored baseUrl override from DB.
      const cred = await this.prisma.faceProviderCredential.findUnique({
        where: { provider: providerKey },
      });
      if (cred && cred.enabled && cred.baseUrl) {
        return { baseUrl: cred.baseUrl };
      }
      // No row or no custom baseUrl — provider uses env/default fallback.
      return {};
    }

    const cred = await this.prisma.faceProviderCredential.findUnique({
      where: { provider: providerKey },
    });
    if (!cred) {
      throw new BadRequestException(
        `Face provider "${providerKey}" is not configured`,
      );
    }
    if (!cred.enabled) {
      throw new BadRequestException(
        `Face provider "${providerKey}" is disabled`,
      );
    }
    const apiKey = decryptSecret(cred.encryptedKey);
    return {
      apiKey,
      baseUrl: cred.baseUrl ?? undefined,
      region: cred.region ?? undefined,
    };
  }
}
