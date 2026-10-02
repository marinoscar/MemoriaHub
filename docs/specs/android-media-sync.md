# Android Media Sync (feature spec and contract)

> **Status:** specified, implementation in progress (epic #498; this document is #501) · **Code (planned):** `apps/android/`, `apps/api/src/media-sync/`, `apps/api/src/android-app/`, `apps/api/src/storage/`, `apps/api/src/doctor/`, `apps/web/src/pages/MediaSyncPage.tsx`, `apps/web/src/pages/AndroidAppDownloadPage.tsx`, `apps/web/src/pages/Admin/AndroidAppPage.tsx`, `apps/cli/src/android/` · **API:** `/api/media-sync/*`, `/api/android-app/*`, `/api/admin/android-app/*`, `/api/well-known/assetlinks.json` (see `/api/docs`) · **UI:** `/settings` (Android app panel), `/settings/android-app`, `/settings/media-sync`, `/admin/settings/android` · **Architecture:** [native-companion-architecture.md](native-companion-architecture.md) · **Supersedes:** [android-sync.md](android-sync.md) (the retired v1 app)

The MemoriaHub Android app backs up a phone's photos and videos to a MemoriaHub circle in the background. It is the MemoriaHub PWA in a Trusted Web Activity plus a small native Kotlin "Media Sync" module that reads MediaStore, keeps a per-file ledger, and uploads resumably. The server is the hub: the web and the phone's native screens edit a versioned **desired config**; the phone pulls it on every check-in and reports counts, runs and diagnostics back. **This document is the single contract every sub-issue of epic #498 builds against.** Where it disagrees with an issue body, this document wins; every such case is listed in [section 22](#22-decisions).

## Table of contents

1. [Purpose and requirements](#1-purpose-and-requirements)
2. [Identity](#2-identity)
3. [Architecture and ownership](#3-architecture-and-ownership)
4. [Data model](#4-data-model)
5. [Desired config and commands](#5-desired-config-and-commands)
6. [API contract](#6-api-contract)
7. [Pairing](#7-pairing)
8. [The device ledger](#8-the-device-ledger)
9. [Upload sequence and resume](#9-upload-sequence-and-resume)
10. [Scheduling and background rules](#10-scheduling-and-background-rules)
11. [Permissions](#11-permissions)
12. [Native UI map](#12-native-ui-map)
13. [Diagnostics](#13-diagnostics)
14. [Release model](#14-release-model)
15. [Web surfaces](#15-web-surfaces)
16. [RBAC and security](#16-rbac-and-security)
17. [Error codes](#17-error-codes)
18. [Observability](#18-observability)
19. [Configuration](#19-configuration)
20. [Doctor](#20-doctor)
21. [Guardrails and issue map](#21-guardrails-and-issue-map)
22. [Decisions](#22-decisions)
23. [Non-goals](#23-non-goals)
- [Appendix A: Notes salvaged from the legacy app](#appendix-a-notes-salvaged-from-the-legacy-app)

## 1. Purpose and requirements

- **What it is.** An optional sideloaded Android app that:
  - renders the MemoriaHub PWA full screen (no URL bar, brand status and navigation bars, splash) in a TWA;
  - uploads photos and videos from selected phone folders, in the background, resumably, in constant memory;
  - exposes native screens (pairing, folders, network policy, file list, diagnostics) that the web cannot provide, reachable by long-pressing the launcher icon;
  - can be downloaded, configured, monitored and updated from MemoriaHub itself.
- **What it is not.** Not on Google Play, not iOS, not a two-way sync (deleting on the phone never deletes on the server), not a second client with its own business rules.

### 1.1 User capabilities (acceptance for the epic)

| # | Capability | Where it is delivered |
|---|---|---|
| 1 | Download the APK from the user settings page | `/settings/android-app`, signed download link ([section 6.5](#65-android-app-trusted-apps-assetlinks-releases)) |
| 2 | Configure sync from settings, including inside the app: choose folders, **Wi-Fi only** or **Wi-Fi and mobile data** | Desired config ([section 5](#5-desired-config-and-commands)), `/settings/media-sync`, native Folders and Network screens |
| 3 | Track which files are synced and retry failures | Room ledger ([section 8](#8-the-device-ledger)), native Files screen, web counts and `failedSample` |
| 4 | Upload very large files: resumable multipart, constant memory | [Section 9](#9-upload-sequence-and-resume) |
| 5 | Automatic retry with backoff, plus manual retry of one file, all failed, or blocked files | [Sections 8.4](#84-backoff-and-blocking) and [9.5](#95-failure-classification) |
| 6 | See how many files are synced and how many are still missing | `stats` in the check-in; Hub card; web tiles ([section 8.5](#85-statistics)) |
| 7 | Stop and start syncing | `config.paused` through commands ([section 5.4](#54-commands)) |
| 8 | Run in the background; a new photo or video in a selected folder triggers a sync | [Section 10](#10-scheduling-and-background-rules) |

### 1.2 evopath experience parity (hard requirements)

- **The PWA renders natively in the TWA:** brand colours, splash, maskable icons, Digital Asset Links verification so no URL bar appears.
- **First-run Setup screen** asks for the server URL ("Save and open"); the URL can also be baked in at build time.
- **Long-press the app icon for shortcuts:** *Media sync* (the hub, where the phone is paired through the device flow in a Custom Tab), *Diagnostics* (the self-test), and dynamic *Sync now* and *Pause/Resume*.
- **Hub** top to bottom: Update card, Server, Pairing, Media sync card (counts, Start/Stop, Sync now, Folders, Network, Files, Diagnostics, health line), Open MemoriaHub, version footer ([section 12.3](#123-hub)).
- **Diagnostics screen:** summary counts and "Run self-test", check rows each with a fix action, per-folder inventory, recent runs, live log, Sync now, Upload report, Share report, Copy to clipboard, Reset local sync state ([section 13](#13-diagnostics)).
- **Download from the website** through a signed link so the Android installer opens.
- **CLI push (core):** `memoriahub android release` bumps, builds, verifies, publishes and marks the release current; the phone then shows an Update card and the web shows `AndroidUpdateBanner` inside the TWA ([section 14](#14-release-model)).

## 2. Identity

| Name | Value | Notes |
|---|---|---|
| Product name | `MemoriaHub` | App label |
| `applicationId` (release) | **`memoriahub.marin.cr`** | **All lowercase.** Package names are case-sensitive in `assetlinks.json` and everywhere else; never re-cased |
| `applicationId` (debug) | `memoriahub.marin.cr.debug` | `applicationIdSuffix ".debug"`; a different package, so it needs its own trusted-signer entry and is never offered the release as an update |
| Kotlin namespace and source package | `memoriahub.marin.cr` | `app/src/main/java/memoriahub/marin/cr/` |
| Deep-link scheme | `memoriahub` | Already accepted by `sanitizeReturnUri` (`memoriahub:` or `https:`) |
| Storage prefix | `memoriahub` | Shared-preference and database file prefix: `memoriahub_config`, `memoriahub_secure`, `memoriahub_sync.db` |
| Theme colour | `#1976d2` | Must equal `THEME_COLOR` in `apps/web/pwa/manifest.ts` |
| Background colour | `#ffffff` | Must equal `BACKGROUND_COLOR` in `apps/web/pwa/manifest.ts` |
| APK stem | `memoriahub-android` | Build output `dist/android/memoriahub-android-<versionName>.apk`; download file name `memoriahub-android-<versionName>.apk` |
| Min / compile / target SDK | 26 / 36 / 36 | Java 17 |
| User agent | `MemoriaHub-Android/<versionName>` | |

`apps/android/identity.properties` is the source of truth:

```properties
productName=MemoriaHub
applicationId=memoriahub.marin.cr
deepLinkScheme=memoriahub
storagePrefix=memoriahub
themeColor=#1976d2
backgroundColor=#ffffff
apkStem=memoriahub-android
```

- These values are mirrored in `apps/web/src/utils/androidIdentity.ts` (`ANDROID_PACKAGE_NAME`, `ANDROID_DEEP_LINK_SCHEME`, `MEDIA_SYNC_DEEP_LINK = 'memoriahub://media-sync'`, `mediaSyncDeepLink(path?, action?)`, `androidApkFileName(versionName)`). A web unit test reads `identity.properties` and compares them.
- **Versioning.** `apps/android/version.properties` holds `versionName=2.0.0` and `versionCode=100`. The Gradle properties `-Papp.versionName` and `-Papp.versionCode` override them (the CLI passes these). The build fails unless `versionCode` is in `1..2,100,000,000`. `versionCode` only increases.
- **The legacy v1 app** was `cr.marin.memoriahub`: a **different package**. A phone can have both installed and both would upload. Users uninstall v1 manually; the download page and the runbook say so.

## 3. Architecture and ownership

```
┌──────── Phone ──────────────────────────────────────────────┐
│ TWA (Chrome, full-screen PWA)    Native "Media Sync" module  │
│  /settings/media-sync ──deep link memoriahub://media-sync──► │ Compose hub: pairing, folders,
│  ?source=twa&appVersion=… ◄── launch URL ───────────────────  │  network, files, diagnostics
│                                  WorkManager: periodic +     │
│                                  content-URI trigger + now   │
│                                  Room ledger (files, runs)   │
│                                  EncryptedTokenStore (pat_)  │
└───────┬──────────────────────────────────┬──────────────────┘
   JWT (web session)                 PAT (Bearer pat_)
        ▼                                  ▼
  /api/media-sync/devices/*   ◄── server = hub ──►  /api/storage/objects/upload/* → object storage parts
  PATCH config (desired)                            POST /api/media (source=android, sourceDeviceId)
  GET status / runs / diagnostics                   POST /devices/:id/checkin (stats+inventory+run → config)
  /api/android-app/releases/*, /.well-known/assetlinks.json
```

- **Native stack** mirrors evopath: AGP 8.13.x, Kotlin 2.2.x, Jetpack Compose (BOM 2025.10.x), `androidbrowserhelper` 2.6.x, `work-runtime-ktx` 2.10.x, `security-crypto` 1.1.0, OkHttp 4.12, kotlinx.serialization 1.9, plus Room 2.7.x (KSP) for the ledger. Tests: JUnit 4 and MockWebServer. **No Hilt or Dagger**: manual lazy singletons in `MobileApplication` and an interface at every seam (`MediaGateway`, `SyncScheduling`, `NetworkPolicy`, `TokenStore`, a clock) so the logic runs on the JVM.
- **Credential.** A `pat_` minted through the RFC 8628 device flow with `clientInfo.tokenType: 'pat'`, stored in `EncryptedSharedPreferences`. The device row links `patId`. Re-pairing revokes the old PAT; unpairing revokes the current one.
- **Source of truth per file** is the phone's Room ledger. The server stores aggregates and a bounded sample of failures. Server idempotency is the existing `(circle_id, content_hash)` dedup on `POST /api/media`.
- **Permissions model.** Ordinary RBAC: `media:read` / `media:write`, plus the per-circle `collaborator` role on the target circle. Release administration uses `system_settings:read` / `system_settings:write`. **No new permission and no new environment variable.**

## 4. Data model

One migration, `<ts>_add_android_app_and_media_sync` (#502). Prisma fields are camelCase and map to snake_case columns and tables with `@map`/`@@map` (the repo convention). `BigInt` columns are serialized as **strings** in every API response (the BigInt gotcha in CLAUDE.md); a test JSON-serializes a real response.

### 4.1 Enums

| Enum | Values |
|---|---|
| `MediaSyncDeviceStatus` | `active`, `revoked` |
| `MediaSyncTrigger` | `periodic`, `content_trigger`, `manual`, `app_open`, `initial` |
| `MediaSyncRunStatus` | `ok`, `partial`, `failed`, `skipped`, `paused` |

### 4.2 `AndroidAppRelease` → `android_app_releases`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid | |
| `packageName` | text | `memoriahub.marin.cr` (case-sensitive) |
| `versionName` | VarChar(50) | `/^[0-9A-Za-z][0-9A-Za-z._+-]*$/` |
| `versionCode` | Int | `1..2,100,000,000`; unique per package |
| `signingSha256` | text | Signer certificate SHA-256, **uppercase colon form** (`AA:BB:…`, 32 bytes) |
| `fileSha256` | Char(64) | Lowercase hex of the APK bytes |
| `sizeBytes` | BigInt | Serialized as a string |
| `storageKey` | text | `android-releases/<releaseId>.apk` |
| `storageProvider`, `bucket` | text? | The provider and bucket the bytes were written to, so a later provider switch keeps old releases downloadable (same precedent as `StorageObject.storageProvider` and the db-backup recorded provider) |
| `notes` | VarChar(2000)? | |
| `isCurrent` | Boolean, default false | At most one current release deployment-wide |
| `uploadedById` | FK users, SetNull | |
| `createdAt` | timestamptz | |

- `@@unique([packageName, versionCode])`.
- **Raw-SQL partial unique index** (intentional schema drift, written by hand in the migration; never "fix" it with `@@unique`, never replace it with a `findFirst` pre-check): `CREATE UNIQUE INDEX "android_app_releases_one_current_uniq_idx" ON "android_app_releases" ((true)) WHERE "is_current";`. A comment above the model explains the drift, as for the other raw-SQL indexes.
- APKs are **not** `storage_objects` rows. They live under `android-releases/` (`ANDROID_RELEASES_KEY_PREFIX`) in the active storage provider.

### 4.3 `MediaSyncDevice` → `media_sync_devices`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid | Also the value of `sourceDeviceId` on media items |
| `userId` | FK users, Cascade | Owner |
| `installationId` | uuid | Generated once per install; survives unpair so re-pairing reuses the row |
| `name` | VarChar(100) | |
| `manufacturer?`, `model?`, `androidVersion?`, `sdkInt?` | | Reported at registration |
| `appVersion?`, `appVersionCode Int?` | | Reported at registration and on every check-in |
| `packageName?` | text | `memoriahub.marin.cr` or `….debug`; never re-cased |
| `signingSha256?` | text | Reported signer, uppercase colon form; informational only |
| `timezone?` | text | IANA zone, display only |
| `patId?` | FK personal_access_tokens, SetNull | The linked PAT |
| `status` | `MediaSyncDeviceStatus`, default `active` | |
| `config` | Json | Desired config ([section 5](#5-desired-config-and-commands)) |
| `configVersion` | Int, default 1 | Bumped on every successful config PATCH or command |
| `appliedConfigVersion` | Int, default 0 | Last version the phone reported applying |
| `inventory` | Json? | Folder list last reported by the phone |
| `stats` | Json? | Counts last reported |
| `permission?` | `full` \| `partial` \| `denied` | |
| `networkState?` | `wifi` \| `cellular` \| `none` | |
| `batteryOptimized?` | Boolean | |
| `lastSeenAt?`, `lastSyncAt?` | timestamptz | `lastSyncAt` is the last run's `finishedAt` |
| `lastSyncStatus?` | `MediaSyncRunStatus` | |
| `lastError?` | VarChar(1000) | |
| `createdAt`, `updatedAt` | | |

- `@@unique([userId, installationId])`; `@@index([userId, status])`; `@@index([lastSeenAt])` (Doctor staleness check).
- CHECK constraints: `config_version >= 1`, `applied_config_version >= 0`.

### 4.4 `MediaSyncRun` → `media_sync_runs`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid | |
| `deviceId` | FK, Cascade | |
| `trigger` | `MediaSyncTrigger` | |
| `status` | `MediaSyncRunStatus` | |
| `startedAt`, `finishedAt` | timestamptz | |
| `filesUploaded`, `filesFailed`, `filesDeduplicated` | Int | |
| `bytesUploaded` | BigInt | Serialized as a string |
| `errorCode?` | VarChar(64) | One of the [run error codes](#174-run-error-codes) |
| `details` | Json? | `{ failedSample?, perFolder? }` |
| `createdAt` | timestamptz | |

- `@@index([deviceId, createdAt(sort: Desc)])`. CHECK constraints: the three counts and `bytes_uploaded` are `>= 0`.

### 4.5 `MediaSyncDiagnosticReport` → `media_sync_diagnostic_reports`

`id`, `deviceId` (Cascade), `summary` VarChar(500)?, `report` Json, `createdAt`; `@@index([deviceId, createdAt(sort: Desc)])`.

### 4.6 Retention, deletion and resets

- **Retention:** newest **200 runs** and **20 reports** per device, enforced by the service on insert (#505).
- **User deletion:** FKs cascade.
- **Resets:** MemoriaHub has no factory-reset or user-data-purge helper at this time. If one is added, it keeps `android_app_releases` rows and their APKs (deployment artifacts) and deletes media-sync devices, runs and reports.
- **Rejected:** a per-file server ledger table. The phone's Room ledger is authoritative and server idempotency is `(circle_id, content_hash)`; only aggregates and a failure sample are stored. Separate config columns were rejected in favour of a versioned JSON validated by Zod, so new config fields need no migration.

## 5. Desired config and commands

### 5.1 Schema

`MediaSyncDevice.config` (server → phone). Validated by a strict Zod schema; every API that returns a device returns this exact shape.

```ts
{ targetCircleId: uuid,
  folders: { bucketId: string, name: string }[],     // ≤200; empty = nothing syncs
  includePhotos: boolean, includeVideos: boolean,
  network: 'wifi' | 'any',                           // wifi ⇒ UNMETERED, any ⇒ CONNECTED
  requireCharging: boolean,
  paused: boolean,
  uploadExisting: 'all' | 'from_pairing',            // default 'all'
  retryFailedGeneration: number, syncNowGeneration: number }  // monotonically increasing commands
```

| Field | Type | Limits | Meaning |
|---|---|---|---|
| `targetCircleId` | uuid | The caller must hold the per-circle `collaborator` role (or the super-admin bypass) | Circle every file is uploaded to |
| `folders[]` | `{ bucketId, name }` | ≤200 entries; each `bucketId` must exist in the device's last reported `inventory`; `name` is overwritten by the server from the inventory entry | Selected MediaStore buckets. **Empty means nothing syncs**, so a fresh pairing never uploads the whole phone by surprise |
| `includePhotos`, `includeVideos` | boolean | | Media types in scope. Both false means nothing syncs |
| `network` | `'wifi'` \| `'any'` | | `wifi` ⇒ WorkManager `NetworkType.UNMETERED` and a mid-upload metered-network stop; `any` ⇒ `NetworkType.CONNECTED`. Default `wifi` |
| `requireCharging` | boolean | | Adds `setRequiresCharging(true)`. Default false |
| `paused` | boolean | | Set by the `pause` and `resume` commands. Default false |
| `uploadExisting` | `'all'` \| `'from_pairing'` | | `all`: every file in the selected folders. `from_pairing`: only files whose `dateTaken >= pairedAt` (the phone's local timestamp of its first successful registration); older rows are `EXCLUDED` |
| `retryFailedGeneration` | int ≥ 0 | Never set directly | Incremented by the `retry_failed` command. The phone retries all `FAILED` and `BLOCKED` rows when it exceeds the last applied value |
| `syncNowGeneration` | int ≥ 0 | Never set directly | Incremented by `sync_now`. The phone runs a manual sync when it exceeds the last applied value |

**Default config** (a new device row): `targetCircleId` = the user's personal circle (`isPersonal: true`), `folders: []`, `includePhotos: true`, `includeVideos: true`, `network: 'wifi'`, `requireCharging: false`, `paused: false`, `uploadExisting: 'all'`, both generations `0`. `configVersion = 1`, `appliedConfigVersion = 0`.

### 5.2 Versioning model

- `configVersion` is a server-owned, monotonically increasing integer. **Every** successful `PATCH /devices/:id/config` and every `POST /devices/:id/commands` increments it by exactly 1.
- The phone calls `POST /devices/:id/checkin` before and after each run. The response always carries the current `{ config, configVersion }`. The phone applies it when `configVersion > its stored applied version` and reports the applied version in the next check-in as `appliedConfigVersion`.
- The web shows `configPending = appliedConfigVersion < configVersion` as "Changes pending, will apply next time the phone checks in". Inside the TWA, `memoriahub://media-sync?action=apply` makes the phone check in immediately.
- **Who edits.** The web (JWT) and the phone's native Folders and Network screens (PAT, `PATCH` and commands) edit the same document. Conflict rule: **the newest write wins** at the server; the phone never silently overwrites a newer server version because every local edit is a `PATCH` that returns the merged config, which the phone then applies.
- **Offline local edits.** The phone keeps a local outbox of pending edits (config patches and commands) and replays them through `PATCH /config` and `POST /commands` **before** the next check-in. They are never carried in the check-in body ([D7](#22-decisions)).

### 5.3 `ConfigApplier` (phone)

Applying a config is a deterministic procedure:

1. Persist the config and `configVersion`.
2. Re-evaluate every ledger row against the config ([section 8.3](#83-ingest-and-policy-evaluation)): rows not in `UPLOADED`/`DEDUPLICATED` become `EXCLUDED` when ineligible and `QUEUED` when an `EXCLUDED` row becomes eligible. In-flight uploads of newly excluded rows are aborted at the next part boundary.
3. Rebuild WorkManager constraints ([section 10.1](#101-constraints)).
4. If `paused`, cancel the sync work and return.
5. If `retryFailedGeneration` exceeds the last applied value, call `ledger.retryFailed()` and `ledger.retryBlocked()`.
6. If `syncNowGeneration` exceeds the last applied value, treat the run as `manual`.
7. Store the applied generations and `appliedConfigVersion`.

Each generation delta fires **exactly one** retry or sync.

### 5.4 Commands

`POST /devices/:id/commands` body `{ action: 'pause' | 'resume' | 'retry_failed' | 'sync_now' }`.

| Action | Effect on `config` | `configVersion` |
|---|---|---|
| `pause` | `paused = true` | +1 |
| `resume` | `paused = false` | +1 |
| `retry_failed` | `retryFailedGeneration += 1` | +1 |
| `sync_now` | `syncNowGeneration += 1` | +1 |

The phone's own Stop/Start calls `pause`/`resume` so the web reflects it; if offline the command waits in the outbox.

## 6. API contract

### 6.1 Conventions

- Base path `/api`. Success bodies are `{ data: T, meta: { timestamp } }`, except the three documented raw responses: `GET /api/well-known/assetlinks.json` (bare array), `GET /api/android-app/download/:token` (APK bytes) and the part upload route (empty body plus an `ETag` header).
- Error bodies are `{ statusCode, code, message, details?, timestamp, path }`. **`code` is always derived from the HTTP status** (`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, …) by `HttpExceptionFilter`. The machine-readable reason is **`details.reason`**, and any extra field (for example `bucketIds`, `partNumbers`, `activeRunId`) must also live under `details`: a top-level custom field on a thrown exception is silently dropped by the filter's allowlist. Wherever an issue or this document writes "409 `RELEASE_IS_CURRENT`", it means status 409 with `details.reason: 'RELEASE_IS_CURRENT'`. All reasons are in [section 17](#17-error-codes).
- All timestamps are ISO 8601 UTC strings. All ids are uuids. `BigInt` values are decimal strings in responses.
- Every endpoint declares `@Auth()` unless deliberately public (there is no global JWT guard).
- **OpenAPI** tags added: "Android app" and "Media Sync".

### 6.2 Auth matrix

`@Auth()` accepts either the web JWT or a `pat_` token. "PAT" below means the request must carry a `pat_`; the guard stamps `request.authCredential = { kind: 'jwt' | 'pat', tokenId? }` and the route reads it with `@AuthCredential()` (introduced by #505, [D4](#22-decisions)). A **device-linked PAT** is a PAT whose id equals some device's `patId`.

| Route | Credential | Permission | Notes |
|---|---|---|---|
| `POST /media-sync/devices` | PAT only (JWT → 400 `PAT_REQUIRED`) | `media:write` | Register or upsert |
| `GET /media-sync/devices` | JWT or PAT | `media:read` | Caller's devices |
| `GET /media-sync/devices/:id` | JWT or PAT | `media:read` | Another user's id → **404** |
| `PATCH /media-sync/devices/:id/config` | JWT or PAT | `media:write` | Device-scoped write |
| `POST /media-sync/devices/:id/commands` | JWT or PAT | `media:write` | Device-scoped write |
| `POST /media-sync/devices/:id/checkin` | PAT only, and it must be **that device's linked PAT** | `media:write` | Else 400 `PAT_REQUIRED` or 404 |
| `GET /media-sync/devices/:id/runs` | JWT or PAT | `media:read` | |
| `POST /media-sync/devices/:id/diagnostics` | JWT or PAT | `media:write` | Device-scoped write; also accepted for a revoked device |
| `GET /media-sync/devices/:id/diagnostics[/:reportId]` | JWT or PAT | `media:read` | |
| `DELETE /media-sync/devices/:id` | JWT or PAT | `media:write` | Unpair |
| `GET/PUT /admin/android-app` | JWT | `system_settings:read` / `:write` | |
| `GET /well-known/assetlinks.json` | public | | `@Public()`, maintenance-exempt |
| `POST/GET /admin/android-app/releases`, `POST …/:id/make-current`, `DELETE …/:id` | JWT or PAT | `system_settings:write` / `:read` | The CLI uses a PAT |
| `GET /android-app/releases/latest`, `POST /android-app/releases/:id/download-link` | JWT or PAT | any signed-in user | |
| `GET /android-app/download/:token` | public | signed token | **Not** maintenance-exempt |

- **PAT scoping.** When the caller is a device-linked PAT, the device-scoped write routes (`config`, `commands`, `checkin`, `diagnostics`) accept **only that device's id**; any other id → 404. A phone can never reconfigure a different phone. A JWT caller, or a PAT not linked to any device (for example a CLI PAT), manages all of the owner's devices.
- **Per-circle role.** Config and upload targets require the per-circle `collaborator` role, checked with `CircleMembershipService.assertCircleAccess(userId, circleId, permissions, CircleRole.collaborator)`.

### 6.3 Device API

**Register: `POST /api/media-sync/devices`** (strict body)

| Field | Type | Limits |
|---|---|---|
| `installationId` | uuid | required |
| `name` | string | ≤100, required |
| `manufacturer`, `model`, `androidVersion` | string? | ≤100 |
| `sdkInt` | int? | |
| `appVersion` | string? | ≤50 |
| `appVersionCode` | int? | |
| `packageName` | string? | Package-name regex; never re-cased |
| `signingSha256` | string? | Normalised to uppercase colon form (accepts 64 hex digits or colon form) |
| `timezone` | string? | IANA |

Upserts on `(userId, installationId)`. Stores `patId = credential.tokenId`. In the **same transaction** it revokes the previously linked PAT if it differs (re-pair) and sets `status = active`. A new row gets the default config. Responds **201** for a new row and **200** for a re-registration, with `{ ...DeviceView, config, configVersion }`.

**`DeviceView`**

| Field | Type | Meaning |
|---|---|---|
| `id`, `name`, `manufacturer`, `model`, `androidVersion` | | |
| `appVersion`, `appVersionCode` | | |
| `latestVersionCode` | int \| null | Current release's `versionCode`, when its package equals the device's `packageName` (or the device reports none); else null |
| `updateAvailable` | boolean | `appVersionCode` known and `< latestVersionCode` |
| `status` | `active` \| `revoked` | |
| `config`, `configVersion`, `appliedConfigVersion` | | |
| `configPending` | boolean | `appliedConfigVersion < configVersion` |
| `inventory` | `InventoryEntry[]` \| null | |
| `stats` | `SyncStats` \| null | |
| `permission`, `networkState`, `batteryOptimized` | | |
| `lastSeenAt`, `lastSyncAt`, `lastSyncStatus`, `lastError` | | |
| `tokenExpiresAt` | ISO \| null | From the linked PAT |
| `createdAt` | ISO | |

**`PATCH /devices/:id/config`**: body is a partial of `{ targetCircleId, folders, includePhotos, includeVideos, network, requireCharging, uploadExisting }` (strict; `paused` and the generations are rejected here, they change only through commands) plus an optional `inventory`.

- `targetCircleId`: caller must be a collaborator of that circle, else **403** `TARGET_CIRCLE_FORBIDDEN`.
- `folders`: every `bucketId` must exist in the device's last reported inventory, else **400** `UNKNOWN_FOLDER` with `details.bucketIds`. An empty list is allowed. A PAT caller may send `inventory` in the same request (≤500 entries); it is stored like a check-in inventory and used to validate the same request. A JWT caller sending `inventory` gets 400 `INVENTORY_NOT_ALLOWED`.
- Bumps `configVersion` by 1 and writes the audit event `media_sync.config.updated` with `actor: 'web' | 'device'`.
- Returns `{ config, configVersion }`.

**`POST /devices/:id/commands`**: [section 5.4](#54-commands). Audit `media_sync.command` (`{ action, actor }`). Returns `{ config, configVersion }`.

**`DELETE /devices/:id`**: sets `status = revoked` and revokes the linked PAT in one transaction; **204**.

**`GET /devices/:id/runs?limit`**: default 50, max 200, newest first; each run serializes `bytesUploaded` as a string.

### 6.4 Check-in

`POST /api/media-sync/devices/:id/checkin` (phone → server). The body is a **strict** Zod schema: an unknown key is a 400, so the phone sends only these fields.

```ts
{ appliedConfigVersion: number,
  inventory?: { bucketId, name, relativePath, photoCount, videoCount, bytes }[],   // ≤500
  stats: { eligible, uploaded, deduplicated, pending, uploading, failed, blocked, bytesPending, bytesUploaded },
  permission: 'full'|'partial'|'denied', networkState: 'wifi'|'cellular'|'none', batteryOptimized: boolean,
  appVersion?, appVersionCode?,
  run?: { trigger: 'periodic'|'content_trigger'|'manual'|'app_open'|'initial',
          status: 'ok'|'partial'|'failed'|'skipped'|'paused',
          startedAt, finishedAt, filesUploaded, bytesUploaded, filesFailed, filesDeduplicated,
          errorCode?, perFolder?, failedSample?: { name, relativePath, sizeBytes, attempts, lastError }[] /*≤50*/ } }
→ { config, configVersion, serverTime }
```

| Field | Type | Limits and meaning |
|---|---|---|
| `appliedConfigVersion` | int ≥ 0 | The config version the phone has applied. Stored (clamped to ≤ `configVersion`) |
| `inventory` | array? | Folder list; omitted when unchanged (sent when it changes or every 24 h). Replaces the stored inventory. ≤500 entries |
| `inventory[].bucketId` | string | MediaStore `BUCKET_ID`; ≤64 chars |
| `inventory[].name` | string | `BUCKET_DISPLAY_NAME`; ≤255 |
| `inventory[].relativePath` | string | MediaStore `RELATIVE_PATH` (API 29+) or the directory of `DATA`; ≤1024 |
| `inventory[].photoCount`, `videoCount` | int ≥ 0 | Non-pending, non-trashed items |
| `inventory[].bytes` | int ≥ 0 | Sum of sizes (a JS-safe integer) |
| `stats` | object | Counts from [section 8.5](#85-statistics); all ints ≥ 0; no extra keys (the phone keeps `perBucket` locally) |
| `permission` | enum | `full`, `partial` (Android 14 selected-only, or only one of the two Android 13 media permissions), `denied` |
| `networkState` | enum | `wifi` (unmetered), `cellular` (metered or mobile), `none` |
| `batteryOptimized` | boolean | `true` when `PowerManager.isIgnoringBatteryOptimizations` is **false** |
| `appVersion`, `appVersionCode` | string?, int? | Updates the device row |
| `run` | object? | One finished run; inserts a `MediaSyncRun` |
| `run.trigger` | enum | `MediaSyncTrigger` |
| `run.status` | enum | `ok` (nothing failed), `partial` (some failed, or the run stopped early: network policy, `FGS_TIMEOUT`), `failed` (fatal), `skipped` (did not run: permission), `paused` |
| `run.startedAt`, `finishedAt` | ISO | |
| `run.filesUploaded`, `filesFailed`, `filesDeduplicated`, `bytesUploaded` | int ≥ 0 | |
| `run.errorCode` | string? | ≤64; one of the [run error codes](#174-run-error-codes) |
| `run.perFolder` | `{ bucketId, uploaded, failed, deduplicated }[]`? | Optional, ≤200 entries; stored in `details`. Not required in v1 |
| `run.failedSample[]` | `{ name, relativePath, sizeBytes, attempts, lastError }` | ≤50 entries; `lastError` ≤500 chars |

In **one transaction** the server: updates `stats`, `inventory` (when present), `permission`, `networkState`, `batteryOptimized`, `appliedConfigVersion`, `appVersion`/`appVersionCode`, `lastSeenAt`; if `run` is present, inserts a `MediaSyncRun`, updates `lastSyncAt`/`lastSyncStatus`/`lastError` and trims runs to 200. A **revoked device** gets 409 `DEVICE_REVOKED`. Response: `{ config, configVersion, serverTime }`. The server logs one `media_sync.checkin` line ([section 18](#18-observability)).

### 6.5 Android app: trusted apps, assetlinks, releases

**Trusted apps (#503).** Stored in its own `system_settings` row `key = 'android_app'` (`ANDROID_APP_SETTINGS_KEY`), value `{ trustedApps: { packageName, sha256 }[] }`, at most 10 (`MAX_TRUSTED_ANDROID_APPS`). It is a separate row, not part of the `global` settings document, so the generic settings API never returns it and the "hand-maintained copies" pitfall does not apply.

- Fingerprints normalise to uppercase colon form matching `/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/`; both 64 hex digits and the colon form are accepted.
- Package names match `/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/` and are compared **case-sensitively**, never re-cased. Duplicates are removed.

| Route | Behaviour |
|---|---|
| `GET /api/admin/android-app` (`system_settings:read`) | `{ trustedApps, reportedApps, assetLinks }`. `reportedApps[] = { packageName, sha256, deviceCount, lastSeenAt, trusted }`, from one `groupBy` over **active** `media_sync_devices` |
| `PUT /api/admin/android-app` (`system_settings:write`) | Body `{ trustedApps }` replaces the whole list; audit `android_app.trusted_apps.updated` with `{ added, removed }` |
| `GET /api/well-known/assetlinks.json` (`@Public()`, controller-level `@AllowDuringMaintenance()`) | A **bare JSON array**, `Content-Type: application/json; charset=utf-8`, `Cache-Control: public, max-age=300`; one statement per package with its fingerprints grouped; `[]` when empty |

```json
[{ "relation": ["delegate_permission/common.handle_all_urls"],
   "target": { "namespace": "android_app", "package_name": "memoriahub.marin.cr", "sha256_cert_fingerprints": ["AA:…"] } }]
```

nginx (both `infra/nginx/nginx.conf` and `nginx.prod.conf`): `location = /.well-known/assetlinks.json { proxy_pass http://<api upstream>/api/well-known/assetlinks.json; }`. `AndroidAppService.ensureTrusted({ packageName, sha256 }, userId): Promise<boolean>` adds a pair idempotently; when the list is full it logs a warning and returns false, **never throws**. It is called when a release becomes current.

**Releases (#504).**

| Constant | Value |
|---|---|
| `MAX_APK_BYTES` | 150 MiB |
| `versionCode` | 1..2,100,000,000 |
| `versionName` | ≤50 chars, `/^[0-9A-Za-z][0-9A-Za-z._+-]*$/` |
| notes | ≤2000 chars |
| `ZIP_MAGIC` | `PK\x03\x04` |
| file field | `apk` |
| `DOWNLOAD_LINK_TTL_SECONDS` | 600 |
| storage key | `android-releases/<releaseId>.apk` |
| download file name | `memoriahub-android-<versionName>.apk` |

| Route | Auth | Behaviour |
|---|---|---|
| `POST /api/admin/android-app/releases` | `system_settings:write` | Multipart; text fields **first**: `packageName, versionName, versionCode, signingSha256, notes?, makeCurrent` (default true), `force` (default false); then the file field `apk`. Parser limits `{ fileSize: MAX_APK_BYTES, files: 1, fields: 16, fieldSize: 16KB }`. 503 `STORAGE_NOT_CONFIGURED` when no storage provider is configured |
| `GET /api/admin/android-app/releases` | `system_settings:read` | `AdminRelease[]`, newest first |
| `POST /api/admin/android-app/releases/:id/make-current` | `system_settings:write` | Rollback to a lower `versionCode` is allowed. Calls `ensureTrusted` |
| `DELETE /api/admin/android-app/releases/:id` | `system_settings:write` | 409 `RELEASE_IS_CURRENT`; deletes the stored bytes **first**, then the row |
| `GET /api/android-app/releases/latest` | any signed-in user | `PublicRelease`, or 404 `NO_RELEASE` |
| `POST /api/android-app/releases/:id/download-link` | any signed-in user | `{ url: "/api/android-app/download/<token>", expiresAt }` |
| `GET /api/android-app/download/:token` | public, **not** maintenance-exempt | Streams the APK with `Content-Type: application/vnd.android.package-archive`, `Content-Disposition: attachment; filename=…`, `Content-Length`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store` |

- `PublicRelease = { id, packageName, versionName, versionCode, fileSha256, sizeBytes (string), notes | null, createdAt }`. `AdminRelease = PublicRelease + { signingSha256, isCurrent, uploadedBy: { id, email, displayName } | null }`.
- **Validation.** `releaseUploadFieldsSchema` is `.strict()` and coerces form strings; `signingSha256` is normalised to uppercase colon form.
- **Version rule** `versionRuleRefusal(current, next, force)`: the same `(packageName, versionCode)` → 409 `RELEASE_VERSION_EXISTS`; with `makeCurrent`, if the current release has the same package and `versionCode >= next`, → 409 `RELEASE_VERSION_NOT_NEWER` unless `force`.
- **Streaming check** (`apk-inspector.ts`): a Transform stream between multipart and storage checks the ZIP magic on the first bytes, counts bytes against the limit and computes SHA-256 while streaming. **The APK is never buffered.** Any failure after bytes reached storage deletes them. Refusals: `RELEASE_NOT_AN_APK`, `RELEASE_TOO_LARGE`, `RELEASE_INVALID_UPLOAD`.
- **Make current** runs in a `$transaction`: `updateMany({ isCurrent: true } → false)`, then set the new row current. A P2002 on `android_app_releases_one_current_uniq_idx` becomes 409 `RELEASE_CURRENT_CONFLICT`. Afterwards call `androidApp.ensureTrusted({ packageName, signingSha256 })`.
- **Download token** (`download-token.ts`): payload `[0x01][releaseId 16B][userId 16B][expiry uint32 BE]`; token `base64url(payload) + "." + base64url(HMAC-SHA256(key, payload)[0..24])`, 83 characters, under Fastify's 100-character path-parameter limit. Key `deriveSubKey('android-app-download')` from `common/crypto/secret-cipher.ts` (derived from `SECRETS_ENCRYPTION_KEY`; no new environment variable). The signature is checked **before** the expiry: bad signature → 404 `DOWNLOAD_LINK_INVALID`; expired → 410 `DOWNLOAD_LINK_EXPIRED`.
- **Audit events:** `android_app.release.uploaded`, `android_app.release.made_current`, `android_app.release.deleted`.
- **Storage.** Use the **active** storage provider through `StorageProvidersModule` (not the full storage module, so the job queue is not pulled in) and record `storageProvider` and `bucket` on the row.
- **nginx** (both files): `location = /api/admin/android-app/releases` with `client_max_body_size 160m; proxy_request_buffering off;` and 600 s read/send timeouts; `location /api/android-app/download/` with `proxy_buffering off;` and 600 s timeouts.

### 6.6 Endpoints the phone uses for upload and registration

All with `Authorization: Bearer pat_…`; the PAT carries its owner's `storage:write` and `media:write`.

| Step | Endpoint | Request | Response |
|---|---|---|---|
| Dedup pre-check | `GET /api/media?circleId=<id>&contentHash=<sha256>&pageSize=1` | `circleId` is required; `page` omitted (keyset mode, no `COUNT(*)`) | A list with `items[]` (the CLI reads `items`); a non-empty list means the server already has it. Clients unwrap a `{ data }` envelope if present |
| Init | `POST /api/storage/objects/upload/init` | `{ name (1..255), size (>0), mimeType }` | `{ objectId, uploadId, partSize, totalParts, presignedUrls: [{ partNumber, url }] (first ≤10), partUploadAuth }` |
| More part URLs | `POST /api/storage/objects/:id/upload/part-urls` | `{ partNumbers: int[] (1..100 entries) }` | `{ presignedUrls: [{ partNumber, url }], partUploadAuth }` |
| Upload a part | `PUT <url>` | raw bytes | `ETag` response header (quotes preserved) |
| Status | `GET /api/storage/objects/:id/upload/status` | | `{ objectId, status, uploadedParts: int[], totalParts, uploadedBytes (string), totalBytes (string) }` |
| Complete | `POST /api/storage/objects/:id/upload/complete` | `{ parts: [{ partNumber, eTag }] (≥1) }` | the object (`status: 'processing'`) |
| Abort | `DELETE /api/storage/objects/:id/upload/abort` | | 204; 404 means already gone |
| Register | `POST /api/media` | below | **201** created, or **200** with `deduplicated: true` |

`POST /api/media` body (existing `createMediaSchema`; `capturedAtOffset` and EXIF are left to the server's metadata pipeline):

```ts
{ storageObjectId, circleId, type: 'photo'|'video', source: 'android', originalFilename,
  contentHash,                       // lowercase hex SHA-256 of the exact bytes uploaded
  capturedAt?,                       // ISO of MediaStore DATE_TAKEN when > 0
  sourceDeviceId,                    // MediaSyncDevice.id
  sourceDeviceName,                  // the device name
  sourcePath }                       // relativePath + displayName
→ { mediaItemId, deduplicated, ... }
```

- `partSize` defaults to 10 MiB (`storage.partSize`, minimum 5 MiB for S3). The phone **always uses the `partSize` the server returned**, never an assumption. Presigned URLs expire; the client re-fetches on a 403 from storage.
- **`source: 'android'` with `sourceDeviceId`** must name an **active** `media_sync_devices` row owned by the caller, else 400 `UNKNOWN_SOURCE_DEVICE` (#505). Legacy clients that send no `sourceDeviceId` are unaffected.
- **`partUploadAuth`** (#506): `'none'` for presigned S3/R2 URLs (the client must **not** send an `Authorization` header to storage); `'bearer'` for the API's own part route (the client **must** send `Authorization: Bearer <pat>`).

**Local-provider part upload (#506).** The `local` storage provider cannot hand out presigned URLs. Instead:

- `PUT /api/storage/objects/:id/upload/parts/:partNumber`: `@Auth()` with `storage:write`; the caller must be the object's uploader (else 403, the same rule as `GET :id/upload/status`). Body `application/octet-stream`, streamed straight to `.multipart/<uploadId>/part-<n>.tmp` then renamed, so a retried part is idempotent; **never buffered** (a raw content-type parser registered for this route only, body limit `partSize + 1 MiB`). Returns the part's MD5 as the quoted `ETag` header and records the part in `storage_object_chunks` with its real size, so `GET :id/upload/status` reports `uploadedParts`.
- Validation: object status is `pending` or `uploading` (the first part sets `uploading`), else 400 `UPLOAD_NOT_ACTIVE`; `partNumber` in `1..totalParts`, else 400 `PART_OUT_OF_RANGE`; size equals `partSize` except for the last part, else 400 `PART_SIZE_MISMATCH`.
- When the resolved provider is `local`, `upload/init` and `upload/part-urls` return absolute same-origin URLs `${APP_URL}/api/storage/objects/:id/upload/parts/:n` (never `internal://`) and `partUploadAuth: 'bearer'`.
- `completeMultipartUpload` (local) **throws when a listed part file is missing or its MD5 differs from the supplied `eTag`**; the controller maps it to **409** `UPLOAD_PARTS_MISSING` with `details.partNumbers`, and no corrupt object is written. The client re-sends only those parts.
- A stale session on complete (the provider forgot the multipart upload, or the ETags belong to another one) is a 409 with `details.reason: 'UPLOAD_SESSION_INVALID'`: the client aborts and re-inits.
- nginx: a regex location `^/api/storage/objects/[^/]+/upload/parts/` with `client_max_body_size 64m; proxy_request_buffering off;` and 300 s timeouts. The CLI's uploader (`apps/cli/src/upload.ts`, `apps/cli/src/sync/sync-engine.ts`) also honours `partUploadAuth` (CLI patch bump).
- The provider interface exposes `supportsPresignedParts: boolean`.

### 6.7 Device flow

`POST /api/auth/device/code` (public) with

```ts
clientInfo { deviceName: "<Maker Model> · Media sync", userAgent, tokenType: "pat",
             name: "MemoriaHub Android · <Model>", returnUri: "memoriahub://media-sync/paired" }
```

`ClientInfoSchema` must allow `tokenType` (`'session' | 'pat'`, anything else → 400), `name` (≤100, trimmed), `hostname` (≤255) and `platform` (≤50) alongside `deviceName`, `userAgent` and `returnUri`, as an **explicit allowlist, never `.passthrough()`** (#499; today the global validation pipe strips these keys and the server mints a 7-day JWT pair instead of a PAT). `returnUri` stays limited to the `memoriahub:` and `https:` schemes (≤512 chars).

`POST /api/auth/device/token` on approval with `tokenType: 'pat'` returns `{ accessToken: 'pat_…', refreshToken: '', tokenType: 'Bearer', expiresIn: <DEVICE_PAT_TTL_DAYS × 86400>, credentialType: 'pat' }`; without `tokenType` it returns `credentialType: 'session'` and the JWT pair (unchanged). The phone **rejects any credential whose `credentialType` is not `pat`**, so a server missing #499 fails loudly. RFC 8628 error values: `authorization_pending`, `slow_down`, `access_denied`, `expired_token`.

## 7. Pairing

Phone-side behaviour (#509). The user long-presses the icon, opens **Media sync**, then **Connect**.

1. **Request the code** and emit `CodeReady(userCode, verificationUriComplete)`. The UI opens the URI in a **Custom Tab** (shares Chrome's cookie jar with the TWA, so the user is already signed in and only clicks Approve).
2. **Poll** `POST /api/auth/device/token` with `DeviceFlowPoller`:

| Response | Action |
|---|---|
| `authorization_pending` | Keep polling |
| `slow_down` | Add 5 s to the interval, capped at 60 s |
| `access_denied` / `expired_token` | Stop |
| Network error or 5xx | Keep polling until the code deadline |

Every sleep is padded by 250 ms. After approval the activation page redirects to `memoriahub://media-sync/paired`, which brings the user back to `MediaSyncActivity` and triggers an immediate poll (`pokeNow()`).

3. **Store the token immediately** (`tokens.setToken(token, expiresAt)`), so a failed registration retries without re-approving.
4. **Register** (`POST /api/media-sync/devices`) with `installationId`, `name`, `manufacturer`, `model`, `androidVersion`, `sdkInt`, `appVersion`, `appVersionCode`, `packageName`, `signingSha256` (read through `GET_SIGNING_CERTIFICATES` on API 28+, formatted `AA:BB:…`) and `timezone`.
5. **Store `deviceId`**, then `scheduler.ensurePeriodic()` and `syncNow(INITIAL)`.

- **`TokenStore`** holds `token`, `expiresAt`, `deviceId` and `installationId`. `installationId` is a UUID generated once that **survives `clear()`**, so re-pairing reuses the same server row. `EncryptedTokenStore` uses `EncryptedSharedPreferences` (Keystore `MasterKey` AES256_GCM, file `memoriahub_secure`); an undecryptable keyset deletes the prefs and starts fresh (the user re-pairs).
- **`unpair()`**: `DELETE /api/media-sync/devices/:id`; a 401, 404 or 409 counts as already done. Then `tokens.clear()` (keeping `installationId`) and cancel all work. If the server cannot be reached, show "Could not reach the server" offering "Remove from this phone" (forget locally) or Cancel.
- **Global error reactions** (every caller): **401** → set `pairingExpired = true` and post the "Pairing expired, re-pair" notification (content intent `EXTRA_OPEN=connect`); **409 `DEVICE_REVOKED`** → clear the token and `deviceId`, keep `installationId`, cancel work.
- **Status model** `PairingStatus { hasToken, paired, expired, tokenExpiresAt }`, persisted.
- **Connect screen** states (copy matches evopath): No server ("Set the server address on the Media sync screen first."), Not paired (**Pair with MemoriaHub**), Code shown (large `userCode`, **Open sign-in page** / **Cancel**), Paired (token expiry, **Re-pair** / **Unpair** with a confirm dialog), Token but no device ("Signed in, but this phone is not registered yet." **Retry registration**), Expired ("The server no longer accepts this phone's token. Pair again to resume syncing." **Re-pair**). It also hosts the media permission request and the Android 13+ notification permission request.

## 8. The device ledger

Room database `memoriahub_sync.db` (#510). The ledger is **the source of truth per file** on the phone. Interfaces: `MediaGateway` (plain Kotlin) with the `AndroidMediaGateway` implementation over `ContentResolver`; `LedgerRepository`; `LedgerTransitions` (pure Kotlin, encodes the table below, every status write goes through it, an illegal transition throws in debug builds and logs in release).

### 8.1 Tables

**`sync_files`**

| Column | Notes |
|---|---|
| `id` | PK, autoincrement |
| `mediaStoreId`, `volume` | Unique together |
| `contentUri` | |
| `bucketId`, `relativePath`, `displayName`, `mimeType` | |
| `mediaType` | `PHOTO` / `VIDEO` |
| `sizeBytes`, `dateTaken`, `dateModified`, `generation` | `dateTaken` may be 0 or null |
| `status` | `SyncStatus` |
| `contentHash` | Nullable; lowercase hex SHA-256 |
| `objectId`, `uploadId`, `partSize`, `totalParts` | Nullable; the in-flight multipart session |
| `completedPartsJson` | `[{ partNumber, eTag }]`, written after every part |
| `partUploadAuth` | `none` / `bearer` |
| `attempts`, `nextAttemptAt`, `lastError`, `lastErrorCode` | |
| `mediaItemId` | Nullable; set on `UPLOADED` and `DEDUPLICATED` |
| `uploadedAt`, `createdAt`, `updatedAt` | |

Indexes: `(status, nextAttemptAt)`, `(bucketId)`. **`sync_runs`**: the last 50 local runs (trigger, status, timestamps, counts, `errorCode`) for the Diagnostics "recent runs" card. Cursors (per volume) and `pairedAt` are stored beside them.

`SyncStatus`: `DISCOVERED, QUEUED, HASHING, UPLOADING, REGISTERING, UPLOADED, DEDUPLICATED, FAILED, BLOCKED, EXCLUDED`.

### 8.2 State machine

Allowed transitions. **Any transition not in this table is illegal.** Every row is a testable case for `LedgerTransitionsTest`.

| # | From | To | Trigger | Effects |
|---|---|---|---|---|
| T1 | (new row) | `DISCOVERED` | Scan found a row | Inserted inside the ingest transaction only |
| T2 | `DISCOVERED` | `QUEUED` | Ingest: row is eligible (selected folder, included type, policy allows) | |
| T3 | `DISCOVERED` | `EXCLUDED` | Ingest: row is ineligible (folder, type, or `from_pairing` policy) | |
| T4 | `QUEUED` | `HASHING` | Engine claims it | `attempts` unchanged |
| T5 | `FAILED` | `HASHING` | Engine claims it once `nextAttemptAt <= now` | |
| T6 | `HASHING` | `UPLOADING` | Hash stored; server has no copy; multipart session persisted | `contentHash`, `objectId`, `uploadId`, `partSize`, `totalParts`, `partUploadAuth` saved **before** any byte is sent |
| T7 | `HASHING` | `DEDUPLICATED` | Pre-check found an item | `mediaItemId` set |
| T8 | `UPLOADING` | `UPLOADING` | A part completed; or the session was reset (abort and re-init); or an upload stopped by network policy, pause or FGS timeout | `completedPartsJson` updated; **no attempt counted** for a policy, pause or timeout stop |
| T9 | `UPLOADING` | `REGISTERING` | `complete` succeeded (or `status` shows `processing`/`ready`) | |
| T10 | `REGISTERING` | `UPLOADED` | `POST /api/media` returned 201 | `mediaItemId`, `uploadedAt` set; multipart fields cleared |
| T11 | `REGISTERING` | `DEDUPLICATED` | `POST /api/media` returned 200 with `deduplicated: true` | `mediaItemId` set; multipart fields cleared |
| T12 | `HASHING`, `UPLOADING`, `REGISTERING` | `FAILED` | Retryable failure and `attempts < 5` | `attempts + 1`, `lastError`, `lastErrorCode`, `nextAttemptAt` per [section 8.4](#84-backoff-and-blocking) |
| T13 | `HASHING`, `UPLOADING`, `REGISTERING` | `BLOCKED` | Non-retryable 4xx, or the 5th failed attempt | `lastError`, `lastErrorCode` |
| T14 | `HASHING` | `QUEUED` | Process-death recovery at run start (nothing was uploaded yet) | |
| T15 | `FAILED`, `BLOCKED` | `QUEUED` | Manual retry (`retry(id)`, `retryFailed()`, `retryBlocked()`) or the `retry_failed` command | `attempts = 0`, `nextAttemptAt = null`, `lastError` kept until the next outcome |
| T16 | `UPLOADED`, `DEDUPLICATED` | `QUEUED` | File changed on the phone (`sizeBytes` or `dateModified` differ): a new version | `contentHash`, multipart fields, `mediaItemId`, `attempts` cleared |
| T17 | `QUEUED`, `FAILED`, `BLOCKED`, `HASHING`, `UPLOADING` | `EXCLUDED` | Config applied: folder deselected, type excluded, or `from_pairing` policy | An in-flight upload is aborted at the next part boundary and its server session aborted best effort |
| T18 | `EXCLUDED` | `QUEUED` | Config applied: the row is eligible again | |
| T19 | any non-terminal (`DISCOVERED`, `QUEUED`, `FAILED`, `BLOCKED`, `EXCLUDED`, `HASHING`, `UPLOADING`) | (row deleted) | The file vanished from the device before upload (`vanished(ids)`) | Never deletes anything on the server |

- **Terminal for upload:** `UPLOADED`, `DEDUPLICATED`. They only leave through T16. `REGISTERING` is not excluded by T17: once the bytes are complete, registration finishes.
- `UPLOADING` and `REGISTERING` rows left over by a killed process are **resumed first** at the next run: `nextBatch()` returns them ahead of `QUEUED` rows ([D9](#22-decisions)). `HASHING` leftovers go back to `QUEUED` (T14).
- `DISCOVERED` is transient: a row never rests in it after ingest completes. It stays in the enum and in the `pending` count so nothing is lost if an ingest transaction is ever split.

### 8.3 Ingest and policy evaluation

`isEligible(row, config, pairedAt)` is a pure function: the row's bucket is in `config.folders`, its type is included, and under `uploadExisting = 'from_pairing'` its `dateTaken >= pairedAt`.

- **`ingest(scanRows, config)`**: upserts rows; a new eligible row becomes `QUEUED` (T1+T2), an ineligible one `EXCLUDED` (T1+T3). A row whose `dateModified` or `sizeBytes` changed after `UPLOADED` or `DEDUPLICATED` is re-queued as a new version (T16); the server deduplicates by hash anyway.
- **`applyConfig` / `applyFolderSelection`**: re-evaluates every row not in `UPLOADED`/`DEDUPLICATED` with `isEligible` (T17, T18). A re-evaluation, not a reason column, restores correctly regardless of why a row was excluded.
- **`vanished(ids)`**: a file deleted on the phone before upload is removed from the ledger (T19). Vanished detection runs **only after a full scan with `permission = full`**, because scans under `partial` or `denied` return an incomplete universe and absence proves nothing (the legacy app's `canRead()` guard).
- **`nextBatch(limit)`**: orphaned `UPLOADING`/`REGISTERING` rows first, then `QUEUED`, then `FAILED` rows whose `nextAttemptAt <= now`; within each group `dateTaken DESC` (newest photos first; null last).
- **`retry(id)`, `retryFailed()`, `retryBlocked()`**: T15.
- **`failedSample(50)`**: for the check-in.
- **`resetLocalState()`**: clears the ledger and cursors but keeps pairing, `pairedAt` and the `installationId`. The next scan rebuilds; server dedup prevents duplicates.

**Scanner** (`MediaGateway`):

- `inventory(): List<Bucket>`: queries `MediaStore.Images.Media` and `MediaStore.Video.Media` across `MediaStore.getExternalVolumeNames()` (API 29+; `VOLUME_EXTERNAL` below), groups by `BUCKET_ID`, `BUCKET_DISPLAY_NAME`, `RELATIVE_PATH`; returns `{ bucketId, name, relativePath, photoCount, videoCount, bytes }`; excludes `IS_PENDING = 1` and `IS_TRASHED = 1` (API 30+).
- `scan(since: ScanCursor, buckets, includePhotos, includeVideos): Sequence<MediaRow>`: columns `_ID`, volume, `DISPLAY_NAME`, `RELATIVE_PATH`, `BUCKET_ID`, `MIME_TYPE`, `SIZE`, `DATE_TAKEN`, `DATE_MODIFIED`, `GENERATION_MODIFIED` (API 30+), `DURATION` for video. Incremental on `GENERATION_MODIFIED > lastGeneration` (API 30+); below API 30 it falls back to `DATE_MODIFIED >= lastDateModified - 2s`. The cursor is stored **per volume**; capture `currentGeneration(volume)` (`MediaStore.getGeneration`) **before** the scan so mid-scan changes are re-scanned next run rather than lost. If `MediaStore.getVersion` changes (the media database was rebuilt and generations reset), invalidate the cursors and do a full scan.
- A **full reconcile scan** runs on periodic runs at most once per 24 h, after `resetLocalState`, and after a MediaStore version change.
- `openRange(uri, offset, length)` for the upload engine; `permissionState(): Full | Partial | Denied` ([section 11](#11-permissions)).

### 8.4 Backoff and blocking

`attempts` counts failed attempts. The delay before the next try after the Nth failure:

| Failure number N | Row becomes | `nextAttemptAt` |
|---|---|---|
| 1 | `FAILED` | now + 30 s |
| 2 | `FAILED` | now + 2 min |
| 3 | `FAILED` | now + 10 min |
| 4 | `FAILED` | now + 1 h |
| 5 | `BLOCKED` | none (manual retry only) |

A `Retry-After` header (429, 503) raises the delay to at least that value, capped at 1 h, and **does not** count as an extra attempt. A non-retryable 4xx goes straight to `BLOCKED` ([section 9.5](#95-failure-classification)). Stops caused by network policy, pause or the Android 15 timeout never count an attempt.

### 8.5 Statistics

`stats()` returns the `SyncStats` used everywhere (check-in, Hub, web tiles). Every row counts in exactly one bucket, so `eligible = uploaded + deduplicated + pending + uploading + failed + blocked`.

| Field | Rows counted |
|---|---|
| `eligible` | every row not `EXCLUDED` |
| `uploaded` | `UPLOADED` |
| `deduplicated` | `DEDUPLICATED` |
| `pending` | `DISCOVERED`, `QUEUED`, `HASHING` |
| `uploading` | `UPLOADING`, `REGISTERING` |
| `failed` | `FAILED` (whether or not its retry is due) |
| `blocked` | `BLOCKED` |
| `bytesPending` | sum of `sizeBytes` of `DISCOVERED`, `QUEUED`, `HASHING`, `UPLOADING`, `REGISTERING`, `FAILED`, `BLOCKED` rows (may over-estimate by bytes already sent) |
| `bytesUploaded` | sum of `sizeBytes` of `UPLOADED` rows |

Local `stats()` also carries a `perBucket` breakdown (not sent to the server). The UI derives **Synced = uploaded + deduplicated** and **Missing = pending + uploading + failed + blocked**.

## 9. Upload sequence and resume

`upload/UploadEngine.kt`, `net/MediaSyncApi.kt` and `upload/ContentRangeRequestBody.kt` (#511). `ledger.nextBatch()` feeds **2 files in parallel**, coroutine-supervised so one failure does not cancel the other; parts within a file are sequential.

### 9.1 Per-file pipeline

1. **HASHING.** Stream SHA-256 from `contentResolver.openInputStream` with a 64 KB buffer; store `contentHash`. Skip when a hash is stored and `sizeBytes`/`dateModified` are unchanged. **The hash and the upload must read the same bytes**: open the same URI form for both (for photos with `ACCESS_MEDIA_LOCATION` granted, use `MediaStore.setRequireOriginal` for both, with a fallback that uses the plain URI for both when it throws), or dedup would miss.
2. **Dedup pre-check.** `GET /api/media?circleId=<targetCircleId>&contentHash=<sha>&pageSize=1` (omit `page`). If an item exists, the row becomes `DEDUPLICATED` with that `mediaItemId` (T7). The pre-check is an optimisation; `POST /api/media` is authoritative.
3. **Resume or init.**
   - If the row has an `objectId`/`uploadId`, call `GET /api/storage/objects/:id/upload/status`.
     - **404, 403**, or `status` of `failed`: `DELETE …/upload/abort` (best effort), clear the upload fields and init fresh.
     - `status` of `processing` or `ready`: the previous run completed the upload and died before registering; **go straight to step 6**.
     - `status` of `pending` or `uploading`: resume with the local `completedPartsJson`. **The server's `uploadedParts` is advisory only**: for S3/R2 the part list is recorded server-side only at `complete`, so it can legitimately be empty while the parts exist in storage. The local ETags are authoritative; for the `local` provider the server list is a superset check. Parts the local list lacks but the server reports are re-sent only if their ETag is unknown.
   - Else `POST /api/storage/objects/upload/init { name: displayName, size, mimeType }` and persist `objectId`, `uploadId`, `partSize`, `totalParts`, `partUploadAuth` **before sending any byte** (T6).
4. **UPLOADING.** For each missing part:
   - Take the URL from the init batch (first ≤10) or fetch more via `POST …/upload/part-urls { partNumbers ≤ 100 }`. On a 403 from storage, re-fetch the URL once.
   - `PUT` a `ContentRangeRequestBody(uri, offset = (n-1)*partSize, length = min(partSize, size - offset))`. It streams through `FileChannel.position()` or `skip` with no in-memory part buffer.
   - **Authorization:** none for presigned storage URLs (`partUploadAuth = none`); `Bearer <pat>` for the API part route (`bearer`).
   - Record the `ETag` header (quotes preserved) into `completedPartsJson` **after every part**, in one Room transaction.
   - Before each part, call `NetworkPolicy.allowed(config)`. Under `network = 'wifi'`, a metered network (`!NET_CAPABILITY_NOT_METERED`) throws `NetworkPolicyStop`: the row stays `UPLOADING` with its parts saved and the worker returns retry under the constraint now in force.
   - Before each part, check `isStopped`/cancellation: pause and the Android 15 foreground-service timeout stop cleanly the same way.
5. **Complete.** `POST …/:id/upload/complete { parts }`.
   - 409 `UPLOAD_PARTS_MISSING`: drop the listed `details.partNumbers` locally and loop back to step 4.
   - Any other 409 (`UPLOAD_SESSION_INVALID`, or the legacy un-reasoned "session no longer valid" conflict): abort, reset the row's upload fields and re-init (T8 self-transition). This mirrors the CLI (`apps/cli/src/upload.ts`).
6. **REGISTERING.** `POST /api/media` ([section 6.6](#66-endpoints-the-phone-uses-for-upload-and-registration)). 201 → `UPLOADED` (T10); 200 with `deduplicated: true` → `DEDUPLICATED` (T11); both store `mediaItemId`.

### 9.2 Network timeouts

API calls: connect 15 s, read 60 s. Part `PUT`s: connect 15 s, read and write 120 s, no call timeout (a stalled socket fails the part; the ledger keeps the earlier parts).

### 9.3 Memory

Constant memory: 64 KB hash buffer and 64 KB copy buffer per stream, no part buffer. Acceptance: uploading a ≥2 GB video keeps heap under 64 MB above baseline.

### 9.4 Progress

`Flow<UploadProgress { fileName, bytesSent, bytesTotal, filesDone, filesTotal }>`, emitted at most every 500 ms, for the foreground notification and the UI.

### 9.5 Failure classification

`UploadErrorPolicy` is pure and unit tested.

| Error | Result |
|---|---|
| Network or IO error, 408, 429 (honour `Retry-After`), 5xx | `FAILED`, `attempts + 1`, `nextAttemptAt` per [section 8.4](#84-backoff-and-blocking); `BLOCKED` at the 5th |
| 401 | Pairing expired: stop the whole run, row unchanged, no attempt counted; run `errorCode: PAIRING_EXPIRED` |
| 409 `DEVICE_REVOKED` | Stop the whole run, forget the pairing; `errorCode: DEVICE_REVOKED` |
| 403 on a `circleId` (not a collaborator) | Stop the run with `errorCode: TARGET_CIRCLE_FORBIDDEN`, surfaced in the check-in and diagnostics; rows unchanged |
| 400 or 413 validation (file type rejected, size) | `BLOCKED` immediately with `lastError` |
| `SecurityException` or `FileNotFoundException` on the URI | File gone or permission revoked: remove the row (vanished) or set the permission flag |

### 9.6 Logging

Write to `AppLog` ([section 13.5](#135-applog-and-redaction)): file id, sizes, part numbers and HTTP status only. Never log URLs with query strings (presigned URLs carry credentials) and never log tokens.

## 10. Scheduling and background rules

`MediaSyncScheduler` (WorkManager, behind a `SyncScheduling` interface for tests) and `MediaSyncWorker` (#512).

### 10.1 Constraints

Rebuilt from the current config every time work is enqueued:

| Config | Constraint |
|---|---|
| `network = 'wifi'` | `NetworkType.UNMETERED` |
| `network = 'any'` | `NetworkType.CONNECTED` |
| `requireCharging` | `setRequiresCharging(true)` |
| always | `setRequiresStorageNotLow(true)` |

### 10.2 Work

| Work | Unique name | Spec |
|---|---|---|
| Periodic catch-up | `media-sync-periodic` | `PeriodicWorkRequest` every **6 h**, flex 1 h, `BackoffPolicy.EXPONENTIAL` 60 s. Policy `UPDATE` when the constraints hash changed, else `KEEP` |
| New-media trigger | `media-sync-trigger` | `OneTimeWorkRequest<MediaContentTriggerWorker>` with `addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)` and the same for `Video` (descendants included), `setTriggerContentUpdateDelay(15 s)`, `setTriggerContentMaxDelay(2 min)`. The worker enqueues "now" with trigger `content_trigger`, then **re-arms itself** (content-URI work is one-shot). Policy `REPLACE` |
| Now | `media-sync-now` | `OneTimeWorkRequest<MediaSyncWorker>`, `setExpedited(RUN_AS_NON_EXPEDITED_WORK_REQUEST)`. `REPLACE` for manual and remote commands, `KEEP` for app-open and trigger |

- **App-open trigger.** `onAppOpen()` is debounced to **15 minutes**, runs only when paired and not paused. Called from `TwaLauncherActivity` and `MediaSyncActivity`.
- **Re-arm points.** `MobileApplication.onCreate` re-asserts periodic and trigger work (`KEEP`) when paired and not paused. WorkManager persists across reboots, so no boot receiver is needed.
- **Triggers are batched, not instant**, and some OEM battery managers block them; the 6 h periodic catch-up, the `battery.optimization` diagnostic and a prompt to exempt the app mitigate this.

### 10.3 `MediaSyncWorker` run

1. **Check-in before.** `POST /devices/:id/checkin` with current stats, permission, network and battery state (inventory when changed or every 24 h). Apply the returned config through `ConfigApplier` ([section 5.3](#53-configapplier-phone)).
2. If paused: record a `paused` run, return success.
3. If permission is `denied`: record `skipped` with `MEDIA_PERMISSION_MISSING` and post the issue notification (at most once per 24 h).
4. Scan, then upload until the queue is empty, stopped, or the policy blocks.
5. **Foreground.** Call `setForeground(getForegroundInfo())` once more than 1 file or more than 50 MB is pending. Notification channel "Upload progress": "Uploading 3 of 120 · IMG_1234.jpg · 45%", with a **Pause** action through a broadcast receiver to `pause()`. Service type `ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC`. The manifest declares `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` and `POST_NOTIFICATIONS` and merges `androidx.work.impl.foreground.SystemForegroundService` with `foregroundServiceType="dataSync"`. A failure to enter the foreground (for example `ForegroundServiceStartNotAllowedException` on Android 12+) is **not fatal**: log `sync.foreground.denied` and continue as ordinary background work.
6. **Android 15 `dataSync` timeout.** Handle `onStopped` and the `STOP_REASON_FOREGROUND_SERVICE_TIMEOUT` stop reason: persist state (parts are already saved), record the run as `partial` with `FGS_TIMEOUT`, return retry. The periodic and trigger work resume later.
7. **Check-in after**, with the `run` block (trigger, status, counts, `failedSample` ≤50, `errorCode`). Save a local `sync_runs` row.
8. **Result:** `ok`, `partial` and `paused` → success; `RetryLater` (network policy, 5xx) → retry while `runAttemptCount < 4`; `Unpaired` → cancel all work, success; `Failed` → failure. Then `AutoDiagnostics.afterRun(outcome)` ([section 13.4](#134-autodiagnostics)).

### 10.4 Start/Stop (`SyncControl`)

- **`pause()`**: set local `paused`; cancel `media-sync-now`, `media-sync-trigger` and `media-sync-periodic` (a running upload stops between parts); `POST /devices/:id/commands { action: 'pause' }` so the web reflects it (queued in the outbox if offline).
- **`resume()`**: the reverse, then run "now".
- **Conflict:** the newest wins; the server `configVersion` is authoritative for remote changes and a local toggle immediately goes through the command.

### 10.5 Android version rules

| Android | Rule |
|---|---|
| 8–12 (API 26–32) | `READ_EXTERNAL_STORAGE`; no `RELATIVE_PATH` below API 29 (derive the folder path from `DATA`); no generation columns below API 30 (use the `DATE_MODIFIED` fallback); foreground-service start from the background is restricted on API 31+ (see step 5) |
| 13 (API 33) | Granular `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO`; `POST_NOTIFICATIONS` is a runtime permission, so the foreground notification can be hidden by the user while the service still runs |
| 14 (API 34) | Foreground services must declare a type and the matching permission (`FOREGROUND_SERVICE_DATA_SYNC`); partial media access (`READ_MEDIA_VISUAL_USER_SELECTED`) means MediaStore returns only the selected items |
| 15 (API 35) | `dataSync` foreground services are capped at about **6 hours per 24 h**; the system calls `onTimeout` and the worker stops. The resumable ledger tolerates the cutoff; the run is `partial` with `FGS_TIMEOUT`. `dataSync` services cannot be started from `BOOT_COMPLETED`, which this app never does |
| All | Doze, App Standby buckets and OEM "deep sleep" (Xiaomi, Huawei, Samsung, OnePlus) delay work until the app is exempted from battery optimization |

## 11. Permissions

### 11.1 Manifest

| Permission | Constraint | Why |
|---|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | | Upload and network-policy checks |
| `READ_MEDIA_IMAGES` | API 33+ | Read photos |
| `READ_MEDIA_VIDEO` | API 33+ | Read videos |
| `READ_MEDIA_VISUAL_USER_SELECTED` | API 34+ | Partial access ("Select photos and videos") |
| `READ_EXTERNAL_STORAGE` | `android:maxSdkVersion="32"` | Android 12 and below |
| `ACCESS_MEDIA_LOCATION` | API 29+; requested together with media access | Without it EXIF GPS is redacted from the bytes we upload |
| `POST_NOTIFICATIONS` | API 33+ runtime | Progress and issue notifications |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` | | Long uploads (`dataSync`) |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | | The "exempt this app" prompt (fallbacks to the battery settings list) |

Plus a `<queries>` entry for the Custom Tabs service. No `RECEIVE_BOOT_COMPLETED` (WorkManager persists), no `MANAGE_EXTERNAL_STORAGE`.

### 11.2 Permission state

`permissionState()`:

| Android | `Full` | `Partial` | `Denied` |
|---|---|---|---|
| 14+ | `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` granted | `READ_MEDIA_VISUAL_USER_SELECTED` granted without them, or only one of the two | none |
| 13 | both granted | exactly one granted | none |
| 12 and below | `READ_EXTERNAL_STORAGE` granted | n/a | not granted |

Under `partial` the app syncs the selected items, says so ("only selected photos sync"), disables vanished detection, and offers "Allow access to all photos". The permission itself can only be granted in the native UI; Android requires it, which is why the web cannot do it.

### 11.3 Sideload only

Google Play restricts `READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO` to apps whose core purpose needs broad access and otherwise expects the system photo picker. A backup app qualifies in principle, but the declaration and review are out of scope. The app is distributed from the deployment itself (and, secondarily, a GitHub prerelease).

### 11.4 Privacy

What leaves the phone: the file bytes, its path (`sourcePath`), its capture date, the device name, and (with `ACCESS_MEDIA_LOCATION`) embedded GPS. Nothing is uploaded from folders that are not selected. Tokens are stored encrypted and never logged.

## 12. Native UI map

### 12.1 Shortcuts

Static shortcuts are generated per variant by a `GenerateShortcutsTask` copied from evopath (`res/xml/shortcuts.xml`, because a static shortcut must name the package and class literally) and attached to the launcher `activity-alias` (`android.app.shortcuts`).

| Shortcut ID | Label | Deep link |
|---|---|---|
| `media_sync` | "Media sync" (long label "Media sync & pairing") | `memoriahub://media-sync` |
| `diagnostics` | "Diagnostics" | `memoriahub://media-sync/diagnostics` |

Dynamic shortcuts (`ShortcutManagerCompat`), published only when paired and refreshed when the paused state changes: "Sync now" → `memoriahub://media-sync?action=sync`; "Pause sync" or "Resume sync" → `?action=pause|resume`. The launcher entry is `<activity-alias android:name="${applicationId}.TwaLauncherActivity" android:targetActivity=".TwaLauncherActivity" exported=true>` with MAIN/LAUNCHER; the stable alias keeps home-screen icons alive across refactors.

### 12.2 Deep links

`MediaSyncActivity` (`exported=true`, `launchMode=singleTask`) has a VIEW, DEFAULT, BROWSABLE filter on `scheme=memoriahub host=media-sync`.

| URI | Opens |
|---|---|
| `memoriahub://media-sync` (also `/`) | Hub |
| `memoriahub://media-sync/connect` | Connect (pairing) |
| `memoriahub://media-sync/paired` | Hub after pairing; triggers an immediate poll (`pokeNow()`). Used as the device-flow `returnUri` |
| `memoriahub://media-sync/folders` | Folders |
| `memoriahub://media-sync/network` | Network and power |
| `memoriahub://media-sync/files` | Files |
| `memoriahub://media-sync/diagnostics` | Diagnostics |

An optional `?action=` runs after the screen opens:

| Action | Effect |
|---|---|
| `apply` | Immediate check-in to apply the desired config; snackbar "Settings applied" |
| `sync` | `syncNow(MANUAL)` |
| `retry` | `retryFailed()` then `syncNow` |
| `pause` | `SyncControl.pause()` |
| `resume` | `SyncControl.resume()` |

Intent extras also open a screen: `EXTRA_OPEN` = `hub \| connect \| folders \| network \| files \| diagnostics` (used by notification content intents). Intent parsing is a pure function covered by a unit test for every path and action. Paths and actions are the web's `mediaSyncDeepLink(path?, action?)` inputs.

### 12.3 Hub

`MediaSyncActivity` is a single activity with an in-memory screen enum `Hub, Connect, Folders, Network, Files, Diagnostics`, a `BackHandler` back to Hub and a brand-coloured `TopAppBar` with Back. No NavHost (same as evopath). `onCreate`: `MediaSyncScheduler.onAppOpen`, `AppUpdates.onAppOpen`, route the deep-link path or `EXTRA_OPEN`. `onResume`: refresh pairing, ledger stats, permission state, diagnostics and the available update. `onNewIntent`: handle new paths and actions.

Hub, top to bottom:

1. **Update card** when a newer release exists.
2. **Server card:** the URL, plus "Change" opening the `ServerUrlEditor` dialog.
3. **Pairing card:** "Paired. Token expires <date>." / "Pairing expired…" / "Not paired with your MemoriaHub account yet." → **Connect** or **Pairing and permissions**.
4. **Media sync card:** big counts **Synced N**, **Missing N**, Failed N, Blocked N, "X GB left"; a status line (Idle / Syncing with live progress / Paused / Waiting for Wi-Fi / Waiting for charging / Permission needed / Partial access); the primary button **Stop syncing** or **Start syncing**, then **Sync now**; buttons **Folders (n selected)**, **Network & power**, **Files**, **Diagnostics**; the `HealthLine` ("All checks pass" or "N problems, open Diagnostics", red when any check fails, where N = failing + warning checks); the target circle name (read-only here, changed on the web).
5. **Open MemoriaHub** (starts `TwaLauncherActivity`).
6. **Version footer:** "MemoriaHub 2.0.0 (100)".

### 12.4 Screens

- **Connect:** from [section 7](#7-pairing), plus "Allow access to photos and videos" (full or partial handling; on partial, "Allow access to all photos" opens the system picker or app settings), `ACCESS_MEDIA_LOCATION`, and the notifications permission.
- **Folders:** a checklist from the live `inventory()`: name, relative path, "1,234 photos · 56 videos", uploaded/total per folder; search; **Select all** / **None**; toggles Include photos / Include videos. Save writes locally, `PATCH /api/media-sync/devices/:id/config` with the PAT (the PAT is allowed on this route), then `ledger.applyFolderSelection` and sync now. Offline edits wait in the outbox ([section 5.2](#52-versioning-model)).
- **Network & power:** radio **Wi-Fi only** (default) or **Wi-Fi and mobile data** ("Large videos can use a lot of mobile data"); switch **Only while charging**; Upload existing: "All photos and videos in selected folders" or "Only new ones taken from now on" (confirm dialog because existing rows become `EXCLUDED`); a toggle for the "photos backed up" summary notification. Saving PATCHes the config and rebuilds constraints.
- **Files:** tabs with counts **Missing**, **Failed**, **Blocked**, **Synced**, **All**; a paged list from Room (thumbnail via `ContentResolver.loadThumbnail`, name, folder, size, status chip, attempts, `lastError`, "next retry in 9 min"); per-row **Retry**; toolbar **Retry all failed** and **Retry blocked**. Tapping a synced item opens `$server/media` in the TWA (the gallery; there is no per-item web route today).
- **Theme:** `ui/theme/AppTheme`, Material3 colours from `BuildConfig.THEME_COLOR`, light and dark.

### 12.5 Notifications

| Channel | Importance | Use |
|---|---|---|
| Upload progress | low | Foreground service |
| Sync issues | default | Permission lost, pairing expired, uploads blocked, target circle forbidden, battery restricted |

Issue notifications are throttled to at most one per type per 24 h and their content intents use `EXTRA_OPEN` or a deep link to the right screen. A summary notification ("12 photos backed up to <circle>", low importance, togglable) follows a background run that uploads at least one file.

### 12.6 TWA shell and Setup

- `TwaLauncherActivity` extends `com.google.androidbrowserhelper.trusted.LauncherActivity`; `shouldLaunchImmediately() = serverUrl != null`; `getLaunchingUrl()` returns `"$server/?source=twa&appVersion=<enc>&appVersionCode=<n>"` (presentation only, never authorization). With no server configured it starts `SetupActivity` and finishes. On a fresh create it calls `MediaSyncScheduler.onAppOpen` and `AppUpdates.onAppOpen`.
- Manifest meta-data on the activity and the alias: `DEFAULT_URL`, `STATUS_BAR_COLOR` = brand primary, `NAVIGATION_BAR_COLOR` = brand background, `NAVIGATION_BAR_COLOR_DARK` = brand primary, `SPLASH_SCREEN_BACKGROUND_COLOR` = brand background. The `DelegationService` is declared so PWA notifications appear as app notifications. Adaptive launcher icons are generated from `apps/web/public/icons/icon-maskable-512.png` plus a monochrome layer.
- `SetupActivity`: "Welcome to MemoriaHub", "Enter the address of your MemoriaHub server…", **Save and open** (launches the TWA with `NEW_TASK|CLEAR_TASK`). `ServerUrls.normalize()` accepts **https origins only** (no path, query or credentials) because TWA and Digital Asset Links require https. `ServerConfig` keeps plain prefs `memoriahub_config`; a URL the user saved wins over `BuildConfig.DEFAULT_SERVER_URL` (`-Papp.serverUrl`, empty by default).
- `android:allowBackup="false"`; `data_extraction_rules.xml` and `backup_rules.xml` exclude all shared preferences and Room databases; `network_security_config` permits cleartext only for debug builds on `10.0.2.2` and `localhost`.
- `ApiClient` (OkHttp plus kotlinx.serialization) reads the base URL and token on every request, adds `Authorization: Bearer <pat>` only when `authenticated = true`, unwraps the `{ data }` envelope, parses errors into `ApiError(kind, httpStatus, code, reason = details.reason, oauthError)`, logs only method, path, status and code (never a body). `ApiResult` is `Success` or `Failure`, never throws.
- Signing comes **only** from `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`; with any missing, the release APK is built **unsigned with a warning**, never a failure. The release build uses `isMinifyEnabled = true` and `isShrinkResources = true`; ProGuard keeps the serializers and `CoroutineWorker` constructors. `scripts/build-meta.sh` prints `product`, `slug`, `version_name`, `version_code` for CI.

## 13. Diagnostics

A direct port of the evopath diagnostics (#514). The phone runs a self-test; the user or an automatic trigger uploads the report; the web renders it.

### 13.1 Check model

`CheckResult { id, label, status: pass | warn | fail | skip, detail, remedy?, data? }`, serialized. A phone-only `CheckAction` enum drives the fix button. `probe(timeoutMs) { … }` runs each probe in a detached scope with a hard deadline and **never throws**; a timeout becomes a `fail` with detail. Every verdict is a **pure function** in `Checks.kt`. `SelfTest` runs the probes in parallel (live, device, assetlinks, work, release, ledger) and builds `SelfTestResult` with pass/warn/fail counts and `problemCount` (warn + fail); it feeds the Hub `HealthLine`.

### 13.2 Check catalogue

| id | Label | Rule | Action |
|---|---|---|---|
| `app.version` | App version | info: name (code) | none |
| `app.update` | App update | warn when the current release `versionCode` is greater than the installed one; `skip` when there is no release, the release is for another package, the phone is not paired, or the check fails | `GET_UPDATE` |
| `server.configured` | Server address | fail when unset | `SET_SERVER` |
| `server.reachable` | Server reachable | `GET /api/health/live` within 5 s; fail otherwise | none |
| `pairing.token` | Pairing token | fail when there is no token; warn when it expires in under 14 days | `REPAIR` |
| `auth.valid` | Token accepted | `GET /api/media-sync/devices/:id`: 401 fails (expired), 409 or 404 fails (revoked) | `REPAIR` |
| `api.connection` | API connection | the last check-in succeeded within 24 h | `SYNC_NOW` |
| `media.permission` | Photo & video access | `full` passes, `partial` warns ("only selected photos sync"), `denied` fails | `GRANT_MEDIA` |
| `media.location` | Photo location access | warn when `ACCESS_MEDIA_LOCATION` is not granted (GPS stripped) | `GRANT_MEDIA` |
| `media.folders` | Folders selected | fail when 0 selected; warn when a selected bucket no longer exists | `CHOOSE_FOLDERS` |
| `media.trigger` | New-photo trigger | the `media-sync-trigger` work is `ENQUEUED` (`getWorkInfosForUniqueWork`); fail otherwise, unless paused | `SYNC_NOW` (re-arms) |
| `work.periodic` | Background sync scheduled | `media-sync-periodic` is enqueued | `SYNC_NOW` |
| `sync.paused` | Sync state | warn when paused | `RESUME` |
| `network.policy` | Network | warn when "Wi-Fi only" is set, the device is on cellular, and there are pending files | `NETWORK_SETTINGS` |
| `battery.optimization` | Battery optimization | warn when the app is not exempt | `BATTERY_SETTINGS` |
| `notifications.permission` | Notifications | warn when denied (Android 13+) | `NOTIFICATION_SETTINGS` |
| `sync.last` | Last sync | warn when the last `ok` run is older than 24 h with pending files; fail on 3 consecutive failed runs | `SYNC_NOW` |
| `upload.backlog` | Upload backlog | warn when `failed > 0`, fail when `blocked > 0` (with counts) | `RETRY_FAILED` |
| `upload.stalled` | Stalled uploads | warn when a row has been `UPLOADING` with no part progress for more than 1 h | `RETRY_FAILED` |
| `upload.target` | Target circle | fail on the last `TARGET_CIRCLE_FORBIDDEN` | `OPEN_WEB_SETTINGS` |
| `storage.space` | Free space | info; warn under 500 MB (hashing and temp files) | none |
| `twa.verification` | Full-screen web app (Digital Asset Links) | fetch `$server/.well-known/assetlinks.json`, parse it, check that this package plus signing SHA-256 is present. **Warn only, never fail** | `OPEN_ANDROID_APP_ADMIN` |

`CheckAction`: `SET_SERVER`, `REPAIR`, `GRANT_MEDIA`, `CHOOSE_FOLDERS`, `RESUME`, `RETRY_FAILED`, `NETWORK_SETTINGS`, `BATTERY_SETTINGS` (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` with fallbacks), `NOTIFICATION_SETTINGS`, `SYNC_NOW`, `GET_UPDATE`, `OPEN_WEB_SETTINGS` (the TWA at `/settings/media-sync`), `OPEN_ANDROID_APP_ADMIN` (the TWA at `/admin/settings/android`).

### 13.3 Diagnostics screen

Same layout as evopath's `DiagnosticsScreen`: (1) summary card with pass, warn and fail counts and **Run self-test** ("Checking…" while running); (2) check rows sorted fail, then warn, then pass, each with a status icon and colour, the label, detail, remedy and an action button; (3) inventory card per selected folder ("photos · videos · uploaded/total · last file"); (4) recent runs card (last 10 local `sync_runs`); (5) log card (last ~100 `AppLog` lines plus **Refresh log**); (6) buttons **Sync now**, **Upload report** (then "Report uploaded (id abc12345…)" plus **Open Media sync settings**), **Share report** (`ACTION_SEND`), **Copy to clipboard** (marked `EXTRA_IS_SENSITIVE` on Android 13+), **Reset local sync state** (confirm dialog, calls `ledger.resetLocalState()`).

`DiagnosticReport` is JSON: app, device, config (no token), stats, checks, inventory, recent runs, log tail, kept under 200 KB (the log is halved first, then the runs, the inventory and the checks' `data`; redaction runs on every string of the JSON tree so a masked URL never breaks the document), uploaded with `POST /api/media-sync/devices/:id/diagnostics { summary, report }` (`summary` ≤500, report ≤256 KB serialized; 201 `{ id, createdAt }`).

### 13.4 `AutoDiagnostics`

After a run that failed or was partial, upload a report **at most every 6 hours**, only when paired and `/api/health/live` answers. The throttle counts from the attempt, not the success.

Integration: the sync worker (#512) calls `MobileApplication.autoDiagnostics.onRunFinished(status)` with the run's check-in `status` (`ok`, `partial`, `failed`, `skipped`, `paused`) after recording the run. It returns at once, ignores anything but `failed` and `partial`, and runs the self-test and upload on the app scope; it never throws. The last attempt time is kept in plain prefs `<prefix>_diagnostics`.

### 13.5 `AppLog` and redaction

`Redaction` masks `pat_…`, `Bearer …` and any URL query string (presigned URLs). `RollingLog` keeps at most 1,000 lines in a file. Sensitive data never goes through `android.util.Log`. Event names (the first token of a log line, followed by `key=value` pairs):

| Event | Fields |
|---|---|
| `app.start` | `version`, `sdk` |
| `pairing.code`, `pairing.approved`, `pairing.registered`, `pairing.unpaired`, `pairing.expired` | `deviceId` (never the token) |
| `config.applied` | `configVersion`, `folders`, `network`, `paused` |
| `scan.done` | `mode` (`incremental`/`full`), `rows`, `new`, `ms` |
| `run.start`, `run.end` | `trigger`, `status`, `uploaded`, `failed`, `deduplicated`, `errorCode` |
| `upload.start`, `upload.part`, `upload.resume`, `upload.complete`, `upload.dedup`, `upload.fail` | file id, sizes, part number, HTTP status |
| `sync.foreground.denied`, `sync.fgs.timeout`, `sync.network.stop` | |
| `checkin.ok`, `checkin.fail` | `appliedConfigVersion`, status |

### 13.6 Updates

`ReleaseApi.latest()` calls `GET /api/android-app/releases/latest` (PAT) on app open and Hub resume, at most every 12 h, only while paired. `isUpdate(release, ownPackage, ownVersionCode)` must be true to show anything (the package must match, so a debug build never sees the release). The **Update card** says "MemoriaHub 2.1.0 is available (you have 2.0.0 (100))" with size and notes and **Get the update**, which calls `POST …/releases/:id/download-link`, validates that `downloadUrl()` is **same-origin** as the server, then opens it with `ACTION_VIEW` in the browser. The system downloads the APK and hands it to the package installer.

## 14. Release model

The **core flow** is the CLI (#517); the admin page (#516) and CI (#518) are secondary.

```
git clone https://github.com/marinoscar/MemoriaHub.git && cd MemoriaHub
memoriahub login
memoriahub android doctor --fix      # installs the Android SDK (+ JDK on Debian/Ubuntu)
memoriahub android keystore init     # once; BACK UP ~/.memoriahub/android/
memoriahub android release --bump patch --notes "…"
```

### 14.1 CLI

- Code: `apps/cli/src/commands/android.ts`, logic in `apps/cli/src/android/`.
- **State** `~/.memoriahub/android/` (mode 0700; respects `MEMORIAHUB_STATE_DIR`); **SDK** `~/.memoriahub/android-sdk/` unless `ANDROID_HOME` or `ANDROID_SDK_ROOT` is set; **credentials** from the existing `loadConfig()`.
- **Repo checkout resolution** (`paths.ts`): `--repo <path>`, then `MEMORIAHUB_REPO_ROOT`, then walk up from the cwd to the nearest ancestor containing `apps/android/version.properties`; else exit code **6** with "No MemoriaHub checkout found. Clone the repo … or pass `--repo <path>`." Commands needing no checkout (`releases`, `releases current`, `publish <apk>`, `keystore …`) work anywhere.

| Command | Behaviour |
|---|---|
| `android doctor [--fix] [--dry-run] [--json]` | Checks `repo`, `gradlew`, `version`, `jdk` (17+), `sdk` parts (`platform-tools`, `platforms;android-36`, `build-tools;36.0.0`, `apksigner`), `keystore`, `fingerprint`, `login` (hint only). Exit 6 on a required failure. `--fix` prints a plan then continues only with `--yes` or a confirm: downloads `commandlinetools` `13114758`, accepts licences, installs the packages; on Debian/Ubuntu installs `openjdk-17-jdk-headless` through apt using `runWithSudoAnnounced()` (every privileged command printed first); other OSes get instructions only. Never creates a keystore. `--json`: `{ ok, checks: [{ id, label, status, detail, fix? }] }` |
| `android keystore init [--alias] [--dname]` | `keytool -genkeypair -keyalg RSA -keysize 4096 -validity 36500` into `~/.memoriahub/android/release.jks`; `signing.json` (mode 0600); default alias `memoriahub`; password from `ANDROID_KEYSTORE_PASSWORD`, a prompt, or 24 random bytes base64url; **refuses to overwrite**; prints "BACK UP THIS FILE. Losing it forces every user to uninstall and reinstall." |
| `android keystore import <file> [--alias]` | Verifies with `keytool -list -v` before copying |
| `android keystore show` | Path, alias, SHA-256 (colon form) |
| `android keystore secrets` | Prints `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` for the GitHub secrets, with a warning |
| `android version [--bump patch\|minor\|major] [--set x.y.z] [--code n] [--json]` | Edits `version.properties`. **Every bump or set also does `versionCode += 1`**; `--code` must increase; no flags prints the current version |
| `android build [--server-url <url>] [--debug]` | `gradlew assembleRelease\|assembleDebug -Papp.versionName=… -Papp.versionCode=… [-Papp.serverUrl=…] --console=plain` plus `$MEMORIAHUB_GRADLE_ARGS`; child env carries the SDK and signing variables; verifies with `apksigner verify --print-certs` that the signer equals the keystore fingerprint; copies to `dist/android/memoriahub-android-<ver>.apk` and writes a sidecar `.json` `{ packageName, versionName, versionCode, signingSha256, fileSha256, sizeBytes, builtAt, gitSha }`. **In the sidecar `signingSha256` is lowercase hex with no colons**; the server normalises it |
| `android publish [apk] [--notes] [--no-current] [--force]` | Defaults to the newest APK in `dist/android`; multipart `POST /api/admin/android-app/releases` with text fields first, then `apk`, streamed with a 15-minute timeout; maps `RELEASE_VERSION_EXISTS` / `RELEASE_VERSION_NOT_NEWER` to the hint "run `memoriahub android version --bump patch`"; pre-checks `system_settings:write` through `GET /api/auth/me` |
| `android releases [--json]`, `android releases current <id> [--yes]` | List with the current marked; make current is the **rollback**, confirming when the code is lower (`--yes` skips the question; without a terminal a lower code needs `--yes`) |
| `android release [--bump …] [--notes] [--server-url] [--no-commit]` | (1) Pre-checks **before any bump**: repo, doctor essentials (jdk, sdk, keystore), logged in with `system_settings:write`, and the post-bump local `versionCode` above the server's current (`GET /api/android-app/releases/latest`, 404 `NO_RELEASE` meaning none); (2) bump, build, publish (make current; the server auto-trusts the signer); (3) `git commit -- apps/android/version.properties -m "chore(android): release <name> (<code>)"` unless `--no-commit` (not pushed). A failure after the bump prints how to retry without bumping again (`android build && android publish`). `--bump` is optional: without it the current version is released when it is already newer than the server's, so re-running with no changes is refused before any work ("not newer, pass `--bump`") |

- **Exit codes:** 0 ok, 1 a tool or server failure, 2 bad usage, 6 a precondition (no checkout, toolchain, keystore, login, not newer). In `doctor`, a missing keystore is a **warning** (debug builds need none and `--fix` never creates one); `release` requires it.
- **TUI:** an `android` action and a menu entry "Android app (build, publish, releases)" in `tui/menu-config.ts`; long-running steps spawn the CLI itself as a child with piped output rendered as Ink `<Text>` lines (Ink owns stdout and stdin; never `stdio: 'inherit'`); status rows Checkout, Local version, Keystore, Login/server, Server current release, Newer?; actions doctor, bump, build, publish, **release** (default highlighted), releases (with rollback), login. Confirmations default to No.
- **CLI versioning:** every CLI change bumps `apps/cli/package.json` by one patch and runs `npm install --package-lock-only`. **Out of scope: a CLI `deploy` command or `deploy --with-android`**; do not build.

### 14.2 The four release routes

1. `memoriahub android release` (recommended, core).
2. `android build`, then `android publish`.
3. The admin page upload at `/admin/settings/android` (accepts an `.apk` plus the CLI's sidecar JSON to auto-fill).
4. CI → GitHub prerelease `android-latest`. **CI never publishes to a MemoriaHub server** (it would need a long-lived admin PAT per deployment).

### 14.3 CI workflow

`.github/workflows/android.yml` (#518). Triggers: push or pull_request to `main` with paths `apps/android/**`, `apps/web/pwa/manifest.ts` (the build checks the brand colours against it) and the workflow file, and `workflow_dispatch`. Job `test`: checkout, Temurin 21 with Gradle cache, `android-actions/setup-android@v3` with explicit `packages: 'platform-tools platforms;android-36 build-tools;36.0.0'` (the default list fails), `scripts/build-meta.sh`, `./gradlew --no-daemon testDebugUnitTest assembleDebug`, upload reports on failure and the artifact `memoriahub-android-debug`. Job `release` (after `test`, only on `main` pushes, `permissions: contents: write`, `concurrency: android-release`): skip with `::warning::` when any of `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` is missing (never fail); decode to `$RUNNER_TEMP/release.jks`; `./gradlew --no-daemon assembleRelease` with **no version override** (the committed `version.properties` rules); `apksigner verify --print-certs`; `rm -f` the keystore under `if: always()`; upload the artifact `memoriahub-android`; force-push **only** the tag `android-latest`; `gh release upload android-latest … --clobber` (or create it as `--prerelease --latest=false`).

### 14.4 Version and rollback rules

- `versionCode` strictly increases for every published APK; Android refuses to install a lower code over a higher one. The server refuses a duplicate and, as current, a non-newer code unless forced.
- **Rollback** is `android releases current <id>` or the admin "Make current". Phones never auto-downgrade; users must reinstall.
- **Trust** follows the release: making a release current adds its `(packageName, signingSha256)` to `trustedApps` (while the list has room). A debug build (`….debug`) has a different package and must be trusted by hand.
- The signing key is the trust anchor; lose it and installed copies can never be updated.

## 15. Web surfaces

### 15.1 TWA awareness (presentation only, never authorization)

- `utils/twa.ts`: `captureTwaLaunch()` once in `main.tsx` (reads `?source=twa&appVersion=&appVersionCode=`, stores to `sessionStorage` keys `memoriahub.twa`, `memoriahub.twa.appVersion`, `memoriahub.twa.appVersionCode`, strips them with `history.replaceState`); `isRunningInTwa()` (flag `'1'` or `document.referrer.startsWith('android-app://')`); `getInstalledAppVersion()`.
- `utils/androidIdentity.ts` as in [section 2](#2-identity).
- `InstallPrompt` is never shown inside the TWA.

### 15.2 Routes and components

| Route | Component | Gate | Notes |
|---|---|---|---|
| `/settings` | `AndroidAppPanel` section, `id="android-app"` (after Notifications) | signed in | No device: "Get the MemoriaHub Android app" with the version and **Download** (to `/settings/android-app`). Devices: compact list (name, Synced N / Missing N, last seen, status chip) and **Manage** (to `/settings/media-sync`). Inside the TWA: **Open Media sync on this phone**, **Diagnostics on this phone** |
| `/settings/android-app` | `AndroidAppDownloadPage` | signed in | Latest release (version name and code, size, notes, copyable SHA-256, date); `DownloadApkButton` calls `POST …/download-link` then `window.location.assign(url)` (it **navigates**, never fetches a blob, so Android hands the file to the installer); install steps (allow installs from your browser; open the file; **uninstall the older v1 app `cr.marin.memoriahub`**, which keeps syncing on its own otherwise; open the app and enter this server's address, shown with a copy button from `window.location.origin`); inside the TWA, "You're up to date (2.0.0)" or "Update available"; on 404 `NO_RELEASE`, "No Android release has been published yet." with an admin link to `/admin/settings/android` |
| `/settings/media-sync` | `MediaSyncPage` | `RequirePermission('media:read')`; write controls disabled without `media:write` | One `DeviceCard` per device (below). Refetch every 30 s while visible |
| `/admin/settings/android` | `AndroidAppPage` | `ADMIN_SECTIONS` entry `{ title: 'Android app', permission: 'system_settings:read', path: '/admin/settings/android' }` in the General group; writes gated inside the page by `system_settings:write` | Releases section (current card, upload form with progress, table with Make current and Delete, rollback confirm, force flow on `RELEASE_VERSION_NOT_NEWER`) and Trusted signing keys section (trusted list with add and remove, reported apps with one-click **Trust**, the live `assetlinks.json` preview). Uses the shared `AdminPageHeader`. The "N devices behind" count is omitted in v1 (no admin device aggregate exists) |

`DeviceCard`: header (name and model, app version, `RunStatusChip`, last seen, "Update available" chip, "Pairing expires in N days" under 14 days); count tiles **Synced**, **Missing**, Failed, Blocked, "X GB left" and a progress bar (synced / eligible); a status line (Paused / Waiting for Wi-Fi when `network = 'wifi'` and `networkState = 'cellular'` with pending files / Partial or No photo access / Battery restricted / "Changes pending, will apply next time the phone checks in" while `configPending`); controls **Stop/Start syncing** (`commands pause|resume`), **Retry failed** (`retry_failed`), **Sync now** (`sync_now`), and inside the TWA **Apply now on this phone** (`memoriahub://media-sync?action=apply|sync|retry|pause|resume`); the config editor (target circle select limited to circles where the user is collaborator or admin; folders checklist from `device.inventory` with search and Select all / None, empty state "Open the app on your phone once so it can report its folders"; Include photos and videos; Network radios with a data-usage note; Only while charging; Upload existing) whose Save calls `PATCH /devices/:id/config` and maps 400 `UNKNOWN_FOLDER` (`details.bucketIds`) and 403 `TARGET_CIRCLE_FORBIDDEN` to field errors; the last run's `failedSample` table with **Retry failed** and, inside the TWA, **Open file list on this phone**; sync history (`GET …/runs`); diagnostics (`GET …/diagnostics` list and `DiagnosticReportViewer`: checks sorted fail, warn, pass, plus raw JSON; inside the TWA **Run diagnostics on this phone**); **Unpair** (`UnpairDialog`: "The phone stops syncing; already uploaded media stays").

`AndroidUpdateBanner` is mounted in `Layout.tsx` and shown **only inside the TWA** when `getInstalledAppVersion().code` is lower than `latest.versionCode`: "A new version of the MemoriaHub app is available" with **Update** (to `/settings/android-app`). Dismissal is stored per `versionCode` in `localStorage['memoriahub.androidUpdate.dismissedVersionCode']`.

Services and hooks: `services/mediaSync.ts`, `services/androidApp.ts` (types mirror the API DTOs), `useMediaSyncDevices`, `useDeviceRuns`, `useDeviceDiagnostics`, `useLatestRelease` (null on 404). Tab bars spread `scrollableTabsProps`; layouts work at 360 px with no horizontal scroll. Routes register their titles in the AppBar title resolver. MemoriaHub's user settings is a stacked page, so this feature follows that pattern and adds sub-routes rather than migrating it to a registry hub.

## 16. RBAC and security

| Capability | Permission | Per-circle role |
|---|---|---|
| Register, check in, configure, command, unpair a device; post a diagnostic report | `media:write` | `collaborator` on `targetCircleId` for config |
| List and read devices, runs and reports | `media:read` | |
| Upload bytes (`storage/objects/*`) | `storage:write` | |
| Register a media item | `media:write` | `collaborator` on `circleId` |
| Latest release and download link | signed in | |
| Trusted apps and releases (list, upload, make current, delete) | `system_settings:read` / `system_settings:write` | |

- **No new permission and no new environment variable.** A device is inherently personal; every `:id` route resolves the device by `id` **and** the caller's `userId` and answers **404, not 403**, for another user's device (enumeration-resistant).
- **Two independent credentials** (web JWT, native `pat_`); the PAT is minted through the device flow, device-scoped, revocable, and never reaches anything its owner could not already reach.
- **Attribution cannot be spoofed:** `sourceDeviceId` must be an active device of the caller (`UNKNOWN_SOURCE_DEVICE`); the provider string and device ids are never trusted from the payload; the reported package and fingerprint are informational, only an admin's trust decision or a current release changes `assetlinks.json`.
- **Logs redact** `pat_` and `Bearer`; the server logs ids and counts only; presigned URLs are never logged.
- **Backups are disabled** on the phone; tokens live in `EncryptedSharedPreferences`.
- **The APK is never buffered**, on the server or anywhere; downloads use a short-lived signed same-origin token and never expose a bucket URL.
- **Maintenance mode:** `assetlinks.json` is exempt (Chrome caches a failed verification, so a 503 would leave installed apps with a URL bar long after the window); the APK download is not.

## 17. Error codes

Wire format: `{ statusCode, code, message, details: { reason, … } }`. `code` is status-derived; **clients key off `details.reason`**.

### 17.1 Media Sync

| HTTP | `details.reason` | When | Extra `details` |
|---|---|---|---|
| 400 | `PAT_REQUIRED` | Register or check-in with a JWT, or check-in with a PAT that is not the device's | |
| 400 | `UNKNOWN_FOLDER` | `folders[].bucketId` absent from the reported inventory | `bucketIds` |
| 400 | `INVENTORY_NOT_ALLOWED` | A JWT caller sent `inventory` to `PATCH config` | |
| 400 | `UNKNOWN_SOURCE_DEVICE` | `POST /api/media` with `source: 'android'` and a `sourceDeviceId` that is not an active device of the caller | |
| 403 | `TARGET_CIRCLE_FORBIDDEN` | Caller is not a collaborator of `targetCircleId` (also returned by `POST /api/media` for a circle the caller cannot write) | `circleId` |
| 404 | (none) | Another user's device, run or report; a device-linked PAT used with another device's id | |
| 409 | `DEVICE_REVOKED` | Check-in for a revoked device | |

### 17.2 Android app and releases

| HTTP | `details.reason` | When |
|---|---|---|
| 400 | `INVALID_FINGERPRINT`, `INVALID_PACKAGE_NAME`, `TOO_MANY_TRUSTED_APPS` | `PUT /admin/android-app` validation |
| 400 | `RELEASE_NOT_AN_APK` | First bytes are not `PK\x03\x04` |
| 400 | `RELEASE_INVALID_UPLOAD` | Malformed multipart (fields after the file, missing file, bad field) |
| 413 | `RELEASE_TOO_LARGE` | Over 150 MiB |
| 404 | `NO_RELEASE` | No current release |
| 404 | `DOWNLOAD_LINK_INVALID` | Bad or tampered token (checked before expiry) |
| 410 | `DOWNLOAD_LINK_EXPIRED` | Valid signature, expired |
| 409 | `RELEASE_VERSION_EXISTS` | `(packageName, versionCode)` exists |
| 409 | `RELEASE_VERSION_NOT_NEWER` | As current, not above the current release of the same package, and not forced |
| 409 | `RELEASE_IS_CURRENT` | Delete of the current release |
| 409 | `RELEASE_CURRENT_CONFLICT` | Concurrent make-current lost the race (P2002 on the partial index) |
| 503 | `STORAGE_NOT_CONFIGURED` | Upload with no storage provider |

### 17.3 Storage

| HTTP | `details.reason` | When | Extra `details` |
|---|---|---|---|
| 400 | `UPLOAD_NOT_ACTIVE` | Part PUT for an object that is not `pending`/`uploading` | |
| 400 | `PART_OUT_OF_RANGE` | `partNumber` outside `1..totalParts` | |
| 400 | `PART_SIZE_MISMATCH` | Part size differs from `partSize` (and is not the last part) | |
| 403 | (none) | Not the object's uploader | |
| 409 | `UPLOAD_PARTS_MISSING` | `complete` on the local provider with a missing or mismatched part | `partNumbers` |
| 409 | `UPLOAD_SESSION_INVALID` | `complete` where the provider forgot the multipart session or the ETags are not its own | |

### 17.4 Run error codes

Phone-originated values for `run.errorCode` (≤64 chars) and `sync_runs.errorCode`:

| Code | Meaning | Typical status |
|---|---|---|
| `MEDIA_PERMISSION_MISSING` | Permission `denied` at run start; nothing read | `skipped` |
| `FGS_TIMEOUT` | Android 15 `dataSync` foreground timeout | `partial` |
| `TARGET_CIRCLE_FORBIDDEN` | 403 uploading to the target circle | `failed` |
| `PAIRING_EXPIRED` | 401 from the server | `failed` |
| `DEVICE_REVOKED` | 409 `DEVICE_REVOKED` | `failed` |
| `NETWORK_POLICY` | Stopped because the network became metered under `wifi` | `partial` |
| `SERVER_UNREACHABLE` | No connection to the server for the whole run | `failed` |
| `UNKNOWN` | Anything else | `failed` |

## 18. Observability

**Server (Pino, structured JSON).** Never log tokens, presigned URLs or file contents.

| Event | Fields |
|---|---|
| `media_sync.checkin` (one per check-in) | `deviceId`, `appliedConfigVersion`, `configVersion`, `stats.pending`, `stats.failed`, `run.status` (when present), `permission`, `networkState` |
| `media_sync.device.registered` | `deviceId`, `reattached`, `repaired` (a previous PAT was revoked) |
| `media_sync.device.revoked` | `deviceId` |
| `media_sync.config.updated`, `media_sync.command` | `deviceId`, `configVersion`, `actor` (`web`\|`device`), `action` |
| `media_sync.diagnostics.stored` | `deviceId`, `reportId`, `bytes` |
| `android_app.assetlinks.served` (debug level) | `statements` |

**Audit events** (`audit_events`): `media_sync.config.updated`, `media_sync.command`, `android_app.trusted_apps.updated`, `android_app.release.uploaded`, `android_app.release.made_current`, `android_app.release.deleted`.

**Doctor** ([section 20](#20-doctor)) is the operator-facing summary. **Phone log events** are listed in [section 13.5](#135-applog-and-redaction). Counters and traces ride the existing OpenTelemetry HTTP instrumentation; no custom metrics are required.

## 19. Configuration

- **Environment variables:** none new. Existing `DEVICE_PAT_TTL_DAYS` (default 90, pairing token lifetime; the earlier `DEVICE_TOKEN_EXPIRY_DAYS` applies only to session tokens), `DEVICE_CODE_EXPIRY_MINUTES`, `DEVICE_CODE_POLL_INTERVAL` and `SECRETS_ENCRYPTION_KEY` (download-link key). Never add an environment variable for storage; it is runtime-configured.
- **System setting:** the `android_app` row (`trustedApps`), edited at `/admin/settings/android`.
- **nginx:** the three groups of locations from sections [6.5](#65-android-app-trusted-apps-assetlinks-releases) and [6.6](#66-endpoints-the-phone-uses-for-upload-and-registration) in **both** `infra/nginx/nginx.conf` and `nginx.prod.conf`: the assetlinks mapping, the release upload and download locations, and the part-upload location. On the production host the outer `proxy-nginx` vhost (generated by `infra/deploy/install.sh` and `update.sh`) proxies `/` to the stack nginx, so no host-level change is needed (to be verified in #503).
- **Build inputs:** `apps/android/identity.properties`, `apps/android/version.properties`, Gradle `-Papp.serverUrl`, `-Papp.versionName`, `-Papp.versionCode`, and the four `ANDROID_KEYSTORE_*`/`ANDROID_KEY_*` signing variables.

## 20. Doctor

A new section in `apps/api/src/doctor/doctor.service.ts` (#507): `SectionDef { key: 'android', label: 'Android app', checkKeys: [...] }` with four checks, each keeping the 10 s `runCheck` timeout and exception normalisation. The section status is the worst of its checks. `docs/specs/doctor.md` and the CLAUDE.md Doctor paragraph counts are updated (#507 or #519).

| Key | Label | Logic |
|---|---|---|
| `android.assetlinks` | Digital Asset Links | **skipped:** no active device has reported a signer. **warning:** some reported `(packageName, signingSha256)` is not in `trustedApps` (up to 3 listed); action item "Trust it in Admin → Settings → Android app". **ok:** every reported pair is trusted. **error:** the settings read failed |
| `android.releases` | Android release | **skipped:** no active device. **warning:** devices exist but no release is current. **ok:** a release is current; the message includes `devicesBehind` (active devices with `appVersionCode` below the current one) |
| `android.mediaSync` | Media sync devices | **skipped:** no active device. **warning:** any active device with `lastSeenAt` older than 48 h, or `stats.blocked > 0`, or `permission != 'full'` (devices and counts named). **ok:** otherwise |
| `android.uploadPath` | Phone upload path | **ok:** the active provider supports presigned parts (S3/R2) or the local provider's API part route is available. **error:** the provider is unconfigured. The message includes the provider key |

## 21. Guardrails and issue map

### 21.1 Required tests (acceptance for the epic)

- API (`npm test --workspace=api`, `npm run test:db --workspace=api`): schema normalisation (lowercase hex, 64-char form, bad package names, more than 10 entries, duplicates, case preserved); public bare-array assetlinks incl. maintenance mode; RBAC 403/404 matrix; `reportedApps` trusted flag; release version-rule matrix, token round trip, tamper → 404, expiry → 410, APK inspector (non-ZIP, over limit, sha256), upload then list then `latest` then link then identical bytes, delete-current 409, make-current auto-trust, BigInt serialization, concurrent make-current produces one current (`*.db.spec.ts`); device register, re-pair PAT revocation, unpair, PAT-to-device scoping, config validation, commands, runs capped at 200 and reports at 20, revoked check-in 409, concurrent registration produces one row (`*.db.spec.ts`); `POST /api/media` with a foreign `sourceDeviceId` → 400; local-provider part upload (init, three bearer parts, status, complete, bytes equal, idempotent retry, missing part 409, other user 403, wrong size 400, S3 path unchanged); device-flow PAT (`apps/api/test/device-auth/device-auth-pat.integration.spec.ts`); Doctor branches.
- Web (`npm run test:run --workspace=web`): `twa.ts`, TWA-only rendering, identity-sync test against `identity.properties`, download flow, no-release state, config editor PATCH body and `UNKNOWN_FOLDER` mapping, commands, counts math, `configPending`, unpair, admin releases and trusted-apps flows, `adminSections` registry test.
- CLI (`npm run test:run --workspace=cli`): repo resolution, version rules, doctor plan, keystore, build arguments and sidecar, publish multipart order and hints, release pre-checks before the bump, TUI model.
- Android (`./gradlew testDebugUnitTest`): `ServerUrlsTest`, `SharedPrefsTokenStoreTest`, `ApiClientTest`, `DeviceFlowPollerTest`, `PairingManagerTest`, `LedgerTransitionsTest`, ledger ingest/stats/`nextBatch`/retry tests, scanner cursor and permission-state tests, `UploadEngine` tests (happy path ranges and ETags, dedup, resume after process death, stale upload, `UPLOAD_PARTS_MISSING`, mid-file metered switch, backoff and blocking, 401/409/403/400 handling, auth header rules), scheduler constraint mapping, `ConfigApplier` deltas, FGS timeout, `ChecksTest`, `SelfTestTest`, `AutoDiagnosticsTest`, `AppLogTest`, `UpdateTest`, deep-link intent parsing, generated shortcuts.

### 21.2 Issue map

| Issue | Delivers | Sections |
|---|---|---|
| #499 | Device flow keeps `tokenType`/`name`; `credentialType` in the token response | [6.7](#67-device-flow) |
| #500 | Retire the legacy app and its docs | [Appendix A](#appendix-a-notes-salvaged-from-the-legacy-app) |
| #501 | This document and the architecture spec | all |
| #502 | Prisma models and migration | [4](#4-data-model) |
| #503 | Trusted apps and `assetlinks.json` | [6.5](#65-android-app-trusted-apps-assetlinks-releases) |
| #504 | APK releases | [6.5](#65-android-app-trusted-apps-assetlinks-releases), [14](#14-release-model) |
| #505 | Media Sync device API, `AuthCredential`, media linkage | [5](#5-desired-config-and-commands), [6.2-6.4](#62-auth-matrix) |
| #506 | Local-provider part upload, `partUploadAuth`, fail on missing parts | [6.6](#66-endpoints-the-phone-uses-for-upload-and-registration) |
| #507 | Doctor `android` section | [20](#20-doctor) |
| #508 | Scaffold: TWA shell, Setup, identity, signing, API client, token store | [2](#2-identity), [12.6](#126-twa-shell-and-setup) |
| #509 | Pairing | [7](#7-pairing) |
| #510 | Discovery and ledger | [8](#8-the-device-ledger) |
| #511 | Upload engine | [9](#9-upload-sequence-and-resume) |
| #512 | Background sync | [10](#10-scheduling-and-background-rules), [5.3](#53-configapplier-phone) |
| #513 | Native UI | [12](#12-native-ui-map) |
| #514 | Diagnostics, auto-report, log, update checker | [13](#13-diagnostics) |
| #515 | Web user settings | [15](#15-web-surfaces) |
| #516 | Web admin Android page | [15](#15-web-surfaces) |
| #517 | CLI `android` commands and TUI | [14.1](#141-cli) |
| #518 | CI workflow | [14.3](#143-ci-workflow) |
| #519 | Runbooks, API.md, CLAUDE.md, CLI README | docs |

## 22. Decisions

Where the issue bodies disagree with each other or with the code as it stands, this is the resolution. Issue authors follow this list.

| # | Question | Resolution |
|---|---|---|
| D1 | `code` versus `details.reason`. Issues write "409 `RELEASE_IS_CURRENT`" as if it were `code` | `HttpExceptionFilter` rebuilds the body and always derives `code` from the HTTP status, so a custom `code` on a thrown exception is discarded. Every machine reason is `details.reason`; extra fields (`bucketIds`, `partNumbers`) live in `details` too. The phone's `ApiError.reason` reads `details.reason` |
| D2 | Download-token key: #504 says `deriveSigningKey` | MemoriaHub's helper is `deriveSubKey(purpose)` in `apps/api/src/common/crypto/secret-cipher.ts` (the Memories digest tokens use it). Use `deriveSubKey('android-app-download')`; no new environment variable |
| D3 | Pairing token lifetime variable: evopath used `DEVICE_PAT_EXPIRY_DAYS` | MemoriaHub's existing variable is `DEVICE_PAT_TTL_DAYS` (default 90, read as `deviceAuth.patTtlDays`). Use it; add nothing |
| D4 | #505 relies on `@AuthCredential()` and `request.authCredential`, which MemoriaHub lacks (the PAT branch of `JwtAuthGuard` only sets `request.user`, and `PatService.validateToken` returns only the user) | #505 introduces them: `PatService.validateToken` also exposes the token id, `JwtAuthGuard` stamps `request.authCredential = { kind: 'pat', tokenId }` (or `{ kind: 'jwt' }`), and an `@AuthCredential()` param decorator reads it. Unit-tested in #505 |
| D5 | The device-flow `/token` response has no `credentialType`, and `ClientInfoSchema` strips `tokenType` | #499 adds both (allowlisted fields, `credentialType: 'pat' \| 'session'`). The phone refuses anything but `pat` ([section 6.7](#67-device-flow)) |
| D6 | Which routes take JWT versus PAT | Register: PAT only. Check-in: PAT only, and only the device's own linked PAT. `config`, `commands`, `diagnostics`: JWT or PAT, with the device-scoping rule for device-linked PATs. #513's note that the PAT route "must be confirmed" is settled: PATCH config accepts both |
| D7 | #513 says offline local edits are "sent on the next check-in", but the check-in contract has no config field | Pending local edits are replayed through `PATCH /config` and `POST /commands` **before** the check-in (a local outbox). The check-in body never carries config |
| D8 | #510 counts `FAILED`-and-due rows in `pending` and also in `failed`, which would double count and break "Missing = pending + uploading + failed + blocked" | `pending` is `DISCOVERED`, `QUEUED`, `HASHING` only. `FAILED` rows count only in `failed`. Invariant: `eligible = uploaded + deduplicated + pending + uploading + failed + blocked` |
| D9 | #510's `nextBatch` returns `QUEUED` and due `FAILED` only, so an `UPLOADING` row left by a killed process would never resume, and the state `DISCOVERED` is never reached by any rule | `nextBatch` returns orphaned `UPLOADING`/`REGISTERING` rows first; `HASHING` leftovers go back to `QUEUED`; `DISCOVERED` is the transient insertion state inside the ingest transaction (T1 to T2/T3) |
| D10 | Backoff numbering: "30 s, 2 m, 10 m, 1 h, then `BLOCKED` at 5 attempts" | After failure 1: 30 s; 2: 2 m; 3: 10 m; 4: 1 h; the 5th failure blocks ([section 8.4](#84-backoff-and-blocking)) |
| D11 | #502 stores `perFolder` in `MediaSyncRun.details` but #501's check-in `run` has no such field | `run.perFolder` is an optional field (≤200 entries); the phone may omit it in v1 |
| D12 | PATCH config: where the folder `name` comes from, and who may send `inventory` | The server overwrites `folders[].name` from the inventory entry. `inventory` in a PATCH is accepted only from PAT callers (400 `INVENTORY_NOT_ALLOWED` for JWT) |
| D13 | Deep-link paths: #501 lists `folders\|files\|diagnostics`, #513 adds `/connect` and `/paired` | The full set is `/`, `/connect`, `/paired`, `/folders`, `/network`, `/files`, `/diagnostics` (`/network` added so every screen is addressable) |
| D14 | `signingSha256` representation | Server, database, `assetlinks.json` and the web use **uppercase colon** form. The CLI sidecar uses lowercase hex without colons; the server accepts and normalises both |
| D15 | Dedup pre-check: #511 says `page=1&pageSize=1`; #501 omits `page` | Omit `page`. Passing `page` selects the legacy offset mode with a `COUNT(*)`; keyset mode (no `page`) costs one indexed lookup |
| D16 | Resume uses the server's `uploadedParts`, but for S3/R2 the server records parts only at `complete`, so `uploadedParts` can be empty while the parts exist | The phone's `completedPartsJson` (ETag per part, written after every part) is authoritative; `status` is used to confirm the session still exists and to detect `processing`/`ready` (crash between `complete` and registration, which jumps straight to registration) |
| D17 | #506 validates "object status is `uploading`", but `upload/init` creates the object as `pending` and nothing moves it to `uploading` on the S3 path | The local part route accepts `pending` or `uploading` and sets `uploading` on the first part. #511's "no longer `uploading`" check becomes "not `pending`/`uploading`" |
| D18 | `complete` stale-session conflict has no `details.reason` today | #506 adds `UPLOAD_SESSION_INVALID` to it. Until then the phone treats any 409 on `complete` that is not `UPLOAD_PARTS_MISSING` as session-gone: abort and re-init |
| D19 | #516 expects an admin "N devices behind" count from `GET /api/media-sync/devices` | That route is owner-scoped; no admin aggregate exists in v1. The admin page omits the count; the Doctor `android.releases` message carries `devicesBehind` |
| D20 | #513: tapping a synced file opens `$server/media/<mediaItemId>` "if that route exists" | It does not (the web has `/media` only). The Files screen opens `$server/media` |
| D21 | Android 13 has no partial state in #510 | Exactly one of `READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO` granted is `partial` (and disables vanished detection) |
| D22 | Storage-not-configured reason naming (evopath used lowercase) | `STORAGE_NOT_CONFIGURED`, uppercase like every other reason |
| D23 | Foreground service start can be refused on Android 12+ when the app is in the background | Failure to enter the foreground is not an error: log `sync.foreground.denied` and keep running as background work |
| D24 | Photos with `ACCESS_MEDIA_LOCATION`: the plain content URI returns GPS-redacted bytes, so hashing and uploading different URI forms would defeat dedup | Hash and upload use the same URI form (`setRequireOriginal` when permitted, with a fallback applied to both) |
| D25 | `uploadExisting` re-evaluation: #510 only describes the `all` to `from_pairing` direction | Config application re-evaluates eligibility for every non-uploaded row, so either direction (and folder/type changes) restore or exclude rows correctly without a reason column |
| D26 | Debug builds | `memoriahub.marin.cr.debug` is a different package: it needs its own trusted-signer entry for full-screen mode and never sees the release as an update (`app.update` is `skip`) |
| D27 | No CLI `deploy` and no `deploy --with-android` | Explicitly out of scope per the product owner |

## 23. Non-goals

- **Delete reconciliation.** Deleting a photo on the phone never deletes it on the server, and the ledger never infers deletion from absence under partial or denied permission.
- **Google Play distribution** (sideload only, because of the `READ_MEDIA_*` policy).
- **iOS.**
- **Firebase push wake-ups** (FCM). The deep-link "apply now", app-open and trigger check-ins are enough for v1.
- **Android 14 user-initiated data transfer jobs** (a possible follow-up for very large user-initiated syncs; WorkManager does not expose them).
- **A CLI `deploy` command** or `deploy --with-android`.
- **A per-file server ledger table.**

## Appendix A: Notes salvaged from the legacy app

The retired v1 app (`apps/android/`, package `cr.marin.memoriahub`, Hilt, Room v2, Retrofit, AGP 9.2.1) is replaced by this design. The code is not reused; these hard-won details are re-implemented by #510 and #511. The retired reference is kept as [android-sync.md](android-sync.md), marked superseded. **Do not grep-replace `cr.marin.memoriahub` in historical docs**: it stays correct as the description of the retired app.

**`MediaStoreScanner`** (#510)

- Raw column names (`datetaken`, `bucket_display_name`, `bucket_id`, `generation_added`, `generation_modified`) work on API 26+ and avoid API-gated constants; the generation columns exist only on API 30+, so using them below throws.
- Combine the change filter with OR: `(generation_added > ? OR generation_modified > ? OR date_added >= ?)`. The generation branch catches edits that keep their `DATE_ADDED`; the date branch is a belt-and-braces catch for volumes whose generation is not tracked. The new design keys on `GENERATION_MODIFIED` (and the `DATE_MODIFIED - 2 s` fallback) per volume.
- Capture `MediaStore.getGeneration(context, volume)` **before** scanning, so changes made mid-scan are re-scanned rather than lost; also keep `MediaStore.getVersion` (it changes when the media database is rebuilt and generations reset).
- Bucket enumeration: any bucket MediaStore returns necessarily has media, so "only folders with media" is automatic; map by `BUCKET_ID`, display `BUCKET_DISPLAY_NAME`. The legacy default of the names `Camera`, `DCIM` and `Pictures` when no selection existed is deliberately **not** carried over: an empty selection syncs nothing.
- `canRead()` guard: with permission revoked, scans return empty, and a deletion diff would wrongly treat every pending row as gone. Vanished detection must only run after a full scan with full permission.
- Sort by `DATE_ADDED ASC` for deterministic keyset-style progress; the new `nextBatch` orders by `dateTaken DESC` so the newest photos upload first.
- Exclude pending and trashed rows (`IS_PENDING`, `IS_TRASHED`) from inventory and scan.

**`S3PartUploader` and `ContentUriRequestBody`** (#511)

- PUT each part directly to the presigned URL with **no `Authorization` header** and read the `ETag` response header (quotes preserved); a missing `ETag` is an error.
- Stream a byte range of a content URI into an OkHttp `RequestBody`: `contentLength() = length`; re-open the stream on every `writeTo` so OkHttp can retry safely; skip to `offset` with a loop that falls back to `read()` when `skip()` returns 0; copy through a 64 KB buffer until `length` bytes are written; stop at EOF. This keeps memory constant for 4K videos.
- The legacy retry stack (status plus throttle-body sniff plus IO exceptions): retryable statuses 429, 502, 503, 504; sniff `SlowDown|ServiceUnavailable|TooManyRequests|Throttl` in the response body for S3 `503 SlowDown` and R2 `429` even on odd statuses; backoff `random() * min(max, base * 2^(n-1))`; honour `Retry-After`.

**`Hashing`** (#511)

- Streaming SHA-256 over an `InputStream` with a 64 KB buffer, lowercase hex: this matches the API's `contentHash` (`/^[a-f0-9]{64}$/i`). Close the stream.

**`ReconcilePolicy`** (#510)

- Reconcile decision per scanned item: no row → queue; size or mtime changed → re-queue (content change wins over metadata drift); only `contentUri` or `displayName` changed → refresh metadata and keep the status; else unchanged.
- Vanished-pending diff is a pure function over the **full** scan only, scoped to the rows the scan could have seen (rows in deselected buckets are not diffed).

**`ForegroundPolicy`** (#512)

- Promote to a foreground service only when there is work to do: a run with nothing to upload (the common periodic case) stays plain background work with no notification flash. The new rule is "more than 1 file or more than 50 MB pending".

**Other legacy facts**

- The retry cap was 5 attempts; statuses were `QUEUED, HASHING, UPLOADING, UPLOADED, SKIPPED, FAILED, BLOCKED` (`SKIPPED` is the new `DEDUPLICATED`).
- The old app declared `RECEIVE_BOOT_COMPLETED` and a boot receiver; WorkManager persists across reboots, so the new app needs neither.
- Auth was a 7-day JWT plus a refresh cookie replayed by hand; the new app uses a `pat_`.
- The old `docs/specs/android-sync.md` named the package `com.memoriahub.sync`, old AGP versions, wrong upload fields and snake_case tokens, and said there was no folder filtering; none of that matched the code and is superseded by this document.
