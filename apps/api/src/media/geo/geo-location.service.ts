import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { OfflineGeoLocationProvider } from './offline-geo-location.provider';
import { NominatimGeoLocationProvider } from './nominatim-geo-location.provider';
import { GoogleGeoLocationProvider } from './google-geo-location.provider';
import { GeoLocationResult } from './geo-location-provider.interface';
import { decryptSecret } from '../../common/crypto/secret-cipher';

@Injectable()
export class GeoLocationService {
  private readonly logger = new Logger(GeoLocationService.name);

  constructor(
    private readonly systemSettings: SystemSettingsService,
    private readonly offlineProvider: OfflineGeoLocationProvider,
    private readonly nominatimProvider: NominatimGeoLocationProvider,
    private readonly googleProvider: GoogleGeoLocationProvider,
    private readonly prisma: PrismaService,
  ) {}

  async reverseGeocode(lat: number, lng: number): Promise<{ result: GeoLocationResult | null; source: string }> {
    // Defensive choke point for every provider (offline/nominatim/google) and every
    // caller: a non-finite coordinate (NaN/Infinity) must never reach a provider.
    // The offline kd-tree geocoder has no "no location" concept and returns a bogus
    // nearest city (Talnakh, RU) for a NaN input; short-circuit to an empty result.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      this.logger.debug(`reverseGeocode called with non-finite coordinates (${lat}, ${lng}); returning null`);
      return { result: null, source: 'none' };
    }

    const settings = await this.systemSettings.getSettings();
    const activeProvider = (settings as any).geo?.reverseProvider ?? process.env['GEO_PROVIDER'] ?? 'offline';

    if (activeProvider === 'google') {
      const cred = await this.prisma.geoProviderCredential.findUnique({ where: { provider: 'google' } });
      if (!cred || !cred.enabled) {
        this.logger.warn('Google geo provider configured but credential not found or disabled; falling back to offline');
        const result = await this.offlineProvider.reverseGeocode(lat, lng);
        return { result, source: 'geonames-offline' };
      }
      const apiKey = decryptSecret(cred.encryptedKey);
      const result = await this.googleProvider.reverseGeocodeWithKey(lat, lng, apiKey);
      return { result, source: 'google' };
    }

    if (activeProvider === 'nominatim') {
      const result = await this.nominatimProvider.reverseGeocode(lat, lng);
      return { result, source: 'nominatim' };
    }

    // default: offline
    const result = await this.offlineProvider.reverseGeocode(lat, lng);
    return { result, source: 'geonames-offline' };
  }
}
