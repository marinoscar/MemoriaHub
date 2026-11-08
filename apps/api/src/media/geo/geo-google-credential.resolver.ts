import { Injectable } from '@nestjs/common';
import { CredentialsService } from '@marinoscar/platform-api/credentials';

import {
  GEO_PROVIDER_CREDENTIAL_PURPOSE,
} from '../../platform/credentials/credential-purposes.manifest';
import { AppSystemSettingsService } from '../../platform/settings/app-system-settings.service';

/** The credential name of the Google key under the `geo_provider` purpose. */
export const GEO_GOOGLE_CREDENTIAL_NAME = 'google';

/**
 * Resolves the Google reverse-geocoding key (RETRO-B4, #617).
 *
 * The secret is the platform credential `geo_provider/google`; the on/off switch is the
 * non-secret `geo.google.enabled` setting. Returns `null` when no key is stored or the provider
 * is switched off, which every caller turns into the offline fallback (the pre-adoption rule).
 * SERVER-SIDE ONLY: the plaintext is returned to the caller and must not be logged or returned
 * from a controller.
 */
@Injectable()
export class GeoGoogleCredentialResolver {
  constructor(
    private readonly credentials: CredentialsService,
    private readonly systemSettings: AppSystemSettingsService,
  ) {}

  async resolveApiKey(): Promise<string | null> {
    const settings = await this.systemSettings.getSettings();
    if (settings.geo?.google?.enabled === false) return null;
    return this.credentials.getSecret(GEO_PROVIDER_CREDENTIAL_PURPOSE, GEO_GOOGLE_CREDENTIAL_NAME);
  }
}
