# Doctor Diagnostics — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.1 |
| **Last Updated** | July 2026 |
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

Doctor is an admin-only, on-demand configuration health sweep. A single button click (or `POST` call) runs twenty-five checks across core infrastructure, authentication, storage, AI, face recognition, geo, the job queue, and the distributed worker-node fleet, and returns a structured `DoctorReport`. It exists to give admins one place to verify that the application is correctly configured — instead of manually cross-checking environment variables, system settings, and provider credentials across half a dozen separate admin pages.

A common failure mode Doctor is designed to catch: a feature flag is turned on (e.g. `features.autoTagging`) but the corresponding provider was never configured, so uploads silently enqueue jobs that will fail forever. Doctor's flag-consistency checks surface this class of misconfiguration directly, with an actionable next step.

### Goals

- Single place to verify configuration health across the database, pgvector, storage, AI, face, geo, and the enrichment job queue.
- Actually exercise live provider connectivity (not just "is a credential present") by reusing each domain's existing "test connection" service.
- Surface flag/provider inconsistencies (feature enabled with no provider, or provider configured with the feature off) that are otherwise invisible until something fails silently in the background.
- Stay fast and safe: run all checks concurrently, bound every check to a hard timeout, and never let one hung or throwing check take down the whole sweep.
- No new persistence, no new schedule — every call is a fresh, on-demand computation.

### Non-Goals

- No history or trend tracking — Doctor does not store past reports. Each call is independent.
- No automatic remediation — Doctor only reports; the admin acts on the `actionItem` text manually (e.g. in the AI/Face/Geo/Storage settings pages).
- Not a substitute for the Job Queue Insights or Storage Insights dashboards — Doctor's job-queue check is a coarse pending/running/failed/stuck health signal, not a durations/ETA breakdown.

---

## 2. Response Shape

**File:** `apps/api/src/doctor/doctor.types.ts`

```typescript
export type DoctorCheckStatus = 'ok' | 'warning' | 'error' | 'skipped';

export interface DoctorCheck {
  key: string;
  label: string;
  status: DoctorCheckStatus;
  message: string;
  actionItem?: string;
  durationMs: number;
}

export interface DoctorSection {
  key: string;
  label: string;
  /** Worst status among its checks; 'skipped' counts as 'ok' for aggregation. */
  status: DoctorCheckStatus;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  computedAt: string;
  durationMs: number;
  summary: { ok: number; warning: number; error: number; skipped: number; total: number };
  sections: DoctorSection[];
}
```

Example response (`POST /api/admin/doctor/run`):

```json
{
  "computedAt": "2026-07-03T12:00:00.000Z",
  "durationMs": 842,
  "summary": { "ok": 17, "warning": 2, "error": 1, "skipped": 1, "total": 21 },
  "sections": [
    {
      "key": "ai",
      "label": "AI & Enrichment",
      "status": "error",
      "checks": [
        {
          "key": "ai.flagConsistency",
          "label": "Auto-tagging flag consistency",
          "status": "error",
          "message": "Auto-Tagging is enabled but no tagging provider is configured.",
          "actionItem": "Configure a tagging provider or disable the Auto-Tagging feature flag.",
          "durationMs": 1
        }
      ]
    }
  ]
}
```

---

## 3. Status Semantics

| Status | Meaning |
|--------|---------|
| `ok` | The check passed; configuration is healthy. |
| `warning` | Non-fatal issue — something is inconsistent or suboptimal but not blocking (e.g. a provider is configured but its feature flag is off; `APP_URL` still points at `localhost` in production). |
| `error` | The check failed in a way that blocks correct operation; always carries an `actionItem` telling the admin what to do. |
| `skipped` | The check intentionally did not run because the feature it covers is turned off (e.g. face recognition disabled). **Never treated as a failure.** |

### Aggregation

- **Section status** = the worst status among its checks, where `error` > `warning` > `ok`, and `skipped` counts as `ok` for this purpose (`DoctorService.worstStatus`). A section made entirely of `skipped` checks reports `ok`.
- **Summary counts** (`summary.ok/warning/error/skipped/total`) are a flat tally across all checks regardless of section, computed by incrementing `summary[c.status]` for every check.
- **Overall report status** is not a field on `DoctorReport` itself — the frontend derives it from `summary`: any `error` → "Unhealthy", else any `warning` → "Needs attention", else → "Healthy" (see `DoctorPage.tsx`).

---

## 4. Check Catalog

Twenty-five checks across eight sections, defined in `DoctorService.runDiagnostics()` (`apps/api/src/doctor/doctor.service.ts`). Section status is the worst of its listed checks.

### Core (`core`)

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `core.database` | Database connectivity | `SELECT 1` against Postgres via Prisma | `error` — "Verify POSTGRES_* env vars and that the database is reachable." |
| `core.migrations` | Migrations applied | `_prisma_migrations` has no row with `finished_at IS NULL` | `error` — "Run `npx prisma migrate deploy`." |
| `core.pgvector` | pgvector extension | `pg_extension` contains `vector` AND `to_regclass('public.media_item_embedding')` resolves | `error` — "Use a pgvector-capable Postgres image (pgvector/pgvector:pg16) and re-run migrations; semantic search is unavailable without it." |
| `core.secretsKey` | Secrets encryption key | `SECRETS_ENCRYPTION_KEY` is set and base64-decodes to exactly 32 bytes | `error` — "Set SECRETS_ENCRYPTION_KEY to a base64-encoded 32-byte key (openssl rand -base64 32)." |
| `core.appUrl` | App URL | `APP_URL` is set; warns if it still contains `localhost` while `NODE_ENV=production` | `warning` (both branches — unset, or localhost-in-prod) |

### Authentication (`auth`)

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `auth.jwt` | JWT secret | `JWT_SECRET` is set and at least 32 characters | `error` — "Set JWT_SECRET to a random string of at least 32 characters." |
| `auth.googleOauth` | Google OAuth | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are both set | `error` in production ("Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET."); `warning` ("dev fallback only") outside production |
| `auth.adminBootstrap` | Admin bootstrap | At least one user holds the `admin` role | `warning` — "Set INITIAL_ADMIN_EMAIL and have that user sign in." (message notes whether `INITIAL_ADMIN_EMAIL` is even set) |

### Storage (`storage`)

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `storage.activeProvider` | Active storage provider | The resolved active provider (`storage.activeProvider` setting, else `STORAGE_PROVIDER` env, else `s3`) is `local`, or has an `enabled` row in `storage_provider_credentials` | `error` — "Configure a storage provider in Admin Settings → Storage Providers." |
| `storage.liveTest` | Storage connectivity | Live write→read→delete round-trip via `StorageSettingsService.testConnection()` against the active provider | `error` with the service's own error message — "Fix storage credentials/bucket in Admin Settings → Storage Providers." |

### AI & Enrichment (`ai`)

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `ai.search` | AI search provider | If `ai.features.search` is configured, live connectivity via `AiSettingsService.testProvider()`; `skipped` if not configured | `error` — "Check the provider API key and model in Admin Settings → AI." |
| `ai.tagging` | Auto-tagging provider | Same live test against `ai.features.tagging`; `skipped` if not configured | `error` — same action item as above |
| `ai.embedding` | Text embedding provider | Live test via `AiSettingsService.testEmbedding()` against `ai.features.embedding`; `skipped` if not configured; downgrades to `warning` if the provider returns a dimension `warning` | `error` — same action item as above |
| `ai.flagConsistency` | Auto-tagging flag consistency | Cross-checks `features.autoTagging` against whether a tagging provider is configured | `error` if flag on / no provider — "Configure a tagging provider or disable the Auto-Tagging feature flag."; `warning` if provider configured / flag off — "Enable Auto-Tagging in Admin Settings → Tagging if desired." |
| `ai.socialMedia` | Social media detection | `skipped` if `features.socialMediaDetection` is off; `warning` if the env kill-switch `SOCIAL_MEDIA_DETECTION_ENABLED=false` overrides an enabled flag, or if any `socialMedia.*` tunable is out of its documented range; otherwise probes `SocialMediaOcrService.getStatus()` — `ok` "Two-tier detection operational" when the OCR worker is healthy (or `ok` "Tier-1 (metadata/filename) only" when `socialMedia.ocrEnabled` is off), `warning` "Running Tier-1 only — OCR model unavailable (degraded)" when the OCR worker failed to initialize | `warning` — "Remove or set SOCIAL_MEDIA_DETECTION_ENABLED=true" / "Correct the social media detection parameters in Admin Settings." / "Ensure MODELS_DIR/tesseract is writable and traineddata can be fetched or pre-placed" |

### Face Recognition (`face`)

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `face.detection` | Face detection provider | If `features.faceRecognition` is on with no provider configured → `error`; if a provider is configured, live test via `FaceSettingsService.testProvider()`; otherwise `skipped` | `error` — "Configure a face detection provider or disable Face Recognition." / "Check the provider configuration in Admin Settings → Face." |
| `face.flagConsistency` | Face flag consistency | Cross-checks `features.faceRecognition` against whether a detection provider is configured | `warning` if provider configured / flag off — "Enable Face Recognition in Admin Settings → Face if desired."; `skipped` if flag off and no provider |
| `face.pgvector` | Face pgvector index | `skipped` when `FACE_VECTOR_BACKEND=app`; otherwise checks `information_schema.columns` for `embedding_vec` and `pg_indexes` for all three HNSW index names (`faces_embedding_vec_hnsw_idx` main, `faces_embedding_vec_archive_hnsw_idx` partial archive-set, `faces_embedding_vec_assigned_hnsw_idx` partial assigned-set) | `warning` if the column or main index is missing — "Run migrations (npx prisma migrate deploy) to add the face pgvector column/indexes, or set FACE_VECTOR_BACKEND=app to roll back."; separate `warning` if only the partial archive index is missing — "Run migrations to add the partial archive index." (face-auto-archive KNN degrades to the main index); separate `warning` if only the partial assigned-set index is missing — "Run migrations (npx prisma migrate deploy) to add the partial assigned-set index." (person-match KNN falls back to the main index and can be starved by unassigned faces after bulk imports); `ok` — "faces.embedding_vec column and all three HNSW indexes present." when the column and all three indexes are present |

### Geo (`geo`)

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `geo.reverseProvider` | Reverse geocoding | Live test via `GeoSettingsService.testProvider()` against the resolved active reverse provider (`geo.reverseProvider` setting, else `GEO_PROVIDER` env, else `offline`) | `error` — "Configure the geo provider credentials in Admin Settings → Geo." |

### Job Queue & Worker (`jobs`)

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `jobs.workerEnabled` | Enrichment worker enabled | Mode-aware via `resolveWorkerMode()` (`ENRICHMENT_WORKER_MODE=all\|system\|off`, legacy booleans as fallback). `all` → `ok`. `system`/`off` additionally run a cheap `worker_nodes` count (online + fresh heartbeat within the shared `NODE_HEARTBEAT_STALE_SECONDS` window + `eligibleTypes` covering `face_detection`/`auto_tagging`): `system` + healthy node(s) → `ok`; `system` + none while an enrichment feature (`features.autoTagging` / `features.faceRecognition` / `features.burstDetection`) is on → `warning`; `off` + healthy node(s) → `warning` (no server fallback — server-only jobs won't run); `off` + none while a feature is on → `error` | `error` — "Set ENRICHMENT_WORKER_MODE=all (or =system with a running node fleet) so enrichment jobs get processed."; `warning` action items point at starting a node or switching to `system` mode |
| `jobs.queueHealth` | Queue health | `EnrichmentAdminService.getStats()`: warns on stuck-running jobs, then on any failed jobs | `warning` — "Reset stuck jobs from the Job Queue page." / "Review and retry failed jobs from the Job Queue page." |
| `jobs.burstConfig` | Burst detection | Reports `ok` when `features.burstDetection` is on (no provider dependency — relies only on the enrichment worker); `skipped` when off | n/a (informational only, never `error`/`warning`) |

### Worker Nodes (`nodes`)

Distributed compute fleet health (see [distributed-nodes.md §10.2](distributed-nodes.md)). All checks are pure DB reads — worker nodes are optional, so an unused fleet never fails.

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|-------------------|----------------------------------|
| `nodes.registeredCount` | Registered nodes | Counts `worker_nodes` rows (and how many are `online`); `skipped` when none are registered | n/a (informational only) |
| `nodes.heartbeatFreshness` | Heartbeat freshness | For `status='online'` nodes, flags any whose `lastHeartbeatAt` is null or older than `NODE_HEARTBEAT_STALE_SECONDS` (default 60s); `skipped` if no online nodes | `warning` if some online nodes are stale, `error` if ALL are — message/action item names the stale node(s) |
| `nodes.staleLeases` | Expired leases | Counts `enrichment_jobs` where `status='running'` and `leaseExpiresAt < now()` (claiming node likely died) | `warning` — "Reset stuck jobs from the Job Queue page (reset-stuck) so they are requeued." |
| `nodes.capabilityHealth` | Node capability health | Inspects each online node's reported `capabilities` JSON for a degraded/error capability backing one of its `eligibleTypes`; `skipped` if no node has reported capabilities yet | `warning` — "Run `memoriahub node doctor` on the affected machine(s) to resolve the failing capability." |

---

## 5. `runCheck` Design

**File:** `apps/api/src/doctor/doctor.service.ts`

Every check is defined as a `CheckDef { key, label, fn }` and wrapped by a shared `runCheck()` helper before being added to the report. Three properties make the sweep robust:

### Concurrency via `Promise.allSettled`

All twenty check functions are invoked together:

```typescript
const settled = await Promise.allSettled(defs.map((def) => this.runCheck(def)));
```

`Promise.allSettled` guarantees every check resolves (never rejects the whole batch), so a single check's exception can never prevent the other nineteen from completing. The `allSettled` rejection branch in `runDiagnostics()` is unreachable in practice — `runCheck()` already catches everything internally — and is kept only as defense in depth.

### 10-second per-check timeout

```typescript
const CHECK_TIMEOUT_MS = 10_000;
```

Each check races its own promise against a `setTimeout`-based timeout using a private `Symbol` sentinel (`TIMEOUT_SENTINEL`) so a legitimate error value can never be confused with a timeout. If a live provider call (e.g. a slow or hung geo/AI/storage connectivity test) doesn't resolve within 10 seconds, the check is recorded as `error` with message `"Check timed out after 10s"` and the sweep continues — one unreachable third-party API can never hang the whole report.

### Exception normalization

Several of the reused "test connection" services throw (e.g. a `BadRequestException` when credentials are missing) rather than returning `{ ok: false }`. `runCheck()`'s `catch` block normalizes any thrown value — `Error` or otherwise — into a `DoctorCheck` with `status: 'error'` and the thrown message, so a throwing dependency never crashes `runDiagnostics()` or produces a malformed report.

### Single settings snapshot

```typescript
const settings = await this.systemSettings.getSettings();
```

`getSettings()` is called exactly once at the top of `runDiagnostics()`, before any check runs, and the same `settings` object is threaded into every check that needs it (storage, AI, face, geo, jobs checks). This guarantees all twenty checks reason about one consistent point-in-time view of system settings, rather than each check independently re-reading settings mid-sweep (which could produce a report that mixes pre- and post-change state if an admin edits settings while Doctor is running).

### Timing

`runCheck()` records `Date.now()` before invoking the check function and computes `durationMs` in a `finally` block, so every `DoctorCheck` — success, `error`, or timeout — carries an accurate duration. The overall `DoctorReport.durationMs` is measured the same way around the whole `runDiagnostics()` call.

---

## 6. Reuse of Existing Services

Doctor does not implement its own provider connectivity logic. It calls the same "test connection" services that power each settings page's own "Test connection" button, so a passing Doctor check has the same meaning as a passing manual test on that settings page:

| Domain | Service | Method used |
|--------|---------|-------------|
| AI (search / tagging) | `AiSettingsService` | `testProvider({ provider, model })` |
| AI (embedding) | `AiSettingsService` | `testEmbedding({})` |
| Face detection | `FaceSettingsService` | `testProvider({ provider })` |
| Geo (reverse) | `GeoSettingsService` | `testProvider({ provider })` |
| Storage | `StorageSettingsService` | `testConnection({ provider })` |
| Job queue stats | `EnrichmentAdminService` | `getStats()` (same source as `/admin/settings/jobs`) |
| Worker enabled flag | `isEnrichmentWorkerEnabled()` | exported helper from `enrichment/enrichment-job.worker.ts` |

The pgvector probe (`core.pgvector`) is Doctor-specific raw SQL — it is not backed by an existing settings service, since there is no "pgvector settings" page. It queries `pg_extension` for the `vector` extension and `to_regclass('public.media_item_embedding')` to confirm the embedding table exists, mirroring the requirements documented in the [Semantic Search spec](semantic-search.md).

---

## 7. API Endpoint and RBAC

### `POST /api/admin/doctor/run`

- **Auth:** Admin role + `system_settings:read` (`@Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })`)
- **No new permission** — reuses the existing `system_settings:read` permission already granted to Admin users; there is no `doctor:*` permission scope.
- **Request body:** none
- **Behavior:** Synchronously runs all twenty checks concurrently (see §5) and returns the assembled `DoctorReport`. On-demand only — no cron, no queue, no persistence. Two consecutive calls can return different results if underlying configuration or provider reachability changed in between.
- **Response 200:** `DoctorReport` (see §2).
- **Side effects:** none — purely read-only against configuration and live provider endpoints; does not write to the database (aside from the read-only `SELECT 1` / `_prisma_migrations` / `pg_extension` probes) and does not enqueue any job.

### RBAC Summary

| Resource | Permission | Granted To |
|----------|------------|------------|
| Run diagnostics sweep | `system_settings:read` | Admin only |

---

## 8. Frontend Page

**Route:** `/admin/settings/doctor`

**File:** `apps/web/src/pages/Admin/DoctorPage.tsx`

**Entry point:** A "Doctor" card in the Settings hub's Operations group (`apps/web/src/pages/Admin/SettingsHubPage.tsx`), gated on `system_settings:read`, described as "Run configuration health diagnostics and see required action items."

The page is guarded by `usePermissions().isAdmin`; non-admin users are redirected to `/` via React Router's `<Navigate>` (mirrors the pattern used by `JobsPage` / `FaceSettingsPage`).

### Layout

- **Header:** "Doctor — Diagnostics" title with a "Run diagnostics" button (`POST /api/admin/doctor/run` via the `useDoctor` hook). The button shows a spinner while a run is in flight.
- **Summary chips:** once a report is loaded, a chip row shows the overall status label plus per-status counts:
  - Overall status label — `"Unhealthy"` (error, `summary.error > 0`), `"Needs attention"` (warning, no errors but `summary.warning > 0`), or `"Healthy"` (success, otherwise) — computed client-side from `summary`.
  - `OK: N`, `Warning: N`, `Error: N`, `Skipped: N` outlined chips sourced directly from `summary`.
- **Timestamp line:** "Computed {computedAt, localized} · {durationMs} ms".
- **Per-section cards:** one `Paper` card per `DoctorSection`, each showing the section label and a status chip, followed by a row per `DoctorCheck` with a status icon (`CheckCircle` / `WarningAmber` / `Error` / `RemoveCircleOutline` for ok/warning/error/skipped respectively), the check label, and its message.
- **Inline action-item alerts:** when a check carries `actionItem`, an MUI `Alert` (severity mirrors the check's status — `success`/`warning`/`error`/`info`) is rendered directly under that check row with the actionable next step.

### States

| State | Trigger | Display |
|-------|---------|---------|
| Loading (first load) | `loading && !report` | Centered `CircularProgress` |
| Error (first load) | `error && !report` | Full-width `Alert severity="error"` |
| Error (after a report exists) | `error && report` | `Alert severity="error"` above the existing report, which remains visible |
| Loaded | `report` present | Summary chips, timestamp, and all section cards rendered |

---

## 9. Gotchas and Implementation Notes

### `skipped` Is Not a Failure

A check reporting `skipped` (e.g. `face.detection` when `features.faceRecognition` is off) is deliberately excluded from the "worst status" computation at the section level — `worstStatus()` only ever returns `ok`, `warning`, or `error`, treating `skipped` the same as `ok`. Do not add new logic that treats `summary.skipped > 0` as evidence of a problem; it reflects an intentionally-disabled feature, not a misconfiguration.

### Timeout Sentinel Must Be a Private `Symbol`, Not a String or Error

`TIMEOUT_SENTINEL = Symbol('doctor-check-timeout')` is used specifically so the `catch` block in `runCheck()` can distinguish "the check timed out" from "the check threw an error whose message happens to look like a timeout." Using a string or generic `Error` for the sentinel would risk a false-positive match against a real provider error message.

### Reused Services Can Throw Instead of Returning `{ ok: false }`

Some of the AI/face/geo/storage "test connection" methods throw exceptions (e.g. `BadRequestException`) for certain failure modes (missing credentials) rather than resolving with an `{ ok: false, error }` object. Any new check that reuses an existing settings service must not assume a resolved `{ ok }` shape — `runCheck()`'s catch-all exception normalization handles this at the wrapper level, but the individual check's own `try/catch` (where present, e.g. `checkSecretsKey`) should still be reviewed when adding checks against a new service to confirm which failure shape it uses.

### Single Settings Snapshot Can Go Stale Mid-Sweep

Because `settings` is fetched once and reused across all checks, if an admin changes a system setting via a separate request while a Doctor sweep is executing, some checks in that sweep will reflect the old value. This is intentional (see §5) and the sweep completes in well under a second in the common case, so the staleness window is negligible in practice. A fresh `POST /api/admin/doctor/run` call will pick up the change immediately.

### Doctor Duplicates Some Signals Also Available Elsewhere

`jobs.queueHealth` surfaces the same `stuckRunning` and `byStatus.failed` counts already visible on `/admin/settings/jobs`, and `ai`/`face`/`geo` live tests duplicate what each settings page's own "Test connection" button already does. This duplication is intentional — Doctor's value is aggregating all of these signals into one sweep rather than requiring an admin to visit six separate pages — but it means Doctor and the individual settings pages can occasionally show slightly different results if state changes between the two calls (e.g. a job fails moments after Doctor's `jobs.queueHealth` check ran).

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | July 2026 | AI Assistant | Initial specification |
| 1.1 | July 2026 | AI Assistant | Add `ai.socialMedia` check (AI & Enrichment section) covering the social-media video detection feature flag, env override, `socialMedia.*` range validation, and OCR degraded-mode probing; check catalog is now twenty-one checks |
| 1.2 | July 2026 | AI Assistant | Add `nodes` section (Worker Nodes) with four checks — `nodes.registeredCount`, `nodes.heartbeatFreshness`, `nodes.staleLeases`, `nodes.capabilityHealth` — covering the distributed compute fleet ([distributed-nodes.md §10.2](distributed-nodes.md)); check catalog is now twenty-five checks across eight sections |
