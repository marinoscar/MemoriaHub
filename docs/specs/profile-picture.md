# Profile Picture Management — Feature Spec

| Field | Value |
|-------|-------|
| **Issue** | #354 |
| **Version** | 1.0 |
| **Last Updated** | August 2026 |
| **Status** | Implemented (schema, backend, and frontend all landed) |

---

## Table of Contents

1. [Problem](#1-problem)
2. [Data Model](#2-data-model)
3. [The Single-Writer Service](#3-the-single-writer-service)
4. [Avatar Delivery](#4-avatar-delivery)
5. [Derivative Rendering](#5-derivative-rendering)
6. [API Surface](#6-api-surface)
7. [Person Link Semantics](#7-person-link-semantics)
8. [Resolving the Two-Sources-of-Truth Divergence](#8-resolving-the-two-sources-of-truth-divergence)
9. [Frontend](#9-frontend)
10. [First Installation / Empty Database](#10-first-installation--empty-database)
11. [Known Gaps / Limitations](#11-known-gaps--limitations)
12. [Document History](#12-document-history)

---

## 1. Problem

Before #354, "profile picture" was four separate, mostly-broken pieces that never added up to a working feature:

- **`User.profileImageUrl` was a dead column.** The schema already had the correct two-tier shape — a `profileImageUrl` override column alongside `providerProfileImageUrl` — and `AuthService.getCurrentUser` already read `profileImageUrl ?? providerProfileImageUrl` (override-then-provider). But nothing anywhere in the codebase ever WROTE `profileImageUrl`. The override half of a working two-column design existed in the schema and the read path and nowhere else — there was no way for a user to ever populate it.
- **Two disconnected sources of truth.** `user_settings.profile.{useProviderImage, customImageUrl}` was a real, writable pair — the Settings UI let a user toggle `useProviderImage` and (nominally) set `customImageUrl` — but `GET /api/auth/me` read only the two `User` columns above, never `user_settings`. Flipping the toggle changed a JSONB blob nobody downstream ever consulted; the displayed avatar was unaffected by design of the read path, not by a bug in it.
- **The upload endpoint never existed.** `ImageUpload.tsx` POSTed to `/api/users/profile-image` with an inline comment noting the endpoint "would need to be implemented." It never was. Every upload attempt was a 404.
- **No account↔person link at all.** There was no way to say "this recognized Person is me," and therefore no way to ever use a face-recognized picture as an avatar.

The net effect: the only avatar a user could ever actually see was whatever their OAuth provider returned at signup, permanently, with three pieces of dead UI surface area pretending otherwise.

## 2. Data Model

Migration `20260810010000_add_user_avatar_source_and_person_link`. One enum, four additive columns, one FK, one index — no backfill.

```prisma
enum UserAvatarSource {
  oauth
  upload
  person
}

model User {
  // ... existing columns ...
  profileImageUrl         String?          @map("profile_image_url")
  providerProfileImageUrl String?          @map("provider_profile_image_url")

  avatarSource             UserAvatarSource @default(oauth) @map("avatar_source")
  avatarStorageKey         String?          @map("avatar_storage_key")
  avatarVersion            String?          @map("avatar_version")
  linkedPersonId           String?          @map("linked_person_id") @db.Uuid

  linkedPerson             Person?          @relation("UserLinkedPerson", fields: [linkedPersonId], references: [id], onDelete: SetNull)

  @@index([linkedPersonId])
}
```

- **`avatarSource`** — where the *active* picture comes from: the OAuth provider (default, unchanged from pre-#354 behavior), an uploaded image, or the linked Person's picture.
- **`avatarStorageKey`** — the storage key of the rendered 512×512 JPEG, non-null only when `avatarSource` is `upload` or `person`.
- **`avatarVersion`** — a random cache-buster token, regenerated on every render (§4).
- **`linkedPersonId`** — a nullable self-service FK to `people.id`, `ON DELETE SET NULL`. A hard-deleted Person never blocks or cascades into the `users` row — the same nullable-FK precedent already used elsewhere in this schema (e.g. `burst_groups.suggested_best_item_id`). The index follows the existing convention of indexing every FK.

**Additive-only, no backfill warranted.** Every existing row is correctly represented by the defaults: `avatarSource: 'oauth'`, and the three derived columns null. A pre-#354 user simply resolves to the OAuth branch of §3's resolution table, which is exactly the behavior they already had.

**The load-bearing decision is that `User.profileImageUrl` is now the MATERIALIZED, resolved avatar URL** — not a user-supplied override anymore, but the *output* of `UserAvatarService`'s resolution logic, written back to the column on every state change (§3). This is what makes the feature propagate for free: `AuthService.getCurrentUser`, `CirclesService.listMembers`, and the admin users table all already select `profileImageUrl`. None of those three consumers changed for #354 — they simply started reading a column that is now actually kept current.

## 3. The Single-Writer Service

`UserAvatarService` (`apps/api/src/users/user-avatar.service.ts`) is the **only** code path that writes `avatarSource`, `avatarStorageKey`, `avatarVersion`, `linkedPersonId`, or `profileImageUrl`. This mirrors the existing `UserSettingsService.syncDisplayName` precedent — the sole writer of `User.displayName` — and exists for the same reason: a single write path is what makes "the materialized column can never drift from the state that produced it" an enforceable invariant rather than a convention every future caller has to remember.

Every one of those five columns is written through one private method, `writeAvatarState`: it reads the current row, applies the patch **in memory**, resolves `profileImageUrl` from the **post-patch** result, and writes the patch plus the freshly-resolved URL in the same `prisma.user.update` call. `profileImageUrl` is therefore never set from stale state — it is always a pure function of the columns it is written beside.

### 3.1 Resolution table

`resolveAvatarUrl` is the pure function `writeAvatarState` calls on every write, and it is also the fallback `getProfile` uses for a legacy row this service has never touched:

| `avatarSource` | Condition | Resolved URL |
|---|---|---|
| `upload` or `person` | `avatarStorageKey` set | `/api/users/{id}/avatar?v={avatarVersion}` |
| `oauth` | — | `providerProfileImageUrl` (may be `null`) |
| `upload` or `person` | `avatarStorageKey` **not** set | `null` |

The last row covers a derived source with no stored bytes yet — a reset that raced a render, or a legacy row — and deliberately resolves to `null` rather than a URL that would 404; the frontend's contract for a `null` `avatarUrl` is to render initials, never a broken image.

### 3.2 What this service does NOT touch

`AuthService.handleLogin`'s OAuth refresh writes only the `provider*` columns (`providerProfileImageUrl`, `providerDisplayName`) on every login, and it is unchanged by #354 — it never touches `avatarSource`/`avatarStorageKey`/`profileImageUrl`. An `oauth`-sourced user simply resolves to whatever `providerProfileImageUrl` currently holds; a user who has switched to `upload` or `person` keeps seeing their chosen picture through every subsequent login, because the OAuth refresh was never in the business of clobbering a user's choice — it just used to be irrelevant, since nothing consumed the override column it wasn't writing to.

`displayName` writes are explicitly **delegated**, not duplicated: `UpdateProfile`'s `displayName` field is forwarded to `UserSettingsService.patchSettings({ profile: { displayName } })`, whose `syncDisplayName` remains the one place that writes `User.displayName`. `UserAvatarService` never writes that column itself — doing so would create a second writer of a column that already has one, the exact failure mode the single-writer rule exists to prevent.

## 4. Avatar Delivery

`GET /api/users/:id/avatar` streams the stored bytes through an authenticated byte-proxy rather than a signed storage URL — a deliberate choice for two independent reasons, not one:

1. **A signed URL carries a TTL** (24h elsewhere in this codebase, e.g. thumbnail signing), while `profileImageUrl` is a static column read by `auth/me`, circle member lists, and the admin users table. A URL that expires after 24 hours is not something a plain, rarely-rewritten column can hold — every consumer would need to know to re-fetch it, and none of them do.
2. **More importantly: the alternative already in use elsewhere in this app — hand the client a signed URL to the ORIGINAL photo and crop it client-side in CSS, which is exactly what the People page's face-crop rendering does today — would give every viewer of a circle member list full-resolution access to a photo from a circle they may not even belong to.** An avatar is visible to anyone who can see the user in a member list, which is a much wider audience than "everyone who can see the source photo." Serving only the pre-rendered, already-cropped 512×512 square, through a route that never reveals a storage URL or the source media item's id, makes that leak structurally impossible rather than a policy the client has to honor.

The route is authenticated (any role, no new permission) and self-contained: `Content-Type: image/jpeg`, `X-Content-Type-Options: nosniff`, and `Cache-Control: private, max-age=31536000, immutable`. The `immutable` + one-year cache is safe specifically because `avatarVersion` is regenerated on every render (§3.1, §5) — the URL embeds a `?v=` token that changes with the bytes, so a stale browser cache is never actually stale; it just means the URL that would serve fresher bytes is a different URL. This is the same cache-buster pattern already used for thumbnail signing elsewhere in the codebase, applied here to a static (not time-limited) URL.

A `404` from this route means "no stored avatar" — correct for an `oauth`-sourced user, whose picture lives on the provider's CDN and was never proxied through this route in the first place.

## 5. Derivative Rendering

Every avatar — whether uploaded or rendered from a Person — normalizes to exactly **one** artifact: a square **512×512 JPEG at quality 85**, stored at `avatars/{userId}/{uuid}.jpg`.

- **EXIF is auto-oriented, then STRIPPED.** `prepareImageForProcessing` applies EXIF orientation upstream (the standard pipeline entry point for any image processing in this codebase); `renderAvatarJpeg` then re-encodes without `withMetadata()`, deliberately dropping the EXIF block — including GPS — from the output. An uploaded phone photo's GPS coordinates must not leak through an avatar that every member of every circle the user shares can fetch. This mirrors the intentional EXIF-stripping already documented for public media shares, except here it is unconditional rather than a stated limitation.
- **The `StorageObject` row is created directly at `status: 'ready'`, explicitly NOT via `ObjectsService.simpleUpload`.** `simpleUpload` emits `OBJECT_UPLOADED_EVENT`, which would drag the avatar through the entire media processing pipeline — content hashing, thumbnail generation, a second EXIF extraction pass, perceptual hashing, dedup matching. An avatar is not a media item: it has no `MediaItem` row, appears in no gallery, and must never enter a review queue (burst, duplicate, or otherwise). Writing `status: 'ready'` directly also keeps these rows out of `StorageProcessingRecoveryTask`'s stuck-at-`processing` sweep, which would otherwise eventually "recover" an object that was never broken.
- **The `avatars/` key prefix must never become an input to the media processing pipeline** — the same recursion-guard concern that already applies to the `thumbnails/` prefix in `ThumbnailProcessor`. Nothing currently enumerates storage keys by prefix into that pipeline, but the constraint is documented here because a future change that does (a bulk reprocess sweep, a migration tool) must exclude both prefixes for the same reason.
- **The old object is deleted on replace.** `storeAndAdopt` uploads the new bytes, adopts them via `writeAvatarState`, and only then reaps whatever `avatarStorageKey` used to point at — so an account accumulates at most one avatar object at a time, never a growing trail of superseded ones. The delete is strictly best-effort (logged, never thrown): a failed cleanup leaves a cheap orphan object, whereas failing the request would leave the user unable to change their picture.
- **`position: 'attention'` vs. `'centre'`.** `sharp`'s `.resize(512, 512, { fit: 'cover', position })` needs to know which part of a non-square source to keep. An arbitrary uploaded photo has no known subject, so it uses `'attention'` — sharp's saliency heuristic, which on a typical uploaded photo is nearly always the face. A crop the user explicitly chose (the profile-crop dialog result, or a Person's `profileCrop`/cover-face bounding box) uses `'centre'` instead — re-deciding the framing here would silently move a crop the user (or the face detector) already picked.

## 6. API Surface

All six routes live on `UserProfileController`, sharing the `users` prefix with the existing `UsersController`. Every handler carries a bare `@Auth()` — authenticated, any role, **no permission** — because a user's own profile picture is inherently personal; there is nothing an Admin-gated permission would protect on a resource that is, by construction, always the caller's own. This is the same least-privilege rationale already used for `GET /api/features` and the Notification Center's routes. The bare `@Auth()` is load-bearing, not decorative: this codebase has no `APP_GUARD`, so an undecorated handler would be publicly reachable.

**Route ordering note:** `UserProfileController` is registered *before* `UsersController` in `UsersModule`'s `controllers` array, so the literal `me` path segment is matched before `UsersController`'s `@Get(':id')`/`@Patch(':id')` (which sit behind a `ParseUUIDPipe` and would otherwise try — and fail — to parse `"me"` as a UUID). Fastify's radix router already prefers static segments over parametric ones, so this ordering is belt-and-braces rather than strictly required, but it is the documented, load-bearing convention for anyone adding a future route under `users/`.

| Method | Path | Description | Status |
|---|---|---|---|
| `GET` | `/api/users/me/profile` | Current user's profile: `displayName`, resolved `avatarUrl`, `avatarSource`, `providerProfileImageUrl`, `linkedPerson`. | 200 |
| `PATCH` | `/api/users/me/profile` | Partial update of `displayName` / `linkedPersonId` / `avatarSource`; every field independent (§7). | 200, 400 (avatar source unavailable), 404 (person not found/visible) |
| `POST` | `/api/users/me/avatar` | Multipart upload (max 5 MB); auto-oriented, EXIF-stripped, centre-cropped to 512×512 JPEG; sets `avatarSource: 'upload'`. | 201, 400 (missing/oversized/undecodable) |
| `POST` | `/api/users/me/avatar/from-person` | Re-render from the currently linked Person; sets `avatarSource: 'person'`. | 201, 400 (no link, or person has no usable picture) |
| `DELETE` | `/api/users/me/avatar` | Reset to the OAuth picture; sets `avatarSource: 'oauth'`; KEEPS the person link (§7). | 200 |
| `GET` | `/api/users/:id/avatar` | Byte-proxy for the derived avatar JPEG (§4). | 200, 404 (no stored avatar) |

### 6.1 Upload limits and validation

`POST /api/users/me/avatar` overrides the global `@fastify/multipart` limit (100 MB, sized for media uploads) down to a per-request 5 MB cap via `req.file({ limits: { fileSize: AVATAR_MAX_UPLOAD_BYTES }, throwFileSizeLimit: false })`. `throwFileSizeLimit: false` is deliberate: the plugin's default behavior makes `toBuffer()` reject with its own `RequestFileTooLargeError` — a plain `Error`, not an `HttpException`, which Nest's default filter would turn into an opaque 500. Opting out surfaces a `data.file.truncated` flag instead, letting the controller answer a proper 400 naming the limit; the read itself stays bounded either way, since busboy stops feeding the stream once the limit is hit.

The client-supplied `Content-Type` (checked against `AVATAR_ALLOWED_MIME_TYPES`: JPEG, PNG, WebP, GIF, HEIC, HEIF) is only a cheap pre-filter. The authoritative check is that `sharp` (via `prepareImageForProcessing`, with its HEIC/HEIF-decode and ffmpeg-transcode fallback already documented elsewhere in this codebase) decodes the bytes into a non-zero-dimension image — a client cannot fake that by lying about `Content-Type`.

## 7. Person Link Semantics

### 7.1 Validation and the 404-not-403 policy

`PATCH /api/users/me/profile { linkedPersonId }` validates the target Person via `CircleMembershipService.assertCircleAccess(userId, person.circleId, permissions, CircleRole.viewer)` — the caller must at least be a viewer of the circle the Person lives in. Every failure mode — the person id does not exist, the person is soft-deleted, or the caller cannot see the person's circle — collapses to a single **404**, never a 403. A 403 would confirm that the id names a real Person in a circle the caller cannot see, which is exactly the enumeration this codebase's public-share and notification routes also refuse to allow (`assertPersonLinkable` explicitly catches the `CircleMembershipService` rejection and rethrows as `NotFoundException`).

### 7.2 Source-image fallback ladder

`renderPersonAvatar` builds the 512×512 JPEG from a Person in strict preference order, falling through to the next tier whenever a source turns out to be unusable (a trashed media item, a video with no saved representative frame, undecodable bytes):

1. **The Person's explicitly chosen profile picture** — `profileMediaItemId` + `profileCrop` (the same fields the People page's own profile-picture picker writes), cropped with `position: 'centre'` since the user already told the app what the subject is.
2. **The resolved cover face** — `coverFaceId` if set, else the highest-confidence face on the person (`confidence DESC, createdAt DESC`), matching `PeopleService.pickCoverFace`'s own `coverFace ?? faces[0]` selection. A video-sourced face reuses its already-saved representative-frame JPEG (`frameThumbnailKey`) directly rather than re-decoding the source video; a photo-sourced face is cropped via the shared `buildFaceCropThumbnail` helper (the same one the video face pipeline uses, accepted as a second encode rather than re-implementing face-padding math as a second source of truth).
3. **Nothing usable** — a `400` with an actionable message: *"This person has no profile picture or detected face yet. Set one on the People page first."*

### 7.3 Re-render triggers

The avatar is re-rendered from a Person at exactly three moments:

- **On link**, when the same `PATCH` that sets `linkedPersonId` does not also carry an explicit `avatarSource` — i.e. linking a person, with nothing else specified, is treated as the moment the picture becomes available and therefore also the moment it is adopted. An explicit `avatarSource` in the same request wins over this implicit behavior, so the service never renders bytes only to discard them a step later.
- **On explicit request**, via `POST /api/users/me/avatar/from-person`.
- **Best-effort, fire-and-forget, whenever `PeopleService.updatePerson` changes the person's chosen profile picture** (`profileMediaItemId` or `profileCrop`). `PeopleService.refreshAvatarsForPerson` is called after the person row is written; it finds every `avatarSource: 'person'` user linked to that person and re-renders each one, swallowing and logging every failure — the person update must never fail because an avatar happened to fail to re-render, the same posture this codebase already applies to its notification producers. Only `avatarSource: 'person'` accounts are touched: a linked user currently displaying an upload or the OAuth picture has not adopted the person's picture, so there is nothing to refresh for them.

### 7.4 Merge carry-over

`PeopleService.mergePeople` carries every account link from the merged-away (source) Person onto the merge target, via `UserAvatarService.carryLinkedUsersOnMerge` — called from *inside* the merge's transaction, in the same step order as the existing `coverFaceId` carry-over, so a link can never survive a rolled-back merge. The already-rendered avatar bytes need **no** re-render as part of this: the avatar's URL addresses the *user*, not the person, so it stays valid regardless of which Person record now backs it — which is also why neither `profileImageUrl` nor `avatarVersion` is touched by the carry-over.

### 7.5 Reset keeps the link — the critical nuance

`DELETE /api/users/me/avatar` (reset to the OAuth picture) deliberately **keeps** `linkedPersonId`. "This Person is me" is a fact that stays true regardless of which picture happens to be displayed — the link and the displayed picture are two independent statements, and conflating them would force a user who wants to temporarily go back to their Google photo to also throw away the fact that they'd identified themselves in the family circle. Unlinking is a **separate, explicit** action: `PATCH /api/users/me/profile { linkedPersonId: null }`. That unlink, symmetrically, does **not** touch the currently-displayed picture — the already-rendered bytes remain a perfectly good avatar even after the link that produced them is gone.

## 8. Resolving the Two-Sources-of-Truth Divergence

Before #354, `user_settings.profile.useProviderImage` / `customImageUrl` were real, writable settings that nothing downstream ever read (§1). #354 resolves the divergence in favor of the new `User` columns:

- **The columns win, unconditionally.** `avatarSource`/`avatarStorageKey`/`avatarVersion`/`linkedPersonId`, written only by `UserAvatarService`, are now the single source of truth for what a user's avatar is and where it comes from.
- **The two `user_settings.profile` keys are kept on the wire, not removed.** `PATCH /api/user-settings` still accepts `profile.useProviderImage` and `profile.customImageUrl` in its Zod schema — but both are now documented, no-op deprecated fields: nothing in the API reads them for anything. This is a deliberate compatibility choice, not an oversight — removing the keys from the schema would turn any old client (or a stale browser tab that hasn't picked up the new frontend yet) still sending them into a hard 400, where keeping them as accepted-but-ignored costs nothing and preserves a graceful transition.
- **No data migration was warranted**, and this is worth stating explicitly rather than leaving as an implicit gap: `customImageUrl` could only ever have been populated by an upload flow that never worked (§1) — there is no scenario in which a production row holds a real, meaningful value in that key. Migrating "nothing that was ever real" is not a migration; it is a no-op dressed up as one.

Anywhere `user_settings` is described elsewhere in this codebase's documentation, `profile.useProviderImage` and `profile.customImageUrl` should be marked `@deprecated (issue #354)`, pointing readers at `User.avatarSource` and `GET`/`PATCH /api/users/me/profile` instead.

## 9. Frontend

- **`/profile`** (`apps/web/src/pages/Profile/ProfilePage.tsx`) is the new home for everything the `/settings` Profile card used to half-own: the display name, and an explicit three-way avatar SOURCE selector (`ToggleButtonGroup`: Google picture / Upload an image / My linked person), replacing the old mutually-ignorant settings pair. Every mutation returns the whole refreshed profile — local state is *replaced* from the server response rather than patched optimistically — and is followed by `refreshUser()` so the top-bar avatar updates in the same tick as the page itself.
- **The upload flow is picked file → object URL → crop step → blob → `POST`.** `AvatarCropDialog` wraps `react-easy-crop` in a fixed square aspect, rendering the chosen crop rectangle client-side into a 512×512 canvas (quality 0.92 JPEG) before the network call — so a 12 MP phone photo and a small existing thumbnail both leave the browser as the same-shaped upload, comfortably inside the API's 5 MB cap regardless of the source resolution. (The service-side `renderAvatarJpeg` still runs its own resize/encode pass on arrival — a deliberate, cheap redundancy: the API can never trust a client-side crop as the final word on output shape, and re-deriving it server-side is what actually enforces the 512×512/JPEG-85 contract in §5.)
- **`LinkedPersonCard`** (`apps/web/src/components/user/LinkedPersonCard.tsx`) is the person picker, and it distinguishes **three genuinely different empty states** rather than collapsing them into one "nothing here":
  1. **Face recognition is off globally** — sourced from `GET /api/features` (authenticated, any role) via `useFeatureFlags()`, deliberately **not** `GET /api/system-settings` (Admin-gated, would 403 for the ordinary circle member this page mostly serves — see the `GET /api/features` rationale in the main API surface). Renders an admin-linked call-to-action for an Admin viewer, a plain "ask an administrator" message otherwise.
  2. **Enabled, but no people detected yet** — an info alert pointing at "upload photos and MemoriaHub will detect faces automatically."
  3. **People exist** — the actual `Autocomplete` picker, grouped by circle (active circle first), each option rendering a `PersonAvatar` + face count.
  A fourth, un-numbered case — zero circle memberships — is handled the same way rather than left to spin forever; see §10.
- **The authenticated-image constraint.** `GET /api/users/:id/avatar` is a bearer-guarded byte proxy, so a bare `<img src="/api/users/…/avatar">` renders broken — the browser sends no `Authorization` header on an `<img>` fetch. `useAuthedImage` (`apps/web/src/hooks/useAuthedImage.ts`) is the general-purpose fix: it fetches the URL with the token attached (single-retry-on-401 refresh, mirroring `ApiService.request`), hands back a revocable `URL.createObjectURL` blob URL, and passes non-API URLs (the OAuth provider's absolute `https://` picture, a `blob:`/`data:` URI) straight through untouched. Every avatar-rendering surface in the app — `ProfilePage`, the reduced `ProfileSettings` summary card — goes through this hook rather than a plain `src`.
- **`ProfileSettings`** (`apps/web/src/components/settings/ProfileSettings.tsx`) is now a *read-only* summary card on `/settings`: avatar, name, email, and a single "Manage profile picture" button linking to `/profile`. It deliberately renders neither `useProviderImage` nor `customImageUrl` — those keys are dead (§8), and the avatar's source is first-class `User` state now, not a settings blob this card would need to interpret.

## 10. First Installation / Empty Database

Nothing about a fresh install changes: `avatarSource` defaults to `oauth` and all four new columns are nullable/defaulted, so day-one behavior is byte-for-byte identical to pre-#354 — every user resolves through the `oauth` branch of §3.1's table, exactly as before this feature existed.

Two edge cases are explicitly handled rather than left to accidentally work:

- **The bootstrap `INITIAL_ADMIN_EMAIL` admin, or any user, may have a `providerProfileImageUrl` of `null`** — Google does not guarantee a profile picture on every account. `resolveAvatarUrl`'s `oauth` branch already tolerates this (`providerProfileImageUrl ?? null`), and the frontend's contract for a `null` `avatarUrl` is to degrade to initials (§3.1) — never a broken `<img>`.
- **A user with zero circle memberships** — exactly what `TestAuthService` creates for a fresh test user, and a legitimate state for any brand-new signup before they create or join a circle — must render a real empty state in `LinkedPersonCard` rather than an endless spinner or a thrown error. The component checks `circles.length > 0` before ever issuing a `listPeople` call and renders a dedicated "you are not a member of any circle yet" alert with a link to `/circles` (§9).

## 11. Known Gaps / Limitations

- **v1 supports exactly one `linkedPersonId` per user, and that Person may live in *any* circle the user belongs to** — but `Person` records are themselves circle-scoped, so the same human has a **distinct** `Person` row in every circle they appear in (a family circle and a separate friend-group circle each cluster and recognize that person independently). A user genuinely present across multiple circles can therefore only ever link to *one* of their per-circle Person records, not "the concept of me across every circle I'm in." A full cross-circle identity model would need a `user_person_links` join table (one user to many per-circle Person rows) rather than a single scalar FK. This was deliberately deferred rather than built speculatively; the current column can be superseded by such a join table later without breaking the resolved-URL contract in §2, since `profileImageUrl` is a materialized output, not something any other feature reads `linkedPersonId` through directly (yet — see below).
- **Admin management of other users' avatars or links is out of scope.** Every route in §6 is self-scoped to the caller's own JWT `userId`; there is no admin-facing "set this user's avatar" or "unlink this user's person" surface, and none was requested by the issue.
- **`linkedPersonId` is not (yet) consumed by any downstream feature.** It exists purely to drive this feature's own avatar rendering. Using it to power something like "photos of me" filtering, Memories personalization, or notification targeting is plausible future work but was explicitly not part of #354's scope, and no such consumer exists in the codebase today.
- **No avatars for circles or albums.** This feature is user-avatar-only; circles and albums have no analogous picture concept, and none was added.
- **A user left at `avatarSource: 'person'` whose linked Person is later hard-deleted keeps serving the last-rendered bytes.** Hard-deleting a `Person` nulls `linkedPersonId` via the FK's `ON DELETE SET NULL`, but it does **not** touch `avatarStorageKey`/`avatarSource`/`profileImageUrl` — those columns are only ever written by `UserAvatarService`, and a Person hard-delete happens entirely outside that service. The practical effect: `getProfile`'s `linkedPerson` field reports `null` (§ the DTO's own documentation of this — `describeLinkedPerson` returns `null` for both a soft-deleted and a hard-deleted-and-FK-nulled link), which is exactly the signal `LinkedPersonCard` uses to offer a re-link, while the avatar itself keeps rendering whatever was last successfully stored. This is a deliberate "degrade gracefully, never silently blank the picture" choice, not an oversight: the alternative — reactively clearing the avatar the instant its source Person disappears — would punish the user with a sudden blank avatar for an event (someone else merging or deleting a Person record) they may have had no part in.

## 12. Document History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | August 2026 | AI Assistant | Initial specification, documenting the shipped issue #354 implementation: the four verified pre-existing defects, the `UserAvatarSource` data model and additive-only migration, the single-writer `UserAvatarService` and its resolution table, the byte-proxy delivery rationale (two independent reasons), the one-artifact 512×512 JPEG rendering pipeline and its recursion-guard/EXIF-stripping details, the six-route API surface and its RBAC posture, person-link validation/fallback/re-render/merge/reset semantics, the deprecation of `user_settings.profile.{useProviderImage,customImageUrl}`, the frontend surface and its three-empty-state person picker, first-installation behavior, and known v1 gaps |
