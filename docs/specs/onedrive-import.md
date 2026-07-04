# OneDrive Data Import — Design Specification

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | July 2026 |
| **Status** | Design (not yet implemented) |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Token Storage](#2-token-storage)
3. [Microsoft Graph Client](#3-microsoft-graph-client)
4. [Import Run / Item Domain Tables](#4-import-run--item-domain-tables)
5. [Import Job Handler](#5-import-job-handler)
6. [API Endpoints](#6-api-endpoints)
7. [Frontend](#7-frontend)
8. [Configuration / Environment Variables](#8-configuration--environment-variables)
9. [Security and Privacy](#9-security-and-privacy)
10. [What Is Reused vs. New](#10-what-is-reused-vs-new)
11. [Open Questions / Future Work](#11-open-questions--future-work)

---

## 1. Overview and Goals

OneDrive Data Import lets a user connect their personal Microsoft OneDrive account and pull photos and videos into MemoriaHub. Imported files flow through the **existing** ingest pipeline — `StorageObject` → `MediaItem` (via `MediaService.createMedia`) → enrichment (`MediaEnrichmentService.enqueueUploadEnrichment`) — so they get content-hash dedup, EXIF/metadata sync, auto-tagging, face detection, burst detection, duplicate detection, and location inference for free, identical to a CLI or web upload. There is no OneDrive-specific enrichment logic; OneDrive is purely a new *source* of bytes feeding the same pipe.

This mirrors the design of [Storage Provider Configuration](storage-providers.md) — a per-object copy job pattern with a run/item table pair driven by the enrichment queue — but for pulling bytes *in* from an external, per-user OAuth-gated source rather than moving bytes *between* two admin-configured storage backends.

### Goals

- Let an individual user (any system role) connect their own Microsoft account, without admin involvement per connection.
- Browse and select a OneDrive folder (optionally recursive) and a target MemoriaHub circle, then start a background import.
- Import bytes server-side — no browser upload, no client-side polling loop against Microsoft Graph.
- Reuse the enrichment queue's retry/backoff, priority, and rate-limit deferral machinery (see [Bulk Import Resilience](bulk-import-resilience.md)) rather than inventing a parallel retry mechanism.
- Give the user visibility into run progress (imported / failed / skipped counts) analogous to `GET /api/storage-settings/migrate/:runId`.
- Preserve file bytes exactly as stored in OneDrive, including embedded EXIF/GPS, so the existing metadata-extraction and geocoding pipeline can read it.

### Non-Goals

- Two-way sync: this is a one-time (or repeatable, manually-triggered) pull, not continuous bidirectional sync.
- Delta/incremental re-import in v1 (see [§11](#11-open-questions--future-work)).
- SharePoint document libraries or shared/team drives — personal OneDrive only in v1.
- A generalized "external connector" abstraction — this spec is OneDrive-specific; generalizing to Google Photos/Dropbox is future work.
- Browser-driven upload of OneDrive files (e.g. picking files client-side and re-uploading through the existing `/api/storage/objects` endpoints) — all transfer happens server-side.

---

## 2. Token Storage

### Why the existing credential tables don't fit

`AiProviderCredential`, `GeoProviderCredential`, and `StorageProviderCredential` (`apps/api/prisma/schema.prisma` lines ~651, ~1059, ~1103) all share the same shape: `provider String @unique`, one row per provider key, admin-managed, system-wide. That model is correct for "the Google Maps API key MemoriaHub uses for everyone," but wrong for "the OneDrive account *this specific user* connected." OneDrive Import needs a **per-user** credential, keyed by `userId`, not a global provider row.

### New model: `OneDriveConnection`

A new Prisma model, `OneDriveConnection`, stores exactly one active Microsoft connection per user:

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `userId` | UUID | FK → `users`, cascade delete; the MemoriaHub user who connected |
| `microsoftAccountId` | String | Microsoft `oid`/account identifier from the ID token, for display and account-switch detection |
| `microsoftEmail` | String | Display-only; the connected Microsoft account's email/UPN |
| `encryptedRefreshToken` | String | AES-256-GCM ciphertext of the OAuth refresh token — see below |
| `scopes` | String | Space-delimited granted scopes, e.g. `offline_access Files.Read User.Read` |
| `connectedAt` | DateTime | Set on first successful connect |
| `updatedAt` | DateTime | Auto-updated whenever the refresh token is rotated |

`@@unique([userId])` — one connection per MemoriaHub user in v1. (`@@unique([userId, microsoftAccountId])` is a plausible alternative if multi-account-per-user is wanted later, but v1 keeps it to one connection to keep the "disconnect" and "reconnect" UX simple — connecting a new account replaces the row.)

**Encryption:** the refresh token is encrypted with the existing `apps/api/src/common/crypto/secret-cipher.ts` helpers (`encryptSecret` / `decryptSecret`), which use AES-256-GCM keyed by `SECRETS_ENCRYPTION_KEY` — the identical key and cipher already used for AI, Face, Geo, and Storage provider secrets. No new encryption primitive is introduced.

**Access tokens are never persisted.** Microsoft access tokens are short-lived (typically ~1 hour) and are minted on demand from the stored refresh token immediately before each Graph call (or a batch of calls), then discarded. Only the refresh token — the thing that grants durable, revocable access — is stored, and only in encrypted form.

### Why the Google strategy can't be reused

`apps/api/src/auth/strategies/google.strategy.ts` implements login-only OAuth: its `validate(accessToken, refreshToken, profile, done)` method (lines ~44-45) receives both tokens from Passport but the doc comments explicitly note `accessToken`/`refreshToken` are "not used in our implementation" — they are discarded, and only the profile (`id`, `email`, `displayName`, `picture`) is carried forward to build the MemoriaHub session. This is correct for *authentication* (proving who the user is) but wrong for *authorization to call Graph on the user's behalf later*, which requires holding onto the refresh token. OneDrive Import therefore needs its own Microsoft OAuth strategy/controller flow that captures and persists the refresh token — it is a *data-access* grant, not a *login* grant, and the two are kept separate: connecting OneDrive does not change how the user logs into MemoriaHub, and disconnecting OneDrive does not log them out.

### Token refresh

Before any Graph API call, the import job handler (or the folder-browsing endpoint) loads the user's `OneDriveConnection`, decrypts the refresh token, and calls Microsoft's token endpoint to mint a fresh access token. If Microsoft returns a new refresh token in the response (rotation), the row's `encryptedRefreshToken` is updated in the same operation. If the refresh call fails with `invalid_grant` (revoked/expired), the connection is treated as broken — surfaced to the user as "reconnect required" rather than silently retried indefinitely.

---

## 3. Microsoft Graph Client

A new `MicrosoftGraphClient` service wraps the pieces of Microsoft Graph the feature needs. It does not attempt to be a general-purpose Graph SDK wrapper — only the four operations below.

### Authorization code → tokens

Standard OAuth 2.0 authorization-code exchange against Microsoft's `/oauth2/v2.0/token` endpoint (tenant `common` by default, so both personal Microsoft accounts and work/school accounts can connect). Scopes requested: `offline_access Files.Read User.Read` — `offline_access` is what makes Microsoft issue a refresh token at all; `Files.Read` is read-only (import never writes back to OneDrive); `User.Read` is used once, to populate `microsoftEmail`/`microsoftAccountId` for display.

### Access token refresh

Standard refresh-token grant against the same token endpoint. Handles rotated refresh tokens as described in [§2](#2-token-storage).

### Listing DriveItems

`GET /me/drive/root:/{path}:/children` (or `/me/drive/items/{id}/children` for a specific folder) lists files and subfolders. Responses are paged via `@odata.nextLink` — the client follows the link fully before returning, since folder enumeration happens once per import run (not per-request), and folder sizes in personal photo libraries are bounded enough that in-memory accumulation during enumeration is acceptable (this mirrors how `StorageMigrationHandler` accumulates one job per object rather than streaming the object list). Only image/video MIME types (via the `file.mimeType` facet, filtered client-side) are enqueued for import; other file types encountered during a recursive walk are counted as skipped, not imported.

### Downloading content

`GET /me/drive/items/{id}/content` returns a redirect to a pre-authenticated download URL; the client follows the redirect and streams the response body directly into the upload to the active MemoriaHub storage provider (via `StorageProviderResolver.getActiveProvider()`, the same resolver used by every other upload path) without buffering the whole file in memory where the storage provider's SDK supports streaming upload.

### Throttling

Microsoft Graph throttles with HTTP `429 Too Many Requests` and a `Retry-After` header (seconds). This is mapped onto the existing rate-limit deferral path documented in [Bulk Import Resilience](bulk-import-resilience.md):

- The Graph client throws a `RateLimitError` (matching the pattern already used by the Google Geocoding and Nominatim providers) when it observes a 429, carrying the `Retry-After` value.
- `classifyRateLimit` recognizes this and the enrichment worker routes the job through the `rateLimitHits` counter rather than the normal `attempts` counter — `scheduledFor` is set to the backoff window, and the job is retried automatically rather than failed outright.
- A new `ProviderThrottleService` throttle key, `onedrive`, is added to the job-type-to-throttle-key mapping (alongside `tagging`, `geocode`, `face`) so that a 429 on one per-item import job immediately backs off sibling `onedrive_import` jobs in the same run, rather than every concurrent worker independently hammering Graph until each individually trips.
- Unlike the OpenAI/Anthropic/geocoding cases, a single user's OneDrive throttle is scoped to that user's own Graph app registration quota — the coarse per-type gate is still a reasonable approximation because only one import run per user is expected to be active at a time (enforced at [§4](#4-import-run--item-domain-tables)).

---

## 4. Import Run / Item Domain Tables

Modeled directly on the `storage_migration_runs` / `storage_migration_items` pair ([Storage Provider Configuration §6](storage-providers.md#6-copy-only-migration-model)), substituting "OneDrive remote item" for "storage object being migrated."

### `OneDriveImportRun`

One row per import initiated by a user.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | Returned as `runId` in API responses |
| `userId` | UUID | FK → `users`; the user who started the import |
| `circleId` | UUID | FK → `circles`; the target circle for imported media |
| `remoteFolderPath` | String? | The OneDrive path/folder the run was scoped to; `null` = drive root |
| `recursive` | Boolean | Whether subfolders were walked |
| `status` | Enum | `pending` \| `running` \| `completed` \| `failed` \| `cancelled` |
| `totalCount` | Int | Number of eligible items discovered during enumeration |
| `startedAt` | DateTime? | Set when enumeration begins |
| `finishedAt` | DateTime? | Set when all items are terminal |
| `lastError` | String? | Error message from the last failed item, or an enumeration-level failure |

Counts (`importedCount`, `failedCount`, `skippedCount`) are **recomputed from item rows** on each detail read, following the same rationale as `storage_migration_runs`: avoiding denormalized counters that can drift under concurrent updates or a crashed job.

**One active run per user** is enforced at creation time (`POST /api/onedrive/import` returns 409 if the user already has a `pending`/`running` run) — this bounds the per-user Graph throttle concern in [§3](#3-microsoft-graph-client) and keeps the UI's "current import" concept unambiguous.

### `OneDriveImportItem`

One row per remote file discovered during enumeration.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `runId` | UUID | FK → `onedrive_import_runs`, cascade delete |
| `remoteItemId` | String | OneDrive DriveItem id |
| `remotePath` | String | Full path, for display and troubleshooting |
| `remoteName` | String | File name |
| `remoteSize` | BigInt | Byte size reported by Graph, for progress display; stored the same way large byte counts are elsewhere in this codebase — see the `perceptual_hash` TEXT-not-bigint gotcha in `CLAUDE.md` for why any *unsigned* 64-bit value would need TEXT instead, but Graph's reported size is a signed-safe file size well under 2^63 so a standard `BigInt`/`bigint` column is fine here |
| `status` | Enum | `pending` \| `running` \| `completed` \| `failed` \| `skipped` |
| `mediaItemId` | UUID? | FK → `media_items`, `SetNull` on delete; set on successful import (or on a dedup hit — see [§5](#5-import-job-handler)) |
| `lastError` | String? | Error message if status is `failed` |
| `createdAt` / `updatedAt` | DateTime | |

`@@unique([runId, remoteItemId])` — identical rationale to `storage_migration_items`' `@@unique([runId, objectId])`: re-enqueueing (e.g. after a worker restart) never creates duplicate item rows, and the handler's first step is always "is this item already `completed`? if so, no-op."

---

## 5. Import Job Handler

### Enrichment job type: `onedrive_import`

A new `EnrichmentHandler` implementation, `OneDriveImportHandler`, self-registers with `EnrichmentHandlerRegistry` in `onModuleInit()` — the identical bootstrap pattern used by `StorageMigrationHandler` (`apps/api/src/storage-settings/storage-migration.handler.ts:79`, `this.registry.register(this)`), conforming to the `EnrichmentHandler` interface (`readonly type: string`, `process(job: EnrichmentJob): Promise<void>`) defined in `apps/api/src/enrichment/enrichment-handler.interface.ts`.

Both `mediaItemId` and `circleId` on the `enrichment_jobs` row are set for per-item import jobs (the job is scoped to both a specific target circle and, once created, a specific media item) — unlike the global jobs in this codebase (`storage_insights`, `trash_purge`, `job_history_purge`) which leave both null.

### Two-phase flow

**Phase 1 — enumeration** happens synchronously inside `POST /api/onedrive/import` (or, for very large folders, could itself be deferred to a first "enumerate" job — v1 keeps it synchronous since Graph's paged listing is fast relative to the subsequent downloads, mirroring how `POST /api/storage-settings/migrate` computes `totalCount` synchronously before returning `{ runId, totalCount }`):

1. Resolve the target folder (`remoteFolderPath`, or drive root) via the Graph client.
2. Walk it (recursively if `recursive: true`) collecting eligible image/video `DriveItem`s.
3. Create one `OneDriveImportRun` row and one `OneDriveImportItem` row per eligible file, status `pending`.
4. Enqueue one `onedrive_import` enrichment job per item, `reason: 'backfill'`, priority left at the default foreground priority (this is a user-initiated, waited-for action, not a low-priority background sweep like `storage_migration`'s priority 100). Each job's payload is `{ runId, itemId, remoteItemId }`.
5. Each job sets `skipDedup: true` so the standard `(type, mediaItemId IS NULL)` global-job dedup does not collapse per-item jobs into one — identical rationale to `storage_migration`'s use of `skipDedup` — except here `mediaItemId` is null only transiently (before the `MediaItem` is created), so `skipDedup` matters for the same reason: many jobs of the same `type` must coexist.
6. Return `{ runId, totalCount }` to the caller immediately; phase 2 proceeds asynchronously via the enrichment worker.

**Phase 2 — per-item processing**, executed by `OneDriveImportHandler.process(job)` for each `onedrive_import` job:

1. **Guard: run cancelled?** Load the `OneDriveImportRun` row. If `cancelled`, mark the item `skipped` and return — no error, no retry. Identical semantics to `StorageMigrationHandler`'s cancel guard.
2. **Guard: already done?** If the `OneDriveImportItem` row is already `completed`, return immediately (idempotent no-op).
3. **Refresh access token** for `run.userId` via the Microsoft Graph client ([§3](#3-microsoft-graph-client)).
4. **Download** the file content from OneDrive.
5. **Upload** the bytes to the active MemoriaHub storage provider via `StorageProviderResolver.getActiveProvider()`, producing a `StorageObject` row exactly as any other upload path does.
6. **Register the MediaItem** by calling `MediaService.createMedia(...)` with:
   - `source: 'import'` — the `MediaSource` enum (`apps/api/prisma/schema.prisma` line ~444) already defines `web | cli | android | import | sync`; `'import'` is the exact value this feature needs with no enum change required.
   - `sourcePath`, `sourceDeviceId`, `sourceDeviceName` — `MediaItem` already carries these provenance columns (`apps/api/src/media/media.service.ts` ~lines 100-234, `dto.sourcePath ?? null` etc.); OneDrive Import populates `sourcePath` with the remote path and can use `sourceDeviceId`/`sourceDeviceName` to record the connected Microsoft account (e.g. `sourceDeviceName: 'OneDrive'`) for later filtering/debugging, without needing new schema.
   - `contentHash` computed from the downloaded bytes, so the existing `(circleId, contentHash)` dedup fast-path in `createMedia` applies automatically: a file already imported (or already uploaded via CLI/web) is detected as a dedup hit, the redundant blob is cleaned up, and the *existing* `MediaItem.id` is written back onto `OneDriveImportItem.mediaItemId` with the item marked `completed` (not `failed`) — a re-run of an import over the same folder is safe and cheap.
7. Because `createMedia` already calls `MediaEnrichmentService.enqueueUploadEnrichment(...)` synchronously before returning ([`CLAUDE.md`](../../CLAUDE.md), "Upload enrichment trigger"), auto-tagging/face detection/burst detection/duplicate detection/location inference jobs are enqueued automatically for the new item, gated by their existing global feature flags. **The `onedrive_import` handler does not need to enqueue any enrichment itself** — this is the entire point of routing import through `createMedia` rather than writing `MediaItem` rows directly.
8. Mark the `OneDriveImportItem` row `completed`, with `mediaItemId` set.

On any error, the handler re-throws (except for the explicit cancel/already-done no-ops in steps 1–2) so the enrichment worker applies the standard retry/backoff/rate-limit-deferral logic described in [Bulk Import Resilience](bulk-import-resilience.md) — no bespoke retry logic is written for this feature.

### Run status transitions

`OneDriveImportRun.status` moves `pending → running` when the first item job is claimed, and to `completed` once every item is terminal (`completed`/`failed`/`skipped`) with zero `failed` items, or `failed` if any items failed and the run reader surfaces that (mirroring `storage_migration_runs`, where the run-level terminal status is derived from item rows rather than tracked independently by the handler).

---

## 6. API Endpoints

Signatures and RBAC only — no request/response bodies beyond what is needed to convey shape; implementation is out of scope for this design doc.

| Method | Path | Permission | Description |
|--------|------|------------|--------------|
| `GET` | `/api/onedrive/auth/start` | `onedrive:connect` | Redirect to Microsoft's OAuth authorize endpoint; state carries the MemoriaHub user id |
| `GET` | `/api/onedrive/auth/callback` | `onedrive:connect` | OAuth callback; exchanges the code for tokens, upserts the caller's `OneDriveConnection` |
| `GET` | `/api/onedrive/connection` | `onedrive:connect` | Return the caller's connection status: `{ connected, microsoftEmail?, connectedAt? }` — never returns the refresh token |
| `DELETE` | `/api/onedrive/connection` | `onedrive:connect` | Disconnect: delete the caller's `OneDriveConnection` row; does not affect already-imported media |
| `GET` | `/api/onedrive/folders?path=` | `onedrive:connect` | List subfolders (and eligible file counts) under `path` for the folder picker, proxying Graph's children listing |
| `POST` | `/api/onedrive/import` | `onedrive:connect` | Body `{ circleId, remoteFolderPath?, recursive? }` → `{ runId, totalCount }`; requires the caller's per-circle `collaborator` role on `circleId`; 409 if the caller already has an active run |
| `GET` | `/api/onedrive/import/runs` | `onedrive:connect` | List the caller's own import runs, paginated |
| `GET` | `/api/onedrive/import/runs/:id` | `onedrive:connect` | Run detail with recomputed per-status item counts, mirroring `GET /api/storage-settings/migrate/:runId` |
| `POST` | `/api/onedrive/import/runs/:id/cancel` | `onedrive:connect` | Cancel a pending/running run; in-flight item jobs detect the cancellation and skip gracefully, matching the `storage_migration` cancel semantics |

### RBAC notes

`onedrive:connect` is proposed as a **new permission granted to all system roles** (Admin, Contributor, Viewer) — unlike every other credential-shaped permission in this codebase (`ai_settings:*`, `face_settings:*`, `geo_settings:*`, `storage_settings:*`), which are Admin-only because they configure a *system-wide* provider. OneDrive Import is fundamentally different: it is a personal data-import action analogous to using the CLI to upload one's own files, not an admin configuration surface. The permission exists mainly to provide a single toggle point (e.g. for a future deployment that wants to disable the feature for non-admins) rather than to gate it away from ordinary users by default.

Regardless of `onedrive:connect`, `POST /api/onedrive/import` still requires the caller to hold `collaborator` (or higher) on the target `circleId`, via the existing `CircleMembershipService.assertCircleAccess` check that every other media-creating endpoint uses (see `MediaService.createMedia`'s `assertCircleAccess(userId, dto.circleId, userPermissions, 'collaborator')` call) — a user cannot use their own OneDrive connection to write media into a circle they don't collaborate on.

---

## 7. Frontend

A new user-facing settings surface, **not** nested under `/admin/settings/*` (this is a personal integration, available to every user, unlike the admin-only provider pages it borrows layout patterns from):

- **Connection card** — composes the same "provider card with Test/Connect/Disconnect" visual pattern used by `apps/web/src/pages/Admin/StorageProvidersPage.tsx`'s provider cards, adapted to a single OAuth "Connect Microsoft Account" button (redirects to `GET /api/onedrive/auth/start`) plus a "Disconnect" action once connected, showing the connected `microsoftEmail`.
- **Folder picker + start import** — a simple breadcrumb/tree folder browser backed by `GET /api/onedrive/folders`, a target-circle selector (reusing whatever circle-picker component the existing Albums/Upload flows use), a "recursive" checkbox, and a "Start Import" button calling `POST /api/onedrive/import`.
- **Run progress view** — composes the same polling-list-plus-detail pattern used by `apps/web/src/pages/Admin/BackupPage.tsx` (run history list) and `apps/web/src/pages/Admin/JobsPage.tsx` (live status polling): a list of the user's runs with status chips, and a detail view for the active run showing imported/failed/skipped counts, refreshing on an interval while the run is `pending`/`running`.
- **Entry point** — since this is a personal feature rather than an admin one, it is reachable from the user's own settings area rather than `SettingsHubPage.tsx`'s admin-only sub-page grid; a small card can still optionally appear in the Settings hub for Admins who want visibility into whether the feature is enabled deployment-wide, but the primary entry point is user-facing.

---

## 8. Configuration / Environment Variables

| Variable | Default | Description |
|----------|---------|--------------|
| `MICROSOFT_CLIENT_ID` | — | Azure AD app registration's application (client) ID; required for the feature to function |
| `MICROSOFT_CLIENT_SECRET` | — | Azure AD app registration's client secret |
| `MICROSOFT_TENANT` | `common` | Azure AD tenant segment of the authorize/token URLs; `common` allows both personal Microsoft accounts and work/school accounts to connect |
| `MICROSOFT_OAUTH_REDIRECT_URI` | — | Must exactly match a redirect URI registered on the Azure AD app; typically `${APP_URL}/api/onedrive/auth/callback` |

An Azure AD (Microsoft Entra ID) app registration is required in the Azure Portal before this feature can be used in any environment, analogous to the Google Cloud OAuth client already required for login. The registration must request `offline_access`, `Files.Read`, and `User.Read` as delegated permissions.

**Feature flag:** `features.oneDriveImport` — boolean system setting, default `false`, following the exact pattern of `features.autoTagging`/`features.faceRecognition`/etc. When disabled, the connect/import endpoints return 400 and the frontend surface is hidden, without requiring the Azure AD credentials to be unset.

---

## 9. Security and Privacy

- **Refresh token encryption**: `OneDriveConnection.encryptedRefreshToken` uses the same AES-256-GCM cipher (`apps/api/src/common/crypto/secret-cipher.ts`) and the same `SECRETS_ENCRYPTION_KEY` as every other provider credential in this codebase. No new key material, no new cipher.
- **Access tokens are never persisted** — minted from the refresh token immediately before use and discarded after the Graph call(s) that need them. This bounds the blast radius of a database compromise to whatever the refresh token itself can do (which is already revocable from the user's Microsoft account security settings).
- **Per-user isolation**: `OneDriveConnection` and `OneDriveImportRun`/`OneDriveImportItem` are all keyed to `userId`. There is no cross-user listing endpoint — a user can only see and manage their own connection and runs. (An Admin-facing "which users have connected OneDrive" audit view is future work, not included in v1's endpoint list.)
- **Scope minimization**: only `Files.Read` is requested — the feature never writes to, renames, or deletes anything in the user's OneDrive. `offline_access` is requested solely to obtain a refresh token; `User.Read` is used once for display purposes.
- **EXIF/GPS preserved, not stripped**: bytes are copied byte-for-byte from OneDrive into MemoriaHub's storage, identical to how the CLI and web uploaders behave — any embedded EXIF (including GPS) survives the import and is then read by the existing metadata-extraction pipeline. This is consistent with the rest of the codebase's stance (see the Public Sharing spec's EXIF/GPS note) that MemoriaHub does not strip metadata from originals at upload/import time; only outbound-facing surfaces like public shares have their own (separate, already-documented) metadata-exposure contract.
- **Disconnection does not retroactively affect imported media** — deleting the `OneDriveConnection` row only prevents future imports; `MediaItem`s already created from a prior import are ordinary MediaItems indistinguishable from any other upload source once created (aside from the `source='import'` provenance tag).
- **Token refresh failure handling**: an `invalid_grant` response from Microsoft (revoked consent, expired refresh token) marks the connection as needing reconnection rather than being retried indefinitely by the enrichment worker — the job fails with a clear `lastError` message (e.g. "OneDrive connection expired — please reconnect") rather than burning through `ENRICHMENT_MAX_ATTEMPTS` silently.

---

## 10. What Is Reused vs. New

| Component | Reused | New |
|---|---|---|
| Secret encryption (AES-256-GCM, `SECRETS_ENCRYPTION_KEY`) | `apps/api/src/common/crypto/secret-cipher.ts` (`encryptSecret`/`decryptSecret`) | — |
| Ingest pipeline (dedup, metadata sync, enrichment enqueue) | `MediaService.createMedia`, `MediaEnrichmentService.enqueueUploadEnrichment`, `MediaMetadataSyncService` | — |
| Active storage provider resolution | `StorageProviderResolver.getActiveProvider()` | — |
| Enrichment queue, retry/backoff, rate-limit deferral | `EnrichmentHandler` interface, `EnrichmentHandlerRegistry`, `EnrichmentJobWorker`, `classifyRateLimit`, `RateLimitError` | New throttle key `onedrive` added to `ProviderThrottleService`'s job-type mapping |
| Run/item table pattern | Modeled on `storage_migration_runs`/`storage_migration_items` | New tables `OneDriveImportRun`/`OneDriveImportItem` |
| Credential storage pattern | Same encrypted-secret shape as `AiProviderCredential`/`GeoProviderCredential`/`StorageProviderCredential` | New **per-user** table `OneDriveConnection` (existing credential tables are all system-wide, one row per provider — wrong shape for a personal OAuth grant) |
| OAuth login flow | — (deliberately NOT reused; `GoogleStrategy.validate()` discards tokens by design) | New Microsoft OAuth authorization-code flow that captures and stores the refresh token |
| `MediaSource` enum value | `MediaSource.import` already exists in `schema.prisma` | — |
| `MediaItem` provenance columns | `sourcePath`, `sourceDeviceId`, `sourceDeviceName` already exist | — |
| Admin settings page visual patterns | Card layout borrowed from `StorageProvidersPage.tsx`; run-history/progress polling borrowed from `BackupPage.tsx`/`JobsPage.tsx` | New user-facing (non-admin) settings surface |
| RBAC permission | — | New permission `onedrive:connect`, granted to all system roles (not Admin-only, unlike every existing `*_settings:*` permission) |
| Feature toggle pattern | Same shape as `features.autoTagging` etc. | New `features.oneDriveImport` system setting |
| Microsoft Graph client | — | New `MicrosoftGraphClient` service: auth-code exchange, token refresh, paged listing, content download |
| Import job handler | Self-registration pattern from `StorageMigrationHandler.onModuleInit()` | New `OneDriveImportHandler`, enrichment type `onedrive_import` |

---

## 11. Open Questions / Future Work

- **Delta sync / incremental re-import.** v1 always performs a full folder walk. Microsoft Graph supports a delta query API (`/me/drive/root/delta`) that returns only items changed since a stored delta token — a future version could store a per-connection (or per-folder) delta token and offer "check for new photos" without re-walking the whole tree. Note that content-hash dedup already makes a naive full re-walk *safe* (re-imported files are detected as dedup hits and marked `completed` without creating duplicate `MediaItem`s) — delta sync would be a performance optimization, not a correctness fix.
- **SharePoint / shared and team drives.** v1 scopes to `/me/drive` (the user's personal OneDrive) only. Supporting `sites.read.all`-scoped shared libraries would need a drive-selection step before the folder picker and a broader consent scope.
- **Generalizing into a common external-connector interface.** If a future Google Photos or Dropbox importer is built, the run/item table pair, the enrichment-job-per-file fan-out, and the "download → upload to active provider → `createMedia`" phase-2 flow described in [§5](#5-import-job-handler) are all provider-agnostic in shape. A shared `ExternalImportHandler` base (parameterized by a small `RemoteFileSource` interface: list, download, throttle-classify) could reduce duplication across connectors rather than each provider re-implementing its own run/item tables and handler from scratch. This spec deliberately does not attempt that abstraction up front — OneDrive is the first and only connector, and premature generalization before a second concrete implementation exists would guess at the wrong seams.
- **Multiple OneDrive accounts per user.** The `@@unique([userId])` constraint on `OneDriveConnection` means connecting a second Microsoft account replaces the first. If demand emerges for importing from more than one Microsoft account, relaxing to `@@unique([userId, microsoftAccountId])` and adding an account-selector to the UI is a straightforward follow-up.
- **Admin visibility.** There is no admin-facing dashboard of which users have connected OneDrive or how many imports have run, unlike every other backfill/migration surface in this codebase, which is Admin-only by construction. If usage monitoring becomes necessary (e.g. to bound Graph API cost across all users), a read-only Admin aggregate view could be added without changing the per-user data model.
