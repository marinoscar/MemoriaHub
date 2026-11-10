// =============================================================================
// Face Settings Service
// =============================================================================
//
// Manages face provider configuration and the detection feature selection.
//
// RETRO-B4 (#617): a provider's SECRET (none today: CompreFace is keyless) is the platform
// credential `face_provider/<provider>`; its non-secret half (`baseUrl`, `enabled`) is the
// `face.providers.<provider>` settings namespace. The legacy `face_provider_credentials` table is
// no longer read or written (it is moved by `npm run credentials:migrate-legacy` and dropped later).
// =============================================================================

import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type {
  SetDetectionFeature,
  TestFaceProvider,
  UpsertFaceCredentials,
} from '@marinoscar/memoriahub-contract/face';
import { MEMORIAHUB_SECRETS, type MemoriahubSecretsPort } from '../ports/index.js';
import { FaceProviderRegistry } from './providers/face-provider.registry.js';
import { FaceProviderCredentials } from './providers/face-provider.interface.js';
import { FaceSystemSettings } from './host/face-system-settings.js';

/**
 * The secret purpose of a face provider's key (`face_provider/<provider>`). Permanent: the stored rows
 * name it.
 *
 * @stability experimental
 */
export const FACE_PROVIDER_CREDENTIAL_PURPOSE = 'face_provider';

/**
 * The admin wire still says `last4`; the secret store keeps a masked hint (`••••1234`, or `••••` for a
 * secret shorter than eight characters). Strip the mask: a short secret reveals nothing, so it maps to
 * `null`.
 *
 * @stability experimental
 */
export function hintToLast4(hint: string | null | undefined): string | null {
  const tail = (hint ?? '').replace(/^•+/, '');
  return tail.length > 0 ? tail : null;
}

/**
 * The face provider settings: the provider list, the CompreFace base URL override (a `face.providers.*` setting plus the `face_provider` secret purpose), the detection feature selection, the connection test and the credentials the detection path resolves.
 *
 * @stability experimental
 */
@Injectable()
export class FaceSettingsService {
  private readonly logger = new Logger(FaceSettingsService.name);

  constructor(
    @Inject(MEMORIAHUB_SECRETS) private readonly secrets: MemoriahubSecretsPort,
    private readonly registry: FaceProviderRegistry,
    private readonly systemSettings: FaceSystemSettings,
  ) {
    this.secrets.registerPurpose(FACE_PROVIDER_CREDENTIAL_PURPOSE, 'Face provider key');
  }

  /** What the secret store says of a provider's key: null when none is stored. Never the material. */
  private async describe(provider: string): Promise<{ hint: string | null; updatedAt: Date | undefined } | null> {
    const status = await this.secrets.status(FACE_PROVIDER_CREDENTIAL_PURPOSE, provider);
    if (!status.configured) return null;
    return { hint: status.hint, updatedAt: status.updatedAt ? new Date(status.updatedAt) : undefined };
  }

  // ---------------------------------------------------------------------------
  // getSettings
  // ---------------------------------------------------------------------------

  /** Return face settings summary (no plaintext keys, no ciphertext) */
  async getSettings() {
    const sysSettings = await this.systemSettings.getSettings();
    const face = (sysSettings as any).face;

    const providers = this.registry.keys().map(key => {
      const reg = this.registry.get(key);
      const stored = this.providerSettings(face, key);
      return { key, reg, stored };
    });

    const described = await Promise.all(
      providers.map(p => this.describe(p.key)),
    );

    const configured: Array<Record<string, unknown>> = [];
    const knownProviders: Array<Record<string, unknown>> = [];
    providers.forEach((p, i) => {
      const info = described[i];
      const keyless = !p.reg.requiresCredentials;
      if (keyless || info) {
        configured.push({
          provider: p.key,
          configured: true,
          enabled: p.stored?.enabled ?? true,
          requiresCredentials: p.reg.requiresCredentials,
          last4: hintToLast4(info?.hint),
          // The stored override, else the effective default so the UI can show/edit it
          // (CompreFace resolves via FACE_COMPREFACE_URL or its docker-network default).
          baseUrl: p.stored?.baseUrl ?? this.defaultBaseUrl(p.key),
          ...(info && { updatedAt: info.updatedAt }),
          capabilities: p.reg.capabilities,
        });
      } else {
        knownProviders.push({
          provider: p.key,
          configured: false,
          enabled: false,
          requiresCredentials: true,
          last4: null,
          baseUrl: null,
          capabilities: p.reg.capabilities,
        });
      }
    });

    return {
      providers: configured,
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
    dto: UpsertFaceCredentials,
    userId: string,
  ) {
    this.registry.get(provider); // throws for an unknown provider key
    if (provider !== 'compreface') {
      throw new BadRequestException(`Face provider "${provider}" has no settings slot`);
    }

    // apiKey is optional: CompreFace is keyless, so there is usually no secret at all. A blank key
    // PRESERVES a stored one (the credential store's rule); removing it is deleteCredential.
    const rawKey = dto.apiKey ?? '';
    if (rawKey) {
      await this.secrets.set(FACE_PROVIDER_CREDENTIAL_PURPOSE, provider, rawKey, userId);
    }
    // baseUrl is overwritten (null clears it); enabled only when sent: the legacy upsert's rule.
    await this.systemSettings.patchFace(
      {
        providers: {
          [provider]: { baseUrl: dto.baseUrl ?? null, ...(dto.enabled !== undefined && { enabled: dto.enabled }) },
        },
      },
      userId,
    );

    const [info, settings] = await Promise.all([
      this.describe(provider),
      this.systemSettings.getSettings(),
    ]);
    const stored = this.providerSettings((settings as any).face, provider);

    this.logger.log(
      `Face provider settings upserted for provider "${provider}" by user ${userId}`,
    );

    return {
      provider,
      configured: true,
      enabled: stored?.enabled ?? true,
      last4: hintToLast4(info?.hint),
      baseUrl: stored?.baseUrl ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // deleteCredential
  // ---------------------------------------------------------------------------

  /** Delete the stored override (secret and settings) for a face provider */
  async deleteCredential(provider: string, userId: string) {
    const info = await this.describe(provider);
    const settings = await this.systemSettings.getSettings();
    const stored = this.providerSettings((settings as any).face, provider);
    const hasOverride = !!stored && (stored.baseUrl !== null || stored.enabled === false);
    if (!info && !hasOverride) {
      throw new NotFoundException(
        `No credential configured for face provider: ${provider}`,
      );
    }

    if (info) await this.secrets.delete(FACE_PROVIDER_CREDENTIAL_PURPOSE, provider, userId);
    if (provider === 'compreface') {
      await this.systemSettings.patchFace({ providers: { compreface: { baseUrl: null, enabled: true } } }, userId);
    }
    this.logger.log(
      `Face provider settings deleted for provider "${provider}" by user ${userId}`,
    );
  }

  // ---------------------------------------------------------------------------
  // testProvider
  // ---------------------------------------------------------------------------

  /** Test face provider connectivity */
  async testProvider(dto: TestFaceProvider) {
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

    // Works without a configured credential: a missing or disabled one yields an empty key.
    const resolved = await this.resolveCredentials(providerKey).catch((): FaceProviderCredentials => ({}));
    const creds: FaceProviderCredentials = { apiKey: '', ...resolved };

    return provider.listModels(creds);
  }

  // ---------------------------------------------------------------------------
  // setDetectionFeature
  // ---------------------------------------------------------------------------

  /** Persist the active detection provider and model in system settings */
  async setDetectionFeature(dto: SetDetectionFeature, userId: string) {
    await this.systemSettings.patchFace(
      {
        features: {
          detection: { provider: dto.provider, model: dto.model },
        },
      },
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
   * CompreFace — the only face provider — has requiresCredentials === false:
   *   - Check DB for an optional credential row that stores a custom baseUrl.
   *   - If a row exists and is enabled, return its baseUrl (no apiKey needed).
   *   - If no row exists, return an empty object — the provider will fall back
   *     to FACE_COMPREFACE_URL or its hard-coded docker-network default.
   *   - Never throw "not configured" for keyless providers.
   *
   * The requiresCredentials === true branch below is kept for forward
   * compatibility should a credentialed provider ever be added again — a DB
   * credential row would then need to exist and be enabled.
   */
  async resolveCredentials(providerKey: string): Promise<FaceProviderCredentials> {
    // Validate that the provider key is known — registry.get throws for unknown keys.
    const provider = this.registry.get(providerKey);

    const settings = await this.systemSettings.getSettings();
    const stored = this.providerSettings((settings as any).face, providerKey);

    if (!provider.requiresCredentials) {
      // Keyless provider: optionally read a stored baseUrl override from settings.
      if (stored && stored.enabled && stored.baseUrl) {
        return { baseUrl: stored.baseUrl };
      }
      // No custom baseUrl — provider uses env/default fallback.
      return {};
    }

    const apiKey = await this.secrets.get(FACE_PROVIDER_CREDENTIAL_PURPOSE, providerKey);
    if (apiKey === null) {
      throw new BadRequestException(
        `Face provider "${providerKey}" is not configured`,
      );
    }
    if (stored && !stored.enabled) {
      throw new BadRequestException(
        `Face provider "${providerKey}" is disabled`,
      );
    }
    return {
      apiKey,
      baseUrl: stored?.baseUrl ?? undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private providerSettings(
    face: any,
    providerKey: string,
  ): { baseUrl: string | null; enabled: boolean } | undefined {
    return face?.providers?.[providerKey];
  }

  private defaultBaseUrl(providerKey: string): string | null {
    return providerKey === 'compreface'
      ? (process.env.FACE_COMPREFACE_URL ?? 'http://compreface-core:3000')
      : null;
  }
}
