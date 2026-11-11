import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { GeoSettingsService } from '@marinoscar/memoriahub-api/location';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, errorMessage, fail, pass } from '../outcome';
import { AppSystemSettingsService } from '../../../platform/settings/app-system-settings.service';

// Ported from `DoctorService.checkGeoReverseProvider` (key
// `geo.reverseProvider`). Live probe: one reverse-geocode lookup of a fixed
// coordinate through the active provider (a read; a Google lookup is a billed
// request). Writes nothing.

export function decideGeoReverseProvider(
  provider: string,
  result: { ok: boolean; error?: string },
): DoctorCheckOutcome {
  if (!result.ok) {
    return fail(
      result.error ?? 'Reverse geocoding provider test failed.',
      'Configure the geo provider credentials in Admin Settings → Geo.',
      { provider },
    );
  }
  return pass(`Provider ${provider} responding.`, { provider });
}

@Injectable()
export class GeoReverseProviderDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('geo', 'reverse-provider');
  readonly category = 'geo';
  readonly label = 'Reverse geocoding';
  readonly settingsPath = '/admin/settings/geo';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly systemSettings: AppSystemSettingsService,
    private readonly geoSettings: GeoSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const settings = await this.systemSettings.readKnownValue();
    const provider = settings.geo?.reverseProvider ?? process.env['GEO_PROVIDER'] ?? 'offline';
    try {
      const result = await this.geoSettings.testProvider({
        provider: provider as 'offline' | 'nominatim' | 'google',
      });
      return decideGeoReverseProvider(provider, result);
    } catch (err) {
      return decideGeoReverseProvider(provider, { ok: false, error: errorMessage(err) });
    }
  }
}
