# Doctor Diagnostics — End-to-End Reference

> **Since RETRO-B1b (#602) the Doctor is the platform's** (`@marinoscar/platform-api/doctor`, `GET /api/admin/doctor`). MemoriaHub contributes 32 read-only checks as `memoriahub.<section>.<name>`; the framework (report, timeout, normalisation, cache, support bundle) is the package's: see the platform's `docs/specs/doctor.md` and `docs/runbooks/doctor.md`. Sections 2, 3 and 5 to 8 below describe how it is mounted here; §4 is this app's check inventory and the mapping from the former 35 keys.

| Field | Value |
|-------|-------|
| **Version** | 2.0 |
| **Last Updated** | November 2026 |
| **Status** | Implemented |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Response Shape](#2-response-shape)
3. [Status Semantics](#3-status-semantics)
4. [Check Catalog](#4-check-catalog)
5. [`runCheck` Design](#5-runcheck-design)
6. [Reuse of Existing Services](#6-reuse-of-existing-services)
7. [API Endpoint and RBAC](#7-api-endpoint-and-rbac)
8. [Frontend Page](#8-frontend-page)
9. [Gotchas and Implementation Notes](#9-gotchas-and-implementation-notes)

---

## 1. Overview and Goals

Doctor is an admin-only, on-demand configuration health sweep. A single button click (or `GET` call) runs the checks across core infrastructure, authentication, storage, AI, face recognition, geo, the job queue, the distributed worker-node fleet, workflow automation, and the Android app, and returns a structured `DoctorReport`. It exists to give admins one place to verify that the application is correctly configured — instead of manually cross-checking environment variables, system settings, and provider credentials across half a dozen separate admin pages.

A common failure mode Doctor is designed to catch: a feature flag is turned on (e.g. `features.autoTagging`) but the corresponding provider was never configured, so uploads silently enqueue jobs that will fail forever. Doctor's flag-consistency checks surface this class of misconfiguration directly, with an actionable next step.

### Goals

- Single place to verify configuration health across the database, pgvector, storage, AI, face, geo, and the enrichment job queue.
- Exercise live provider connectivity where it is read-only or cheap (AI, face, geo) by reusing each domain's "test connection" service; storage is a read-only probe (see §6).
- Surface flag/provider inconsistencies (feature enabled with no provider, or provider configured with the feature off) that are otherwise invisible until something fails silently in the background.
- Stay fast and safe: the platform service runs checks in parallel (dependency-aware), bounds each to a timeout and turns a throw into a `fail`.
- No new persistence, no new schedule — the report is computed per request and cached in memory for 15 s (`refresh=true` bypasses it).

### Non-Goals

- No history or trend tracking — Doctor does not store past reports. Each call is independent.
- No automatic remediation — Doctor only reports; the admin acts on the `actionItem` text manually (e.g. in the AI/Face/Geo/Storage settings pages).
- Not a substitute for the Job Queue Insights or Storage Insights dashboards — Doctor's job-queue check is a coarse pending/running/failed/stuck health signal, not a durations/ETA breakdown.

---

## 2. Response Shape

Owned by the platform (`@marinoscar/platform-contract/doctor`). `GET /api/admin/doctor[?category=&refresh=true]`:

```json
{
  "data": {
    "verdict": "warn",
    "generatedAt": "2026-11-08T10:00:00.000Z",
    "durationMs": 842,
    "checks": [
      {
        "id": "memoriahub.ai.flag-consistency",
        "category": "ai",
        "label": "Auto-tagging flag consistency",
        "settingsPath": "/admin/settings/tagging",
        "status": "fail",
        "detail": "Auto-Tagging is enabled but no tagging provider is configured.",
        "remedy": "Configure a tagging provider or disable the Auto-Tagging feature flag.",
        "error": null,
        "data": null,
        "durationMs": 1
      }
    ]
  }
}
```

The flat `checks` list is sorted by category (the order configured in `apps/api/src/doctor/doctor.config.ts`, `DOCTOR_CATEGORY_ORDER`: `core, auth, maintenance, storage, email, push, ai, face, geo, jobs, nodes, workflows, android, backup, telemetry, network`), then registration order. There are no `sections`: the page groups by `category`. `GET /api/admin/doctor/support-bundle` downloads a redacted JSON diagnostic file (audited, `SENSITIVE_KEY_PATTERN` redaction).

---

## 3. Status Semantics

| Status | Was | Meaning |
|--------|-----|---------|
| `pass` | `ok` | The check passed; configuration is healthy. |
| `warn` | `warning` | Non-fatal issue: inconsistent or suboptimal but not blocking. Always carries a `remedy`. |
| `fail` | `error` | The check failed in a way that blocks correct operation. Always carries a `remedy`. |
| `skip` | `skipped` | Not evaluated: the feature it covers is off, or a check it `dependsOn` did not pass. **Never a failure.** |

The report's `verdict` is the worst status (`pass < skip < warn < fail`). The old per-section status and `summary` counts are derived by the page. `message` is now `detail`, `actionItem` is `remedy`. A check that omitted an action item on a `warn` (a platform contract rule) now supplies one: `core.app-url` (unset), `core.pg-client-version` (server version unreadable), `ai.embedding` (dimension warning), `jobs.worker-enabled` (two `warn` branches).

---

## 4. Check Catalog

The former 35 checks, now 32 app checks plus 3 the platform host ships. One class per check in `apps/api/src/doctor/checks/<section>/<name>.doctor-check.ts`, each a `@Injectable()` that registers with `DoctorCheckRegistry` in `onModuleInit`, with a pure `decide*()` function the unit tests drive; they are provided by `DoctorChecksModule` (`doctor-checks.module.ts`). Ids are lower-case kebab (`memoriahub.core.pg-client-version`), which the platform's identity rule requires, so the camelCase tails of the old keys changed (`pgClientVersion` is `pg-client-version`, `mediaSync` is `media-sync`). Every check keeps the old 10 s ceiling (`timeoutMs`); the platform default is 5 s.

### Mapping from the former keys

| Former key | Now | Category | Disposition |
|---|---|---|---|
| `core.database` | `db.connection` | `core` | Retired: the platform host core ships it (`PlatformHostCoreModule`) |
| `core.migrations` | `db.migrations` | `core` | Retired: the platform host core ships it (`PlatformHostCoreModule`) |
| `core.secretsKey` | `secrets.encryption-key` | `core` | Retired: the platform host core ships it (`PlatformHostCoreModule`) |
| `core.pgvector` | `memoriahub.core.pgvector` | `core` | Domain check; stays an app check |
| `core.pgClientVersion` | `memoriahub.core.pg-client-version` | `core` | Domain check; stays an app check |
| `core.appUrl` | `memoriahub.core.app-url` | `core` | Domain check; stays an app check |
| `auth.jwt` | `memoriahub.auth.jwt` | `auth` | Stays an app check; retired by the identity slice (RETRO-B2) |
| `auth.googleOauth` | `memoriahub.auth.google-oauth` | `auth` | Stays an app check; retired by the identity slice (RETRO-B2) |
| `auth.adminBootstrap` | `memoriahub.auth.admin-bootstrap` | `auth` | Stays an app check; retired by the identity slice (RETRO-B2) |
| `storage.activeProvider` | `memoriahub.storage.active-provider` | `storage` | Stays an app check; retired by the storage slice (RETRO-D1) |
| `storage.liveTest` | `memoriahub.storage.live-test` | `storage` | Stays an app check; retired by the storage slice (RETRO-D1) |
| `ai.search` | `memoriahub.ai.search` | `ai` | Stays an app check; retired by the AI slice (RETRO-E1/E2) |
| `ai.tagging` | `memoriahub.ai.tagging` | `ai` | Stays an app check; retired by the AI slice (RETRO-E1/E2) |
| `ai.embedding` | `memoriahub.ai.embedding` | `ai` | Stays an app check; retired by the AI slice (RETRO-E1/E2) |
| `ai.flagConsistency` | `memoriahub.ai.flag-consistency` | `ai` | Stays an app check; retired by the AI slice (RETRO-E1/E2) |
| `ai.socialMedia` | `memoriahub.ai.social-media` | `ai` | Domain check; stays an app check |
| `ai.duplicateDetection` | `memoriahub.ai.duplicate-detection` | `ai` | Domain check; stays an app check |
| `ai.pictureEnhancer` | `memoriahub.ai.picture-enhancer` | `ai` | Domain check; stays an app check |
| `ai.videoTagging` | `memoriahub.ai.video-tagging` | `ai` | Domain check; stays an app check |
| `face.detection` | `memoriahub.face.detection` | `face` | Domain check; stays an app check |
| `face.flagConsistency` | `memoriahub.face.flag-consistency` | `face` | Domain check; stays an app check |
| `face.pgvector` | `memoriahub.face.pgvector` | `face` | Domain check; stays an app check |
| `geo.reverseProvider` | `memoriahub.geo.reverse-provider` | `geo` | Domain check; stays an app check |
| `jobs.workerEnabled` | `memoriahub.jobs.worker-enabled` | `jobs` | Stays an app check; retired by the jobs slice (RETRO-C1) |
| `jobs.queueHealth` | `memoriahub.jobs.queue-health` | `jobs` | Stays an app check; retired by the jobs slice (RETRO-C1) |
| `jobs.burstConfig` | `memoriahub.jobs.burst-config` | `jobs` | Domain check; stays an app check |
| `nodes.registeredCount` | `memoriahub.nodes.registered-count` | `nodes` | Stays an app check; retired by the nodes slice (RETRO-C2) |
| `nodes.heartbeatFreshness` | `memoriahub.nodes.heartbeat-freshness` | `nodes` | Stays an app check; retired by the nodes slice (RETRO-C2) |
| `nodes.staleLeases` | `memoriahub.nodes.stale-leases` | `nodes` | Stays an app check; retired by the nodes slice (RETRO-C2) |
| `nodes.capabilityHealth` | `memoriahub.nodes.capability-health` | `nodes` | Stays an app check; retired by the nodes slice (RETRO-C2) |
| `workflows.state` | `memoriahub.workflows.state` | `workflows` | Domain check; stays an app check |
| `android.assetlinks` | `memoriahub.android.assetlinks` | `android` | Stays an app check; retired by the android-app slice (RETRO-D5) |
| `android.releases` | `memoriahub.android.releases` | `android` | Stays an app check; retired by the android-app slice (RETRO-D5) |
| `android.mediaSync` | `memoriahub.android.media-sync` | `android` | Domain check; stays an app check |
| `android.uploadPath` | `memoriahub.android.upload-path` | `android` | Domain check; stays an app check |

The tables below keep the former key in the first column for continuity; read it through the mapping above. Statuses are written in the old vocabulary (`ok`/`warning`/`error`/`skipped` = `pass`/`warn`/`fail`/`skip`). `dependsOn: ['db.connection']` is declared on every check that queries the database, so a dead database yields one `fail` and skipped dependents, not a wall of errors.

### Core (`core`)

`core.database`, `core.migrations` and `core.secretsKey` are retired in favour of the platform host's `db.connection`, `db.migrations` and `secrets.encryption-key` (also shipped: `db.rls_role`, `core.deployment-mode`, `core.event-bus`, `maintenance.mode`).

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `core.pgvector` → `memoriahub.core.pgvector` | pgvector extension | `pg_extension` contains `vector` AND `to_regclass('public.media_item_embedding')` resolves | `error` — "Use a pgvector-capable Postgres image (pgvector/pgvector:pg17) and re-run migrations; semantic search is unavailable without it." |
| `core.pgClientVersion` → `memoriahub.core.pg-client-version` | PostgreSQL client version | `pg_dump --version` major vs. `server_version_num` major — `pg_dump` refuses to dump a server newer than itself (issue #364) | `error` when the client is positively older than the server; `warning` when `pg_dump` is missing from PATH (backup/restore unavailable, nothing else affected) or the server version could not be read; action item — "Rebuild the API image with postgresql-client-17 (or newer) — see apps/api/Dockerfile." |
| `core.appUrl` → `memoriahub.core.app-url` | App URL | `APP_URL` is set; warns if it still contains `localhost` while `NODE_ENV=production` | `warning` (both branches — unset, or localhost-in-prod) |

### Authentication (`auth`)

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `auth.jwt` → `memoriahub.auth.jwt` | JWT secret | `JWT_SECRET` is set and at least 32 characters | `error` — "Set JWT_SECRET to a random string of at least 32 characters." |
| `auth.googleOauth` → `memoriahub.auth.google-oauth` | Google OAuth | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are both set | `error` in production ("Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET."); `warning` ("dev fallback only") outside production |
| `auth.adminBootstrap` → `memoriahub.auth.admin-bootstrap` | Admin bootstrap | At least one user holds the `admin` role | `warning` — "Set INITIAL_ADMIN_EMAIL and have that user sign in." (message notes whether `INITIAL_ADMIN_EMAIL` is even set) |

### Storage (`storage`)

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `storage.activeProvider` → `memoriahub.storage.active-provider` | Active storage provider | The resolved active provider (`storage.activeProvider` setting, else `STORAGE_PROVIDER` env, else `s3`) is `local`, or has an `enabled` row in `storage_provider_credentials` | `error` — "Configure a storage provider in Admin Settings → Storage Providers." |
| `storage.liveTest` → `memoriahub.storage.live-test` | Storage connectivity | **Read-only probe** (RETRO-B1b): resolves the active provider through `StorageProviderResolver` and calls `exists()` on a key that is never written (S3 HEAD; a stat for `local`). Bad credentials, a wrong bucket or an unreachable endpoint throw and become `error`. It no longer writes the sentinel object the old write→read→delete round-trip did (a platform rule); that round-trip stays on the Storage Providers page's "Test connection" | `error` with the service's own error message — "Fix storage credentials/bucket in Admin Settings → Storage Providers." |

### AI & Enrichment (`ai`)

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `ai.search` → `memoriahub.ai.search` | AI search provider | If `ai.features.search` is configured, live connectivity via `AiSettingsService.testProvider()`; `skipped` if not configured | `error` — "Check the provider API key and model in Admin Settings → AI." |
| `ai.tagging` → `memoriahub.ai.tagging` | Auto-tagging provider | Same live test against `ai.features.tagging`; `skipped` if not configured | `error` — same action item as above |
| `ai.embedding` → `memoriahub.ai.embedding` | Text embedding provider | Live test via `AiSettingsService.testEmbedding()` against `ai.features.embedding`; `skipped` if not configured; downgrades to `warning` if the provider returns a dimension `warning` | `error` — same action item as above |
| `ai.flagConsistency` → `memoriahub.ai.flag-consistency` | Auto-tagging flag consistency | Cross-checks `features.autoTagging` against whether a tagging provider is configured | `error` if flag on / no provider — "Configure a tagging provider or disable the Auto-Tagging feature flag."; `warning` if provider configured / flag off — "Enable Auto-Tagging in Admin Settings → Tagging if desired." |
| `ai.socialMedia` → `memoriahub.ai.social-media` | Social media detection | `skipped` if `features.socialMediaDetection` is off; `warning` if the env kill-switch `SOCIAL_MEDIA_DETECTION_ENABLED=false` overrides an enabled flag, or if any `socialMedia.*` tunable is out of its documented range; otherwise probes `SocialMediaOcrService.getStatus()` — `ok` "Two-tier detection operational" when the OCR worker is healthy (or `ok` "Tier-1 (metadata/filename) only" when `socialMedia.ocrEnabled` is off), `warning` "Running Tier-1 only — OCR model unavailable (degraded)" when the OCR worker failed to initialize | `warning` — "Remove or set SOCIAL_MEDIA_DETECTION_ENABLED=true" / "Correct the social media detection parameters in Admin Settings." / "Ensure MODELS_DIR/tesseract is writable and traineddata can be fetched or pre-placed" |
| `ai.duplicateDetection` → `memoriahub.ai.duplicate-detection` | Duplicate detection (CLIP) | `skipped` if `features.duplicateDetection` is off; otherwise probes `VisualEmbeddingService.isAvailable()` — the CLIP model loaded, or the feature is running dHash-only | `warning` when degraded to dHash-only (never `error`: detection still works) |
| `ai.pictureEnhancer` → `memoriahub.ai.picture-enhancer` | AI picture enhancer | See [picture-enhancer.md](picture-enhancer.md): `skipped` when `features.pictureEnhancement` is off; `warning` on the `PICTURE_ENHANCEMENT_ENABLED` env override or no `ai.features.enhance` model; `error` when the resolved provider has no enabled credential | as described |
| `ai.videoTagging` → `memoriahub.ai.video-tagging` | Video AI tagging | See [video-auto-tagging.md](video-auto-tagging.md): the visual pass is required (`error` when unconfigured), transcription is optional (`warning`, the job runs visual-only); `skipped` when `features.autoTagging` or `autoTagging.video.enabled` is off | as described |

### Face Recognition (`face`)

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `face.detection` → `memoriahub.face.detection` | Face detection provider | If `features.faceRecognition` is on with no provider configured → `error`; if a provider is configured, live test via `FaceSettingsService.testProvider()`; otherwise `skipped` | `error` — "Configure a face detection provider or disable Face Recognition." / "Check the provider configuration in Admin Settings → Face." |
| `face.flagConsistency` → `memoriahub.face.flag-consistency` | Face flag consistency | Cross-checks `features.faceRecognition` against whether a detection provider is configured | `warning` if provider configured / flag off — "Enable Face Recognition in Admin Settings → Face if desired."; `skipped` if flag off and no provider |
| `face.pgvector` → `memoriahub.face.pgvector` | Face pgvector index | `skipped` when `FACE_VECTOR_BACKEND=app`; otherwise checks `information_schema.columns` for `embedding_vec` and `pg_indexes` for all three HNSW index names (`faces_embedding_vec_hnsw_idx` main, `faces_embedding_vec_archive_hnsw_idx` partial archive-set, `faces_embedding_vec_assigned_hnsw_idx` partial assigned-set) | `warning` if the column or main index is missing — "Run migrations (npx prisma migrate deploy) to add the face pgvector column/indexes, or set FACE_VECTOR_BACKEND=app to roll back."; separate `warning` if only the partial archive index is missing — "Run migrations to add the partial archive index." (face-auto-archive KNN degrades to the main index); separate `warning` if only the partial assigned-set index is missing — "Run migrations (npx prisma migrate deploy) to add the partial assigned-set index." (person-match KNN falls back to the main index and can be starved by unassigned faces after bulk imports); `ok` — "faces.embedding_vec column and all three HNSW indexes present." when the column and all three indexes are present |

### Geo (`geo`)

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `geo.reverseProvider` → `memoriahub.geo.reverse-provider` | Reverse geocoding | Live test via `GeoSettingsService.testProvider()` against the resolved active reverse provider (`geo.reverseProvider` setting, else `GEO_PROVIDER` env, else `offline`) | `error` — "Configure the geo provider credentials in Admin Settings → Geo." |

### Job Queue & Worker (`jobs`)

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `jobs.workerEnabled` → `memoriahub.jobs.worker-enabled` | Enrichment worker enabled | Mode-aware via `resolveWorkerMode()` (`ENRICHMENT_WORKER_MODE=all\|system\|off`, legacy booleans as fallback). `all` → `ok`. `system`/`off` additionally run a cheap `worker_nodes` count (online + fresh heartbeat within the shared `NODE_HEARTBEAT_STALE_SECONDS` window + `eligibleTypes` covering `face_detection`/`auto_tagging`): `system` + healthy node(s) → `ok`; `system` + none while an enrichment feature (`features.autoTagging` / `features.faceRecognition` / `features.burstDetection`) is on → `warning`; `off` + healthy node(s) → `warning` (no server fallback — server-only jobs won't run); `off` + none while a feature is on → `error` | `error` — "Set ENRICHMENT_WORKER_MODE=all (or =system with a running node fleet) so enrichment jobs get processed."; `warning` action items point at starting a node or switching to `system` mode |
| `jobs.queueHealth` → `memoriahub.jobs.queue-health` | Queue health | `EnrichmentAdminService.getStats()`: warns on stuck-running jobs, then on any failed jobs | `warning` — "Reset stuck jobs from the Job Queue page." / "Review and retry failed jobs from the Job Queue page." |
| `jobs.burstConfig` → `memoriahub.jobs.burst-config` | Burst detection | Reports `ok` when `features.burstDetection` is on (no provider dependency — relies only on the enrichment worker); `skipped` when off | n/a (informational only, never `error`/`warning`) |

### Worker Nodes (`nodes`)

Distributed compute fleet health (see [distributed-nodes.md §10.2](distributed-nodes.md)). All checks are pure DB reads — worker nodes are optional, so an unused fleet never fails.

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `nodes.registeredCount` → `memoriahub.nodes.registered-count` | Registered nodes | Counts `worker_nodes` rows (and how many are `online`); `skipped` when none are registered | n/a (informational only) |
| `nodes.heartbeatFreshness` → `memoriahub.nodes.heartbeat-freshness` | Heartbeat freshness | For `status='online'` nodes, flags any whose `lastHeartbeatAt` is null or older than `NODE_HEARTBEAT_STALE_SECONDS` (default 60s); `skipped` if no online nodes | `warning` if some online nodes are stale, `error` if ALL are — message/action item names the stale node(s) |
| `nodes.staleLeases` → `memoriahub.nodes.stale-leases` | Expired leases | Counts `enrichment_jobs` where `status='running'` and `leaseExpiresAt < now()` (claiming node likely died) | `warning` — "Reset stuck jobs from the Job Queue page (reset-stuck) so they are requeued." |
| `nodes.capabilityHealth` → `memoriahub.nodes.capability-health` | Node capability health | Inspects each online node's reported `capabilities` JSON for a degraded/error capability backing one of its `eligibleTypes`; `skipped` if no node has reported capabilities yet | `warning` — "Run `memoriahub node doctor` on the affected machine(s) to resolve the failing capability." |

### Workflows (`workflows`)

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `workflows.state` → `memoriahub.workflows.state` | Workflow engine state | `skipped` when `features.workflows` is off; otherwise looks for non-terminal runs with no progress for 30 minutes, `awaiting_approval` runs past `workflows.previewTtlHours`, and enabled scheduled workflows while the scheduled trigger is switched off (see [workflows.md](workflows.md)) | `warning` combining every finding, with matching action items |

### Android app (`android`)

The Android app and its Media Sync companion (epic #498, issue #507; contract: [android-media-sync.md §20](android-media-sync.md#20-doctor)). Read-only like every other check: trusted apps come from `AndroidAppService`, releases and the upload target from `AndroidReleaseService` (both exported by `AndroidAppModule`), and Media Sync devices straight from Prisma (`DoctorModule` does not import `MediaSyncModule`). "Active device" means `media_sync_devices.status = 'active'`. The section status is the worst of its four checks.

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `android.assetlinks` → `memoriahub.android.assetlinks` | Digital Asset Links | Every distinct (`packageName`, `signingSha256`) an active device reports (`AndroidAppService.getReportedApps`) is in the trusted apps, and so is the current release's signer (fingerprints compared normalised). `skipped` when no active device has reported a signer and the current release (if any) is trusted; `ok` when every reported pair is trusted | `warning` naming up to 3 untrusted pairs (and/or the untrusted release signer): the app opens with a URL bar — "Trust it in Admin → Settings → Android app (/admin/settings/android)."; `error` when the trusted apps cannot be read |
| `android.releases` → `memoriahub.android.releases` | Android release | A release is current once phones are paired. `skipped` with no active device; `ok` message carries `devicesBehind` — active devices whose `appVersionCode` is below the current `versionCode` (same package, or no package reported). This is the only "devices behind" figure an administrator sees (spec D19) and is informational | `warning` when devices are paired but no release is current — publish with `memoriahub android release` or upload in Admin → Settings → Android app |
| `android.mediaSync` → `memoriahub.android.media-sync` | Media sync devices | Each active device: checked in within 48 h (`lastSeenAt`), `stats.blocked` is 0, `permission` is `full` (null = not reported yet, not flagged), and its paired PAT exists, is not revoked and has not expired. `skipped` with no active device | `warning` with per-reason counts and up to 5 devices named (`name, owner email: reasons`) — ask the owner to open Media Sync → Diagnostics, grant full access, resolve blocked files, or pair again |
| `android.uploadPath` → `memoriahub.android.upload-path` | Phone upload path | Resolves the ACTIVE storage provider exactly as the APK upload does (`AndroidReleaseService.resolveUploadTarget`). `ok` when it hands out presigned part URLs (`supportsPresignedParts`, S3/R2) or takes parts through the API route `PUT /api/storage/objects/:id/upload/parts/:n` (`writePart`, local disk, #506). Not skipped without devices: it answers whether a phone could upload before one is paired. The message names the provider key | `error` when the provider is unconfigured (no bucket, undecryptable credential) or supports neither part path — "Configure a storage provider in Admin Settings → Storage Providers." |

---

## 5. How the sweep runs

The framework is the platform's `DoctorService`; this app writes none of it (the old `runCheck()`, `Promise.allSettled` fan-out, timeout `Symbol` sentinel and single-snapshot code were deleted with `doctor.service.ts`). What it gives, per the check contract:

- **Parallel and dependency-aware.** A check whose `dependsOn` did not pass is reported `skip` and never runs.
- **Time-boxed.** A hang becomes `fail` ("Timed out after Nms") after the check's `timeoutMs` (10 s here).
- **A throw is a `fail`** carrying the error message; the whole report always completes.
- **Cached** for 15 s per category; "Run again" sends `refresh=true`.
- **Settings read.** Each check reads `SystemSettingsService.getSettings({ readOnly: true })`, which is cached in-process for 5 s and, unlike plain `getSettings()`, never seeds a missing `system_settings` row (a Doctor run must not write). A run can therefore mix settings across a change made mid-run, within 5 s; negligible.

### The read-only rule

Checks never write a row, an object or an audit event, never enqueue a job and never hold a "test" service that does (`StorageSettingsService`, which writes a sentinel, is forbidden by `apps/api/test/conformance.spec.ts`; the platform's `doctor-read-only` suite runs every registered check against a recording Prisma client and a write-failing storage double). The one deliberate exception is the **live provider probes** `ai.search`, `ai.tagging`, `ai.embedding`, `face.detection` and `geo.reverseProvider`, which call the provider adapter's `testModel`/`testProvider`: they write nothing but spend a few tokens (AI) or one lookup (geo, billed on Google). They are listed in `docs/platform-adoption/local-exceptions.md` and retire with the AI and geo slices.

---

## 6. Reuse of Existing Services

Doctor reuses the domain services that already know how to ask a provider a question:

| Domain | Service | Method used |
|--------|---------|-------------|
| AI (search / tagging) | `AiSettingsService` | `testProvider({ provider, model })` (live probe, see §5) |
| AI (embedding) | `AiSettingsService` | `testEmbedding({})` (live probe) |
| AI (video tagging transcription) | `AiProviderRegistry` | `get(provider)` capability lookup (`transcribeAudio`) |
| Face detection | `FaceSettingsService` | `testProvider({ provider })` (sidecar connectivity) |
| Geo (reverse) | `GeoSettingsService` | `testProvider({ provider })` (live probe) |
| Storage | `StorageProviderResolver` | `getProviderFor(active).exists(probeKey)` (read-only) |
| Job queue stats | `EnrichmentAdminService` | `getStats()` (same source as `/admin/settings/jobs`) |
| Worker mode | `resolveWorkerMode()` | exported helper from `enrichment/enrichment-job.worker.ts` |
| Social media OCR / CLIP | `SocialMediaOcrService.getStatus()`, `VisualEmbeddingService.isAvailable()` | availability only |
| Android trusted / reported apps | `AndroidAppService` | `getTrustedApps()`, `getReportedApps(trusted)` |
| Android releases, upload target | `AndroidReleaseService` | `current()`, `resolveUploadTarget()` |

`core.pgvector` and `face.pgvector` are Doctor-specific catalog SELECTs (no settings page backs them). `core.pg-client-version` spawns `pg_dump --version` through the db-backup util and reads `server_version_num`.

---

## 7. API Endpoint and RBAC

- `GET /api/admin/doctor[?category=&refresh=true]` and `GET /api/admin/doctor/support-bundle`, both `system_settings:read` (`DEFAULT_DOCTOR_PERMISSION`), mounted by `DoctorModule.forRoot` in `apps/api/src/doctor/doctor.config.ts` through the platform host (`platform/platform-host.ts`). Unauthenticated is 401, without the permission 403.
- **`POST /api/admin/doctor/run` is removed** (404). The only callers were the web page (replaced) and this document; the CLI never called it.
- No new permission; no `doctor:*` scope. Side effects: none beyond the read-only probes in §5. The support bundle download is audited (`support_bundle:download`) and redacted.

| Resource | Permission | Granted To |
|----------|------------|------------|
| Run diagnostics / support bundle | `system_settings:read` | Admin only |

---

## 8. Frontend Page

**Route:** `/admin/settings/doctor` (unchanged), the platform's `DoctorPage` (`@marinoscar/platform-web/doctor/ui`).

- **Card:** `{ ...doctorSettingsPage.card, Icon: doctorSettingsPage.Icon }` in `apps/web/src/config/adminSections.tsx`, in the same place in the Operations group, `permission: 'system_settings:read'` (the string the controller enforces).
- **Route:** `apps/web/src/App.tsx`, behind `RequirePermission permission="system_settings:read"`; the lazy binding `pages/Admin/DoctorPage.tsx` passes this app's `categories` (`config/doctorCategories.ts`: labels and order for `face`, `geo`, `workflows`, `android`, in the API's order).
- **Transport:** `PlatformHostProvider` (`platform/platformHost.tsx`). The support-bundle button needs `getBlob`, which the app's `ApiService` lacks; `appGetBlob` (same bearer token, same one refresh-and-retry) supplies it and is a documented shim.
- **Page:** the verdict, counts by status, one accordion per category (problems expanded), a "Problems only" filter, each check's detail, remedy, error and "Open settings" link, "Run again" and "Download support bundle". The old hand-written page, `useDoctor` hook and `services/doctor.ts` are deleted.

---

## 9. Gotchas and Implementation Notes

### `skip` Is Not a Failure

A `skip` (e.g. `face.detection` with face recognition off) is an intentional "not evaluated"; it must not count as a problem. A check also reports `skip` when a dependency (`db.connection`) failed; look at the dependency first.

### Reused Services Can Throw Instead of Returning `{ ok: false }`

Some "test connection" methods throw (a `BadRequestException` for missing credentials). The live-probe checks catch that themselves and report `fail` with the message; the platform guard is the backstop, not the plan.

### Plain `getSettings()` Writes

`SystemSettingsService.getSettings()` creates the `system_settings` row when it is missing. Every Doctor read (and the host core's `HostSystemSettingsShim`, and the queue stats' stuck threshold) uses `getSettings({ readOnly: true })`. A new check must too; the `doctor-read-only` conformance suite fails otherwise.

### Doctor Duplicates Some Signals Also Available Elsewhere

`jobs.queue-health` shows the counts already on `/admin/settings/jobs`, and the live tests duplicate each settings page's "Test connection" button. Intentional: one sweep instead of six pages. They can differ if state changes between two calls.

### Adding a check

Add `checks/<section>/<name>.doctor-check.ts` (id via `checkId(section, name)`, kebab-case; a pure `decide*`; a `remedy` on every `warn`/`fail`; `timeoutMs`; `dependsOn: ['db.connection']` when it queries), add the class to `MEMORIAHUB_DOCTOR_CHECKS` in `doctor-checks.module.ts`, a unit test, and a row to §4. For the Android section also update the table in `docs/runbooks/android-app.md` (CLAUDE.md Android rule 13).

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | July 2026 | AI Assistant | Initial specification |
| 1.1 | July 2026 | AI Assistant | Add `ai.socialMedia` check (AI & Enrichment section) covering the social-media video detection feature flag, env override, `socialMedia.*` range validation, and OCR degraded-mode probing; check catalog is now twenty-one checks |
| 1.2 | July 2026 | AI Assistant | Add `nodes` section (Worker Nodes) with four checks — `nodes.registeredCount`, `nodes.heartbeatFreshness`, `nodes.staleLeases`, `nodes.capabilityHealth` — covering the distributed compute fleet ([distributed-nodes.md §10.2](distributed-nodes.md)); check catalog is now twenty-five checks across eight sections |
| 1.3 | October 2026 | AI Assistant | Add the `android` section (Android app, issue #507) with four checks — `android.assetlinks`, `android.releases`, `android.mediaSync`, `android.uploadPath`; catalog the existing `ai.duplicateDetection`, `ai.pictureEnhancer`, `ai.videoTagging` and `workflows.state` checks; the catalog is now thirty-five checks across ten sections |
| 2.0 | November 2026 | AI Assistant | RETRO-B1b (#602): the Doctor is the platform's (`DoctorModule.forRoot`, `GET /api/admin/doctor`, support bundle); `POST /api/admin/doctor/run` removed; 32 app checks as `memoriahub.<section>.<name>` plus the host's `db.connection`, `db.migrations`, `secrets.encryption-key`; `storage.liveTest` is a read-only probe; status vocabulary pass/warn/fail/skip; mapping table |
