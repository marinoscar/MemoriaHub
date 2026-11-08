// =============================================================================
// Credential purposes (RETRO-B4, #617)
// =============================================================================
//
// The platform `CredentialsService` refuses to write a purpose nobody registered, and a
// purpose is also the AES-GCM sub-key domain of its secrets: a purpose string is PERMANENT
// once a row exists. Registered at import time, before the registries freeze at bootstrap
// (`credentials.config.ts` imports this file).
//
// Platform purposes (registered now so the migration script can write their rows; their
// readers switch in the slice that owns them: storage D1, SMTP/SES D2, VAPID D3):
//   storage      STORAGE_CREDENTIAL_PURPOSE_DEF   (the object store's secret access key)
//   smtp         SMTP_CREDENTIAL_PURPOSE_DEF
//   email_ses    SES_CREDENTIAL_PURPOSE_DEF
//   push_vapid   PUSH_VAPID_CREDENTIAL_PURPOSE_DEF
//
// App purposes (owned by this app; the conformance suite is told `appOwners`):
//   face_provider  face recognition provider keys, name = provider key (`compreface`)
//   geo_provider   reverse geocoding provider keys, name = provider key (`google`)
//
// NOT HERE: AI provider keys (`ai_provider_credentials`), which belong to RETRO-E3.
// =============================================================================

import { registerCredentialPurpose, type CredentialPurposeDef } from '@marinoscar/platform-api/credentials';
import { SES_CREDENTIAL_PURPOSE_DEF, SMTP_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/email';
import { PUSH_VAPID_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/notifications';
import { STORAGE_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/storage';

export const FACE_PROVIDER_CREDENTIAL_PURPOSE = 'face_provider';
export const GEO_PROVIDER_CREDENTIAL_PURPOSE = 'geo_provider';
/** The app owner string of its own purposes. */
export const APP_CREDENTIAL_OWNERS = ['memoriahub-face', 'memoriahub-geo'] as const;

export const FACE_PROVIDER_CREDENTIAL_PURPOSE_DEF: CredentialPurposeDef = {
  purpose: FACE_PROVIDER_CREDENTIAL_PURPOSE,
  owner: 'memoriahub-face',
  label: 'Face recognition provider',
  tiers: ['system'],
};

export const GEO_PROVIDER_CREDENTIAL_PURPOSE_DEF: CredentialPurposeDef = {
  purpose: GEO_PROVIDER_CREDENTIAL_PURPOSE,
  owner: 'memoriahub-geo',
  label: 'Reverse geocoding provider keys',
  tiers: ['system'],
};

export const MEMORIAHUB_CREDENTIAL_PURPOSE_DEFS: readonly CredentialPurposeDef[] = [
  STORAGE_CREDENTIAL_PURPOSE_DEF,
  SMTP_CREDENTIAL_PURPOSE_DEF,
  SES_CREDENTIAL_PURPOSE_DEF,
  PUSH_VAPID_CREDENTIAL_PURPOSE_DEF,
  FACE_PROVIDER_CREDENTIAL_PURPOSE_DEF,
  GEO_PROVIDER_CREDENTIAL_PURPOSE_DEF,
];

let registered = false;

/** Registers every purpose once per process (a second call is a no-op, a duplicate across owners still fails). */
export function registerMemoriaHubCredentialPurposes(): void {
  if (registered) return;
  registered = true;
  for (const def of MEMORIAHUB_CREDENTIAL_PURPOSE_DEFS) registerCredentialPurpose(def);
}

registerMemoriaHubCredentialPurposes();
