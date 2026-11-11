import { Inject, Injectable } from '@nestjs/common';

import {
  MEMORIAHUB_SECRETS,
  MEMORIAHUB_SETTINGS,
  type MemoriahubIssuedJobSecret,
  type MemoriahubJob,
  type MemoriahubJobSecretBroker,
  type MemoriahubJobSecretUsability,
  type MemoriahubSecretsPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import { GEO_GOOGLE_CREDENTIAL_NAME, GeoGoogleCredentialResolver } from './geo-google-credential.resolver.js';
import { GEO_PROVIDER_PURPOSE, type GeoSettingsDocument } from './geo-settings-shape.js';

/**
 * The kind of credential this broker mints (RETRO-C6, #600).
 *
 * PERMANENT once a grant exists: it is half of `job_node_secrets`' `(job_id, kind)` unique key and
 * how the revocation paths find the broker again.
 *
 * @stability experimental
 */
export const GEO_GOOGLE_SECRET_KIND = 'geo.google';

/**
 * Delivers the Google Geocoding key to the worker node that holds one `geocode` job, and nothing else.
 *
 * Whether a node may hold a secret at all is the platform's decision (`nodes.jobSecretBrokerEnabled`,
 * off by default, checked both when a node claims and when it asks for the secret), so this broker
 * does not re-read that switch. What it adds is the geocode-specific part of `usable()`: the active
 * reverse provider is `google` AND a key is stored and switched on. When it is not usable the platform
 * withholds `geocode` from nodes and the server runs the job, so a missing key or provider never fails a job.
 *
 * `usable()` never decrypts the key (it reads credential metadata); the plaintext is read only inside
 * `issue` and returned in `material`, which the platform sends once and never stores. A Google key cannot be
 * revoked per job, so `revoke` is a no-op: the handle is derived from the job id (non-secret) and the
 * grant's bound is the job lease (`expiresAt`). Rotating the key in Google Cloud is the operator's remedy
 * for a compromised node (see the geocoding runbook).
 *
 * NOTHING in a message thrown or logged here carries the key.
 *
 * @stability experimental
 */
@Injectable()
export class GoogleGeocodeKeyBroker implements MemoriahubJobSecretBroker {
  readonly kind = GEO_GOOGLE_SECRET_KIND;

  constructor(
    @Inject(MEMORIAHUB_SECRETS) private readonly secrets: MemoriahubSecretsPort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly googleCredential: GeoGoogleCredentialResolver,
  ) {}

  /** Whether the active provider is Google, switched on, with a stored key. */
  async usable(): Promise<MemoriahubJobSecretUsability> {
    const { value: geo } = await this.settings.readSystem<GeoSettingsDocument | undefined>('geo');
    const provider = geo?.reverseProvider ?? process.env['GEO_PROVIDER'] ?? 'offline';
    if (provider !== 'google') {
      return {
        ok: false,
        reason: `The active reverse-geocoding provider is "${provider}", not "google": a node needs no secret for it.`,
        remedy: 'Geocoding on a node needs the Google provider: select it at /admin/settings/geo, or leave geocoding on the server.',
      };
    }
    if (geo?.google?.enabled === false) {
      return {
        ok: false,
        reason: 'The Google geocoding provider is switched off.',
        remedy: 'Switch the Google provider on at /admin/settings/geo.',
      };
    }
    const info = await this.secrets.status(GEO_PROVIDER_PURPOSE, GEO_GOOGLE_CREDENTIAL_NAME);
    if (!info.configured) {
      return {
        ok: false,
        reason: 'No Google geocoding key is stored.',
        remedy: 'Add the key at /admin/settings/geo, or leave geocoding on the server.',
      };
    }
    return { ok: true };
  }

  /** Mints the Google key for one job; the key is returned in `material` and stored nowhere. */
  async issue(job: MemoriahubJob, until: Date): Promise<MemoriahubIssuedJobSecret> {
    const apiKey = await this.googleCredential.resolveApiKey();
    if (!apiKey) {
      // Never an empty grant: a node that gets no key cannot start, and the server runs the job.
      throw new Error('No usable Google geocoding key is stored');
    }
    return {
      // Derived from the job, so asking again for the same job extends the same grant (idempotent).
      handle: `geo-google-${job.id}`,
      expiresAt: until,
      material: { apiKey },
    };
  }

  /** A Google key cannot be revoked per job: nothing to undo. */
  async revoke(_handle: string): Promise<void> {
    // A Google API key cannot be revoked for one job: nothing to undo, and "already gone" is success.
  }
}
