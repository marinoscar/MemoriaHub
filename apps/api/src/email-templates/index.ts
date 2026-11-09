// =============================================================================
// MemoriaHub's email templates (RETRO-D2, #570)
// =============================================================================
//
// The platform's email slice (`@marinoscar/platform-api/email`) owns the
// layout, the safe-HTML helpers, the registry and the transports; this folder
// holds the two messages that belong to this app:
//
//   membership-confirmation   member add / invite auto-accept
//   memory-digest             the `memory_digest` job (MemoryDigestService)
//
// THE NAMES ARE PERMANENT: they key the template registry and, once the
// notifications slice binds events to templates (RETRO-D3), its delivery
// records. Add a name, never rename one. `circle-invitation` is retired
// (RETRO-I5, #583): circle invites are group invites and the sharing slice
// sends its own `group-invitation` template (event `groups.invitation`). None collides with a platform
// template, so they register without `override`.
//
// The broadcast email is the platform's `broadcast` template (same data shape
// as the app's former copy); the app's own template was deleted.
//
// Registered at import time by `app-registrations/email.ts`, which
// `platform/email/email.config.ts` imports before `EmailModule.forRoot`, so
// the registry is filled before bootstrap freezes it.
// =============================================================================

import { registerEmailTemplates, type EmailTemplateEntry } from '@marinoscar/platform-api/email';

import { membershipConfirmationEmail } from './membership-confirmation.email';
import { memoryDigestEmail } from './memory-digest.email';
import type {
  MembershipConfirmationEmailData,
  MemoryDigestEmailData,
} from './types';

declare module '@marinoscar/platform-api/email' {
  interface EmailTemplateDataMap {
    'membership-confirmation': MembershipConfirmationEmailData;
    'memory-digest': MemoryDigestEmailData;
  }
}

/** The registrant recorded for these templates in the bootstrap log. */
export const MEMORIAHUB_EMAIL_REGISTRANT = 'memoriahub';

/** This app's templates, by permanent name. */
export const MEMORIAHUB_EMAIL_TEMPLATE_NAMES = [
  'membership-confirmation',
  'memory-digest',
] as const;
export type MemoriaHubEmailTemplateName = (typeof MEMORIAHUB_EMAIL_TEMPLATE_NAMES)[number];

export const MEMORIAHUB_EMAIL_TEMPLATES: readonly EmailTemplateEntry[] = [
  { name: 'membership-confirmation', render: membershipConfirmationEmail, registrant: MEMORIAHUB_EMAIL_REGISTRANT },
  { name: 'memory-digest', render: memoryDigestEmail, registrant: MEMORIAHUB_EMAIL_REGISTRANT },
];

let registered = false;

/** Registers {@link MEMORIAHUB_EMAIL_TEMPLATES} once per process. */
export function registerMemoriaHubEmailTemplates(): void {
  if (registered) return;
  registered = true;
  registerEmailTemplates(MEMORIAHUB_EMAIL_TEMPLATES);
}

export { membershipConfirmationEmail, memoryDigestEmail };
export { memoryDigestSubject } from './memory-digest.email';
export type {
  MembershipConfirmationEmailData,
  MemoryDigestEmailData,
  MemoryDigestItemData,
} from './types';
