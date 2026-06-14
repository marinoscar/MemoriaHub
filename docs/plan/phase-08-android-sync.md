# Phase 08 — Android Sync

**Roadmap:** [ROADMAP.md](ROADMAP.md)
**Previous Phase:** [Phase 07 — Memory Prioritization](phase-07-memory-prioritization.md)
**Next Phase:** [Phase 09 — Long-Term Enrichment](phase-09-longterm-enrichment.md)
**Status:** Not Started

---

## 1. Goal

Provide a native Android application that automatically syncs photos and videos from the device's selected folders into MemoriaHub. The app authenticates via Personal Access Tokens (same mechanism as the CLI), uses the existing resumable upload API, and preserves device metadata (date, GPS, device model) that Android's media store exposes. Background sync ensures new photos are uploaded without user intervention.

---

## 2. Vision Mapping

| Vision Item | Relevant Section in VISION.MD |
|-------------|-------------------------------|
| #7 — Android app for mobile photo and video sync | "Android Application" |

From the vision: _"The Android app is critical because mobile devices are where most family memories are created."_ The app's primary value is automatic background sync so users do not have to think about backing up their photos.

MVP capabilities (from the "Android Application" vision section):
- Select media folders to sync
- Upload new photos and videos
- Preserve available metadata from the device
- Track sync status
- Retry failed uploads
- Support background sync when appropriate
- Give the user visibility into what has been uploaded

---

## 3. What We Reuse

| Existing Resource | How It Is Reused |
|------------------|-----------------|
| `apps/api/src/pat/` | PAT is the only auth mechanism for the Android app (no OAuth flow in the app) |
| `POST /api/storage/objects/upload/init` + parts + complete | Same resumable upload API used by the web client and CLI |
| `POST /api/media` | Register each uploaded `StorageObject` as a `MediaItem` with `source: android` |
| Phase 02 `MediaItem.contentHash` | Dedup: app computes SHA-256 locally; queries `GET /api/media?contentHash=<hash>` before uploading |
| Phase 03 upload patterns | Chunk size, retry logic, and progress tracking patterns from the web upload dialog inform the Android implementation |

---

## 4. Scope / Deliverables

**Separate codebase** under `apps/android/` (Kotlin, Jetpack Compose, Android API 26+):

- **Authentication screen**: enter server URL and PAT; validate by calling `GET /api/auth/me`; store credentials in Android `EncryptedSharedPreferences`
- **Folder selection screen**: uses `MediaStore` API to list available media buckets (DCIM, Pictures, Downloads); user selects which buckets to include in sync
- **Sync engine** (`WorkManager` periodic worker, default interval: 1 hour when charging + connected to WiFi; immediate sync button always available):
  1. Enumerate new files in selected buckets since last sync (`MediaStore` query by `DATE_ADDED`)
  2. For each file: compute SHA-256; call `GET /api/media?contentHash=<hash>` — skip if already present
  3. Initialize resumable upload; upload in 5 MB chunks with per-chunk retry (up to 3 attempts)
  4. Complete upload; call `POST /api/media` with `source: android` and device metadata extracted from `MediaStore` (`DATE_TAKEN`, `LATITUDE`, `LONGITUDE`, `MANUFACTURER`, `MODEL`, `DISPLAY_NAME`)
  5. Write to local Room database: `SyncRecord(fileUri, sha256, mediaItemId, syncedAt, status)`
- **Sync status screen**: total synced, pending queue length, last sync time, per-file status for recent items; manual "Sync Now" button
- **Settings screen**: server URL (read-only after login), PAT management, sync interval, WiFi-only toggle, folder list edit
- **Notification**: persistent foreground service notification during active sync; completion notification with count

---

## 5. Data Model Changes

**Server side:** No new Prisma models. `MediaItem.source = android` (enum value already defined in Phase 01).

**Android local database (Room):**

```kotlin
@Entity(tableName = "sync_records")
data class SyncRecord(
    @PrimaryKey val fileUri: String,
    val sha256: String,
    val mediaItemId: String?,
    val syncedAt: Long?,
    val status: SyncStatus,     // PENDING | UPLOADING | DONE | FAILED
    val errorMessage: String?
)

enum class SyncStatus { PENDING, UPLOADING, DONE, FAILED }
```

---

## 6. API Endpoints

The Android app consumes existing endpoints. No new server-side endpoints are required.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/auth/me` | Validate PAT on login and on each sync start |
| `GET /api/media?contentHash=<sha256>` | Dedup check |
| `POST /api/storage/objects/upload/init` | Begin resumable upload |
| `POST /api/storage/objects/:id/upload/complete` | Finalize upload |
| `POST /api/media` | Register as `MediaItem` with `source: android` |

---

## 7. Implementation Steps

| Step | Description | Subagent |
|------|-------------|----------|
| 1 | Create `apps/android/` Gradle project (Kotlin, Jetpack Compose, minSdk 26, targetSdk 34); add `WorkManager`, `Retrofit`, `Room`, `EncryptedSharedPreferences`, `androidx.security.crypto` dependencies | `backend-dev` (initial scaffold) |
| 2 | Implement login screen and PAT storage in `EncryptedSharedPreferences`; PAT validation via `GET /api/auth/me` | `frontend-dev` (Android UI) |
| 3 | Implement `MediaStoreRepository`: enumerate media buckets; query new files since last sync timestamp | `backend-dev` (Android) |
| 4 | Implement SHA-256 computation over `InputStream` from `ContentResolver` | `backend-dev` (Android) |
| 5 | Implement `UploadRepository`: wraps the init → chunk loop → complete API flow using `OkHttp` direct part upload | `backend-dev` (Android) |
| 6 | Implement `SyncWorker` (`CoroutineWorker`): orchestrates dedup check → upload → `POST /api/media`; updates Room `SyncRecord`; handles retry | `backend-dev` (Android) |
| 7 | Schedule `SyncWorker` with `PeriodicWorkRequest` (constraints: network connected + battery not low); expose manual trigger | `backend-dev` (Android) |
| 8 | Implement folder selection, sync status, and settings UI screens (Jetpack Compose) | `frontend-dev` (Android UI) |
| 9 | Implement foreground service notification for active sync | `backend-dev` (Android) |
| 10 | Write unit tests for `SyncWorker` logic (mock `MediaStoreRepository` and `UploadRepository`) and `SHA-256` utility | `testing-dev` |
| 11 | Update `docs/plan/ROADMAP.md` status for Phase 08 | `docs-dev` |

---

## 8. Acceptance Criteria

- A new photo taken on the device and placed in a synced bucket is uploaded within the next sync cycle (at most 1 hour on default settings) without user intervention.
- Deduplication: a file already present on the server (matched by SHA-256) is skipped without re-uploading.
- A 50 MB video uploads in chunks; a failed chunk is retried automatically.
- The app stores the PAT in `EncryptedSharedPreferences`, not plain `SharedPreferences`.
- The sync status screen shows an accurate count of synced vs. pending files.
- The user can disable WiFi-only mode and force sync over cellular.
- The background worker respects Android battery optimization; the foreground service runs only during active upload.
- `SyncRecord` in Room correctly reflects `DONE` or `FAILED` status after each file attempt.

---

## 9. Out of Scope / Deferred

- iOS application (deferred indefinitely; Android is the MVP mobile platform per VISION.MD)
- In-app media browser or viewer (the web app serves this purpose)
- Two-way sync (delete on server → delete on device; deferred — too risky for MVP)
- Import from Google Photos or Apple Photos app libraries (Phase 09)
- End-to-end encryption of media in transit (standard HTTPS used; E2EE deferred)

## 10. Circle Integration

Family Circles (phase FC) is a prerequisite for this phase. The Android sync app must include a `circleId` in the `POST /api/media` body when registering uploads. Resolution order for the active circle: app-level setting (persisted in `EncryptedSharedPreferences`) → default to the user's personal circle. The app should expose a circle selector in Settings so users can direct syncs at a shared family circle. The `GET /api/media?contentHash=<sha256>` dedup check must also include `circleId` as a query parameter to scope dedup to the correct circle.
