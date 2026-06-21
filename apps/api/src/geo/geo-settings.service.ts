import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { encryptSecret, decryptSecret } from '../common/crypto/secret-cipher';
import { GoogleGeoLocationProvider } from '../media/geo/google-geo-location.provider';
import { OfflineGeoLocationProvider } from '../media/geo/offline-geo-location.provider';
import { NominatimGeoLocationProvider } from '../media/geo/nominatim-geo-location.provider';
import { UpsertGeoCredentialDto } from './dto/geo-credential.dto';
import { TestGeoProviderDto } from './dto/geo-test.dto';

@Injectable()
export class GeoSettingsService {
  private readonly logger = new Logger(GeoSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly googleProvider: GoogleGeoLocationProvider,
    private readonly offlineProvider: OfflineGeoLocationProvider,
    private readonly nominatimProvider: NominatimGeoLocationProvider,
  ) {}

  async getSettings() {
    const sysSettings = await this.systemSettings.getSettings();
    const activeReverseProvider = (sysSettings as any).geo?.reverseProvider ?? (process.env['GEO_PROVIDER'] ?? 'offline');

    const googleCred = await this.prisma.geoProviderCredential.findUnique({
      where: { provider: 'google' },
      select: { enabled: true, last4: true, baseUrl: true },
    });

    const providers = [
      {
        provider: 'google',
        configured: googleCred !== null,
        enabled: googleCred?.enabled ?? false,
        last4: googleCred?.last4 ?? null,
        baseUrl: googleCred?.baseUrl ?? null,
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

    const last4 = dto.apiKey.slice(-4);
    const encryptedKey = encryptSecret(dto.apiKey);

    const cred = await this.prisma.geoProviderCredential.upsert({
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

    this.logger.log(`Geo credential upserted for provider "${provider}" by user ${userId}`);

    return {
      provider: cred.provider,
      configured: true,
      enabled: cred.enabled,
      last4: cred.last4,
      baseUrl: cred.baseUrl ?? null,
    };
  }

  async deleteCredential(provider: string, userId: string) {
    if (provider !== 'google') {
      throw new BadRequestException(`Unsupported geo provider: ${provider}`);
    }

    const existing = await this.prisma.geoProviderCredential.findUnique({ where: { provider } });
    if (!existing) {
      throw new NotFoundException(`No credential configured for geo provider: ${provider}`);
    }

    await this.prisma.geoProviderCredential.delete({ where: { provider } });
    this.logger.log(`Geo credential deleted for provider "${provider}" by user ${userId}`);
  }

  async setActiveReverseProvider(
    provider: 'offline' | 'nominatim' | 'google',
    userId: string,
  ) {
    if (provider === 'google') {
      const cred = await this.prisma.geoProviderCredential.findUnique({ where: { provider: 'google' } });
      if (!cred || !cred.enabled) {
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
        const cred = await this.prisma.geoProviderCredential.findUnique({ where: { provider: 'google' } });
        if (!cred || !cred.enabled) {
          return { ok: false, error: 'Google credential not configured or disabled' };
        }
        const apiKey = decryptSecret(cred.encryptedKey);
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
