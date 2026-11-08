// =============================================================================
// MemoriaHub's email templates (RETRO-D2, #570)
// =============================================================================
//
// The platform's email slice (`@marinoscar/platform-api/email`) owns the
// layout, the safe-HTML helpers, the registry and the transports; this folder
// holds the three messages that belong to this app:
//
//   circle-invitation         CirclesService.createInvite
//   membership-confirmation   member add / invite claim
//   memory-digest             the `memory_digest` job (MemoryDigestService)
//
// THE NAMES ARE PERMANENT: they key the template registry and, once the
// notifications slice binds events to templates (RETRO-D3), its delivery
// records. Add a name, never rename one. None collides with a platform
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

import { circleInvitationEmail } from './circle-invitation.email';
import { membershipConfirmationEmail } from './membership-confirmation.email';
import { memoryDigestEmail } from './memory-digest.email';
import type {
  CircleInvitationEmailData,
  MembershipConfirmationEmailData,
  MemoryDigestEmailData,
} from './types';

declare module '@marinoscar/platform-api/email' {
  interface EmailTemplateDataMap {
    'circle-invitation': CircleInvitationEmailData;
    'membership-confirmation': MembershipConfirmationEmailData;
    'memory-digest': MemoryDigestEmailData;
  }
}

/** The registrant recorded for these templates in the bootstrap log. */
export const MEMORIAHUB_EMAIL_REGISTRANT = 'memoriahub';

/** This app's templates, by permanent name. */
export const MEMORIAHUB_EMAIL_TEMPLATE_NAMES = [
  'circle-invitation',
  'membership-confirmation',
  'memory-digest',
] as const;
export type MemoriaHubEmailTemplateName = (typeof MEMORIAHUB_EMAIL_TEMPLATE_NAMES)[number];

export const MEMORIAHUB_EMAIL_TEMPLATES: readonly EmailTemplateEntry[] = [
  { name: 'circle-invitation', render: circleInvitationEmail, registrant: MEMORIAHUB_EMAIL_REGISTRANT },
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

export { circleInvitationEmail, membershipConfirmationEmail, memoryDigestEmail };
export { memoryDigestSubject } from './memory-digest.email';
export type {
  CircleInvitationEmailData,
  MembershipConfirmationEmailData,
  MemoryDigestEmailData,
  MemoryDigestItemData,
} from './types';
