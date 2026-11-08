// =============================================================================
// The sharing slice's registrations (RETRO-I1, #562)
// =============================================================================
//
// Imported by `platform/sharing/sharing.config.ts` and by
// `platform/notifications/notification.manifest.ts` BEFORE their modules
// compose, so every registry is filled before the application bootstraps (the
// registries freeze then). Idempotent: a second import in the same process
// registers nothing twice.
//
//   metrics      `SHARING_APP_METRICS`: `app.sharing.group_mutations` (label `op`),
//                `app.sharing.access_decisions` (`resource_type`, `outcome`, `via`),
//                `app.sharing.link_resolutions` (`outcome`, `resource_type`). Never an
//                organization, group or record id on a label.
//   templates    `group-invitation` and `shared-with-you`: the slice's words in
//                MemoriaHub's layout (`platform/email/templates/`). Names permanent.
//
// Registered ELSEWHERE, on purpose:
//   - the six permissions (`groups:read|write|admin`, `sharing:read|write|admin`):
//     the platform permission manifest, slice `sharing` in `permissions.ts`;
//   - the two notification events (`groups.invitation`, `sharing.shared_with_you`):
//     `platform/sharing/sharing.notifications.ts`, through the notification manifest;
//   - `SHARING_USER_OWNED_MODELS` and `SHARING_MODEL_OWNERSHIP`: already part of the
//     platform inventories `registerPlatformUserOwnedModels` /
//     `registerPlatformModelOwnership` register (`ownership-manifest.ts`), so
//     registering them here would be a duplicate id.
//
// NO RESOURCE TYPE YET. `media_item` and `album` (ownership `user_or_group`) are
// registered by RETRO-I2 together with the `owner_user_id` / `owner_group_id`
// columns their `loadOwners` reads; the decisions are fixed in
// `docs/platform-adoption/circles-to-groups.md`. Until then the sharing
// conformance suite pins an empty resource-type snapshot.
// =============================================================================

import { registerEmailTemplates, type EmailTemplate, type EmailTemplateEntry } from '@marinoscar/platform-api/email';
import { appMetricRegistry, registerAppMetrics } from '@marinoscar/platform-api/otel-core';
import {
  GROUP_INVITATION_EMAIL_TEMPLATE,
  SHARED_WITH_YOU_EMAIL_TEMPLATE,
  SHARING_APP_METRICS,
} from '@marinoscar/platform-api/sharing';

import { groupInvitationEmail, type GroupInvitationEmailData } from '../platform/email/templates/group-invitation.email';
import { sharedWithYouEmail, type SharedWithYouEmailData } from '../platform/email/templates/shared-with-you.email';

declare module '@marinoscar/platform-api/email' {
  interface EmailTemplateDataMap {
    'group-invitation': GroupInvitationEmailData;
    'shared-with-you': SharedWithYouEmailData;
  }
}

/** The registrant recorded for the two templates in the bootstrap log. */
export const SHARING_EMAIL_REGISTRANT = 'sharing';

/** The sharing slice's two e-mail templates, bound to MemoriaHub's layout. */
export const SHARING_EMAIL_TEMPLATES: readonly EmailTemplateEntry[] = [
  {
    name: GROUP_INVITATION_EMAIL_TEMPLATE,
    render: groupInvitationEmail as EmailTemplate<never>,
    registrant: SHARING_EMAIL_REGISTRANT,
  },
  {
    name: SHARED_WITH_YOU_EMAIL_TEMPLATE,
    render: sharedWithYouEmail as EmailTemplate<never>,
    registrant: SHARING_EMAIL_REGISTRANT,
  },
];

let registered = false;

/** Registers the metrics and the two templates once per process. */
export function registerSharingDeclarations(): void {
  if (registered) return;
  registered = true;

  if (!appMetricRegistry.has(SHARING_APP_METRICS[0].key)) {
    registerAppMetrics(SHARING_APP_METRICS);
  }
  registerEmailTemplates(SHARING_EMAIL_TEMPLATES);
}

registerSharingDeclarations();
