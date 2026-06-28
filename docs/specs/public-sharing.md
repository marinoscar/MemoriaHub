# Public Media Sharing — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | June 2026 |
| **Status** | Implemented |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Data Model](#2-data-model)
3. [Token Generation and Share URL](#3-token-generation-and-share-url)
4. [Share Lifecycle — Expiry and Revocation](#4-share-lifecycle--expiry-and-revocation)
5. [Byte-Proxy Rationale](#5-byte-proxy-rationale)
6. [Metadata-Stripping Contract](#6-metadata-stripping-contract)
7. [EXIF / GPS Limitation](#7-exif--gps-limitation)
8. [RBAC](#8-rbac)
9. [Enumeration-Resistant 404 Policy](#9-enumeration-resistant-404-policy)
10. [Archived and Trashed Item Handling](#10-archived-and-trashed-item-handling)
11. [Admin Management Page](#11-admin-management-page)
12. [API Endpoints Reference](#12-api-endpoints-reference)
13. [Key Files](#13-key-files)

---

## 1. Overview and Goals

Public Media Sharing lets authenticated circle collaborators and admins publish a single media item or an entire album to an unauthenticated public URL. Anyone with the URL can view the content in a browser — no login required.

### Goals

- Allow users to share individual photos/videos or whole albums with people who are not MemoriaHub members.
- Protect private circle content by sharing only what the owner explicitly publishes.
- Keep storage URLs private by proxying bytes through the API rather than handing out signed storage URLs.
- Expose no metadata in the public response (no filename, no EXIF fields, no location data from the JSON layer).
- Support optional time-bounded expiration and immediate soft-revocation.
- Give admins a single management page to review and act on all active shares.

### Non-Goals

- File-level EXIF stripping is not performed; raw bytes are proxied as-is (see [§7](#7-exif--gps-limitation)).
- There is no view-count or access-log feature.
- Public shares are not scoped per-circle; any share with a valid token is globally accessible once created.

---

## 2. Data Model

### Table: `media_shares`

Added in migration `20260628130000_add_media_shares`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `token` | String (unique) | Random URL-safe slug used in the public URL path |
| `target_type` | Enum `ShareTargetType` | `media_item` \| `album` |
| `media_item_id` | UUID? | FK → `media_items` (CASCADE DELETE); non-null when `target_type = 'media_item'` |
| `album_id` | UUID? | FK → `albums` (CASCADE DELETE); non-null when `target_type = 'album'` |
| `circle_id` | UUID | FK → `circles` (CASCADE DELETE); denormalized for RBAC and listing |
| `created_by_id` | UUID? | FK → `users` (SET NULL on user delete) |
| `expires_at` | DateTime? | Null = never expires; non-null = UTC expiry timestamp |
| `revoked_at` | DateTime? | Null = active; non-null = soft-revoked at this timestamp |
| `created_at` | DateTime | |
| `updated_at` | DateTime | |

### XOR Constraint

A CHECK constraint on the table enforces that exactly one of `media_item_id` and `album_id` is non-null:

```sql
CHECK (
  (media_item_id IS NOT NULL AND album_id IS NULL) OR
  (media_item_id IS NULL     AND album_id IS NOT NULL)
)
```

This constraint is enforced at the database level in addition to application-level validation.

### Cascade Behavior

- Deleting a `media_items` row cascades to delete its `media_shares` rows.
- Deleting an `albums` row cascades to delete its `media_shares` rows.
- Deleting a `circles` row cascades to delete all shares in that circle.
- Deleting a `users` row sets `created_by_id` to null (SET NULL) — the share is preserved.

---

## 3. Token Generation and Share URL

The `token` column is a cryptographically random URL-safe string generated at share creation time. It is the sole authentication credential for the public endpoints — possession of the token grants access.

The public URL follows the pattern:

```
https://<app-host>/s/<token>
```

The frontend route `/s/:token` renders `PublicSharePage` (no auth wrapper, no Layout). The page calls `GET /api/public/shares/:token` to fetch metadata, then renders the media inline using `GET /api/public/shares/:token/media/:idx` as the image/video `src`.

`POST /api/shares` returns the `publicUrl` in the response body alongside the share record so the caller can copy or display it immediately.

---

## 4. Share Lifecycle — Expiry and Revocation

A share is **active** when all of the following are true:

1. `revoked_at IS NULL`
2. `expires_at IS NULL OR expires_at > now()`
3. The target (media item or album) exists and is not trashed (`deleted_at IS NULL`)

### Expiration

`expires_at` is nullable. Passing `null` (or omitting it) on create means the share never expires. An expiry can be updated at any time via `PATCH /api/shares/:id`. Passing `null` in the patch body clears an existing expiry, making the share permanent again.

Expiry is evaluated at request time on the public endpoints. There is no background job to expire shares; an expired share returns a 404 response identical to a revoked or missing share.

### Soft Revocation

`DELETE /api/shares/:id` performs a **soft revoke** — it sets `revokedAt` to the current timestamp and returns 204. The row is not deleted from the database, which preserves the audit trail (who created it, when it was revoked). The public endpoint returns 404 for revoked shares.

### Hard Delete (Bulk)

`POST /api/shares/bulk` with `action: 'delete'` hard-deletes the specified share rows. This is available to admins only (`shares:manage_any`) and is the only path that permanently removes a share record.

### Idempotent Create

`POST /api/shares` is idempotent for the same `(circleId, targetType, targetId)` combination. If an active share already exists for the target, the existing share is returned along with its `publicUrl` rather than creating a duplicate. Revoked and expired shares do not count as existing for this purpose — a new share is created, generating a fresh token.

---

## 5. Byte-Proxy Rationale

The public byte-serving endpoint (`GET /api/public/shares/:token/media/:idx`) streams file bytes through the API rather than redirecting to a signed storage URL. This design choice is intentional.

### Why Proxy Instead of Signed URL Redirect

| Concern | Signed URL Redirect | Byte Proxy |
|---------|---------------------|------------|
| Storage URL exposure | URL is sent to the browser | Never exposed |
| Storage provider lock-in visible to clients | Yes (S3/R2 hostname in URL) | No |
| Ability to enforce revocation immediately | No (signed URL remains valid until TTL) | Yes (checked on each request) |
| Range request support for video | Depends on provider config | Implemented in handler |
| Caching headers | Provider-controlled | API-controlled |

The proxy path reads the storage object using `StorageProviderResolver.getProviderFor(...)`, streams the bytes to the HTTP response, and sets the following security headers on every response:

- `Content-Disposition: inline` — prevents browsers from triggering a file download.
- `X-Content-Type-Options: nosniff` — prevents MIME-type sniffing.
- `Referrer-Policy: no-referrer` — prevents the public URL from appearing in `Referer` headers sent to third-party resources loaded by the share page.

Video files additionally honor the `Range` request header, returning `206 Partial Content` so browser video players can seek without downloading the entire file.

The `?variant=thumb` query parameter instructs the handler to serve the thumbnail instead of the full-resolution file. Album grids use this variant to show cover images without downloading originals.

---

## 6. Metadata-Stripping Contract

The public metadata endpoint (`GET /api/public/shares/:token`) returns **only** the fields needed to render the viewer. No filename, EXIF data, creation date, circle name, uploader, or tag information is returned.

### Media Item Response

```json
{
  "type": "media_item",
  "media": {
    "mediaType": "image",
    "width": 3024,
    "height": 4032
  }
}
```

### Album Response

```json
{
  "type": "album",
  "itemCount": 12,
  "items": [
    { "mediaType": "image", "width": 3024, "height": 4032 },
    { "mediaType": "video", "width": 1920, "height": 1080 }
  ]
}
```

The `width` and `height` values are included so the frontend can reserve layout space before bytes load. No other metadata is returned.

---

## 7. EXIF / GPS Limitation

The byte-proxy streams the **raw original file** from storage. It does not decode or strip embedded metadata before sending.

As a result:

- A JPEG file containing GPS coordinates in its EXIF headers will have those coordinates present in the bytes sent to the recipient.
- The JSON response from `GET /api/public/shares/:token` contains no location fields, but someone who downloads the raw bytes (e.g. via browser DevTools or `curl`) can read the EXIF data using any standard EXIF tool.

This limitation is documented explicitly because it means the no-metadata guarantee is enforced only at the **API/JSON layer**, not at the file-bytes layer.

### How to Add File-Level Stripping (Future Work)

If file-level EXIF stripping is required, the proxy handler should pipe the byte stream through the processing pipeline in `apps/api/src/storage/processing/` before sending it to the HTTP response. The `image-orientation.util.ts` helper already decodes and re-encodes images for orientation normalization; EXIF stripping can be implemented as an additional step using the same `sharp` pipeline, passing `{ withMetadata: false }` or equivalent.

Video files would require a separate approach (e.g. ffmpeg remux without metadata streams).

Until file-level stripping is implemented, admins should advise users to be aware of this limitation before sharing files that contain sensitive EXIF data.

---

## 8. RBAC

### System Permissions

| Permission | Granted To | Allows |
|------------|------------|--------|
| `shares:manage` | Contributor + Admin | Create shares, list own shares, update expiration on own shares, revoke own shares |
| `shares:manage_any` | Admin only | All `shares:manage` actions plus: list all shares (`scope=all`), manage any user's shares, bulk operations |

### Per-Circle Role Requirement for Create

`POST /api/shares` additionally asserts that the caller is a **collaborator or circle_admin** in the target circle. Viewers cannot create public shares even if they hold `shares:manage`. This follows the same pattern as other write operations on circle content.

### Super-Admin Bypass

Admins holding `circles:manage_any` bypass per-circle role checks on all operations, including share creation. This is consistent with the super-admin bypass documented for other circle-scoped features.

### Public Endpoints

`GET /api/public/shares/:token` and `GET /api/public/shares/:token/media/:idx` are decorated `@Public()` — they do not require a JWT and perform no authentication check. Authorization is implicit in token possession.

---

## 9. Enumeration-Resistant 404 Policy

The public endpoints return identical `404 Not Found` responses for all non-serving conditions:

- Token does not exist in the database.
- Share is soft-revoked (`revokedAt IS NOT NULL`).
- Share has expired (`expiresAt IS NOT NULL AND expiresAt <= now()`).
- Target media item is trashed (`deletedAt IS NOT NULL`).
- Target album is deleted (row does not exist — cascade removed the share).

The response body and HTTP status code are identical in all cases. This prevents attackers from using response differences to determine whether a token was ever valid, whether it was revoked, or whether the target still exists.

Revoked and expired shares are never distinguished from "not found" in public responses.

---

## 10. Archived and Trashed Item Handling

### Archived Items

Archived items (`archivedAt IS NOT NULL`) **are served** via public share. Archive hides items from browse surfaces within the authenticated app but does not prevent public access. If a user archives an item that has an active public share, the share continues to work.

This is a deliberate design decision consistent with the archive semantics defined in the [Archive & Trash Bin spec](archive-trash.md): archive is a visibility filter for authenticated users, not an access revocation mechanism. If a user wants to stop public access to an archived item, they must explicitly revoke the share.

### Trashed Items

Trashed items (`deletedAt IS NOT NULL`) **are not served**. Attempting to access a public share whose target media item is trashed returns the standard enumeration-resistant 404. This is consistent with the principle that trashed items are logically deleted and should not be accessible.

For album shares, trashed member items are **silently excluded** from both the metadata response (`itemCount` reflects only non-trashed members) and byte-proxy responses. If all items in a shared album are trashed, the album metadata returns `{ itemCount: 0, items: [] }` and index-based byte requests return 404.

Hard-deleting a media item or album row cascades the `media_shares` row away via the database FK, so no "zombie" share rows accumulate for deleted targets.

---

## 11. Admin Management Page

A standalone admin page at `/admin/settings/sharing` (reachable from the Settings hub Operations group) provides full share visibility and control for users holding `shares:manage_any`.

### Features

- Paginated list of all shares across the app, filterable by status (`active`, `revoked`, `expired`) and target type (`media_item`, `album`).
- Per-row actions: set/clear expiration, revoke, hard-delete.
- Bulk selection with bulk actions: revoke selected, set expiration on selected, hard-delete selected.

The page is backed by:
- `GET /api/shares?scope=all&...` for listing.
- `PATCH /api/shares/:id` for single-row expiration updates.
- `DELETE /api/shares/:id` for single-row revoke.
- `POST /api/shares/bulk` for bulk operations.

---

## 12. API Endpoints Reference

### Authenticated Management Endpoints

All require JWT Bearer token.

| Method | Path | Permission | Per-Circle Role | Description |
|--------|------|------------|-----------------|-------------|
| `POST` | `/api/shares` | `shares:manage` | collaborator | Create or return existing share; idempotent per target |
| `GET` | `/api/shares` | `shares:manage` | — | List shares; `scope=all` requires `shares:manage_any` |
| `PATCH` | `/api/shares/:id` | `shares:manage` (own) / `shares:manage_any` | — | Update `expiresAt`; `null` = never expires |
| `DELETE` | `/api/shares/:id` | `shares:manage` (own) / `shares:manage_any` | — | Soft-revoke share; 204 No Content |
| `POST` | `/api/shares/bulk` | `shares:manage_any` | — | Bulk revoke / set-expiration / hard-delete |

### Public Endpoints (No Authentication)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/public/shares/:token` | Validate share; return metadata-stripped representation |
| `GET` | `/api/public/shares/:token/media/:idx` | Byte-proxy for media file; supports `?variant=thumb`; video supports Range |

### Request / Response Examples

**Create a share:**
```json
POST /api/shares
{
  "targetType": "media_item",
  "mediaItemId": "uuid-of-media-item",
  "expiresAt": "2026-12-31T23:59:59Z"
}
```
```json
{
  "share": {
    "id": "uuid",
    "token": "abc123xyz",
    "targetType": "media_item",
    "expiresAt": "2026-12-31T23:59:59.000Z",
    "revokedAt": null,
    "createdAt": "2026-06-28T13:00:00.000Z"
  },
  "publicUrl": "https://app.example.com/s/abc123xyz"
}
```

**Public metadata response (media item):**
```json
GET /api/public/shares/abc123xyz
{
  "type": "media_item",
  "media": { "mediaType": "image", "width": 3024, "height": 4032 }
}
```

---

## 13. Key Files

| Path | Role |
|------|------|
| `apps/api/src/share/share.module.ts` | NestJS module wiring |
| `apps/api/src/share/share.service.ts` | Share CRUD, idempotent create, revocation, bulk ops |
| `apps/api/src/share/share.controller.ts` | Authenticated management endpoints (`/api/shares`) |
| `apps/api/src/share/public-share.controller.ts` | Public endpoints (`/api/public/shares`); decorated `@Public()` |
| `apps/api/prisma/migrations/20260628130000_add_media_shares/` | Database migration adding `media_shares` table |
| `apps/web/src/pages/Public/PublicSharePage.tsx` | Unauthenticated public viewer; no Layout/auth wrapper |
| `apps/web/src/components/ShareDialog.tsx` | Share creation dialog in media detail drawer and album menu |
| `apps/web/src/pages/Admin/PublicSharesPage.tsx` | Admin management page at `/admin/settings/sharing` |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 2026 | AI Assistant | Initial specification matching shipped implementation |
