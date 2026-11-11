import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { SetGeoReverseProvider, TestGeoProvider, UpsertGeoCredential } from '@marinoscar/memoriahub-contract/location';

import {
  MEMORIAHUB_SECRETS,
  MEMORIAHUB_SETTINGS,
  type MemoriahubSecretsPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import { GEO_GOOGLE_CREDENTIAL_NAME, GeoGoogleCredentialResolver } from './geo-google-credential.resolver.js';
import { GEO_PROVIDER_PURPOSE, type GeoSettingsDocument } from './geo-settings-shape.js';
import { GoogleGeoLocationProvider } from './google-geo-location.provider.js';
import { NominatimGeoLocationProvider } from './nominatim-geo-location.provider.js';
import { OfflineGeoLocationProvider } from './offline-geo-location.provider.js';

/**
 * The admin wire says `last4`; the credential store keeps a masked hint (`••••1234`, or `••••` for a secret
 * shorter than eight characters). Strip the mask: a short secret reveals nothing, so it maps to `null`.
 */
function hintToLast4(hint: string | null | undefined): string | null {
  const tail = (hint ?? '').replace(/^•+/, '');
  return tail.length > 0 ? tail : null;
}

/**
 * The geo provider administration: the settings summary, the Google key (write-only: the key is never
 * returned), the active reverse provider and the connectivity test.
 *
 * @stability experimental
 */
@Injectable()
export class GeoSettingsService {
  private readonly logger = new Logger(GeoSettingsService.name);

  constructor(
    @Inject(MEMORIAHUB_SECRETS) private readonly secrets: MemoriahubSecretsPort,
    private readonly googleCredential: GeoGoogleCredentialResolver,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly googleProvider: GoogleGeoLocationProvider,
    private readonly offlineProvider: OfflineGeoLocationProvider,
    private readonly nominatimProvider: NominatimGeoLocationProvider,
  ) {}

  private async geo(): Promise<GeoSettingsDocument | undefined> {
    return (await this.settings.readSystem<GeoSettingsDocument | undefined>('geo')).value;
  }

  /** The settings summary: the Google provider (masked) and the active reverse provider. */
  async getSettings() {
    const geo = await this.geo();
    const activeReverseProvider = geo?.reverseProvider ?? (process.env['GEO_PROVIDER'] ?? 'offline');

    const googleCred = await this.secrets.status(GEO_PROVIDER_PURPOSE, GEO_GOOGLE_CREDENTIAL_NAME);
    const googleSettings = geo?.google;

    const providers = [
      {
        provider: 'google',
        configured: googleCred.configured,
        enabled: googleCred.configured ? googleSettings?.enabled ?? true : false,
        last4: hintToLast4(googleCred.hint),
        baseUrl: googleCred.configured ? googleSettings?.baseUrl ?? null : null,
      },
    ];

    return {
      providers,
      activeReverseProvider,
    };
  }

  /**
   * Stores the Google key and its non-secret half.
   *
   * @param provider - the provider key (only `google`).
   * @param dto - the key, an optional endpoint and the on/off switch.
   * @param userId - who changed it.
   */
  async upsertCredential(
    provider: string,
    dto: UpsertGeoCredential,
    userId: string,
  ) {
    if (provider !== 'google') {
      throw new BadRequestException(`Unsupported geo provider: ${provider}`);
    }

    await this.secrets.set(GEO_PROVIDER_PURPOSE, GEO_GOOGLE_CREDENTIAL_NAME, dto.apiKey, userId);
    // The non-secret half lives in the `geo` settings namespace (`baseUrl` is overwritten, `enabled` only when sent).
    await this.settings.patchSystem<GeoSettingsDocument>(
      'geo',
      { google: { baseUrl: dto.baseUrl ?? null, ...(dto.enabled !== undefined && { enabled: dto.enabled }) } },
      { actorUserId: userId },
    );
    const [info, geo] = await Promise.all([
      this.secrets.status(GEO_PROVIDER_PURPOSE, GEO_GOOGLE_CREDENTIAL_NAME),
      this.geo(),
    ]);

    this.logger.log(`Geo credential upserted for provider "${provider}" by user ${userId}`);

    return {
      provider,
      configured: true,
      enabled: geo?.google?.enabled ?? true,
      last4: hintToLast4(info.hint),
      baseUrl: geo?.google?.baseUrl ?? null,
    };
  }

  /**
   * Removes the Google key and puts its non-secret half back to the defaults.
   *
   * @param provider - the provider key (only `google`).
   * @param userId - who removed it.
   */
  async deleteCredential(provider: string, userId: string) {
    if (provider !== 'google') {
      throw new BadRequestException(`Unsupported geo provider: ${provider}`);
    }

    const existing = await this.secrets.status(GEO_PROVIDER_PURPOSE, GEO_GOOGLE_CREDENTIAL_NAME);
    if (!existing.configured) {
      throw new NotFoundException(`No credential configured for geo provider: ${provider}`);
    }

    await this.secrets.delete(GEO_PROVIDER_PURPOSE, GEO_GOOGLE_CREDENTIAL_NAME, userId);
    // Back to the defaults, so a later key starts enabled with no custom endpoint (as a new row did).
    await this.settings.patchSystem<GeoSettingsDocument>('geo', { google: { baseUrl: null, enabled: true } }, { actorUserId: userId });
    this.logger.log(`Geo credential deleted for provider "${provider}" by user ${userId}`);
  }

  /**
   * Selects the active reverse provider (Google needs a stored, enabled key).
   *
   * @param provider - `offline`, `nominatim` or `google`.
   * @param userId - who changed it.
   */
  async setActiveReverseProvider(
    provider: SetGeoReverseProvider['provider'],
    userId: string,
  ) {
    if (provider === 'google') {
      if (!(await this.googleCredential.resolveApiKey())) {
        throw new BadRequestException(
          'Cannot set Google as active provider: no enabled credential configured',
        );
      }
    }

    await this.settings.patchSystem<GeoSettingsDocument>('geo', { reverseProvider: provider }, { actorUserId: userId });

    this.logger.log(`Geo active reverse provider set to "${provider}" by user ${userId}`);
    return { reverseProvider: provider };
  }

  /**
   * Looks one coordinate up through a provider to prove it works (the default point is San José, Costa Rica).
   *
   * @param dto - the provider and an optional coordinate pair.
   * @returns `{ ok: true, sample }` or `{ ok: false, error }`.
   */
  async testProvider(dto: TestGeoProvider) {
    const lat = dto.lat ?? 9.9281;
    const lng = dto.lng ?? -84.0907;

    try {
      let result: Awaited<ReturnType<typeof this.offlineProvider.reverseGeocode>> = null;

      if (dto.provider === 'google') {
        const apiKey = await this.googleCredential.resolveApiKey();
        if (!apiKey) {
          return { ok: false, error: 'Google credential not configured or disabled' };
        }
        result = await this.googleProvider.reverseGeocodeWithKey(lat, lng, apiKey);
      } else if (dto.provider === 'nominatim') {
        result = await this.nominatimProvider.reverseGeocode(lat, lng);
      } else {
        result = await this.offlineProvider.reverseGeocode(lat, lng);
      }

      if (!result) {
        return { ok: false, error: 'Provider returned no result' };
      }

      return {
        ok: true,
        sample: {
          country: result.country,
          locality: result.locality,
          placeName: result.placeName,
        },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, error };
    }
  }
}
