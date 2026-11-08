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
// RETRO-I1 MOUNTS ONLY. The routes are live and empty: no resource type is
// registered and no circle has been mapped to a group (RETRO-I2). Circles,
// circle members, circle invites and `MediaShare` stay app-owned and keep
// deciding access (`circles/`, `share/`) until RETRO-I3..I5. The mapping every
// later issue implements is `docs/platform-adoption/circles-to-groups.md`.
//
// Options (decisions of #562):
//   groups.inviteTtlDays: null        circle invites never expired; the imported
//                                     ones (RETRO-I5) keep that semantics
//   groups.membershipCacheTtlSeconds  the principal cache's TTL
//                                     (AUTH_PRINCIPAL_CACHE_TTL_SECONDS), so both
//                                     caches expire together
//   groups.autoAccept*                left OFF: the app's own sign-in claim of
//                                     circle invites stays until RETRO-I5
//   links.appUrl                      APP_URL (link URL `${APP_URL}/s#lnk_...`)
//   links.defaultTtlDays/maxTtlDays   null: a MemoriaHub public share may be
//                                     "forever" (`expiresAt` null), and imported
//                                     links (RETRO-I4) keep that semantics
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
