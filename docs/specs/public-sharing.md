# Public Media Sharing — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 2.0 |
| **Last Updated** | November 2026 |
| **Status** | Implemented (platform link grants since RETRO-I4, #578) |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Data Model: link grants](#2-data-model-link-grants)
3. [Tokens and URLs](#3-tokens-and-urls)
4. [Lifecycle: create, expire, revoke](#4-lifecycle-create-expire-revoke)
5. [Presigned URLs, never proxied bytes](#5-presigned-urls-never-proxied-bytes)
6. [Metadata-Stripping Contract](#6-metadata-stripping-contract)
7. [EXIF / GPS Limitation](#7-exif--gps-limitation)
8. [RBAC](#8-rbac)
9. [One 404 for every failure](#9-one-404-for-every-failure)
10. [Archived and Trashed Items](#10-archived-and-trashed-items)
11. [Admin Management Page](#11-admin-management-page)
12. [Old links and the cutover from `media_shares`](#12-old-links-and-the-cutover-from-media_shares)
13. [API Reference](#13-api-reference)
14. [Web](#14-web)
15. [Key Files](#15-key-files)

---

## 1. Overview and Goals

Anyone holding a public link can view one photo, one video or one album without an account. Since RETRO-I4 (#578, epic #556) a public link is a **link grant** of the platform sharing slice (`@marinoscar/platform-api/sharing`): a row in `grants` with `grantee_kind = 'link'` on the resource type `media_item` or `album`. MemoriaHub owns only what the slice cannot know: how a photo, a video or an album is shown to a stranger.

### Goals

- A recipient sees the media and nothing about it: no filename, date, location, camera, people, tags, owner or storage location.
- A link can expire ("Never" is allowed) and can be revoked at any time; revocation is immediate.
- The token never travels in a path or a query string, so it never reaches an access log after the first request of an old link.
- Every link made before the cutover keeps working.

### Non-Goals

- Stripping EXIF from the file bytes (section 7, unchanged limitation).
- Download affordances or editing for link holders: a link grants `viewer` only.
- Group and user grants beyond what the slice's `ShareDialog` offers (RETRO-I6 decides their exposure).

---

## 2. Data Model: link grants

There is no MemoriaHub table. A public link is one `grants` row (platform `0027_add_grants`, org-owned, FORCE ROW LEVEL SECURITY):

| Column | Value for a MemoriaHub link |
|--------|-----------------------------|
| `grantee_kind` | `link` |
| `resource_type` / `resource_id` | `media_item` + the media item id, or `album` + the album id (ids permanent, pinned by the sharing conformance suite's `resource-type-ids-stable`) |
| `role` | `viewer` (the only role `grantable.link` lists for both types) |
| `link_token_hash` | SHA-256 hex of the full `lnk_...` token: the lookup key (unique) |
| `link_token_ciphertext` | the token encrypted with `SECRETS_ENCRYPTION_KEY` under the purpose `sharing.link:<grant id>`, so the sharer can copy the link again |
| `expires_at` / `revoked_at` | `null` = never / not revoked |
| `granted_by_id` | who created it (SetNull when the user is deleted: a link belongs to the RECORD's owner) |
| `org_id` | the record's organization |

The resource types are registered in `apps/api/src/app-registrations/sharing.ts`: `actions.share_link: 'editor'` (a group editor, i.e. a circle collaborator, may create and manage links), `grantable.link: ['viewer']`, `bypassPermissions.share_link: 'sharing:admin'` (the admin page may revoke or re-date any link), `denyAs: 'not_found'`. `loadOwners` treats a trashed media item as missing.

**Deleting a record** leaves its link grants behind; they resolve as `resource_gone`, the same 404 as any failure, and the slice's `sharing.grants.prune` job removes revoked and expired grants after its retention. (The old `media_shares` FKs cascaded; calling `GrantsService.deleteForResources` from the media and album delete paths is a follow-up of RETRO-I3/I6.)

---

## 3. Tokens and URLs

- A token is `lnk_` plus 43 base64url characters (32 random bytes).
- The shareable URL is `<APP_URL>/s#lnk_...`: the token is in the **fragment**, which a browser never sends to a server.
- The SPA reads the fragment and calls the API with the token in the `X-Link-Token` header. A token in a path or a query string is never read.
- The token is returned in clear only once, in the `POST /api/grants/links` response; the list re-derives the URL from the ciphertext. It is never logged, put on a span, an audit row, an event or an error body.

---

## 4. Lifecycle: create, expire, revoke

| Action | Route (the slice's) | Who |
|--------|---------------------|-----|
| Create | `POST /api/grants/links` `{ resourceType, resourceId, role: 'viewer', expiresAt }` | `sharing:write` and `share_link` on the record (its owner, or an editor or admin of its owning group) |
| List a record's links | `GET /api/grants/links?resourceType&resourceId` | `sharing:read` and `share_link` |
| Re-date | `PATCH /api/grants/:id` `{ expiresAt }` | `sharing:write` and `share_link` (or `sharing:admin`) |
| Revoke | `DELETE /api/grants/:id` (soft: sets `revoked_at`) | `sharing:write` and `share_link` (or `sharing:admin`) |

`links.defaultTtlDays` and `links.maxTtlDays` are `null` in `platform/sharing/sharing.config.ts`, so a link may never expire, as a MemoriaHub share always could. Creating, re-dating and revoking a link are audited (`grant:link:create|update|revoke`); opening one is counted (`app.sharing.link_resolutions`, labels `outcome`, `resource_type`), never audited. The pre-platform bulk **hard delete** is gone (decision 2 of #578): revoke, and let the prune job delete.

The `share_expiring` notification (`shares.expiring`) warns a link's creator when it expires within seven days, once per expiry value (`data.shareId` is the grant id, `data.notifiedFor` the expiry).

---

## 5. Presigned URLs, never proxied bytes

The pre-platform API proxied the media bytes (`/api/public/shares/:token/media/:idx`, with Range). An `<img src>` or `<video src>` cannot send the `X-Link-Token` header, and putting the token back in a URL would put it back in logs, so the public views return **short-lived presigned download URLs** instead (`PUBLIC_LINK_URL_TTL_SECONDS`, one hour, `Content-Disposition: inline`), minted by the storage driver recorded on the row (the platform `StorageProviderRouter`). A presigned URL carries no link token.

Video seeking still works: S3 and R2 presigned GETs honour `Range`, and the `local` driver's signed route (`GET /api/storage/local/objects/:token`) answers `206` (decision 3 of #578; no seam needed).

---

## 6. Metadata-Stripping Contract

Unchanged from v1, plus the two URLs. A media link (`GET /api/public/links/media`):

```json
{ "data": { "type": "media_item", "expiresAt": null,
  "media": { "mediaType": "photo", "width": 4032, "height": 3024,
             "url": "https://<presigned original>", "thumbnailUrl": "https://<presigned thumbnail>" } } }
```

An album link (`GET /api/public/links/album`):

```json
{ "data": { "type": "album", "expiresAt": "2026-12-01T00:00:00.000Z", "itemCount": 2,
  "items": [ { "mediaType": "photo", "width": 4032, "height": 3024, "url": "...", "thumbnailUrl": "..." },
             { "mediaType": "video", "width": 1920, "height": 1080, "url": "...", "thumbnailUrl": null } ] } }
```

Nothing else: no album name, filename, description, tags, dates, location, camera, people, owner, internal id, bucket or storage key. `url` or `thumbnailUrl` is `null` when the driver cannot sign (or the item has no thumbnail).

---

## 7. EXIF / GPS Limitation

The presigned URL serves the **raw original file**. A JPEG with GPS in its EXIF headers carries it to the recipient; the no-metadata guarantee holds at the API/JSON layer only. File-level stripping would need a derived, stripped copy per shared item (sharp for images, an ffmpeg remux for videos) served instead of the original; it is not built. Advise users before sharing files with sensitive EXIF.

---

## 8. RBAC

| Permission | Scope | Granted to | Allows |
|------------|-------|-----------|--------|
| `sharing:read` | org | org_admin, contributor, viewer | list a record's links (with `share_link` on it) |
| `sharing:write` | org | org_admin, contributor | create, re-date, revoke links on records the caller may `share_link` |
| `sharing:admin` | org | org_admin (every administrator) | the admin page (`GET /api/admin/links`); `share_link` on every media item and album |

`shares:manage` and `shares:manage_any` are retired (migration `20261109100000_i4_media_shares_to_link_grants` deletes them): `sharing:write` and `sharing:admin` replace them, and `apps/api/test/rbac/permission-matrix.spec.ts` records the mapping. A `viewer` (system role) still cannot create links.

The public routes carry the identity slice's `@Public()` marker and `LinkGrantGuard`; the sharing conformance suite (`link-routes-guarded`) fails on a link route without the guard, a guarded route without the marker, or a type that lists no link role.

---

## 9. One 404 for every failure

`LinkGrantGuard` answers the same `404 Link not found` for a missing, malformed, unknown, revoked or expired token, a link of the other type, a role too weak for the route and a deleted or trashed record. Repeated failures from one address (`links.maxMissesPerIp`, default 30 in 10 minutes) answer `429` with `Retry-After`, even for a valid token. Every response, success or not, carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Without `SECRETS_ENCRYPTION_KEY`, link creation answers `503 LINKS_UNAVAILABLE`.

---

## 10. Archived and Trashed Items

- **Archived** items are served (archive is not a privacy control), alone or inside an album.
- A **trashed** media item is a missing record: its link answers 404 until it is restored.
- An album link lists only the album's **non-trashed** members, in album order (`addedAt`, then id).

---

## 11. Admin Management Page

`/admin/settings/sharing` (card permission `sharing:admin`, the string `GET /api/admin/links` enforces) lists every public link of the organization: preview, type, album item count, URL (copy; never exported to CSV), creator, expiry, status. Filters: status (active, expired, revoked) and type. Row and bulk actions: **revoke** (`DELETE /api/grants/:id` per link) and **set expiration** (`PATCH /api/grants/:id`). There is no hard delete.

`GET /api/admin/links` reads `grants` through `LinkGrantDirectory` (`apps/api/src/public-links/link-grant-directory.service.ts`), the one app file exempt from the sharing conformance suite's `no-direct-access`: read-only, link-only, in the default organization's RLS scope. `PLATFORM-ADOPTION-SHIM(#578)` until the slice offers an organization-wide link listing (seam request in `docs/platform-adoption/local-exceptions.md`).

---

## 12. Old links and the cutover from `media_shares`

Every `media_shares` row was imported as a link grant by `npm run sharing:import-media-shares --workspace=api -- --apply` (`apps/api/scripts/import-media-shares.ts`, logic in `src/legacy/media-shares-import.ts`) through the slice's `importLegacyToken`: role `viewer`, the target, the record's organization, `expiresAt`, `revokedAt`, `createdAt` and the creator kept, the token stored as `lnk_<old token>`. Revoked and expired shares were imported too. The import is idempotent and re-keys `share_expiring` stamps to the grant ids. Migration `20261109100000_i4_media_shares_to_link_grants` then dropped `media_shares` and `ShareTargetType`; it refuses to run while a share is not imported. Procedure: [circles-to-groups runbook §7](../runbooks/circles-to-groups.md#7-public-shares-to-link-grants-retro-i4).

An old URL is `/s/<token>` with the token in the PATH. The SPA route `/s/:token` (`LegacyShareRedirect`) does `window.location.replace('/s#lnk_<token>')`, and the public page resolves it like any link. The first request of an old link still carries its token in its path (and so in an access log), as it always did; revoke and re-share a link that must never have been logged.

The old API routes `GET /api/public/shares/:token` and `/:token/media/:idx` answer **410** with `details.reason: 'LEGACY_SHARE_ROUTE'` (decision 1 of #578) and log one line per hit, without the token, so stragglers can be counted. `/api/shares` (create, list, update, revoke, bulk) is gone.

---

## 13. API Reference

| Route | Auth | Notes |
|-------|------|-------|
| `GET /api/public/links/current` | public, `X-Link-Token` | the slice's resolution: resource type, id, role, expiry, title |
| `GET /api/public/links/media` | public, `X-Link-Token` (`media_item` links) | section 6 |
| `GET /api/public/links/album` | public, `X-Link-Token` (`album` links) | section 6 |
| `GET /api/public/shares/:token`, `/:token/media/:idx` | public | 410 `LEGACY_SHARE_ROUTE` |
| `POST`/`GET /api/grants/links`, `PATCH`/`DELETE /api/grants/:id` | `sharing:read` / `sharing:write` | the slice's (section 4) |
| `GET /api/admin/links?status&resourceType&page&pageSize` | `sharing:admin` | `{ items: [{ id, resourceType, resourceId, role, label, url, status, expiresAt, revokedAt, grantedById, grantedBy, createdAt, preview }], meta }` |

---

## 14. Web

- `/s` is the slice's `PublicLinkPage` (outside the shell), with `apiClient={appPlatformApi}`. The renderers `media_item` and `album` (`apps/web/src/platform/linkRenderers/`, registered and frozen in `main.tsx` before the first render) fetch the views above with the `x-link-token` header and show the pre-platform viewer and grid. Any failure shows "This link is not available".
- `/s/:token` is `LegacyShareRedirect` (section 12).
- Albums and memories share through `MediaShareDialog` (`platform/sharing/`): the slice's `ShareDialog` with `allowLinks`, `linkRoles: viewer` and expiries Never / 1 / 7 / 30 days. The media drawer and the lightbox keep an inline `LinkSharePanel` over `useLinkGrants`, because a dialog opened over a temporary drawer freezes in a nested focus trap.

---

## 15. Key Files

| Path | Role |
|------|------|
| `apps/api/src/app-registrations/sharing.ts` | the `media_item` / `album` resource types (link role, `share_link`, admin bypass) |
| `apps/api/src/public-links/public-media-link.controller.ts`, `public-album-link.controller.ts` | the guarded public views |
| `apps/api/src/public-links/public-link-view.service.ts` | reads in `withLinkScope`, strips metadata, signs URLs |
| `apps/api/src/public-links/legacy-public-share.controller.ts` | the 410s |
| `apps/api/src/public-links/admin-public-links.controller.ts`, `admin-public-links.service.ts`, `link-grant-directory.service.ts` | the admin listing (shim) |
| `apps/api/src/notification-producers/share-expiring.service.ts` | the `share_expiring` sweep over link grants |
| `apps/api/scripts/import-media-shares.ts`, `src/legacy/media-shares-import.ts` | the one-time import |
| `apps/api/prisma/migrations/20261109100000_i4_media_shares_to_link_grants/` | the contract migration (guarded) |
| `apps/web/src/platform/linkRenderers/` | the public renderers |
| `apps/web/src/platform/sharing/` | `MediaShareDialog`, `LinkSharePanel` |
| `apps/web/src/pages/Public/LegacyShareRedirect.tsx` | `/s/:token` |
| `apps/web/src/pages/Admin/PublicSharesPage.tsx` | the admin page |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 2026 | AI Assistant | Initial specification (`media_shares`, byte proxy) |
| 2.0 | November 2026 | AI Assistant | RETRO-I4 (#578): platform link grants, presigned URLs, legacy redirect and 410s, admin listing on `sharing:admin` |
