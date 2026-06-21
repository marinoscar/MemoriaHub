# Android Sync MVP — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | June 2026 |
| **Status** | Specification |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Tech Stack and Project Location](#2-tech-stack-and-project-location)
3. [Authentication — RFC 8628 Device Authorization Flow](#3-authentication--rfc-8628-device-authorization-flow)
4. [Token Refresh — Cookie-Replay Strategy](#4-token-refresh--cookie-replay-strategy)
5. [Sync Engine and Room State Machine](#5-sync-engine-and-room-state-machine)
6. [Change Detection — Three-Layer Model](#6-change-detection--three-layer-model)
7. [Per-File Upload Pipeline](#7-per-file-upload-pipeline)
8. [Retry, Resume, and Crash Recovery](#8-retry-resume-and-crash-recovery)
9. [WorkManager Triggers](#9-workmanager-triggers)
10. [API Endpoints Consumed](#10-api-endpoints-consumed)
11. [UI Screens](#11-ui-screens)
12. [Build and Test Commands](#12-build-and-test-commands)
13. [Known MVP Limitations and Future Work](#13-known-mvp-limitations-and-future-work)

---

## 1. Overview and Goals

The Android MVP is the first native mobile client for MemoriaHub. It provides always-on camera backup: every photo and video captured on the device is automatically uploaded to the user's chosen circle (defaulting to the personal circle) using the existing resumable upload pipeline. It is the first consumer of the `android` value in the server-side `MediaSource` enum.

The MVP prioritises correctness and durability over features. Every upload decision is recorded in a local Room database and survives app kills, device reboots, and network interruptions. Upload state is visible to the user at a per-photo level in the Backup and Photos screens.

### Goals

- Authenticate against any self-hosted MemoriaHub server using the RFC 8628 device flow without requiring a browser login on the device.
- Detect new camera photos and videos from MediaStore, deduplicate by SHA-256 content hash, and upload them to a circle via the server's resumable multipart upload API.
- Persist all sync state durably in Room so progress survives process death and device reboots.
- Provide a simple three-screen UI (Photos / Backup / Settings) with per-photo sync status badges.
- Require zero changes to the existing MemoriaHub server — the cookie-replay refresh strategy works with the current `POST /api/auth/refresh` contract without any backend modifications.

### Non-Goals

- The MVP does not provide in-app photo viewing or editing beyond the backup-status grid.
- The app does not browse or download media already stored on the server.
- There is no network-policy UI (Wi-Fi only vs cellular); the app syncs on any available network.
- The MVP only scans the device's camera roll (all buckets visible via `MediaStore.Images` and `MediaStore.Video` without bucket filtering).
- Video files are uploaded; there is no transcoding or quality selection.
- Push notifications for upload completion are not implemented.

---

## 2. Tech Stack and Project Location

### Project Layout

The Android app is a standalone Gradle project located at `apps/android/` within the monorepo. It is **not** part of the npm workspace and is **not** included in the Docker Compose stack. It is built independently using Android Studio or the Gradle wrapper.

```
apps/android/
  app/
    src/
      main/
        java/com/memoriahub/sync/
          auth/           # TokenStore, AppConfigStore, DeviceAuthViewModel
          sync/           # SyncEngine, SyncWorker, ChangeDetector, SyncFileDao
          ui/             # MainActivity, Photos/Backup/Settings screens
          network/        # ApiClient, TokenAuthenticator, ContentUriRequestBody
      test/               # JVM unit tests
    build.gradle.kts
  build.gradle.kts
  settings.gradle.kts
  gradlew / gradlew.bat
```

### Key Dependencies

| Component | Library |
|-----------|---------|
| Language | Kotlin |
| UI | Jetpack Compose + Material 3 |
| HTTP | OkHttp 4 |
| Local DB | Room |
| Background work | WorkManager |
| Image loading | Coil |
| Encrypted storage | androidx.security:security-crypto (`EncryptedSharedPreferences`) |
| Browser tab | androidx.browser (Custom Tabs) |

### Build Configuration

| Parameter | Value |
|-----------|-------|
| AGP | 8.11.1 |
| Gradle | 8.13 |
| `compileSdk` / `targetSdk` | 36 |
| `minSdk` | 26 (Android 8.0) |

---

## 3. Authentication — RFC 8628 Device Authorization Flow

Authentication follows [RFC 8628 — OAuth 2.0 Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628). No browser-level Google OAuth is used on the device; the app authenticates against the MemoriaHub API directly.

### First-Run Setup

On first launch (or when no server URL is stored), the app shows a server URL entry screen. The user types their MemoriaHub instance URL (e.g. `https://memoriahub.example.com`). The URL is persisted to `AppConfigStore` (plain `SharedPreferences`).

### Device Authorization Sequence

1. **Request device code** — `POST /api/auth/device/code` (public endpoint, no auth required). The server returns:
   - `device_code` — opaque code used when polling
   - `user_code` — short human-readable code shown to the user (e.g. `ABCD-1234`)
   - `verification_uri` — the URL the user visits to approve the device
   - `verification_uri_complete` — the verification URI with `user_code` pre-filled
   - `expires_in` — lifetime of the code in seconds
   - `interval` — minimum polling interval in seconds

2. **Show user code** — the app displays `user_code` in a prominent dialog and offers a "Approve on this device" button that opens `verification_uri_complete` in a Chrome Custom Tab.

3. **Poll for authorization** — the app polls `POST /api/auth/device/token` at the interval specified in step 1. The response body's `error` field is used to branch:
   - `authorization_pending` — continue polling
   - `slow_down` — increase the polling interval by 5 seconds and continue
   - `access_denied` — user rejected the request; abort and show error
   - `expired_token` — the device code expired; restart the flow
   - No `error` field — authorization succeeded; extract `access_token` and `refresh_token` from the response body

4. **Persist tokens** — the `access_token` and `refresh_token` are stored in `EncryptedSharedPreferences` via `TokenStore`. `EncryptedSharedPreferences` uses AES-256-GCM for values and is backed by the Android Keystore.

### Logout

Logout calls `POST /api/auth/logout` (with the current access token in the `Authorization` header), clears all tokens from `TokenStore`, and cancels all pending WorkManager jobs. The app returns to the server URL / first-run screen.

---

## 4. Token Refresh — Cookie-Replay Strategy

The MemoriaHub server's `POST /api/auth/refresh` endpoint reads the refresh token exclusively from a `Cookie: refresh_token=...` header. The device authorization flow returns the refresh token in the JSON response body, not via `Set-Cookie`. To bridge this mismatch without any backend changes, the app uses a **cookie-replay** strategy implemented in `TokenAuthenticator` (an OkHttp `Authenticator`).

### How Cookie-Replay Works

`TokenAuthenticator` is registered on the main `OkHttpClient` and fires on every HTTP 401 response:

1. Read the stored `refresh_token` from `TokenStore`.
2. If no refresh token is present, clear tokens and return `null` (triggers re-login).
3. Build a `POST /api/auth/refresh` request with the refresh token replayed as `Cookie: refresh_token=<stored_value>`. No `Authorization` header is sent on this call.
4. Execute the refresh call using a separate bare `OkHttpClient` (no `TokenAuthenticator`, to avoid recursion).
5. On a 2xx response:
   - Extract the new `access_token` from the JSON body.
   - Look for a `Set-Cookie: refresh_token=...` header on the response and, if present, persist the rotated refresh token. If no `Set-Cookie` is present, retain the existing refresh token (the server may choose not to rotate on every call).
   - Persist the new `access_token` to `TokenStore`.
   - Retry the original request with the new `Authorization: Bearer <new_access_token>` header.
6. On a non-2xx response from the refresh call, clear all tokens from `TokenStore` and return `null` — the OkHttp call chain propagates the 401, and the app detects the cleared token state on the next UI check and redirects to login.

This strategy requires zero server-side changes. The server cannot distinguish a cookie-replayed refresh from a normal browser-originated refresh.

---

## 5. Sync Engine and Room State Machine

All sync progress is tracked in a Room database. The two key tables are `sync_files` and `sync_runs`. The `SyncEngine` class coordinates the state machine; `SyncWorker` is the WorkManager entry point.

### `sync_files` Table

One row per camera file discovered by MediaStore reconciliation.

| Column | Type | Notes |
|--------|------|-------|
| `id` | Long PK | MediaStore `_ID` value for the file |
| `uri` | String | Content URI (`content://media/...`) |
| `displayName` | String | File name |
| `mimeType` | String | MIME type as reported by MediaStore |
| `size` | Long | File size in bytes |
| `dateAdded` | Long | MediaStore `DATE_ADDED` epoch seconds |
| `contentHash` | String? | SHA-256 hex; null until hashing completes |
| `status` | String | See status enum below |
| `storageObjectId` | String? | Server-assigned UUID after `upload/init` |
| `mediaItemId` | String? | Server-assigned UUID after `POST /api/media` |
| `uploadedPartCount` | Int | Parts confirmed uploaded; used for resume |
| `totalPartCount` | Int | Total parts required for multipart upload |
| `lastError` | String? | Last failure message |
| `attemptCount` | Int | Number of upload attempts made |
| `createdAt` | Long | Row insert timestamp |
| `updatedAt` | Long | Last status transition timestamp |

**Status enum:**

| Status | Meaning |
|--------|---------|
| `queued` | File discovered; waiting for a sync run to process it |
| `hashing` | SHA-256 computation in progress |
| `uploading` | Multipart upload in progress |
| `uploaded` | Server confirmed; `POST /api/media` succeeded |
| `skipped` | Server dedup pre-check confirmed the file already exists in the circle |
| `failed` | Transient error; will be auto-retried on the next run |
| `blocked` | Attempt cap (5) reached; requires manual intervention |

### `sync_runs` Table

One row per sync execution (one per `SyncWorker` invocation).

| Column | Type | Notes |
|--------|------|-------|
| `id` | Long PK (auto) | |
| `trigger` | String | `periodic`, `content_observer`, `manual` |
| `startedAt` | Long | |
| `finishedAt` | Long? | Null if still running |
| `queued` | Int | Files added to queue this run |
| `uploaded` | Int | Files successfully uploaded this run |
| `skipped` | Int | Files skipped (dedup) this run |
| `failed` | Int | Files that failed this run |

### Concurrent Worker Pool

`SyncEngine` processes up to 3 files concurrently using Kotlin coroutines (`async` + `awaitAll` in batches). Each coroutine runs one file through the full pipeline (hash → dedup → upload → register). The concurrency limit prevents saturating the device radio or the server.

---

## 6. Change Detection — Three-Layer Model

Change detection uses an **idempotent reconcile** approach: the Room `sync_files` table is kept in sync with MediaStore. MediaStore is the source of truth; Room tracks upload state on top of it. The reconcile is cheap and safe to run frequently.

### High-Water Mark

Each reconcile pass queries MediaStore for files with `DATE_ADDED > last_high_water_mark`. After a successful reconcile, the high-water mark is advanced to the maximum `DATE_ADDED` seen in the pass. This ensures each file is added to `sync_files` at most once (INSERT OR IGNORE semantics on the `id` column).

### Three Triggers

Change detection is driven by three independent triggers. All three fire the same reconcile logic; they differ only in timing and persistence.

**Trigger 1 — Periodic safety-net (15 minutes)**

A periodic `WorkManager` constraint fires every 15 minutes. It re-arms automatically. This is the catch-all: even if the content observer or boot receiver misfires, no file is missed for more than 15 minutes.

**Trigger 2 — MediaStore content-URI observer**

`WorkManager.addContentUriTrigger` registers a process-independent observer on `MediaStore.Images.Media.EXTERNAL_CONTENT_URI` and `MediaStore.Video.Media.EXTERNAL_CONTENT_URI`. When MediaStore reports new content, WorkManager enqueues a reconcile+sync run. The observer is re-armed after each firing by scheduling the next `OneTimeWorkRequest` with a fresh `addContentUriTrigger`. This ensures prompt detection of new photos without requiring the app process to be alive.

**Trigger 3 — Manual "Sync now"**

The Backup screen exposes a "Sync now" button that enqueues an immediate `OneTimeWorkRequest`. This is useful after connectivity is restored or after granting permissions.

### BootReceiver

A `BroadcastReceiver` listening for `ACTION_BOOT_COMPLETED` re-arms the periodic and content-URI triggers after a device reboot. Without this, WorkManager's persistent scheduled work is restored automatically, but the BootReceiver provides an explicit safety net and triggers an immediate reconcile pass on first boot after install.

---

## 7. Per-File Upload Pipeline

`SyncEngine.processFile(syncFile)` implements the per-file pipeline. The steps mirror the MemoriaHub CLI's resumable upload flow.

### Step 1 — Hash with Cache

Compute SHA-256 of the file contents by opening the content URI via `ContentResolver.openInputStream`. The hash is stored in `sync_files.contentHash` as soon as it completes, so the hashing step is skipped on retry (the row already has a non-null hash). Status transitions: `queued → hashing → (next step)`.

### Step 2 — Dedup Pre-Check

`GET /api/media?circleId=<targetCircleId>&contentHash=<sha256>&pageSize=1`

If the response returns one or more items, the file already exists in the target circle. Set status `skipped` and return. This differs from the CLI, which omits `circleId` from the pre-check; the Android app always scopes the check to the target circle.

### Step 3 — Initialize Resumable Upload

`POST /api/storage/objects/upload/init`

Request body:
```json
{
  "filename": "<displayName>",
  "mimeType": "<mimeType>",
  "size": <bytes>,
  "contentHash": "<sha256>"
}
```

Response provides `storageObjectId`, `uploadId`, a list of presigned part URLs (up to 50 at a time — additional batches are fetched as needed), and `partSize`. Persist `storageObjectId` to `sync_files.storageObjectId`.

### Step 4 — Upload Parts via Presigned URLs

Each part is uploaded with a bare `OkHttpClient` (no `Authorization` header — presigned URLs are self-authenticating). The request body is a `ContentUriRequestBody` that streams a byte range of the source file directly from the content URI without reading the entire file into memory.

Progress is persisted per part: `sync_files.uploadedPartCount` is incremented after each successful part PUT. On resume (after crash or retry), parts already confirmed are skipped. ETags returned by the part PUT responses are collected for the complete call.

Part URLs are fetched in batches of 50 from the server. When a batch is exhausted, the next batch is fetched via `GET /api/storage/objects/:id/upload/status` before continuing.

### Step 5 — Complete Multipart Upload

`POST /api/storage/objects/:id/upload/complete`

Request body contains the ordered list of `{ partNumber, eTag }` pairs collected in Step 4. On success, the storage object is committed on the server.

### Step 6 — Register as Media Item

`POST /api/media`

Request body:
```json
{
  "storageObjectId": "<uuid>",
  "circleId": "<targetCircleId>",
  "source": "android",
  "contentHash": "<sha256>",
  "capturedAt": "<ISO-8601 from MediaStore DATE_TAKEN>",
  "sourceDeviceId": "<Android device ID>",
  "sourceDeviceName": "<device model name>"
}
```

- HTTP 201 — new item created; persist `mediaItemId`, set status `uploaded`.
- HTTP 200 — the server detected the file as a duplicate of an existing item via content hash; set status `skipped`.

---

## 8. Retry, Resume, and Crash Recovery

### Retry Policy

The retry strategy mirrors the MemoriaHub CLI's `retry.ts`:

- Retry on HTTP 429, 502, 503, 504.
- Retry on `IOException` (network error).
- Retry on non-2xx responses whose body contains throttle-related text (non-2xx body sniff only).
- Honor `Retry-After` headers: parse as seconds or HTTP-date and wait the specified duration before retrying.
- Backoff: exponential with full jitter. Base delay 1 second, maximum delay 30 seconds.

Retries within a single `SyncWorker` invocation are transparent to the Room state machine — the status remains `uploading`. Retries across invocations (i.e., after a crash or WorkManager reschedule) use the resume logic described below.

### Attempt Cap

When `sync_files.attemptCount` reaches 5, the file transitions to `blocked`. Blocked files are not retried automatically. The user can trigger a manual retry from the Backup screen's failures list, which resets `attemptCount` to 0 and sets status back to `queued`.

### Resume After Crash

When `SyncWorker` starts, it resets any rows stuck in `hashing` or `uploading` back to `queued` (with the `contentHash` preserved if already computed, so hashing is not repeated). The per-part progress in `uploadedPartCount` is used to skip already-completed parts when a multipart upload resumes — the `storageObjectId` and `uploadId` from the previous `upload/init` call are still valid on the server.

### Transient FAILED Auto-Retry

Files with status `failed` are automatically re-queued at the start of each sync run (reset to `queued`, `attemptCount` incremented). This means transient network failures resolve themselves on the next trigger without user intervention, up to the attempt cap.

---

## 9. WorkManager Triggers

| Trigger | Type | Constraints | Recurrence |
|---------|------|-------------|-----------|
| Periodic safety-net | `PeriodicWorkRequest` | None | Every 15 minutes |
| Content-URI observer | `OneTimeWorkRequest` with `addContentUriTrigger` | None | Re-armed after each fire |
| Manual sync | `OneTimeWorkRequest` | None | On demand |
| Boot re-arm | `OneTimeWorkRequest` via `BootReceiver` | None | On `ACTION_BOOT_COMPLETED` |

`SyncWorker` is a `CoroutineWorker` that:
1. Calls `ChangeDetector.reconcile()` to bring `sync_files` up to date with MediaStore.
2. Resets stuck rows (hashing/uploading) back to queued.
3. Auto-retries failed rows (increment attempt count, reset to queued).
4. Processes up to 3 queued files concurrently via the upload pipeline.
5. Updates the foreground service notification with running counts.
6. Inserts a `sync_runs` row with final counts.

`SyncWorker` runs as a foreground data-sync service (`ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC`) with a persistent progress notification showing "Backing up photos — X of Y".

---

## 10. API Endpoints Consumed

All endpoints are on the configured server base URL. All calls except the device code endpoints require `Authorization: Bearer <access_token>`.

| Step | Method | Path | Notes |
|------|--------|------|-------|
| Device code request | `POST` | `/api/auth/device/code` | Public — no auth required |
| Device token poll | `POST` | `/api/auth/device/token` | Public — no auth required |
| Token refresh | `POST` | `/api/auth/refresh` | Cookie-replay strategy; see §4 |
| Logout | `POST` | `/api/auth/logout` | |
| Current user | `GET` | `/api/auth/me` | Used to populate Settings screen |
| List circles | `GET` | `/api/circles` | Used to populate target-circle picker |
| Dedup pre-check | `GET` | `/api/media?circleId=&contentHash=&pageSize=1` | |
| Init upload | `POST` | `/api/storage/objects/upload/init` | |
| Upload status / next part URLs | `GET` | `/api/storage/objects/:id/upload/status` | |
| Complete upload | `POST` | `/api/storage/objects/:id/upload/complete` | |
| Abort upload | `DELETE` | `/api/storage/objects/:id/upload/abort` | Called on unrecoverable failure |
| Register media item | `POST` | `/api/media` | Body includes `source: "android"` |

Part PUTs go directly to the presigned S3/R2 URLs returned by `upload/init`. These are bare HTTPS calls with no MemoriaHub auth header.

---

## 11. UI Screens

The app uses a bottom navigation bar with three destinations, all gated behind a media-permission check on first launch.

### Photos Screen

A Google-Photos-style adaptive grid of all camera files visible in `sync_files`, sorted by `dateAdded` descending. Day-header separators group photos by calendar date and stick to the top while scrolling. Each tile loads a thumbnail via Coil (with video frame extraction for video files). A small badge in the corner of each tile shows the sync status:

| Badge | Meaning |
|-------|---------|
| Green check | `uploaded` |
| Grey cloud | `queued` |
| Animated spinner | `uploading` |
| Orange exclamation | `failed` |
| Red X | `blocked` |
| No badge | `skipped` (file already existed) |

### Backup Screen

Shows aggregate counts by status (uploaded, pending, failed) for the current sync run and all time. Three action buttons:

- **Sync now** — enqueues an immediate `OneTimeWorkRequest`.
- **Retry failed** — resets all `failed` rows to `queued` and enqueues a sync.
- **Failures list** — expandable section showing each `failed` or `blocked` file with its `lastError` message and a per-file retry button.

### Settings Screen

- **Account** — displays the signed-in user's name and email (from `GET /api/auth/me`).
- **Target circle** — a radio group of circles fetched from `GET /api/circles`. Selecting a circle updates `AppConfigStore`. New sync runs use the selected circle. Existing `uploaded` rows are not moved.
- **Server URL** — display only; shows the configured base URL. A "Change server" option clears all local state (tokens, sync_files, sync_runs) and restarts the onboarding flow.
- **Log out** — calls `POST /api/auth/logout`, clears tokens, cancels WorkManager jobs, and navigates to the server URL screen.

---

## 12. Build and Test Commands

### Build

The app is built using the Gradle wrapper from the `apps/android/` directory:

```bash
# Assemble debug APK
cd apps/android
./gradlew :app:assembleDebug

# Assemble release APK
./gradlew :app:assembleRelease

# Install debug build on connected device
./gradlew :app:installDebug
```

The project is also openable directly in Android Studio: open `apps/android/` as the project root.

### Run Tests

```bash
cd apps/android

# Run all JVM unit tests (debug variant)
./gradlew :app:testDebugUnitTest
```

The test suite includes 11 passing JVM unit tests covering:

| Test class | Coverage |
|------------|---------|
| `RetryPolicyTest` | Exponential full-jitter backoff intervals at cap, 429 retry, `Retry-After` parsing, IOException retry, non-retryable 4xx passthrough — verified with MockWebServer |
| `TokenAuthenticatorTest` | Cookie construction from stored refresh token, new access token extraction from response body, `Set-Cookie` rotation capture |
| `Sha256HashTest` | SHA-256 output for known inputs; hash stability across multiple calls on the same content |

There are no instrumented (on-device) tests in the MVP. End-to-end behavior is verified by running the app against a local MemoriaHub dev instance.

---

## 13. Known MVP Limitations and Future Work

The following are known gaps accepted for the MVP. They are left to future iterations and do not require changes to the server-side data model.

| Limitation | Notes |
|-----------|-------|
| No bucket filtering | The app scans all buckets visible via `MediaStore.Images` and `MediaStore.Video` (screenshots, downloads, etc.). A camera-only mode with bucket selection is planned |
| No network policy UI | The app syncs on any available network (Wi-Fi and cellular). A "Wi-Fi only" toggle is a common user request and will be added in a follow-up |
| No server-library browsing | The Photos screen shows only local camera files with their sync status. Browsing media already on the server (uploaded from other devices) is not supported in this MVP |
| No in-app photo viewer | Tapping a photo badge opens the system photo viewer, not an in-app viewer |
| No video transcoding | Videos are uploaded as-is; no quality selection or compression |
| Single active upload pipeline | Upload concurrency is fixed at 3 workers; there is no adaptive throttle based on network type |
| No push notifications | Upload completion is not announced via push; users must open the app to see status |
| No multiple account support | The app is configured for a single server URL and a single user account. Switching servers requires clearing all local state |
| Instrumented tests absent | The test suite covers only JVM unit tests; Espresso / Compose UI tests are not written |
| `minSdk 26` (Android 8.0) | Devices running Android 7.x (Nougat) and earlier are not supported |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 2026 | AI Assistant | Initial specification |
