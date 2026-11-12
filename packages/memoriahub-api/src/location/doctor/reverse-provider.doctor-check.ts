import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import {
  DOCTOR_CHECK_TIMEOUT_MS,
  doctorCheckId,
  errorMessage,
  fail,
  pass,
  readSystemNamespaces,
} from '../../core/index.js';
import {
  MEMORIAHUB_DOCTOR,
  MEMORIAHUB_SETTINGS,
  type MemoriahubDoctorCheck,
  type MemoriahubDoctorOutcome as DoctorCheckOutcome,
  type MemoriahubDoctorPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import { GeoSettingsService } from '../geo/geo-settings.service.js';

// Ported from `DoctorService.checkGeoReverseProvider` (key
// `geo.reverseProvider`). Live probe: one reverse-geocode lookup of a fixed
// coordinate through the active provider (a read; a Google lookup is a billed
// request). Writes nothing.

/** The status ladder of the geo reverse provider check. @stability experimental */
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
/** The geo reverse provider check. @stability experimental */
export class GeoReverseProviderDoctorCheck implements MemoriahubDoctorCheck, OnModuleInit {
  readonly id = doctorCheckId('geo', 'reverse-provider');
  readonly category = 'geo';
  readonly label = 'Reverse geocoding';
  readonly settingsPath = '/admin/settings/geo';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    @Inject(MEMORIAHUB_DOCTOR) private readonly doctor: MemoriahubDoctorPort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly geoSettings: GeoSettingsService,
  ) {}

  /** Registers the check with the diagnostics port. */
  onModuleInit(): void {
    this.doctor.registerCheck(this);
  }

  /** Runs the check. */
  async run(): Promise<DoctorCheckOutcome> {
    const settings = await readSystemNamespaces(this.settings, ['geo']);
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
