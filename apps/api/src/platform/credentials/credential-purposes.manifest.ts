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
//   telemetry_greptime  the telemetry slice's GreptimeDB `reader` and `admin` passwords (RETRO-T2,
//                       #625); the app declares it because the slice reaches the store through its
//                       TELEMETRY_CREDENTIAL_STORE port. `GREPTIME_*` is only the deployment default.
//   webhook_signing     an endpoint's signing secret (RETRO-H4, #603), in all three tiers: the
//                       deployment's and an organization's (WEBHOOK_SIGNING_CREDENTIAL_PURPOSE_DEF) and a
//                       member's own (WEBHOOK_SIGNING_USER_CREDENTIAL_PURPOSE_DEF, the user registry).
//
// App purposes (owned by this app; the conformance suite is told `appOwners`):
//   face_provider  face recognition provider keys, name = provider key (`compreface`)
//   geo_provider   reverse geocoding provider keys, name = provider key (`google`)
//
//   ai             AI_CREDENTIAL_PURPOSE_DEF   the deployment's AI provider keys (RETRO-E3, #605): the address
//                  `AiConfigAdminService.setKey` writes and `AiConfigService.getOrgKey` / `AiKeyResolver`
//                  read; `npm run ai:migrate-keys` copies `ai_provider_credentials` here. Tiers system and org.
// =============================================================================

import {
  registerCredentialPurpose,
  registerUserCredentialPurpose,
  userCredentialPurposeRegistry,
  type CredentialPurposeDef,
} from '@marinoscar/platform-api/credentials';
import { AI_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/ai';
import { SES_CREDENTIAL_PURPOSE_DEF, SMTP_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/email';
import { PUSH_VAPID_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/notifications';
import { STORAGE_CREDENTIAL_PURPOSE_DEF } from '@marinoscar/platform-api/storage';
import { TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE } from '@marinoscar/platform-api/telemetry';
import {
  WEBHOOK_SIGNING_CREDENTIAL_PURPOSE_DEF,
  WEBHOOK_SIGNING_USER_CREDENTIAL_PURPOSE_DEF,
} from '@marinoscar/platform-api/webhooks';

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

export const TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE_DEF: CredentialPurposeDef = {
  purpose: TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE,
  owner: 'telemetry',
  label: 'GreptimeDB reader and admin passwords',
  tiers: ['system'],
};

export const MEMORIAHUB_CREDENTIAL_PURPOSE_DEFS: readonly CredentialPurposeDef[] = [
  STORAGE_CREDENTIAL_PURPOSE_DEF,
  SMTP_CREDENTIAL_PURPOSE_DEF,
  SES_CREDENTIAL_PURPOSE_DEF,
  PUSH_VAPID_CREDENTIAL_PURPOSE_DEF,
  FACE_PROVIDER_CREDENTIAL_PURPOSE_DEF,
  GEO_PROVIDER_CREDENTIAL_PURPOSE_DEF,
  TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE_DEF,
  WEBHOOK_SIGNING_CREDENTIAL_PURPOSE_DEF,
  AI_CREDENTIAL_PURPOSE_DEF,
];

let registered = false;

/** Registers every purpose once per process (a second call is a no-op, a duplicate across owners still fails). */
export function registerMemoriaHubCredentialPurposes(): void {
  if (registered) return;
  registered = true;
  for (const def of MEMORIAHUB_CREDENTIAL_PURPOSE_DEFS) registerCredentialPurpose(def);
  // A member's own tier of the webhook signing secret (RETRO-H4, #603).
  if (!userCredentialPurposeRegistry.has(WEBHOOK_SIGNING_USER_CREDENTIAL_PURPOSE_DEF.purpose)) {
    registerUserCredentialPurpose(WEBHOOK_SIGNING_USER_CREDENTIAL_PURPOSE_DEF);
  }
}

registerMemoriaHubCredentialPurposes();
