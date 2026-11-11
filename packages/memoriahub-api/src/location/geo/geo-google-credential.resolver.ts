import { Inject, Injectable } from '@nestjs/common';

import {
  MEMORIAHUB_SECRETS,
  MEMORIAHUB_SETTINGS,
  type MemoriahubSecretsPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import { GEO_PROVIDER_PURPOSE, type GeoSettingsDocument } from './geo-settings-shape.js';

/**
 * The credential name of the Google key under the `geo_provider` purpose.
 *
 * @stability experimental
 */
export const GEO_GOOGLE_CREDENTIAL_NAME = 'google';

/**
 * Resolves the Google reverse-geocoding key (RETRO-B4, #617).
 *
 * The secret is the credential `geo_provider/google` (through the secrets port); the on/off switch is the
 * non-secret `geo.google.enabled` setting. Returns `null` when no key is stored or the provider is switched
 * off, which every caller turns into the offline fallback (the pre-adoption rule).
 * SERVER-SIDE ONLY: the plaintext is returned to the caller and must not be logged or returned from a controller.
 *
 * @stability experimental
 */
@Injectable()
export class GeoGoogleCredentialResolver {
  constructor(
    @Inject(MEMORIAHUB_SECRETS) private readonly secrets: MemoriahubSecretsPort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
  ) {}

  /** The Google API key, or `null` when none is stored or the provider is switched off. */
  async resolveApiKey(): Promise<string | null> {
    const { value } = await this.settings.readSystem<GeoSettingsDocument | undefined>('geo');
    if (value?.google?.enabled === false) return null;
    return this.secrets.get(GEO_PROVIDER_PURPOSE, GEO_GOOGLE_CREDENTIAL_NAME);
  }
}
