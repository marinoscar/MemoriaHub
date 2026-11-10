// =============================================================================
// Where MemoriaHub's AI call sites get their provider key (RETRO-E3, #605)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(#605): the legacy-key reader. Release N of the
// two-release key migration.
//
// ORDER, per provider:
//   1. The PLATFORM deployment key: the credential store at
//      (`AI_CREDENTIAL_PURPOSE`, `aiCredentialName(provider)`), the exact
//      address `AiConfigService.getOrgKey` and `AiKeyResolver` (deployment
//      tier) read. When it exists, the platform governs the provider: its
//      switch is `ai.providers.<id>.enabled` and its endpoint
//      `ai.providers.<id>.baseUrl`.
//   2. Otherwise the LEGACY row in `ai_provider_credentials` (read-only), with
//      a warning once per provider per process: the deployment has not run
//      `npm run ai:migrate-keys --workspace=api -- --apply` yet
//      (docs/runbooks/ai-platform-migration.md).
//
// Release N+1 drops `ai_provider_credentials`, deletes step 2 and this file's
// legacy half. Since RETRO-E2 (#601) no model call reads a key here: they go through `AiService`,
// which resolves keys from the platform store only, so `npm run ai:migrate-keys` MUST have run.
//
// KEYS. `resolve` is the only method that returns plaintext; since RETRO-E2/C2 nothing in the app
// calls it (model calls go through `AiService`, the node credential broker is gone)
// and never reaches an HTTP response or a log line. `status` never decrypts.
// =============================================================================

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AI_CREDENTIAL_PURPOSE, aiCredentialName } from '@marinoscar/platform-api/ai';
import { CredentialsService } from '@marinoscar/platform-api/credentials';

import { decryptSecret } from '../legacy/legacy-secret-cipher';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';
import { hintToLast4 } from '../platform/credentials/hint';
import { PrismaService } from '../prisma/prisma.service';

/** Which store answered. */
export type AiKeySourceKind = 'platform' | 'legacy';

/** Presentation-safe status of one provider's deployment key. Holds no key material. */
export interface AiKeyStatus {
  provider: string;
  source: AiKeySourceKind | null;
  configured: boolean;
  enabled: boolean;
  last4: string | null;
  baseUrl: string | null;
  updatedAt: Date | null;
}

/** What a legacy call site hands to the provider adapter. */
export interface ResolvedAiCredentials {
  apiKey: string;
  baseUrl?: string;
}

interface ProviderSlot {
  enabled?: unknown;
  baseUrl?: unknown;
}

@Injectable()
export class AiDeploymentKeySource {
  private readonly logger = new Logger(AiDeploymentKeySource.name);
  private readonly warned = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly systemSettings: AppSystemSettingsService,
  ) {}

  /** The platform slot `ai.providers.<id>` (`enabled`, `baseUrl`), from the cached settings read. */
  private async slot(provider: string): Promise<{ enabled: boolean; baseUrl: string | null }> {
    const settings = await this.systemSettings.getSettings();
    const providers = (settings.ai as unknown as { providers?: Record<string, ProviderSlot> } | undefined)
      ?.providers;
    const slot = providers?.[provider];
    return {
      enabled: slot?.enabled === true,
      baseUrl: typeof slot?.baseUrl === 'string' && slot.baseUrl !== '' ? slot.baseUrl : null,
    };
  }

  private warnLegacy(provider: string): void {
    if (this.warned.has(provider)) return;
    this.warned.add(provider);
    this.logger.warn(
      `AI provider "${provider}" is served from the legacy ai_provider_credentials table. ` +
        'Run `npm run ai:migrate-keys --workspace=api -- --apply` before upgrading to the release ' +
        'that drops it (docs/runbooks/ai-platform-migration.md).',
    );
  }

  /** Status of one provider's key: platform first, then the legacy row. Never decrypts. */
  async status(provider: string): Promise<AiKeyStatus> {
    const info = await this.credentials.describe(AI_CREDENTIAL_PURPOSE, aiCredentialName(provider));
    if (info) {
      const slot = await this.slot(provider);
      return {
        provider,
        source: 'platform',
        configured: true,
        enabled: slot.enabled,
        last4: hintToLast4(info.hint),
        baseUrl: slot.baseUrl,
        updatedAt: info.updatedAt,
      };
    }
    const row = await this.prisma.aiProviderCredential.findUnique({
      where: { provider },
      select: { last4: true, baseUrl: true, enabled: true, updatedAt: true },
    });
    if (row) {
      return {
        provider,
        source: 'legacy',
        configured: true,
        enabled: row.enabled,
        last4: row.last4,
        baseUrl: row.baseUrl ?? null,
        updatedAt: row.updatedAt,
      };
    }
    return { provider, source: null, configured: false, enabled: false, last4: null, baseUrl: null, updatedAt: null };
  }

  /** Every provider that has a key in either store, plus the `known` ones (unconfigured), sorted. */
  async list(known: readonly string[]): Promise<AiKeyStatus[]> {
    const [platform, legacy] = await Promise.all([
      this.credentials.list(AI_CREDENTIAL_PURPOSE),
      this.prisma.aiProviderCredential.findMany({ select: { provider: true } }),
    ]);
    const ids = new Set<string>([...known, ...platform.map((c) => c.name), ...legacy.map((r) => r.provider)]);
    const out: AiKeyStatus[] = [];
    for (const id of [...ids].sort()) out.push(await this.status(id));
    return out;
  }

  /**
   * The key and endpoint for a server call, or a 400 when the provider has no
   * key or is switched off. PLAINTEXT: hand it straight to the adapter.
   */
  async resolve(provider: string): Promise<ResolvedAiCredentials> {
    const platformKey = await this.credentials.getSecret(AI_CREDENTIAL_PURPOSE, aiCredentialName(provider));
    if (platformKey) {
      const slot = await this.slot(provider);
      if (!slot.enabled) throw new BadRequestException(`Provider "${provider}" is disabled`);
      return { apiKey: platformKey, ...(slot.baseUrl ? { baseUrl: slot.baseUrl } : {}) };
    }

    const row = await this.prisma.aiProviderCredential.findUnique({ where: { provider } });
    if (!row) throw new BadRequestException(`Provider "${provider}" is not configured`);
    if (!row.enabled) throw new BadRequestException(`Provider "${provider}" is disabled`);
    this.warnLegacy(provider);
    return { apiKey: decryptSecret(row.encryptedKey), ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}) };
  }
}
