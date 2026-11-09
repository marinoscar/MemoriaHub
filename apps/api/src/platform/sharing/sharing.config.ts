// =============================================================================
// The sharing slice, as MemoriaHub binds it (RETRO-I1, #562; epic #556)
// =============================================================================
//
// `SharingModule.forRoot` mounts groups (members, roles, invites, group
// ownership), grants (user, group, link), `AccessPolicy`, the list helpers, the
// public link route, the user purge, the Doctor check `sharing.groups.orphaned`
// and the job `sharing.grants.prune`:
//
//   /api/groups/**                 groups:read | groups:write (| groups:admin)
//   /api/grants, /api/grants/links sharing:read | sharing:write (| sharing:admin)
//   /api/sharing/group-roles|grantee-kinds   sharing:read
//   /api/public/links/current      deliberately public (`platformHost.allowPublic`,
//                                  the identity slice's `@Public()`); 503
//                                  `LINKS_UNAVAILABLE` without SECRETS_ENCRYPTION_KEY
//
// SINGLE-ORGANIZATION MODE (`SHARING_TENANCY.mode() === 'single'`): circles become
// sharing groups INSIDE the default organization, never tenants (EAB D6).
//
// RETRO-I1 mounted it; RETRO-I2 registered `media_item` / `album` and mirrored
// circles into groups. Since RETRO-I4 (#578) public shares ARE link grants
// (`public-links/`: the guarded public views, the 410 for the retired
// `/api/public/shares/*`, the admin listing). Since RETRO-I5 (#583) circle invites
// ARE group invites (`circles.service.ts` delegates to `GroupInvitesService`).
// Circles and circle members stay app-owned until RETRO-I6. The mapping every issue implements is
// `docs/platform-adoption/circles-to-groups.md`.
//
// Options (decisions of #562):
//   groups.inviteTtlDays: null        circle invites never expired; the imported
//                                     ones (RETRO-I5) keep that semantics
//   groups.membershipCacheTtlSeconds  the principal cache's TTL
//                                     (AUTH_PRINCIPAL_CACHE_TTL_SECONDS), so both
//                                     caches expire together
//   groups.autoAcceptInvitesOnSignup  ON (RETRO-I5, #583): a new user's pending
//   groups.autoAcceptInvitesOnSignIn  invites are claimed at sign-up, and every
//                                     later sign-in claims invites sent since
//                                     (the former circle-invite claim). The
//                                     slice's listener does it (EAB #1078,
//                                     RETRO-SEAM-INVITE-AUTOCLAIM), upgrade-only
//                                     (`inviteRoleMerge` default), for the
//                                     provider-verified address only
//   links.appUrl                      APP_URL (link URL `${APP_URL}/s#lnk_...`)
//   links.defaultTtlDays/maxTtlDays   null: a MemoriaHub public link may be
//                                     "forever" (`expiresAt` null), and the links
//                                     imported from `media_shares` (RETRO-I4) keep it
//
// Imported ONCE by `app.module.ts`, and by any feature module that later
// injects `AccessPolicy` or `GrantsService` (the module is not global).
// =============================================================================

import '../../app-registrations/sharing';

import type { Type } from '@nestjs/common';
import { parsePrincipalCacheTtlSeconds } from '@marinoscar/platform-api/identity';
import { SharingModule, type SharingModuleOptions } from '@marinoscar/platform-api/sharing';

import { platformHost } from '../platform-host';
import { SharingHostModule } from './sharing-host.module';

/** The `SharingModule.forRoot` options, exported for the mount spec. */
export const SHARING_MODULE_OPTIONS: SharingModuleOptions = {
  host: platformHost,
  imports: [SharingHostModule],
  groups: {
    inviteTtlDays: null,
    autoAcceptInvitesOnSignup: true,
    autoAcceptInvitesOnSignIn: true,
    membershipCacheTtlSeconds: parsePrincipalCacheTtlSeconds(process.env.AUTH_PRINCIPAL_CACHE_TTL_SECONDS),
  },
  links: {
    // The same default as `config/configuration.ts` (`appUrl`).
    appUrl: () => process.env.APP_URL || 'http://localhost:3535',
    defaultTtlDays: null,
    maxTtlDays: null,
  },
};

export const sharingModule = SharingModule.forRoot(SHARING_MODULE_OPTIONS);

/** The configured module's controller classes, by class name (route metadata in tests). */
export const sharingControllers: Readonly<Record<string, Type<unknown>>> = Object.freeze(
  Object.fromEntries((sharingModule.controllers ?? []).map((controller) => [controller.name, controller])),
);
