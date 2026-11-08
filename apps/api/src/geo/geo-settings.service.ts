import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { CredentialsService } from '@marinoscar/platform-api/credentials';
import { hintToLast4 } from '../platform/credentials/hint';
import { GEO_PROVIDER_CREDENTIAL_PURPOSE } from '../platform/credentials/credential-purposes.manifest';
import { GeoGoogleCredentialResolver, GEO_GOOGLE_CREDENTIAL_NAME } from '../media/geo/geo-google-credential.resolver';
import { GoogleGeoLocationProvider } from '../media/geo/google-geo-location.provider';
import { OfflineGeoLocationProvider } from '../media/geo/offline-geo-location.provider';
import { NominatimGeoLocationProvider } from '../media/geo/nominatim-geo-location.provider';
import { UpsertGeoCredentialDto } from './dto/geo-credential.dto';
import { TestGeoProviderDto } from './dto/geo-test.dto';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

@Injectable()
export class GeoSettingsService {
  private readonly logger = new Logger(GeoSettingsService.name);

  constructor(
    private readonly credentials: CredentialsService,
    private readonly googleCredential: GeoGoogleCredentialResolver,
    private readonly systemSettings: AppSystemSettingsService,
    private readonly googleProvider: GoogleGeoLocationProvider,
    private readonly offlineProvider: OfflineGeoLocationProvider,
    private readonly nominatimProvider: NominatimGeoLocationProvider,
  ) {}

  async getSettings() {
    const sysSettings = await this.systemSettings.getSettings();
    const activeReverseProvider = (sysSettings as any).geo?.reverseProvider ?? (process.env['GEO_PROVIDER'] ?? 'offline');

    const googleCred = await this.credentials.describe(GEO_PROVIDER_CREDENTIAL_PURPOSE, GEO_GOOGLE_CREDENTIAL_NAME);
    const googleSettings = (sysSettings as any).geo?.google;

    const providers = [
      {
        provider: 'google',
        configured: googleCred !== null,
        enabled: googleCred !== null ? googleSettings?.enabled ?? true : false,
        last4: hintToLast4(googleCred?.hint),
        baseUrl: googleCred !== null ? googleSettings?.baseUrl ?? null : null,
      },
    ];

    return {
      providers,
      activeReverseProvider,
    };
  }

  async upsertCredential(
    provider: string,
    dto: UpsertGeoCredentialDto,
    userId: string,
  ) {
    if (provider !== 'google') {
      throw new BadRequestException(`Unsupported geo provider: ${provider}`);
    }

    await this.credentials.setSecret(GEO_PROVIDER_CREDENTIAL_PURPOSE, GEO_GOOGLE_CREDENTIAL_NAME, dto.apiKey, {
      updatedByUserId: userId,
    });
    // The non-secret half lives in the `geo` settings namespace (`baseUrl` is overwritten, `enabled` only when sent).
    await this.systemSettings.patchSettings(
      { geo: { google: { baseUrl: dto.baseUrl ?? null, ...(dto.enabled !== undefined && { enabled: dto.enabled }) } } } as any,
      userId,
    );
    const [info, settings] = await Promise.all([
      this.credentials.describe(GEO_PROVIDER_CREDENTIAL_PURPOSE, GEO_GOOGLE_CREDENTIAL_NAME),
      this.systemSettings.getSettings(),
    ]);

    this.logger.log(`Geo credential upserted for provider "${provider}" by user ${userId}`);

    return {
      provider,
      configured: true,
      enabled: (settings as any).geo?.google?.enabled ?? true,
      last4: hintToLast4(info?.hint),
      baseUrl: (settings as any).geo?.google?.baseUrl ?? null,
    };
  }

  async deleteCredential(provider: string, userId: string) {
    if (provider !== 'google') {
      throw new BadRequestException(`Unsupported geo provider: ${provider}`);
    }

    const existing = await this.credentials.describe(GEO_PROVIDER_CREDENTIAL_PURPOSE, GEO_GOOGLE_CREDENTIAL_NAME);
    if (!existing) {
      throw new NotFoundException(`No credential configured for geo provider: ${provider}`);
    }

    await this.credentials.deleteSecret(GEO_PROVIDER_CREDENTIAL_PURPOSE, GEO_GOOGLE_CREDENTIAL_NAME);
    // Back to the defaults, so a later key starts enabled with no custom endpoint (as a new row did).
    await this.systemSettings.patchSettings({ geo: { google: { baseUrl: null, enabled: true } } } as any, userId);
    this.logger.log(`Geo credential deleted for provider "${provider}" by user ${userId}`);
  }

  async setActiveReverseProvider(
    provider: 'offline' | 'nominatim' | 'google',
    userId: string,
  ) {
    if (provider === 'google') {
      if (!(await this.googleCredential.resolveApiKey())) {
        throw new BadRequestException(
          'Cannot set Google as active provider: no enabled credential configured',
        );
      }
    }

    await this.systemSettings.patchSettings(
      { geo: { reverseProvider: provider } } as any,
      userId,
    );

    this.logger.log(`Geo active reverse provider set to "${provider}" by user ${userId}`);
    return { reverseProvider: provider };
  }

  async testProvider(dto: TestGeoProviderDto) {
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
