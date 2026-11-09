# Circles to platform groups: the mapping

Decided by RETRO-I1 ([#562](https://github.com/marinoscar/MemoriaHub/issues/562), epic [#556](https://github.com/marinoscar/MemoriaHub/issues/556)). Every later issue of the epic implements a part of it and must not re-decide anything here; a change to a decision is a change to this page, in its own PR, before the code.

| Issue | Implements |
|---|---|
| RETRO-I1 (#562) | Mounts `SharingModule.forRoot` in single-organization mode, binds the six host ports, registers the permissions, metrics, notifications and e-mail templates. Writes no data. This page. |
| RETRO-I2 (#569) | The data: circles to groups, members to group members, `circle_id` to `org_id` + `owner_group_id` / `owner_user_id`, the resource types and the group-owned registrations (§2-§5). |
| RETRO-I3 (#573) | `CircleMemberGuard` / `assertCircleAccess` to `AccessPolicy` and the list helpers (§6, §7, §8). |
| RETRO-I4 (#578) | `MediaShare` to link grants (§9). **Done**: see [public-sharing.md](../specs/public-sharing.md) and the [runbook §7](../runbooks/circles-to-groups.md#7-public-shares-to-link-grants-retro-i4). |
| RETRO-I5 (#583) | `CircleInvite` to `GroupInvite`, and the sign-in claim (§10). |
| RETRO-I6 (#588) | The web, CLI, TUI and Android "circle" UX on platform groups. |

Source recipe: `packages/platform-api/src/sharing/README.md` of EnterpriseAppBase, section *Migration recipe: from circles and public links (MemoriaHub-style)* (the same text ships in `node_modules/@marinoscar/platform-api/src/sharing/README.md`). Platform decision D6 (EAB `docs/specs/platform-packages.md`): **circles are sharing groups inside one organization, never tenants.** MemoriaHub stays `TENANCY_MODE=single` permanently (`SHARING_TENANCY.mode()` returns `'single'`, `apps/api/src/platform/sharing/sharing-host.module.ts`); see EAB `docs/runbooks/multi-org.md` for what is deliberately not switched on.

## 0. State after RETRO-I1

- Mounted: `apps/api/src/platform/sharing/sharing.config.ts` (`SharingModule.forRoot`), imported by `apps/api/src/app.module.ts`.
- Host ports: `apps/api/src/platform/sharing/sharing-host.module.ts` (data, event bus, emitter, notifier, tenancy, jobs).
- Options: `groups.inviteTtlDays: null` (circle invites never expired), `groups.membershipCacheTtlSeconds` = `AUTH_PRINCIPAL_CACHE_TTL_SECONDS`, both auto-accept options OFF (the app's claim stays until I5), `links.appUrl` = `APP_URL`, `links.defaultTtlDays: null` and `links.maxTtlDays: null` (a MemoriaHub share may be forever).
- Routes live and empty: `/api/groups/**`, `/api/grants`, `/api/grants/links`, `/api/grants/shared-with-me`, `/api/sharing/group-roles`, `/api/sharing/grantee-kinds`, and the deliberately public `/api/public/links/current` (`platformHost.allowPublic`, `apps/api/src/platform/platform-host.ts`).
- Registrations: `apps/api/src/app-registrations/sharing.ts` (metrics, the `group-invitation` and `shared-with-you` templates), `apps/api/src/platform/sharing/sharing.notifications.ts` (events), slice `sharing` in `apps/api/src/app-registrations/permissions.ts`.
- Job: `sharing.grants.prune` (server-only, daily 03:00, enqueue-only cron). Doctor: `sharing.groups.orphaned`.
- No resource type is registered and no model has `owner_group_id`; the sharing conformance suite (`apps/api/test/conformance.spec.ts`) pins `resourceTypeIds: []` and `groupOwnedModels: {}`.
- Circles, circle members, circle invites and `MediaShare` are unchanged and keep deciding access (`PLATFORM-ADOPTION-SHIM(#562)` on `apps/api/src/circles/circles.module.ts` and `apps/api/src/share/share.module.ts`; row in [local-exceptions.md](local-exceptions.md)).

## 0b. State after RETRO-I2

Implemented by migration `20261108200000_i2_circles_to_groups_ownership` (operator procedure, timings and verification: [docs/runbooks/circles-to-groups.md](../runbooks/circles-to-groups.md)). What I2 did and, deliberately, did not do:

- **Done.** One `groups` row per shared circle (same uuid) and its `group_members` (roles mapped as §2; a group with no admin gets its circle owner as admin). `org_id` (NOT NULL), `owner_group_id`, `owner_user_id`, the one-owner CHECK, the composite key to `groups (id, org_id)` (`ON DELETE RESTRICT`), `owner_user_id -> users` (`ON DELETE RESTRICT`, open decision 1: a personal library never cascades away with a user row; the user-data removal hook empties it first, as today), FORCE RLS and `<table>_org_isolation` on the 20 tables of §3 and `media_visual_embedding`. `media_item` and `album` registered (§4) and the other 18 models as group-owned types (`app-registrations/sharing.ts`; the type ids are `tag`, `person`, `face`, `memory`, `burst_group`, `duplicate_group`, `location_suggestion`, `media_enhancement`, `media_enhancement_batch`, `review_run`, `trash_empty_run`, `workflow`, `workflow_run`, `media_geocode_status`, `media_metadata_status`, `media_tag_status`, `media_transcript`, `media_item_embedding`); the 20 models are `org` in `model-ownership.ts`.
- **Additive only.** `circles`, `circle_members`, `circle_invites` and every `circle_id` column (and its indexes, the gallery index included) stay; circles keep deciding access. Database triggers (`PLATFORM-ADOPTION-SHIM(#573)`, local-exceptions.md) keep the new model equal to the circles for every writer, so the application code is unchanged: content rows take their owner from `circle_id` on insert and on a `move_to_circle`, and shared circles and their members are mirrored into groups.
- **Left to later issues.** The `owner_key` generated column and the uniques and indexes rewritten on it (open decision 2), dropping `circle_id`, `circle_members` and `circles` (open decision 4), the JSON references of §3 (they stay valid: a shared circle's id is its group's id, and a personal circle still exists), the `legacy-circle-scope.ts` helper and the query rewrite: RETRO-I3 (#573), which writes owners explicitly and drops the content trigger. Grant clean-up in hard deletes: I3/I4 (the slice's daily prune covers it meanwhile).

## 0c. State after RETRO-I3

Access is decided on the platform groups; the data model and every route shape are unchanged.

- **One decision point.** `OwnerAccessService` (`apps/api/src/platform/sharing/owner-scope.ts`, module `OwnerAccessModule`) replaces `CircleMembershipService` at every former call site: `requireOwnerRole(userId, scopeId, permissions, minRole)` with the group roles of §7 (`viewer`, `editor`, `admin`). The scope id is the former circle id: a shared circle resolves to the group of the same id and the caller's role is their `group_members` role, read through the sharing slice's `PrincipalGroupsProvider` (cached for `AUTH_PRINCIPAL_CACHE_TTL_SECONDS`, invalidated by every circle membership write in `circles.service.ts` and the sign-in invite claim); a personal circle resolves to its owner, who alone passes (as `admin`). `CircleMembershipService`, the unused `CircleMemberGuard` and `@RequireCircleRole` are deleted; feature modules import `OwnerAccessModule` instead of `CirclesModule`.
- **403 -> 404 (§6).** A non-member, a stranger on a personal library and an unknown scope get the same 404. A member below the required role still gets 403. Bypass: `groups:admin` (and the deprecated `circles:manage_any`, kept one release), `media:write_any`, `media:read_any`, exactly as before.
- **Personal circles take no members**: `POST /api/circles/:id/members` and `POST /api/circles/:id/invites` answer 400 on a personal circle (such a member was dropped by I2 and would hold no access).
- **Equivalence** is pinned by `apps/api/test/sharing/access-matrix.spec.ts` (decision table and 16 routes across ten domains x five callers, each against the legacy rule table) and `apps/api/test/sharing/owner-access.db.spec.ts` (real PostgreSQL, the I2 mirror, forced RLS).
- **Grants (part 2).** On `media_item` and `album` a caller the owner-scope check refused is then asked about GRANTS through the sharing slice's `AccessPolicy` (`RecordAccessService`, `apps/api/src/platform/sharing/record-access.ts`): `decide` for one record (`GET/PATCH /api/media/:id`, tags, albums), ONE `decideMany` for a bulk batch (`MediaService.assertAllInCircle`), and `accessibleWhere` (scope `shared`) AND-ed onto a non-member's `GET /api/media` / `GET /api/media/albums`. Only a decision `via` a user or group grant is accepted, so every member's outcome is exactly the owner-scope one and a member's list keeps its `circle_id` filter (gallery keyset, map and KNN plans untouched). A viewer grant reads, an editor grant also writes, no grant trashes (`delete` needs the owner) or reaches a group-`admin` action. Pinned by `test/sharing/record-grants.spec.ts` and `test/sharing/cross-group-queries.db.spec.ts`.
- **Owner-scope parameters.** Every route that took `circleId` also takes `ownerGroupId` (a shared library) or `scope=me` (the caller's personal library); `circleId` stays, deprecated in OpenAPI, for one release. A global interceptor (`platform/sharing/owner-scope-params.ts`) rewrites both forms into `circleId` before validation; conflicting forms are 400, `scope=me` with no personal library 404.
- **`groups:write` for `viewer`** (§5), so a viewer can still create a shared library as they could always create a circle.
- **Kept on purpose** (local-exceptions.md): the §8 sweeps still read the mirrored `circles` / `circle_members` (no platform system listing of groups and members; EAB seam), proven equal by `cross-group-queries.db.spec.ts`; job payloads keep `circleId` and the job type strings are unchanged (queued jobs and the platform's permanent type strings); the workflow action stays `move_to_circle` (stored workflow definitions and run snapshots name it; renaming it is RETRO-I6's, with the web builder); the content trigger stays (dropping it is a migration). Grants are not consulted by the map aggregate, explore, facets, search/KNN and the review queues, which stay member-only.

## 1. Decisions (the three open decisions of #562)

1. **The circle UUID is kept as the group UUID.** `groups.id = circles.id` for every non-personal circle, so every `circle_id` value maps 1:1 to `owner_group_id` with no lookup table, and old deep links and stored settings carrying a `circleId` keep resolving.
2. **Link lifetimes are unlimited.** `links.defaultTtlDays: null`, `links.maxTtlDays: null`: an imported share with `expiresAt` null stays forever, as it was. Revisit later; a cap is a settings change, not a migration.
3. **`media_item` and `album` are `ownership: 'user_or_group'`.** Rows of a personal circle become user-owned; rows of any other circle group-owned.

## 2. Circles and members

| MemoriaHub | Platform | Rule |
|---|---|---|
| `Circle` with `isPersonal = false` (`apps/api/prisma/fragments/circles.prisma`, table `circles`) | `groups` row | `id` = circle id (decision 1), `org_id` = the default organization, `name`, `description`, `created_by_id = owner_id`, `created_at` / `updated_at` kept, `metadata` empty |
| `Circle` with `isPersonal = true` | **no group** | its content rows get `owner_user_id = circles.owner_id`, `owner_group_id` null |
| `CircleMember` (`circle_members`) of a non-personal circle | `group_members` row | `group_id = circle_id`, `user_id`, `org_id` = default org, `role` mapped below, `created_at` kept, `added_by_id` null (not recorded today) |
| `CircleMember` of a personal circle | dropped | the owner owns the rows directly |
| `CircleRole` enum | text group role | `circle_admin` -> `admin`, `collaborator` -> `editor`, `viewer` -> `viewer` |
| `Circle.ownerId` (`Restrict`) | `groups.created_by_id` (actor, set null on purge) | ownership of content moves to the group; the "last admin" guard of the slice protects a group, not the creator |

Every circle member is already an active member of the default organization (identity sign-in self-heal), so the slice's `NOT_AN_ORG_MEMBER` rule never blocks the import. Preserving every circle, membership and role exactly is the acceptance test of I2 (row counts per role before and after, on a restored backup).

## 3. Content tables (`circle_id` to ownership)

Each content table gains `org_id uuid NOT NULL` (FORCE RLS, `<table>_org_isolation`), `owner_group_id uuid NULL` with the composite FK `(owner_group_id, org_id) -> groups(id, org_id) ON DELETE RESTRICT`, `owner_user_id uuid NULL REFERENCES users(id)`, and `CHECK (num_nonnulls(owner_user_id, owner_group_id) = 1)`; `circle_id` is dropped at the contract step. The tables carrying `circleId` today (fragment in brackets):

| Model (table) | Fragment | Registration (I2) |
|---|---|---|
| `MediaItem` (`media_items`) | `media.prisma` | **resource type `media_item`** (§4) |
| `Album` (`albums`) | `media.prisma` | **resource type `album`** (§4) |
| `Tag` (`tags`) | `media.prisma` | group-owned `tag` |
| `MediaItemEmbedding` (`media_item_embedding`) | `media.prisma` | group-owned `media_item_embedding` (derived) |
| `Person` (`people`) | `face.prisma` | group-owned `person` |
| `Face` (`faces`) | `face.prisma` | group-owned `face` |
| `Memory` (`memories`) | `memories.prisma` | group-owned `memory` |
| `BurstGroup` (`burst_groups`) | `dedup-burst.prisma` | group-owned `burst_group` |
| `DuplicateGroup` (`duplicate_groups`) | `dedup-burst.prisma` | group-owned `duplicate_group` |
| `LocationSuggestion` (`location_suggestions`) | `location.prisma` | group-owned `location_suggestion` |
| `MediaEnhancement` (`media_enhancements`) | `enhancement.prisma` | group-owned `media_enhancement` |
| `MediaEnhancementBatch` (`media_enhancement_batches`) | `enhancement.prisma` | group-owned `media_enhancement_batch` |
| `MediaGeocodeStatus` (`media_geocode_status`) | `metadata.prisma` | group-owned `media_geocode_status` (derived) |
| `MediaMetadataStatus` (`media_metadata_status`) | `metadata.prisma` | group-owned `media_metadata_status` (derived) |
| `MediaTagStatus` (`media_tag_status`) | `tagging.prisma` | group-owned `media_tag_status` (derived) |
| `MediaTranscript` (`media_transcripts`) | `tagging.prisma` | group-owned `media_transcript` (derived) |
| `ReviewRun` (`review_runs`) | `review-runs.prisma` | group-owned `review_run` |
| `TrashEmptyRun` (`trash_empty_runs`) | `trash.prisma` | group-owned `trash_empty_run` |
| `Workflow` (`workflows`) | `workflows.prisma` | group-owned `workflow` |
| `WorkflowRun` (`workflow_runs`) | `workflows.prisma` | group-owned `workflow_run` |
| raw table `media_visual_embedding` (`circle_id`, no Prisma model) | migration `20260702000000_add_visual_embeddings_and_duplicate_groups` | same columns; HNSW KNN filter moves to `owner_*` |

Not content, handled elsewhere: `CircleMember` and `CircleInvite` (`circles.prisma`; §2, §10), `MediaShare` (`media.prisma`; §9), `EnrichmentJob` (`platform-jobs.legacy.prisma`, legacy; jobs carry `orgId` and a `circleId` payload on the platform `jobs` table), `MhLegacyNotification` (`platform-notifications.legacy.prisma`, legacy; notifications are the platform's since RETRO-D3).

Every group-owned type is registered with `registerGroupOwnedResource({ type, countOwnedByGroup })`, so `DELETE /api/groups/:id` answers 409 `GROUP_OWNS_RESOURCES` while the group still owns rows, and each model goes into the conformance suite's `groupOwnedModels`. Derived tables (status, embedding, transcript) keep denormalized `owner_*` columns copied from their media item.

JSON and array references to a circle id (rewritten by I2's data step only where they hold a personal-circle id; a non-personal id stays valid by decision 1): `user_settings.activeCircleId` (web, `apps/web/src/types/index.ts`), `media_sync_devices.config.targetCircleId` (`apps/api/src/media-sync/media-sync.service.ts`), `node_backup_configs.circle_ids` (`apps/api/prisma/fragments/nodes-backup.prisma:42`), workflow definitions (`move_to_circle` target), pending `jobs.payload.circleId`, platform notification `data.circleId`.

## 4. Resource types `media_item` and `album`

Registered by I2 in `apps/api/src/app-registrations/sharing.ts` (the type ids are PERMANENT once grants exist; the conformance suite then pins `resourceTypeIds: ['album', 'media_item']`):

```ts
registerResourceType({
  type: 'media_item',                       // and 'album', identical except loadOwners/describe
  roles: ['viewer', 'editor'],
  actions: { read: 'viewer', write: 'editor', share_link: 'editor', share: 'owner', delete: 'owner' },
  actionPermissions: { write: 'media:write', delete: 'media:delete' },
  bypassPermissions: { read: 'media:read_any', write: 'media:write_any', delete: 'media:delete_any' },
  ownership: 'user_or_group',
  groupRoleMap: { admin: 'owner', editor: 'editor', viewer: 'viewer' },
  grantable: { user: ['viewer'], group: ['viewer', 'editor'], link: ['viewer'] },
  denyAs: 'not_found',
  loadOwners,         // ONE query; deleted_at IS NOT NULL is a missing record for media_item
  countOwnedByGroup,
  describe,           // title + root-relative path (/media/:id, /albums/:id) for "shared with you"
});
```

The `bypassPermissions` keep today's super-admin bypass (`circles:manage_any`, `media:read_any`, `media:write_any` in `apps/api/src/circles/circle-membership.service.ts:30-39`). `circles:manage_any` itself maps to `groups:admin` (§5).

## 5. Permissions

| MemoriaHub (declared in `apps/api/src/app-registrations/memoriahub-permissions.ts`) | Platform (slice `sharing`, `SHARING_PERMISSION_DECLARATIONS`) |
|---|---|
| `circles:read` (line 105) | `groups:read` |
| `circles:write` (line 111) | `groups:write` |
| `circles:manage_any` (line 117) | `groups:admin` |
| `shares:manage` (line 133) | `sharing:write` (+ the type action `share_link`, §4) |
| `shares:manage_any` (line 139) | `sharing:admin` |

Granted since RETRO-I1 (`apps/api/prisma/catalog/permissions.json`, `npm run catalog:permissions --workspace=api`): `groups:read`, `sharing:read` to `viewer`, `contributor`, `org_admin`; `groups:write`, `sharing:write` to `contributor`, `org_admin`; `groups:admin`, `sharing:admin` to `org_admin`. A system `admin` holds the last two through the `org_admin` role the identity slice gives it on the default organization (all six are ORG-scope, so they are never granted to the system role directly). The MemoriaHub ids stay until I3 retires the last route that checks them; the seed applies the new rows on the next `npm run prisma:seed` (idempotent).

Note the one deliberate difference: `viewer` holds `circles:write` (can create a circle); the platform gives `groups:write` only to `contributor` and `org_admin`. **Decided in I3:** `groups:write` is granted to `viewer` too (`platformGrants` in `apps/api/src/app-registrations/permissions.ts`), keeping that behaviour. No MemoriaHub permission name is dead yet: `circles:*` are checked by the circle routes until I6, `shares:*` by the share routes until I4.

## 6. Error semantics

A non-member of a circle gets **403** today (`apps/api/src/circles/circle-membership.service.ts:54`, `apps/api/src/circles/guards/circle-member.guard.ts:41`). Under `AccessPolicy` with `denyAs: 'not_found'`, and on every group route, it is **404** (the record's existence is hidden); only a missing `actionPermissions` entry on a record the caller can already see stays a 403 naming the permission. This is a deliberate behaviour change of I3, documented for every client (web, CLI, Android: the phone already treats another user's device as 404).

## 7. Per-circle role checks

`@CircleRole(...)` (`apps/api/src/circles/decorators/circle-role.decorator.ts`) with `CircleMemberGuard` and `CircleMembershipService.assertCircleAccess(user, circleId, minRole)` become `AccessPolicy.require(principal, action, { type, id })` on a record, and `ownedByMeOrMyGroups(principal, { ownerUserField: 'ownerUserId', ownerGroupField: 'ownerGroupId' }, { minGroupRole })` on a circle-scoped list (`viewer` -> `minGroupRole: 'viewer'`, `collaborator` -> `'editor'`, `circle_admin` -> `'admin'`). Lists that must also include records shared through grants use `accessibleWhere`.

## 8. Cross-circle query inventory

Every query that reads or writes across more than one circle, refreshed at RETRO-I3 part 2 (`grep -rn "circle\.findMany\|circleMember\.findMany\|circleId: { in" apps/api/src`). **Decision for all of them in I3: they keep reading the app's `circles` / `circle_members`.** The platform has no system listing of groups and of a group's members for a background job, and app code may not read `groups` / `group_members` directly (`no-direct-access`); the RETRO-I2 mirror keeps the two models equal for every circle the app writes. `apps/api/test/sharing/cross-group-queries.db.spec.ts` pins the equality on real PostgreSQL (the swept scopes are the groups plus one personal library per user, the reconcile audience is the group's `editor` + `admin` members, the digest audience all members, a node's backup scope the owner's groups plus their personal library). The EAB seam (system listing) and RETRO-I6 (circles dropped) turn each into a group query.

| File:line | What it does | Group-model meaning | Proven by |
|---|---|---|---|
| `apps/api/src/memories/memories-generation.task.ts:117` | every circle due for `memory_generation` | every group + every personal library | db spec case 1 |
| `apps/api/src/memories/digest/memory-digest.task.ts:133` | every circle due for `memory_digest`; recipients are its members | groups + personal libraries; recipients = `group_members` | cases 1, 2 |
| `apps/api/src/memories/admin/memory-backfill.service.ts:99` | one or every circle for the memories backfill | same as generation | case 1 |
| `apps/api/src/notification-producers/review-queue-reconcile.service.ts:152`, `:198` | every circle, and its collaborator/admin members | every group, its `editor` + `admin` members (open decision 2: 1:1) | cases 1, 2 |
| `apps/api/src/nodes/node-backup.service.ts:251-252` | owner's memberships to validate `circleIds` | owner's groups + personal library | case 3 |
| `apps/api/src/nodes/node-backup-query.service.ts:206` (memberships), `:244`, `:377`, `:414`, `:467`, `:477`, `:487` (`circleId: { in: scope }`) | backup change feed, manifest and dimensions across the node owner's circles | the same scope over `owner_*` (equal by the I2 trigger) | case 3 |
| `apps/api/src/media-sync/media-sync.service.ts:603` (`defaultTargetCircle`) | personal circle, else the first collaborator/admin circle, as a device's target | personal library, else the first group where the user is `editor`+ | owner-access.db.spec (roles) |
| `apps/api/src/circles/circles.service.ts:73`, `:80`, `:133`, `:143` | list circles (all for an admin, else the caller's memberships) and members | `/api/groups` (RETRO-I5/I6 replace these routes) | n/a (routes slated for I6) |
| `apps/api/src/search/semantic-search.service.ts:83` | pgvector KNN by `e.circle_id` | the owner scope's key; grants deliberately not consulted (member-only, index plan kept) | access-matrix (search route) |
| `apps/api/src/workflows/actions/workflow-action.executor.ts:115`, `:381` | `move_to_circle`, editor on BOTH scopes | unchanged name (stored definitions); the check is `requireOwnerRole` on both | workflow-run specs |
| `apps/api/src/platform/onboarding/onboarding.facts.ts:125`, `:134`, `:137` | the caller's circles, their other members and pending invites | groups + invites (I5) | n/a |
| `apps/api/src/platform/user-data/memoriahub-user-data.service.ts:108`, `:224`, `:251`, `:275`, `:294`, `:366`, `:403` | personal-circle purge and owned-circle hand-over | personal library purge (`owner_user_id`); group hand-over | ownership.db.spec |
| `apps/api/src/metadata/metadata-backfill.service.ts:95`, `apps/api/src/face/face-backfill.service.ts:101`, `apps/api/src/burst/burst.service.ts:756`, `apps/api/src/dedup/duplicate-backfill.service.ts:41`, `apps/api/src/tagging/tagging-backfill.service.ts:109`, `apps/api/src/social-media/social-media-backfill.service.ts:103`, `apps/api/src/location-groups/location-group-rebuild.handler.ts:196` | admin backfills and the location rebuild over every circle | every group + personal library | case 1 |

A new hit of the grep belongs in this table, with a case in the db spec when it decides who sees or receives something.

## 9. Public shares (`MediaShare`) to link grants (I4)

`MediaShare` (`apps/api/prisma/fragments/media.prisma`; `apps/api/src/share/`) becomes link grants through `importLegacyToken`: `targetType` picks `media_item` or `album`, `resource_id` the matching id, `role: 'viewer'`, `expires_at`, `revoked_at`, `granted_by_id = created_by_id`, `created_at` kept; then the clear `token` column is dropped. Old URLs `/s/<token>` carry the token in the PATH: the SPA redirects `/s/:token` to `/s#lnk_:token`. The public routes change shape: `apps/api/src/share/public-share.controller.ts` reads `public/shares/:token` and PROXIES bytes (`:token/media/:idx`, with Range); the slice's pattern reads `X-Link-Token` only and returns presigned download URLs. `/api/shares` (`shares:manage`) becomes `/api/grants/links` (`sharing:write` + `share_link`). Links need `SECRETS_ENCRYPTION_KEY` (503 `LINKS_UNAVAILABLE` otherwise; every MemoriaHub deployment already sets it).

**Implemented (RETRO-I4).** As planned, with: the import is an operator script run between the deploy and the contract migration (`npm run sharing:import-media-shares`), which drops the whole `media_shares` table rather than only its token column; the old API routes answer 410 `LEGACY_SHARE_ROUTE`; the admin page lists links through an app shim (`LinkGrantDirectory`, the slice has no organization-wide listing) and lost its hard delete; `bypassPermissions.share_link: 'sharing:admin'` lets an administrator revoke any link.

## 10. Invites (I5)

`CircleInvite` (`apps/api/prisma/fragments/circles.prisma`) becomes `GroupInvite`: unclaimed rows (`claimedAt` null) become pending invites (`invited_by_id = addedById`, `created_at = addedAt`, `expires_at` null: decision of `groups.inviteTtlDays: null`), role mapped as in §2; claimed rows are dropped (their members exist). The sign-in claim (`apps/api/src/circles/identity-listeners.ts`, `identity.user.created` / `identity.login.succeeded`) stays until I5 switches it to the slice's `groups.autoAcceptInvitesOnSignup` / `autoAcceptInvitesOnSignIn` (EAB #728 auto-claim gap) or keeps the app's claim through `GroupInvitesService.claimPendingForEmail`. The invitation e-mail becomes `groups.invitation` with the `group-invitation` template (registered in RETRO-I1); the circle events `circles.invitation` / `circles.membership_confirmed` and the `circle-invitation` / `membership-confirmation` templates stay until then (template names are permanent; they are retired, not renamed).

## 11. What does not change

- `TENANCY_MODE` stays `single`; no organization is created; circles never become organizations.
- Job type strings, notification keys and template names stay (new ones only are added).
- A user's media is never re-owned silently: a personal circle's rows become the same user's rows; a shared circle's rows become its group's rows, with the same members and roles.
