import { Injectable } from '@nestjs/common';
import { CredentialsService } from '@marinoscar/platform-api/credentials';
import type { IssuedJobSecret, Job, JobSecretBroker, JobSecretUsability } from '@marinoscar/platform-api/jobs';

import {
  GEO_PROVIDER_CREDENTIAL_PURPOSE,
} from '../platform/credentials/credential-purposes.manifest';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';
import { GEO_GOOGLE_CREDENTIAL_NAME, GeoGoogleCredentialResolver } from '../media/geo/geo-google-credential.resolver';

/**
 * The kind of credential this broker mints (RETRO-C6, #600).
 *
 * PERMANENT once a grant exists: it is half of `job_node_secrets`' `(job_id, kind)` unique key and
 * how the revocation paths find the broker again.
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
 */
@Injectable()
export class GoogleGeocodeKeyBroker implements JobSecretBroker {
  readonly kind = GEO_GOOGLE_SECRET_KIND;

  constructor(
    private readonly credentials: CredentialsService,
    private readonly systemSettings: AppSystemSettingsService,
    private readonly googleCredential: GeoGoogleCredentialResolver,
  ) {}

  async usable(): Promise<JobSecretUsability> {
    const settings = await this.systemSettings.getSettings();
    const provider = settings.geo?.reverseProvider ?? process.env['GEO_PROVIDER'] ?? 'offline';
    if (provider !== 'google') {
      return {
        ok: false,
        reason: `The active reverse-geocoding provider is "${provider}", not "google": a node needs no secret for it.`,
        remedy: 'Geocoding on a node needs the Google provider: select it at /admin/settings/geo, or leave geocoding on the server.',
      };
    }
    if (settings.geo?.google?.enabled === false) {
      return {
        ok: false,
        reason: 'The Google geocoding provider is switched off.',
        remedy: 'Switch the Google provider on at /admin/settings/geo.',
      };
    }
    const info = await this.credentials.describe(GEO_PROVIDER_CREDENTIAL_PURPOSE, GEO_GOOGLE_CREDENTIAL_NAME);
    if (!info) {
      return {
        ok: false,
        reason: 'No Google geocoding key is stored.',
        remedy: 'Add the key at /admin/settings/geo, or leave geocoding on the server.',
      };
    }
    return { ok: true };
  }

  async issue(job: Job, until: Date): Promise<IssuedJobSecret> {
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

  async revoke(_handle: string): Promise<void> {
    // A Google API key cannot be revoked for one job: nothing to undo, and "already gone" is success.
  }
}
