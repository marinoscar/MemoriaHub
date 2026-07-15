# CLAUDE.md

This file provides guidance for AI assistants working on this codebase.

## Project Overview

Web Application Foundation with React UI + Node API + PostgreSQL. Production-grade foundation with OAuth authentication, RBAC authorization, and flexible settings framework.

## Technology Stack

- **Backend**: Node.js + TypeScript, NestJS with Fastify adapter
- **Frontend**: React + TypeScript, Material UI (MUI)
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: Passport strategies (Google OAuth required)
- **Testing**: Jest + Supertest (backend), React Testing Library + Jest (frontend)
- **Observability**: OpenTelemetry, Uptrace, Pino structured logging
- **Containerization**: Docker + Docker Compose
- **Reverse Proxy**: Nginx (same-origin routing)

## Repository Structure

```
/
  apps/
    api/                    # Backend API
      src/
      test/
      prisma/
        schema.prisma
        migrations/
      Dockerfile            # API container (near its code)
    web/                    # Frontend React app
      src/
      src/__tests__/
      Dockerfile            # Web container (near its code)
  docs/                     # Documentation
  infra/                    # Infrastructure configuration
    compose/
      base.compose.yml       # Core services: api, web, nginx
      dev.compose.yml        # Development overrides (hot reload, volumes)
      prod.compose.yml       # Production overrides (resource limits)
      otel.compose.yml       # Observability: uptrace, clickhouse, otel-collector
      .env.example           # Environment variables template
    nginx/
      nginx.conf             # Nginx routing configuration
    otel/
      otel-collector-config.yaml   # OTEL Collector config
      uptrace.yml            # Uptrace configuration
  tests/e2e/                # Optional E2E tests
```

## MANDATORY: Worktree-Based Feature Development

Every feature or fix MUST be developed in a Git worktree. The main checkout stays on `main` at all times.

### Worktree Location & Naming
- All worktrees live under `worktrees/` in the repo root (git-ignored, never committed)
- Use **flat short names**: `worktrees/<short-name>` (e.g., `worktrees/add-export`, `worktrees/fix-auth-bug`)
- The branch name follows conventional format: `feat/<short-name>`, `fix/<short-name>`, etc.

### Workflow (Claude MUST follow)

**Starting feature work:**
1. From the main checkout, create the worktree:
   ```bash
   git worktree add worktrees/<short-name> -b <type>/<short-name>
   ```
   Example: `git worktree add worktrees/add-export -b feat/add-export`
2. All development happens inside `worktrees/<short-name>/`
3. Commits follow all existing commit rules (see below)

**Finishing feature work:**
1. Ensure all changes are committed inside the worktree
2. Remove the worktree:
   ```bash
   git worktree remove worktrees/<short-name>
   ```
3. The branch remains for PR/merge

### Rules
- NEVER checkout feature branches in the main working directory
- NEVER work on features directly in the main checkout
- One worktree per feature branch (Git enforces this)
- If the worktree already exists for the requested feature, work inside it (don't recreate)

## MANDATORY: Claude Commit-Only Git Rules

Claude: these rules are **MANDATORY**. Follow them exactly.  
Your job is **only** to create clean, frequent commits while implementing the requested work.  
Assume the branch already exists and is checked out. Do **not** create branches or PRs.

---

### Core Commit Rules (MANDATORY)
1. **Commit early, commit often.** Do not leave large uncommitted change sets.
2. Each commit must be **small, coherent, and reviewable**.
3. **One intent per commit** (no “misc fixes” bundles).
4. **Do not include unrelated refactors** unless explicitly requested.
5. If you change behavior, you must add/adjust tests in the same commit or the next immediate commit.

---

### CLI Versioning Rule (MANDATORY)
Every time a **new feature or improvement** is added to the CLI (`apps/cli`), bump the CLI version by
**one increment on the last (patch) digit** in `apps/cli/package.json` — e.g. `1.1.2 → 1.1.3`, then
`1.1.3 → 1.1.4` for the next feature. After editing the version, sync the lockfile with
`npm install --package-lock-only` (from the repo root). The CLI reads its version from `package.json`
at runtime, so no source constant needs changing. Pure bug-fix-only changes may reuse the same bump
discipline at your discretion, but every feature/improvement MUST carry a version bump.

---

### Commit Message Standard (MANDATORY: Conventional Commits)
Use this format:

`<type>(<scope>): <short imperative summary>`

Allowed types:
- `feat:` new functionality
- `fix:` bug fix
- `refactor:` internal change, no behavior change
- `test:` add/adjust tests only
- `docs:` documentation only
- `chore:` tooling, deps, formatting, build, CI

Scopes (pick one relevant area):
- `api`, `web`, `db`, `infra`, `auth`, `chat`, `ui`, `core`, `jobs`, `docs`, `tests`

Examples:
- `feat(chat): add permit search prompt builder`
- `fix(api): handle missing location gracefully`
- `test(api): cover permit filter edge cases`
- `chore(web): run formatter`

---

### Commit Cadence (MANDATORY)
Make commits at these checkpoints:

1) **Scaffold / wiring**
- New files, routes, handlers, basic plumbing (even if incomplete).
- Example: `feat(api): scaffold permit lookup endpoint`

2) **Core functionality**
- Implement the smallest working slice end-to-end.
- Example: `feat(core): implement permit filtering by location radius`

3) **Edge cases + validation**
- Input validation, error handling, fallback behavior.
- Example: `fix(api): validate lat/lng inputs and return 400`

4) **Tests**
- Unit/integration tests for the new behavior and critical edge cases.
- Example: `test(api): add coverage for location filter and empty results`

5) **Cleanup**
- Remove dead code, rename for clarity, small refactors strictly related to the change.
- Example: `refactor(core): extract permit query builder`

6) **Docs (if needed)**
- Only if the task requires it.
- Example: `docs(api): document permit endpoint parameters`

---

### What to Include / Exclude (MANDATORY)
#### Include
- Code + tests for the same feature area
- Minimal config changes needed to run/build/test
- Small, related refactors that reduce complexity for the feature

#### Exclude
- Repo-wide formatting changes unless required
- Dependency upgrades unless required
- Unrelated cleanup in neighboring modules

---

### Commit Command Sequence (MANDATORY)
Before committing:
1. `git status`
2. `git diff`
3. Stage intentionally:
   - `git add -p` (preferred) or `git add <files>`

Commit:
- `git commit -m "<type>(<scope>): <summary>"`

After commit:
- `git status`

Repeat until the next checkpoint is complete, then commit again.

---

### Handling Mixed Changes (MANDATORY)
If you accidentally made unrelated edits:
- Revert them before committing, or
- Split into separate commits (preferred). Only keep the unrelated commit if explicitly requested.

---

### If Tests Cannot Be Run (MANDATORY)
If you cannot run tests for a valid reason (missing env, tool not available):
- Still commit, but include a clear note in the commit body.

Example:
- Subject: `feat(api): implement permit search by address`
- Body: `Notes: tests not run (DB env not available).`

---

### Golden Rule (MANDATORY)
If the diff feels “big,” you waited too long. **Split the work and commit sooner.**

## Architecture Principles

1. **Separation of Concerns**: UI handles presentation only; API handles all business logic and authorization
2. **Same-Origin Hosting**: UI at `/`, API at `/api`, Swagger at `/api/docs`
3. **Security by Default**: All API endpoints require authentication unless explicitly public
4. **API-First**: All business logic resides in the API layer

## Key Commands

```bash
# Setup: copy environment template
cp infra/compose/.env.example infra/compose/.env

# Start development (from infra/compose folder)
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml up

# Start development with observability (Uptrace UI at http://localhost:14318)
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f otel.compose.yml up

# Start production mode
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml up

# Run API tests
cd apps/api && npm test

# Run frontend tests
cd apps/web && npm test

# Generate Prisma client after schema changes
cd apps/api && npm run prisma:generate

# Create a new migration (development)
cd apps/api && npm run prisma:migrate:dev -- --name <migration_name>

# Apply migrations (production)
cd apps/api && npm run prisma:migrate

# Note: Use npm scripts (prisma:*) instead of direct npx commands
# They automatically construct DATABASE_URL from individual env vars
```

## Service URLs (Development)

- **Application**: http://localhost:3535 (via Nginx)
- **Swagger UI**: http://localhost:3535/api/docs
- **Uptrace**: http://localhost:14318 (when otel stack running)

## API Endpoints (MVP)

### Authentication
- `GET /api/auth/providers` - List enabled OAuth providers
- `GET /api/auth/google` - Initiate Google OAuth; optional `?returnTo=<same-site-path>` query param carries a destination through the OAuth `state` (HMAC-signed; must start with `/`, no `//`, no scheme) — used by the device activation page to land the user on `/activate?code=…` after login
- `GET /api/auth/google/callback` - OAuth callback; when a valid `returnTo` was carried in `state`, appends it to the post-login redirect: `/auth/callback?token=…&expiresIn=…&returnTo=<encoded-path>`
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout and invalidate session
- `POST /api/auth/logout-all` - Logout from all devices
- `GET /api/auth/me` - Get current user

### Device Authorization (RFC 8628)
- `POST /api/auth/device/code` - Generate device code (Public); optional `clientInfo.returnUri` — deep-link URI (`memoriahub:` or `https:` scheme only, max 512 chars) the activation page redirects to after approval, returning the user to the requesting app (e.g. Android Custom Tab flow)
- `POST /api/auth/device/token` - Poll for authorization (Public)
- `GET /api/auth/device/activate` - Get activation info; when `?code=` is supplied and `clientInfo.returnUri` was set, the response includes `clientInfo.returnUri` so the page can deep-link back to the app after approval
- `POST /api/auth/device/authorize` - Approve/deny device
- `GET /api/auth/device/sessions` - List device sessions
- `DELETE /api/auth/device/sessions/{id}` - Revoke device session

### Users (Admin-only)
- `GET /api/users` - List users (paginated)
- `GET /api/users/{id}` - Get user by ID
- `PATCH /api/users/{id}` - Update user (roles, activation)
- `PUT /api/users/{id}/roles` - Update user roles

### Settings
- `GET /api/user-settings` - Get current user's settings
- `PUT /api/user-settings` - Replace user settings
- `PATCH /api/user-settings` - Partial update user settings
- `GET /api/system-settings` - Get system settings
- `PUT /api/system-settings` - Replace system settings (Admin)
- `PATCH /api/system-settings` - Partial update system settings (Admin)

### Allowlist (Admin-only)
- `GET /api/allowlist` - List allowlisted emails (paginated, filterable)
- `POST /api/allowlist` - Add email to allowlist
- `DELETE /api/allowlist/{id}` - Remove email from allowlist

### Storage Objects
- `POST /api/storage/objects/upload/init` - Initialize resumable upload
- `GET /api/storage/objects/:id/upload/status` - Get upload progress
- `POST /api/storage/objects/:id/upload/complete` - Complete multipart upload
- `DELETE /api/storage/objects/:id/upload/abort` - Abort upload
- `POST /api/storage/objects` - Simple file upload
- `GET /api/storage/objects` - List objects (paginated)
- `GET /api/storage/objects/:id` - Get object metadata
- `GET /api/storage/objects/:id/download` - Get signed download URL
- `DELETE /api/storage/objects/:id` - Delete object
- `PATCH /api/storage/objects/:id/metadata` - Update metadata

### Admin: Stuck StorageObject Recovery (Admin role + storage:delete_any)
StorageObjects can get orphaned at `status='processing'` forever if the API process is killed (OOM, crash, deploy) mid-pipeline — nothing writes a final status once the initial `processing` write happens, since `markReady`/`markFailed` only run at the very end of `ObjectProcessingService.handleObjectUploaded`. `StorageProcessingRecoveryTask` (a `@Cron` every 10 min, mirroring `EnrichmentStuckResetTask`) automatically finds objects stuck past `STORAGE_PROCESSING_STUCK_MINUTES` and re-runs the full processing pipeline (covers both photos and videos, unlike the narrower `POST /api/admin/media/reprocess`, which now also covers both photos and videos — `reprocessImageObject` was renamed to `reprocessMediaObject` and its guard widened from image-only to image/ and video/ — but still requires `status IN ('ready','failed')`, unlike this cron which targets `status='processing'`). Retries are capped at `STORAGE_PROCESSING_MAX_RETRIES` per object (tracked in `StorageObject.metadata._processingRetryCount`, persisted before each attempt so a crash mid-retry still advances the cap); an object that exhausts the cap is marked `status='failed'` instead of retried further.
- `POST /api/admin/media/reprocess-stuck` body `{ olderThanMinutes? }` - Immediately triggers the same recovery the cron runs automatically, without waiting for the next tick; returns `{ claimed, reprocessed, exhausted, errors }` (Admin + storage:delete_any)

A related but distinct gap is a `StorageObject` that reaches `status IN ('ready','failed')` while its owning `MediaItem` never picked up a `thumbnailStorageKey` — e.g. the sync step was interrupted, or an old ffmpeg failure left a photo/video without a usable thumbnail. `ThumbnailRepairTask` (hourly `@Cron`) enqueues a global `thumbnail_repair` enrichment job (`mediaItemId: null`, `circleId: null`, priority 100, dedup'd against any pending/running instance) that scans for live media items missing a thumbnail on objects older than `THUMBNAIL_REPAIR_MIN_AGE_MINUTES`, covering both photos and videos and excluding `thumbnails/` objects themselves and objects still at `status='processing'` (owned by `StorageProcessingRecoveryTask` above). For each candidate it takes the cheaper path when possible — a metadata resync via `MediaMetadataSyncService` if the thumbnail already exists on the `StorageObject` — and otherwise falls back to a full reprocess via `StorageProcessingRecoveryService.reprocessObjectNow`; attempts are capped at `THUMBNAIL_REPAIR_MAX_ATTEMPTS`, tracked in `StorageObject.metadata._thumbnailRepairAttempts` (persisted before each attempt, cleared on success) with `_thumbnailRepairExhausted` set once the cap is hit. Runs are batch-limited (`THUMBNAIL_REPAIR_BATCH_SIZE`) and processed sequentially to stay memory-safe.
- `POST /api/admin/media/thumbnails/repair` - Enqueues the `thumbnail_repair` job immediately at priority 0 (pre-empting/promoting any pending cron-enqueued instance at priority 100) to drain the backlog without waiting for the next hourly tick; returns `{ data: { jobId, status } }` (Admin + storage:delete_any)

### Personal Access Tokens
- `POST /api/pat` - Create a new personal access token
- `GET /api/pat` - List current user's tokens
- `DELETE /api/pat/{id}` - Revoke a token

### Family Circles (circles:read / circles:write)
Face recognition, auto-tagging, and burst detection are global feature toggles (`features.faceRecognition`, `features.autoTagging`, `features.burstDetection`) controlled in Admin Settings — no longer per-circle opt-ins.
- `POST /api/circles` - Create a circle
- `GET /api/circles` - List circles the caller is a member of
- `GET /api/circles/:id` - Get circle detail
- `PATCH /api/circles/:id` - Update circle name/description (circle_admin role required)
- `DELETE /api/circles/:id` - Delete circle — personal circles cannot be deleted (circle_admin role required)
- `GET /api/circles/:id/members` - List members
- `POST /api/circles/:id/members` - Add member by userId (circle_admin role required)
- `PATCH /api/circles/:id/members/:userId` - Update member role (circle_admin role required)
- `DELETE /api/circles/:id/members/:userId` - Remove member (circle_admin role required)
- `GET /api/circles/:id/invites` - List pending invites (circle_admin role required)
- `POST /api/circles/:id/invites` - Send invite by email; upserts allowed_emails (circle_admin role required)
- `DELETE /api/circles/:id/invites/:inviteId` - Cancel pending invite (circle_admin role required)

### Admin: Backup (Admin role + backup:run / backup:read)
- `POST /api/admin/backup` - Trigger a backup run
- `GET /api/admin/backup/runs` - List recent backup runs
- `GET /api/admin/backup/status` - Alias for /runs
- `GET /api/admin/backup/runs/:runId` - Get single run detail
- `GET /api/admin/backup/objects` - List objects in the backup destination

### Admin: Insights (Admin role + system_settings:read / system_settings:write)
Metrics are precomputed into a snapshot table on a configurable schedule (default every 4 hours); see `storage.insights.refreshIntervalHours` under System Settings. No new permissions were added — the feature reuses the existing system settings permission pair. Computation runs on the shared `enrichment_jobs` queue via the `storage_insights` handler (retries, visible in `/admin/jobs`).
- `GET /api/admin/insights` (system_settings:read) - Return the latest precomputed storage metrics snapshot plus a `refresh` object describing the in-flight job state; `{ status: 'ready'|'empty', metrics|null, computedAt|null, durationMs|null, refresh: { state: 'idle'|'pending'|'running'|'failed', jobId: uuid|null, lastError: string|null } }` — byte fields in `metrics` are STRINGS (BigInt-safe), counts are numbers
- `POST /api/admin/insights/refresh` (system_settings:write) - Enqueue a `storage_insights` enrichment job at priority 0 (highest; pre-empts any scheduled job) and return IMMEDIATELY: `{ jobId: uuid, state: 'pending'|'running' }`; body-less; computation is async — poll `GET /api/admin/insights` until `refresh.state` becomes `idle` or `failed`

### Admin: Doctor / Diagnostics (Admin role + system_settings:read)
On-demand configuration health sweep across ~25 checks in 8 sections (core, auth, storage, AI, face, geo, jobs, nodes); reuses each domain's existing "test connection" service for live provider connectivity and surfaces feature-flag/provider inconsistencies (e.g. a feature enabled with no provider configured). The AI & Enrichment section includes an `ai.socialMedia` check that reports whether social-media video detection is off (skipped), misconfigured (env override / out-of-range `socialMedia.*` values), running degraded (OCR unavailable, Tier-1-only), or fully operational (two-tier). The new `nodes` (Worker Nodes) section adds four checks: registered nodes (any nodes registered at all), heartbeat freshness (nodes not seen within the expected interval), expired leases (claimed jobs whose `lease_expires_at` has passed without renewal), and per-node capability health (each node's last-reported `capabilities`/`node doctor` summary). The Face section adds a `face.pgvector` check that verifies the `faces.embedding_vec` column and its two HNSW indexes exist when `FACE_VECTOR_BACKEND` resolves to `pgvector` (skipped when the backend is `app`); it warns separately if the column/main index is missing (actionable: run migrations or roll back to `app`) versus if only the partial archive index is missing (face-auto-archive KNN degrades to the main index, slower but functional). No new permission, nothing persisted, no cron — a fresh report is computed on every call. See [Doctor Diagnostics spec](docs/specs/doctor.md).
- `POST /api/admin/doctor/run` (system_settings:read) - Run all diagnostics and return a `DoctorReport` { computedAt, durationMs, summary:{ok,warning,error,skipped,total}, sections:[{ key, label, status, checks:[{ key, label, status, message, actionItem?, durationMs }] }] }; runs live provider connectivity tests (AI/face/geo/storage), a pgvector probe, feature-flag/provider consistency checks, and job-queue health; nothing persisted; each check has a 10s timeout

### Admin: Job Queue (Admin role + jobs:read / jobs:write)
An admin dashboard at `/admin/settings/jobs` provides monitoring and control over the generic `enrichment_jobs` queue (used by face detection, storage insights computation, and all future enrichment handlers).
- `GET /api/admin/jobs/stats` (jobs:read) - Queue stats: total, byStatus, byType breakdown, `stuckRunning` count, `stuckThresholdMinutes` (the effective threshold, minutes, used to compute `stuckRunning` — resolved from the `jobs.stuckThresholdMinutes` system setting), and `scheduled` (count of pending jobs currently in backoff, i.e. `scheduledFor > now`); `stuckRunning` also counts zombie rows stuck in `running` with `startedAt IS NULL` (aged by `createdAt` instead), which earlier versions of this count silently missed
- `GET /api/admin/jobs?status=&type=&page=&pageSize=&scheduled=&processedWithin=` (jobs:read) - Paginated job list with optional filters; add `scheduled=true` to show only pending jobs currently in backoff (`scheduledFor > now`; forces status=pending, `type` still applies); each item includes `scheduledFor` (ISO 8601 | null), `rateLimitedAt` (ISO 8601 | null), and `rateLimitHits` (number); `processedWithin` accepts `4h|24h|7d|30d|all` (omitted or `all` = no time filter) and limits results to jobs whose activity time — `COALESCE(finishedAt, createdAt)` — falls within the specified window, so recently-finished jobs appear and recently-created pending/running jobs are not hidden; composes with the other filters
- `POST /api/admin/jobs/:id/retry` (jobs:write) - Reset a single failed/succeeded job to pending; also clears `scheduledFor` and resets `rateLimitHits` to 0 (400 if running, 404 if not found)
- `POST /api/admin/jobs/retry-failed` (jobs:write) - Bulk-retry all failed jobs; optional `{type}` body to scope by job type; also clears `scheduledFor` and resets `rateLimitHits` to 0
- `POST /api/admin/jobs/reset-stuck` (jobs:write) - Recover jobs stuck in `running` past a threshold (including `startedAt IS NULL` zombie rows, aged by `createdAt`); returns `{ reset, failed }`. Because `attempts` is charged at CLAIM time, a stuck job whose `attempts >= ENRICHMENT_MAX_ATTEMPTS` is marked **failed** (counted in `failed`) instead of requeued — this bounds a poison-pill/OOM job to `ENRICHMENT_MAX_ATTEMPTS` crashes; jobs still under budget are reset to `pending` (counted in `reset`). Optional `{olderThanMinutes}` body — when omitted, defaults to the `jobs.stuckThresholdMinutes` system setting (no hard-coded default)
- `DELETE /api/admin/jobs/:id` (jobs:write) - Delete a job row (400 if running, 404 if not found)
- `GET /api/admin/jobs/insights` (jobs:read) - On-demand, read-only aggregate; no polling, no snapshot table; optional `?windowDays=` (default 7, max 90); returns `live` counts (total, byStatus, pending, running, failed, scheduled/backing-off, rateLimited, retried, byType) + `history.overall` and `history.byType[]` (samples, avgMs, p50Ms, p95Ms, throughputPerMin over succeeded jobs in the window) + `eta` (totalRemaining, etaMs, basis `'live'|'partial'|'none'`, perType) + `lifetime` (`overall` and `byType[]` all-time succeeded/failed/total/avgMs/samples — merges live rows with the `job_stats_rollup` of already-purged rows so totals survive purging; counts/avg only, no percentiles); pure SELECT queries — takes only ACCESS SHARE locks, compatible with the worker's ROW EXCLUSIVE/FOR UPDATE row claims; bounded to recent window so it never scans unbounded history; see [Job Queue Insights spec](docs/specs/job-insights.md)
- `POST /api/admin/jobs/insights/reset-history` (jobs:write) - Clears the `job_stats_rollup` table (all-time analytics); live job rows are unaffected; returns `{ reset: number }` (rows cleared)

### Node Data-Plane (Distributed Workers) + Admin: Worker Nodes
CLI-driven machines can register as worker nodes, claim `enrichment_jobs` rows, run the compute locally, and submit results back to the API — a complete, end-to-end feature (control plane, result ingestion, compute/persist split, shared parity package, worker daemon). Media bytes stream directly between the node and the storage provider via short-lived presigned URLs — they are never proxied through the API, and no storage credential is ever placed on the node. `auto_tagging`/`geocode` are the one pair of job types where a node does see a provider secret: a **transient, per-job credential** fetched from the API and held in memory only for the duration of one compute call, never persisted to disk/config/logs (the originally-proposed "AI-proxy" design, where the server made the keyed call on the node's behalf, was rejected in favor of this). See the [Distributed Nodes spec](docs/specs/distributed-nodes.md) for full detail, including the known gaps: `video_face_detection` compute is still a scaffold (server-only in practice), and `thumbnail_repair` is wired for interface parity but not end-to-end node-claimable (it's a global sweep job, not per-item).

**Node control plane** (PAT-auth via `jobs:write`, owner-scoped to the registering user's node):
- `POST /api/nodes/register` - Register a new worker node (name, hostname, platform, cliVersion, eligibleTypes, concurrency); returns the node record
- `POST /api/nodes/:id/deregister` - Deregister a node
- `POST /api/nodes/:id/heartbeat` - Liveness ping; updates `lastHeartbeatAt` and optionally refreshes `status`/`capabilities` (latest `node doctor` summary)
- `POST /api/nodes/:id/claim` - Atomically claim eligible pending jobs (bounded by the node's `concurrency` and `eligibleTypes`); returns `{ jobs: [{ job, inputUrl, params }] }` — `inputUrl` is a presigned GET for the original object bytes (`null` for a global job with no `mediaItemId`)
- `POST /api/nodes/:id/jobs/:jobId/renew` - Extend the lease on a long-running claimed job before it expires
- `POST /api/nodes/:id/jobs/:jobId/upload-url` - Get a presigned PUT URL to upload node-generated output bytes (currently used by the `thumbnail_regen`/`thumbnail_repair` compute path); the server, not the node, chooses the storage key
- `POST /api/nodes/:id/jobs/:jobId/credentials` - Get a transient, per-job provider credential for `auto_tagging` or `geocode` so the node can call the provider's HTTP API directly
- `POST /api/nodes/:id/jobs/:jobId/result` - Submit a node-computed result; validated against the job type's `nodeResultSchema` and persisted via the handler's `persistNodeResult` (the compute/persist split — see spec §6.1), then completed as succeeded through the same `EnrichmentTerminalService` the in-process worker uses
- `POST /api/nodes/:id/jobs/:jobId/failure` - Report a node-side failure; routes through the same rate-limit-deferral-vs-normal-retry backoff path as an in-process failure
- `GET /api/nodes` - List worker nodes owned by the caller (lets `node list`/`node status` work without an Admin permission)
- `GET /api/nodes/:id` - Get a single worker node owned by the caller
- `GET /api/nodes/models/manifest` (jobs:read) - List enrichment model files/versions a node should have locally to serve its `eligibleTypes`, with real sha256/byte-size values for all 5 files (CLIP ONNX + 4 Human face-model files, including `blazeface-back.bin`)

The four job-scoped endpoints (`upload-url`, `credentials`, `result`, `failure`) share one guard: the job must still be claimed by the calling node under a live, unexpired lease, or the call is rejected with 409 — this is what makes a late submission from a reaped/re-claimed node harmless.

**Admin plane** (Admin role):
- `GET /api/admin/nodes` (jobs:read) - List registered nodes with heartbeat health and per-node job counts (claimed, running, succeeded, failed)
- `DELETE /api/admin/nodes/:id` (jobs:write) - Remove a node record

> **CLI:** `apps/cli` gains `memoriahub node install-deps|register|start [--daemon]|stop|status|logs|set-concurrency|service install|uninstall|status|list|doctor` for running a fat worker that performs enrichment compute locally, streaming media bytes to/from storage via presigned URLs. `node install-deps` (Linux-only) is a one-command dependency installer that sets up ffmpeg/ffprobe, the npm native compute libraries, tesseract OCR language data, model files, and (optionally) Docker + the local `compreface-core` sidecar before you register a node — see [Worker Node Setup & Troubleshooting](docs/worker-node-setup.md). `node start --daemon` detaches into the background (pidfile + a Unix-domain-socket NDJSON IPC channel at `~/.memoriahub/node.sock`); `node service install` installs a systemd **user** unit so the node runs as an always-on service (with WSL/Windows guidance when systemd isn't available); `node stop`/`status`/`logs`/`set-concurrency` all talk to a running daemon over IPC when one exists. The Tools > Worker Node TUI dashboard can either own an in-process engine or **attach** to an already-running daemon over the same IPC socket, so an operator can inspect a headless service without stopping it. Heavy model libraries (face/vision/CLIP/OCR) are `optionalDependencies` loaded at runtime, so a lean CLI install doesn't force-download them; the shared `packages/enrichment-compute` package (dual CJS/ESM build, exact-pinned native deps) guarantees a node's compute is numerically identical to the server's — see the spec's parity section and its golden-vector regression test.

### Media — Bulk Operations (circle-scoped, collaborator role required)
- `PATCH /api/media/bulk` - Bulk update location / favorite / capturedAt (date taken) on 1–500 items; `set.capturedAt` accepts an ISO 8601 datetime (set the date) or `null` (clear it)
- `POST /api/media/bulk/tags` - Bulk add/remove tags on 1–500 items
- `POST /api/media/bulk/delete` - Bulk soft-delete 1–500 items (moves items to Trash)
- `POST /api/media/bulk/tags/rerun` body `{ circleId, ids[] }` (1–500) - Bulk re-run AI auto-tagging; dedup-safe enqueue of `auto_tagging` per item at priority 0, upserts `media_tag_status` to pending → `{ queued: number }` (media:write + collaborator)
- `POST /api/media/bulk/faces/rerun` body `{ circleId, ids[] }` (1–500) - Bulk re-run face detection; dedup-safe enqueue of `face_detection` (photos) or `video_face_detection` (videos) per item at priority 0, upserts `media_face_status` to pending → `{ queued: number }` (media:write + collaborator)
- `POST /api/media/bulk/thumbnail/rerun` body `{ circleId, ids[] }` (1–500) - Bulk re-run thumbnail generation; dedup-safe enqueue of the async `thumbnail_regen` enrichment job per item at priority 0 (unlike the synchronous single-item `POST /api/media/:id/thumbnail/rerun`) → `{ queued: number }` (media:write + collaborator)

> **UI:** The gallery multi-select overflow ("More") menu offers Set location / Set date taken / Edit tags plus Refresh thumbnails / Re-run faces / Re-run AI tagging. Selections larger than 25 items prompt a confirmation before enqueueing.

### Media — Archive & Trash
Archive and Trash are two independent states on `media_items`. Archive (`archivedAt` non-null) hides items from all browse surfaces — Home, dashboard, Albums, People, Explore, Map — but search includes archived items by default. Trash (`deletedAt` non-null, i.e. soft-delete) makes items recoverable for up to `storage.trash.retentionDays` days before they are permanently purged. The old "delete" action now moves items to Trash rather than destroying them immediately. Both states are orthogonal; an item can be archived without being trashed and vice versa.

- `PATCH /api/media/bulk/archive` body `{ circleId, ids[] }` → `{ archived: number }` — set `archivedAt = now()` on 1–500 non-deleted, non-archived items (media:write + collaborator)
- `PATCH /api/media/bulk/unarchive` body `{ circleId, ids[] }` → `{ unarchived: number }` — clear `archivedAt` on 1–500 archived items (media:write + collaborator)
- `GET /api/media/archived?circleId=&page=&pageSize=` — paginated list of archived (non-deleted) items, ordered by `archivedAt` descending (media:read + viewer)
- `GET /api/media/trash?circleId=&page=&pageSize=` — paginated list of trashed (soft-deleted) items, ordered by `deletedAt` descending (media:read + viewer)
- `POST /api/media/trash/restore` body `{ circleId, ids[] }` → `{ restored: number, conflicts: string[] }` — clear `deletedAt` on 1–500 trashed items; items whose `content_hash` collides with an active item are skipped and their IDs returned in `conflicts[]` (media:write + collaborator)
- `POST /api/media/trash/delete-forever` body `{ circleId, ids[] }` → `{ deleted: number }` — hard-delete 1–500 trashed items (removes DB rows and S3 blobs); only items with `deletedAt IS NOT NULL` are eligible (media:delete + collaborator)
- `POST /api/media/trash/empty` body `{ circleId }` → `{ deleted: number }` — hard-delete ALL trashed items in a circle (media:delete + circle_admin)

Automatic purge: an hourly cron (`TrashPurgeTask`) enqueues a global `trash_purge` enrichment job that hard-deletes trashed items whose `deletedAt` is older than `storage.trash.retentionDays` days. The job runs on the shared enrichment worker and is visible in `/admin/jobs`. See `storage.trash.retentionDays` under System Settings below.

### Geo / Reverse-Geocoding Settings (Admin only — geo_settings:read / geo_settings:write)
The active reverse-geocoding provider is chosen in the Admin Geo Settings page and persisted in `system_settings` under `geo.reverseProvider` (values: `offline` | `nominatim` | `google`). The selection takes effect immediately on the next geocode call without a restart. When `google` is active but the credential is missing or disabled, the service falls back to `offline` transparently.
- `GET /api/geo/settings` - Get configured providers (masked credential `last4`, `enabled`) and the active reverse provider (geo_settings:read)
- `PUT /api/geo/credentials/:provider` - Upsert provider credentials encrypted at rest; body `{ apiKey, baseUrl?, enabled? }`; only `google` is currently supported (geo_settings:write)
- `DELETE /api/geo/credentials/:provider` - Remove provider credentials; returns 404 if none configured (geo_settings:write)
- `PUT /api/geo/features/reverse` body `{ provider }` - Set the active reverse provider (`offline`|`nominatim`|`google`); returns 400 if `google` is chosen but no enabled credential exists (geo_settings:write)
- `POST /api/geo/test` body `{ provider, lat?, lng? }` - Test provider connectivity; defaults to San José, Costa Rica if no coordinates supplied; returns `{ ok, sample?, error? }` (geo_settings:read)

### Admin: Geocode Backfill (Admin role + geo_settings:write)
App-wide geocode backfill across all circles (not circle-scoped). Processes items where `takenLat` and `takenLng` are non-null.
- `POST /api/admin/geocode/backfill` body `{ from?, to?, force? }` - Bulk-enqueue `geocode` enrichment jobs for all media items with GPS across every circle; `from`/`to` (optional ISO-8601) bound `capturedAt`; when `force` is false (default) only items whose `media_geocode_status` is absent or not `processed` are enqueued; returns `{ enqueued }` (geo_settings:write)

### Email Settings (Admin only — email_settings:read / email_settings:write)
Admin-configurable transactional email with two provider routes: AWS SES (reuses the AWS keys already stored for the S3 storage provider in `storage_provider_credentials` — no separate credential) and SMTP (nodemailer; Gmail/M365/SendGrid/Mailgun/WorkMail/Custom presets). Two transactional emails are sent: circle invitation (on `POST /api/circles/:id/invites`) and circle membership confirmation (on member-add / invite-claim). Sends are fire-and-forget — a failed send never blocks or fails the user action — with graceful degradation when unconfigured.
- `GET /api/email-settings` (email_settings:read) - Get masked email provider configuration: `{ provider: 'ses'|'smtp'|null, enabled, fromAddress, fromName, sesRegion, sesCredentialAvailable, smtp: { host, port, useTls, username, passwordConfigured, passwordLast4 }, credentialSource: 'ses:reuses-s3'|'smtp:inline'|null }`; never returns the SMTP password ciphertext/plaintext
- `PUT /api/email-settings` (email_settings:write) - Update email provider configuration; `smtpPassword` is encrypted at rest — omitting or blanking it preserves the stored password
- `POST /api/email-settings/test` body `{ recipient }` (email_settings:write) - Send a test email through the active provider; returns `{ ok, messageId?, error? }`, surfacing the raw SES/SMTP error on failure

When `provider='ses'`, AWS credentials are read from `storage_provider_credentials` (provider='s3') — single source of truth, no duplicate credential storage. The AWS IAM user (the same one used for S3 storage) must additionally have `ses:SendEmail` and `ses:SendRawEmail`. SES reuse assumes REAL AWS keys — if the s3 provider points at a non-AWS/custom endpoint (MinIO/R2), `sesCredentialAvailable` is false and SES won't authenticate. Unverified SES (sandbox) accounts can only send to/from verified identities.

### Media — Geo Services
- `GET /api/media/geo/reverse?lat=&lng=` - On-demand reverse geocoding; provider resolved per-call from system setting `geo.reverseProvider` (`offline`|`nominatim`|`google`), selected in Admin Settings → Geo (fallback: `GEO_PROVIDER` env var; default `offline`)
- `GET /api/media/geo/search?q=&limit=` - Forward geocoding via Nominatim; requires system setting `geo.forwardSearchEnabled=true` (fallback: `GEO_FORWARD_SEARCH_ENABLED=true`)

### Media — Circle Dashboard
- `GET /api/media/dashboard?circleId=` - On This Day + recent/favorites + review-queue counts; also returns `pendingBurstGroups` count when `features.burstDetection` is enabled globally

### Media — Burst Detection (media:read / media:write / media:delete + per-circle roles)
Burst detection is enabled globally via `features.burstDetection` system setting (default off) and non-destructive — no photo is deleted until a human confirms. Groups are surfaced in a review queue only once they reach `burst.minGroupSize`. `GET /api/media/dashboard` returns a `pendingBurstGroups` count that feeds the review-queue section of the dashboard UI.
- `GET /api/media/bursts?circleId=&status=&page=&pageSize=` - List burst groups (review queue); items `{ id, status, mediaCount, suggestedBestItemId, capturedAt, confidence, suggestedBestThumbnailUrl, coverThumbnailUrls[] }`; `confidence` is a 0–1 visual-cohesion score persisted at detection time (may be `null` for legacy groups); response `{ items, meta:{total,page,pageSize} }` (media:read + viewer)
- `GET /api/media/bursts/:id` - Group detail; ordered members `{ id, capturedAt, burstScore, sharpnessScore, thumbnailUrl, width, height, isSuggestedBest }`; group also includes `confidence` (media:read + viewer)
- `POST /api/media/bursts/:id/resolve` body `{ keepIds[], action: 'archive'|'trash' }` - Keep selected members, archive or trash the rest, mark resolved; `action:'trash'` additionally requires media:delete; writes an `AuditEvent` (`burst_group:resolved`); returns `{ data: { removed, kept, action, groupStatus } }` (media:write + collaborator; trash requires media:delete)
- `POST /api/media/bursts/:id/dismiss` - Mark "not a burst": ungroup members, status=dismissed (media:write + collaborator)
- `POST /api/media/bursts/bulk/resolve` body `{ circleId, ids: uuid[] (1–100), action: 'archive'|'trash' }` - Bulk-resolve multiple pending burst groups in one call; for each group, keeps only its `suggestedBestItemId` and archives/trashes the rest, per-group transaction; groups that are not `pending` or lack a `suggestedBestItemId` are skipped (counted in `skipped`); the whole request is rejected if any `id` is missing or belongs to a different circle; per-group failures are counted in `errors`; returns `{ data: { resolvedGroups, keptCount, removedCount, action, skipped, errors } }` (media:write + collaborator; trash requires media:delete)
- `POST /api/media/bursts/bulk/resolve-by-threshold` body `{ circleId, threshold (int 0–100), action: 'archive'|'trash' }` - Resolve every PENDING burst group whose persisted `confidence >= threshold/100` in one call, capped at 500 groups (`MAX_THRESHOLD_RESOLVE`); null-confidence legacy groups are excluded — never auto-resolved by this path; manual trigger only, no cron; same keep-`suggestedBestItemId`-archive/trash-the-rest semantics as the bulk resolve above; returns `{ data: { resolvedGroups, keptCount, removedCount, action, skipped, errors } }` (media:write + collaborator; trash requires media:delete)

### Media — Duplicates (media:read / media:write / media:delete + per-circle roles)
Near-duplicate detection is enabled globally via `features.duplicateDetection` system setting (default off) and non-destructive — no photo is archived or trashed until a human confirms. Catches visually-identical re-uploads (e.g. WhatsApp re-shares: recompressed/resized/filtered copies with a different `contentHash` and stripped EXIF) that exact-hash dedup and burst detection cannot — see the [Duplicate Detection spec](docs/specs/duplicate-detection.md). Two-tier matching, OR-combined: CLIP ViT-B/32 visual-embedding cosine similarity (pgvector KNN, `dedup.similarityThreshold`) OR dHash Hamming distance (`dedup.hashMaxDistance`); union-find grouping mirrors burst detection, with explicit exclusion rules so the two review queues never fight over the same items. **Burst wins:** since `burst_detection` and `duplicate_detection` are enqueued together on upload, either can run first — if dedup wins the race and groups an item before burst detection does, `BurstDetectionService.processMediaItem` evicts that item (and the rest of its new burst group) from any duplicate group via `DuplicateDetectionService.evictFromDuplicateGroups` once it forms the burst group, so an item never sits in both review queues at once (see spec §3.2). This eviction is now backed by a write-time guarantee: `DuplicateDetectionService` re-checks `burstGroupId` under a `SELECT ... FOR UPDATE` row lock immediately before writing `duplicateGroupId`, closing the residual race at write time rather than relying solely on reactive eviction; additionally, `burst_detection` is now enqueued at upload-time priority 5 vs. `duplicate_detection`'s priority 10, so burst is claimed first in the common case. Best-copy scoring and `kind` classification (`exact_variant`|`edited`|`similar`) are computed at read time, never persisted. `GET /api/media/dashboard` returns a `pendingDuplicateGroups` count (no minimum-size gate, unlike bursts — a group only ever exists with `mediaCount >= 2`).
- `GET /api/media/duplicates?circleId=&status=&kind=&page=&pageSize=` - List duplicate groups (review queue), ordered chronologically by `capturedAt`; items `{ id, status, kind, mediaCount, suggestedBestItemId, capturedAt, confidence, coverThumbnailUrls[] }`; `confidence` is the tightest-pair CLIP cosine similarity (0–1), computed at read time (not persisted); response `{ items, meta:{total,page,pageSize} }` (media:read + viewer)
- `GET /api/media/duplicates/:id` - Group detail; members `{ id, thumbnailUrl, previewUrl, width, height, fileSize, capturedAt, cameraMake, cameraModel, hasGps, contentHash (first 12 chars), sharpnessScore, qualityScore, similarityToBest, isSuggestedBest }`; group also includes `confidence` (media:read + viewer)
- `POST /api/media/duplicates/:id/resolve` body `{ keepIds[], action: 'archive'|'trash' }` - Keep selected members, archive or trash the rest, mark resolved; `action:'trash'` additionally requires media:delete (media:write + collaborator)
- `POST /api/media/duplicates/:id/dismiss` - Mark "not duplicates": ungroup members, status=dismissed (media:write + collaborator)
- `POST /api/media/:id/duplicates/rerun` - Re-enqueue duplicate detection for a single item at priority 0; returns `{ jobId, status }`; **note:** does not currently enforce a per-circle role check, only the system-level media:write permission (media:write)
- `POST /api/media/duplicates/bulk/resolve` body `{ circleId, ids: uuid[] (1–100), action: 'archive'|'trash' }` - Bulk-resolve multiple pending duplicate groups in one call; same semantics as burst bulk resolve above (keeps only `suggestedBestItemId` per group, per-group transaction, `skipped`/`errors` counters); returns `{ data: { resolvedGroups, keptCount, removedCount, action, skipped, errors } }` (media:write + collaborator; trash requires media:delete)
- `POST /api/media/duplicates/bulk/resolve-by-threshold` body `{ circleId, threshold (int 0–100), action: 'archive'|'trash' }` - Same shape as the burst threshold endpoint above, but duplicate confidence is computed at READ time (tightest-pair CLIP similarity via `computeGroupKind`), not persisted — loads pending groups (capped at 500) then filters per-group in application code; groups whose computed similarity is null or below `threshold/100` are counted in `skipped`; returns `{ data: { resolvedGroups, keptCount, removedCount, action, skipped, errors } }` (media:write + collaborator; trash requires media:delete)
- `GET /api/admin/duplicates/status` - Visual-embedding model availability: `{ modelAvailable, modelPath, degraded, model }`; `degraded:true` means the deployment is running dHash-only matching (system_settings:read, Admin)

### Media — Review Insights (media:read + per-circle viewer role)
On-demand, per-circle aggregate of burst and duplicate review-queue activity — no snapshot table, no cron, computed live on every call.
- `GET /api/media/review-insights?circleId=` - Returns `{ bursts: { identified, pending, resolved, dismissed, archivedGroups, trashedGroups, itemsKept, itemsArchived, itemsDeleted }, duplicates: { identified, pending, resolved, dismissed, archivedGroups, trashedGroups, itemsKept, itemsArchived, itemsDeleted } }` (all numbers) (media:read + viewer)

### Location Inference (media:read / media:write + per-circle roles)
Location inference is enabled globally via `features.locationInference` system setting (default off). It fills in missing GPS coordinates on GPS-less photos by interpolating (or, for a single anchor, extrapolating) from chronologically-nearby same-device photos that already have coordinates — see the [Location Inference spec](docs/specs/location-inference.md). High-confidence, two-anchor, same-device inferences within `locationInference.autoApplyMaxGapMinutes` are auto-applied (coords written immediately, `coordSource='inferred'`, revertible); everything else is queued as a `pending` `LocationSuggestion` for confirm/adjust/reject review. Anchors are restricted to `coordSource IN ('exif','manual')` — an inferred coordinate can never itself anchor a further inference (drift prevention). `GET /api/media/dashboard` returns a `pendingLocationSuggestions` count.
- `GET /api/media/location-suggestions?circleId=&status=&page=&pageSize=&mediaItemId=` - List location suggestions (review queue); `status` defaults to `pending`; optional `mediaItemId` filters to one item's suggestion; items include thumbnail, confidence, method (`interpolated`|`nearest`), anchor IDs/gaps/distance, and `impliedSpeedKmh` (media:read + viewer)
- `POST /api/media/location-suggestions/:id/accept` body `{ lat?, lng? }` - Accept a pending suggestion; unmodified → `coordSource='inferred'`, adjusted → `coordSource='manual'`; both write coords + a synchronous reverse-geocode via the shared `applyLocation()` helper (media:write + collaborator)
- `POST /api/media/location-suggestions/:id/reject` - Reject a pending suggestion (sticky against future non-forced recomputes) (media:write + collaborator)
- `POST /api/media/location-suggestions/:id/revert` - Undo an `auto_applied` suggestion only: clears coords/geo columns/`coordSource` via `GEO_CLEAR_COLUMNS`, status→`reverted` (media:write + collaborator)
- `POST /api/media/location-suggestions/bulk-accept` body `{ circleId, minConfidence }` - Accept every pending suggestion at/above a confidence floor, unmodified (always `coordSource='inferred'`) (media:write + collaborator)
- `POST /api/media/:id/infer-location` - Force a fresh per-item inference rerun, bypassing the rejected-suggestion skip; enqueues `location_inference` at priority 0; returns `{ jobId, status }` (media:write + collaborator)
- `POST /api/admin/location-inference/backfill` body `{ from?, to?, force? }` - Enqueue ONE `location_inference` sweep job (mediaItemId: null) per eligible circle across all circles; a sweep loads the entire circle's timeline in memory and writes results in 500-item chunks — not chunked into multiple jobs like duplicate detection, since the work is pure DB + in-memory compute (10k photos < 1 min); 400 if `features.locationInference` is disabled; returns `{ enqueued, circles, estimatedItems }` (Admin + system_settings:write)

### Media — Metadata Extraction Re-run (media:read / media:write + per-circle roles)
Metadata re-run re-extracts EXIF, dimensions, geocode, and video-probe data on demand via the enrichment queue without re-triggering tagging, face detection, or burst detection. There is no per-circle opt-in and no upload-time enqueue — EXIF extraction already runs in the normal upload chain; this feature provides on-demand rerun and backfill only. The `metadata_extraction` enrichment handler runs the four allowlisted processors (`exif`, `dimensions`, `geocode`, `video-probe`), merges results into `StorageObject.metadata._processing`, then calls `MediaMetadataSyncService.syncFromStorageObject` to write typed columns directly. It deliberately does NOT emit `OBJECT_PROCESSED_EVENT`, so auto-tagging, face detection, and burst detection are not re-triggered.
- `POST /api/media/:id/metadata/rerun` - Re-enqueue a `metadata_extraction` enrichment job at priority 0 for a single item; upserts `media_metadata_status` to `pending`; returns `{ jobId, status }` (media:write + collaborator)
- `GET /api/media/:id/metadata/status` - Get per-item metadata extraction status: `{ status, processedAt, lastError }` (status `not_processed|pending|processing|processed|failed`); returns `not_processed` with null fields when no status row exists (media:read + viewer)

> **UI:** A "Re-run metadata extraction" button appears in the media properties pane (MediaDetailDrawer) and calls `POST /api/media/:id/metadata/rerun`. For bulk backfill, Admins use the global backfill panel in Admin Settings (see `POST /api/admin/metadata/backfill` below).

### Media — Thumbnail Rerun (media:write + per-circle collaborator role)
Unlike metadata rerun, thumbnail regeneration runs synchronously in the request (mirrors `MediaReprocessService.reprocessImageObject`'s style, not the `enrichment_jobs` queue) — resolves the `MediaItem`'s `StorageObject`, resets it to `status='processing'`, clears any prior `_processingRetryCount`/`_processingRetryExhausted`, and re-runs the full processing pipeline via `StorageProcessingRecoveryService.reprocessObjectNow`. This is the explicit user-facing counterpart to the automatic `StorageProcessingRecoveryTask` cron documented under Storage Objects above — it bypasses that cron's stuck-threshold and retry-cap entirely, since an explicit retry request should always get a fresh attempt regardless of history.
- `POST /api/media/:id/thumbnail/rerun` - Re-run thumbnail generation for a single item; resolves synchronously, no job to poll; returns `{ status: 'ready' | 'failed' }` reflecting the resulting StorageObject status (media:write + collaborator)

> **UI:** A "Retry thumbnail" button appears in the media properties pane (MediaDetailDrawer) next to the Metadata section and calls `POST /api/media/:id/thumbnail/rerun`. Gallery tiles (`MediaTile`/`GalleryTile`) also fall back from the "Processing…" spinner to a broken-image icon once a thumbnail has been missing for more than 15 minutes, so a genuinely stuck item doesn't spin forever waiting for either the cron or a manual retry.

### Media — Orientation Edit (media:write + per-circle collaborator role)
Destructively rotates/flips a photo's original stored bytes — there is no separate edited copy and no versioning; the only way back is applying the inverse transform. Photos only (400 for videos / non-image media). Applies the transform via sharp, baking in any existing EXIF orientation first, then OVERWRITES the same storage key with the new JPEG bytes, resets `MediaItem.orientation` to 1, and swaps `width`/`height` for the rotate cases. Thumbnails are regenerated through the existing reprocess pipeline (`StorageProcessingRecoveryService.reprocessObjectNow`, same helper used by thumbnail rerun above). Because rotation invalidates normalized face bounding boxes, the endpoint best-effort re-enqueues `face_detection` after the transform completes.
- `POST /api/media/:id/edit/orientation` body `{ op: 'rotate_left' | 'rotate_right' | 'flip_horizontal' | 'flip_vertical' }` - Apply the transform and overwrite the original; returns `{ data: { status: 'ready' | 'failed', width, height } }` (media:write + collaborator)

> **UI:** An "Edit" (rotate/flip) action is available in the full-screen media viewer (MediaLightbox) via an orientation editor panel.

### Media — Geocode Rerun (media:read / media:write + per-circle roles)
Per-item geocoding rerun via the `geocode` enrichment job type. Reads stored `takenLat`/`takenLng` — no image download. Writes geo columns (`geoCountry`, `geoAdmin1`, etc.) and `geoSource` using the active reverse provider configured in Geo Settings. Status is tracked in `media_geocode_status`.
- `POST /api/media/:id/geocode/rerun` - Re-enqueue a `geocode` enrichment job at priority 0; upserts `media_geocode_status` to `pending`; returns `{ jobId, status }` (media:write + collaborator)
- `GET /api/media/:id/geocode/status` - Get per-item geocode status: `{ status, processedAt, lastError }` (status `not_processed|pending|processing|processed|failed`); returns `not_processed` with null fields when no status row exists (media:read + viewer)

### Media — Social Media Detection (media:read / media:write + per-circle roles)
Detects videos downloaded/re-shared from TikTok, Instagram, or Facebook via a two-tier engine (ffprobe container-metadata/filename rules, falling back to on-server OCR of first/last frames when inconclusive but suspicious) and, non-destructively, tags them "Social Media" + a platform tag ("TikTok"/"Instagram"/"Facebook") instead of deleting anything — the user finds flagged videos via `?tag=Social+Media` search and archives/deletes them manually. Tier 1 also detects caption hashtags/@mentions/platform tokens (`#fyp`, `#reels`, `@handletok`, etc.) in the filename or container text tags (`detectCaptionSignal`), excluding purely-numeric hashtags (`#1`, `#2`) to avoid false positives on numbered family-video exports. Enabled globally via `features.socialMediaDetection` (default off). Video-only; see [Social Media Detection spec](docs/specs/social-media-detection.md).
- `GET /api/media/:id/social-media/status` - Get per-item detection status: `{ status, isSocialMedia, platform, detectionMethod, confidence, matchedRule, processedAt, lastError }` (status `not_processed|pending|processing|processed|failed`); returns `not_processed` with null fields when no status row exists (media:read + viewer)
- `POST /api/media/:id/social-media/rerun` - Re-enqueue a `social_media_detection` enrichment job at priority 0; returns `{ jobId, status }`; 400 if `features.socialMediaDetection` is disabled (media:write + collaborator)
- `GET /api/admin/social-media/status` - OCR (Tier 2) model availability and effective config: `{ ocrEnabled, ocrAvailable, degraded, modelPath, languages, minConfidence, ocrMaxFrames, ocrTimeoutSeconds }`; `degraded:true` means the deployment is running Tier-1-only (metadata/filename) matching (system_settings:read, Admin)

### Media — Explore
- `GET /api/media/explore/places?circleId=` - List distinct places with item counts and cover thumbnails; returns `Array<{ name: string; count: number; coverThumbnailUrl: string | null }>` (media:read + viewer)
- `GET /api/media/explore/tags?circleId=` - List tags with item counts and cover thumbnails; same response shape (media:read + viewer)
- `GET /api/media/facets/locations?circleId=` - Return the distinct Country → Region → Locality hierarchy present in the circle, each level with item counts: `Array<{ country, countryCode, count, regions: [{ name, count, localities: [{ name, count }] }] }>`; entries with a NULL `geoCountry` are omitted, so the list reflects geocoded items only; used by the `SearchPanel` cascading location pick-lists (media:read + viewer)
- `GET /api/media/explore/locations?circleId=` - Tiered location browsing overview for the `/places` hub; returns `{ countries: Array<{ name, countryCode, count, coverThumbnailUrl }>, regions: Array<{ name, count, coverThumbnailUrl }>, cities: Array<{ name, count, coverThumbnailUrl }> }`, each tier capped at the top 12 by item count descending; countries grouped by `geoCountryCode` (display name from `geoCountry`), regions by `geoAdmin1`, cities by `geoLocality`; excludes deleted and archived items (unlike `facets/locations`, which includes archived) (media:read + viewer)
- `GET /api/media/explore/locations/:level?circleId=` - Full list for one tier of the above; `level ∈ {countries, regions, cities}`; returns `Array<{ name, countryCode?, count, coverThumbnailUrl }>` capped at 500, sorted by count desc; invalid `level` → 400 (media:read + viewer)
- `GET /api/media/locations?type=&capturedAtFrom=&capturedAtTo=&country=&region=&locality=&place=&location=&albumId=&bbox=` - List the caller's geotagged (non-deleted) media as a flat array of lightweight points for map display (no pagination): `{ id, takenLat, takenLng, capturedAt, geoLocality }`; per-row thumbnail signing was removed (it was an N+1 pattern causing multi-second loads and 502s on large circles) — use `GET /api/media/thumbnails` to fetch thumbnails for the items actually in view; new `bbox` param scopes results to a viewport cell; optional `albumId` scopes results to a single album's members, used by the album Map view (media:read + viewer)
- `GET /api/media/locations/aggregate?circleId=&precision=<0-5>&bbox=<minLng,minLat,maxLng,maxLat>&capturedAtFrom=&capturedAtTo=&type=` - Server-side spatial clustering for the map view; buckets points into a grid via a single GROUP BY (no thumbnails, no metadata reads); returns `Array<{ lat, lng, count, sampleId }>` (media:read + viewer)
- `GET /api/media/thumbnails?circleId=&ids=<comma-separated uuids, 1–200>` - Batched, lazy thumbnail signing for a given set of item ids (one `storageObject.findMany` call, signed locally); returns `Array<{ id, thumbnailUrl|null }>`; used by the map's cluster-drawer to load thumbnails only for items actually being viewed (media:read + viewer)

> **Future:** a globe/3D view for the map is a known follow-up, not yet implemented.

### Albums (media:read / media:write / media:delete)
Albums are circle-scoped named collections; deleting an album removes join rows only — `MediaItem` records are preserved.
- `GET /api/media/albums?circleId=&page=&pageSize=&sortBy=&sortOrder=` - List albums in a circle (paginated; sortBy `name`|`createdAt`|`updatedAt`); each item also includes `coverMediaItemId`, `coverThumbnailUrl` (signed; resolves to the chosen cover item, else the most-recent member's thumbnail, else null), `itemCount`, and `dateRange: { min, max } | null` (min/max capturedAt across non-deleted/non-archived members) (media:read + viewer)
- `POST /api/media/albums` body `{circleId, name, description?}` - Create an album (media:write + collaborator)
- `GET /api/media/albums/:id` - Get album with its ordered item list; items now include a signed `thumbnailUrl` (previously unsigned), and the album itself returns `coverMediaItemId` and `coverThumbnailUrl` (media:read + viewer)
- `PATCH /api/media/albums/:id` body `{name?, description?, coverMediaItemId?}` - Rename / update album; `description: null` clears it; `coverMediaItemId`: a UUID sets the cover (must already be a member of the album, else 400), `null` clears it, omitted leaves it untouched (media:write + collaborator)
- `DELETE /api/media/albums/:id` - Delete album; cascades AlbumItems, preserves MediaItems (media:delete + collaborator)
- `POST /api/media/albums/:id/items` body `{mediaItemIds[]}` (1–500) - Add specific media items to the album; idempotent (media:write + collaborator)
- `DELETE /api/media/albums/:id/items/:itemId` - Remove one item from the album; `:itemId` is the MediaItem UUID (media:write + collaborator) — 204 No Content
- `POST /api/media/albums/:id/items/by-filter` body `{circleId, ...mediaFilterFields}` - Add ALL media matching the given filters to the album in one operation; reuses `GET /api/media` filter semantics (minus pagination/sort); inserts with `skipDuplicates`; returns `{added: number}` (media:write + collaborator)

> **UI:** The album detail page has an icon toolbar (Map, Slideshow, People, Share) and a kebab menu limited to "Select album cover" / "Rename" / "Delete album". The `/albums` page is now a card grid (cover, date range, item count) instead of a flat list. The left sidebar shows a single "Albums" entry instead of enumerating every album. `MediaLightbox` supports an autoplay slideshow.

### AI Settings (Admin only — ai_settings:read / ai_settings:write)
- `GET /api/ai/settings` - Get configured providers and search/tagging/embedding feature config (ai_settings:read)
- `PUT /api/ai/credentials/:provider` - Upsert provider credentials, encrypted at rest (ai_settings:write)
- `DELETE /api/ai/credentials/:provider` - Remove provider credentials (ai_settings:write)
- `POST /api/ai/test` - Test provider connectivity (ai_settings:read)
- `POST /api/ai/test/embedding` - Test embedding-provider connectivity; optional body `{ provider?, model? }` defaults to configured `ai.features.embedding`; returns `{ ok, provider, model, dimensions, warning? }` — `warning` is set when dimensions != 1536; `{ ok:false, error }` on failure (ai_settings:read)
- `GET /api/ai/models?provider=&capability=` - List available models for a provider; optional `capability` param: `chat` (default) or `embedding` — when `embedding`, returns embedding model IDs (OpenAI only: `text-embedding-3-small`, `text-embedding-3-large`; other providers return empty) (ai_settings:read)
- `PUT /api/ai/features/search` - Set active provider and model for AI search (ai_settings:write)
- `PUT /api/ai/features/tagging` - Set active provider and model for AI auto-tagging (ai_settings:write)
- `PUT /api/ai/features/embedding` - Set active provider and model for text embeddings used in semantic search; currently OpenAI-only (`text-embedding-3-small` = 1536-d); required for `semanticQuery` to work (ai_settings:write)

### AI Auto-Tagging (ai_settings:read / ai_settings:write + media:read / media:write)
Auto-tagging is enabled globally via the `features.autoTagging` system setting (default off); see Tag Vocabulary endpoints below and the [auto-tagging spec](docs/specs/auto-tagging.md). The global vocabulary is admin-managed; the vision model assigns labels only from enabled entries. The per-circle `auto_tagging_enabled` column was dropped in migration `20260621050000_drop_circle_feature_flags`.
- `GET /api/tag-labels` - List all tag labels (ai_settings:read)
- `POST /api/tag-labels` body `{name}` - Create a tag label (ai_settings:write); 409 if name exists
- `PATCH /api/tag-labels/:id` body `{name?, enabled?}` - Update a tag label (ai_settings:write)
- `DELETE /api/tag-labels/:id` - Delete a tag label (ai_settings:write) — 204 No Content; removes AI-applied tag instances for that label name across all circles (manual instances preserved)
- `GET /api/tag-labels/export` - Export all tag labels as CSV (`id,name`, ordered by name) (ai_settings:read)
- `POST /api/tag-labels/import` - Import tag labels from a multipart CSV upload (ai_settings:write); CSV columns: `id,name,delete`; empty `id` = create, truthy `delete` = delete by id, else update by id; returns `{created, updated, deleted, errors[]}`
- `GET /api/media/:id/tags/status` - Get per-item tagging status: status, tagCount, providerKey, modelVersion, processedAt, lastError (media:read + viewer)
- `POST /api/media/:id/tags/rerun` - Re-enqueue auto-tagging for a media item at priority 0; returns `{jobId, status}` (media:write + collaborator)

### Face Recognition / Face Settings (Admin only — face_settings:read / face_settings:write)
Three providers: `human` (keyless WASM, in-process, 1024-d), `compreface` (keyless `compreface-core` sidecar, 128-d mobilenet, `requiresCredentials:false`), `rekognition` (delegated AWS, requires credentials). The Face Settings UI has a "Test connection" button for all providers including keyless ones. Face recognition is enabled globally via `features.faceRecognition` system setting (default off); the per-circle `face_recognition_enabled` column was dropped in migration `20260621050000_drop_circle_feature_flags`.
- `GET /api/face/settings` - Get configured providers (masked), known providers, capabilities, and active detection feature (face_settings:read)
- `PUT /api/face/credentials/:provider` - Upsert provider credentials, encrypted at rest (face_settings:write)
- `DELETE /api/face/credentials/:provider` - Remove provider credentials (face_settings:write)
- `POST /api/face/test` - Test provider connectivity (face_settings:read)
- `GET /api/face/models?provider=` - List available models for a provider (face_settings:read)
- `PUT /api/face/features/detection` - Set active face-detection provider and model (face_settings:write)
- `DELETE /api/face/biometrics?circleId=` - Permanently erase all Face, Person, MediaFaceStatus, and FaceJob rows for a circle (face_settings:write + circle_admin); does NOT change any global feature toggle

### Face Recognition — Detection (media:read / media:write + per-circle viewer/collaborator role)
- `GET /api/media/:id/faces` - List detected faces on a media item: id, boundingBox (normalized 0–1), confidence, landmarks, personId, providerKey, modelVersion, manuallyAssigned; for video faces also returns `videoTimestampMs` (Int?, representative appearance time in ms), `videoTimestamps` (Int[], all sampled appearance timestamps), and `faceThumbnailUrl` (signed URL of the representative frame JPEG; null for photos) (media:read + viewer)
- `GET /api/media/:id/faces/status` - Get per-item detection status: status, faceCount, providerKey, modelVersion, processedAt, lastError (media:read + viewer)
- `POST /api/media/:id/faces/rerun` - Re-enqueue face detection for a media item; for photos enqueues `face_detection`, for videos enqueues `video_face_detection`; returns `{jobId, status}` (media:write + collaborator)

### Face Recognition — People (media:read / media:write + per-circle viewer/collaborator/circle_admin role)
- `GET /api/people?circleId=&includeUnlabeled=&page=&pageSize=&albumId=` - List person records in a circle; paginated; optional `albumId` scopes results to people whose faces appear in that album's (non-deleted/non-archived) media, used by the album People view (media:read + viewer)
- `GET /api/people/:id` - Get a person with their associated faces (media:read + viewer)
- `POST /api/people` body `{circleId, name?, faceIds?}` - Create a person, optionally assigning initial faces (media:write + collaborator)
- `PATCH /api/people/:id` body `{name?, coverFaceId?}` - Rename a person or set cover face (media:write + collaborator)
- `POST /api/people/:id/faces` body `{faceIds[]}` - Assign faces to a person (sets manuallyAssigned=true) (media:write + collaborator)
- `DELETE /api/people/:id/faces/:faceId` - Unassign a face; face returns to unknown pool (media:write + collaborator) — 204 No Content
- `POST /api/people/cluster` body `{circleId}` - Cluster unknown faces into provisional Person records; requires `features.faceRecognition` enabled globally (media:write + circle_admin)
- `POST /api/people/merge` body `{sourceId, targetId}` - Reassign all faces source→target, soft-delete source with mergedIntoId audit breadcrumb (media:write + collaborator)
- `DELETE /api/people/:id` - Soft-delete a person; all faces return to unknown pool (media:write + collaborator) — 204 No Content
- `PATCH /api/people/bulk/hide` body `{circleId, ids[]}` (1–500) - Hide people/clusters from People UI surfaces; sets `hiddenAt`; reversible; does not touch faces or media → `{ hidden: number }` (media:write + collaborator)
- `PATCH /api/people/bulk/unhide` body `{circleId, ids[]}` (1–500) - Unhide previously hidden people/clusters; clears `hiddenAt` → `{ unhidden: number }` (media:write + collaborator)
- `POST /api/people/bulk/purge` body `{circleId, ids[]}` (1–500) - Permanently hard-delete Person + Face rows (reclaims embedding storage); writes audit event; re-enqueues `auto_tagging` for affected media; photos/media items are NOT deleted → `{ deleted: number }` (media:delete + collaborator)
- `GET /api/people?circleId=...&hidden=true` - List ONLY hidden people (default list excludes hidden); response items include `hiddenAt` (media:read + viewer)
- `GET /api/people/unassigned?circleId=&page=&pageSize=&archived=` - List unassigned faces (`personId=null`); `archived` boolean: default returns only LIVE unassigned faces (archived excluded), `archived=true` returns only archived faces; items include `hiddenAt` (media:read + viewer)
- `PATCH /api/people/faces/bulk/hide` body `{circleId, ids[]}` (face ids, 1–500) - Archive individual unassigned faces (mirrors person-level hide, scoped to `personId=null` faces only); sets `Face.hiddenAt`; archived faces are hidden from the unassigned-faces list and excluded from clustering → `{ hidden: number }` (media:write + collaborator)
- `PATCH /api/people/faces/bulk/unhide` body `{circleId, ids[]}` (1–500) - Restore archived unassigned faces; clears `Face.hiddenAt` → `{ unhidden: number }` (media:write + collaborator)
- `POST /api/people/faces/bulk/purge` body `{circleId, ids[]}` (1–500) - Permanently hard-delete unassigned Face rows (reclaims the `embedding` column); re-enqueues `auto_tagging` for affected media; photos/media items are NOT deleted → `{ deleted: number }` (media:delete + collaborator)
- `POST /api/people/faces/purge-archived` body `{circleId}` - Permanently hard-delete ALL archived (hiddenAt set) unassigned faces in a circle, including faces on trashed/archived media (deleted count may exceed the visible archived count); writes `face:purge_archived` audit event; re-enqueues `auto_tagging` for affected media; photos/media items are NOT deleted → `{ deleted: number }` (media:delete + collaborator)
- `GET /api/media?personId=` - Filter media list to items containing faces assigned to a specific person (media:read + viewer)
- `GET /api/media?noFaces=true` - Filter media list to items with no faces at all (detected or manually added) — useful for finding untagged photos; semantically `faces: { none: {} }` (media:read + viewer)
- `GET /api/media?missingCapturedAt=true` - Filter media list to items with no EXIF capture date (`capturedAt` is null) — useful for finding imports that lack DateTimeOriginal (media:read + viewer)
- `GET /api/media?missingCamera=true` - Filter media list to items with no camera make/model — useful for finding imports that lack EXIF camera metadata (media:read + viewer)

### Face Recognition — Manual People Association (media:write + per-circle collaborator role)
These endpoints let users associate people with a photo from the media properties pane when face detection misses a face. No bounding box is required. Internally each association is stored as a `Face` row with `providerKey='manual'`, `manuallyAssigned=true`, empty embedding, and zeroed bounding box — so all existing people filters and person galleries work without changes. Manual faces are preserved across face-detection reruns (the rerun delete is scoped to `manuallyAssigned=false`). Adding or removing a manual association re-enqueues `auto_tagging` so description/embedding refresh.
- `POST /api/media/:id/people` body `{ personId }` OR `{ name }` (exactly one) — associate a person with the photo; find-or-create by name when `name` is given; idempotent (no duplicate if the person is already associated); returns `{ personId, personName, faceId, mediaItemId }` (media:write + collaborator)
- `DELETE /api/media/:id/people/:personId` — remove the manual association only (does not touch detected faces); 404 if no manual association exists; 204 No Content (media:write + collaborator)

### Admin: Global Backfill Endpoints (Admin role + system_settings:write or face_settings:write)
These endpoints replace the former per-circle backfill endpoints. Each iterates all circles and returns `{ enqueued, circles }`. The per-circle backfill endpoints (`POST /api/tagging/backfill`, `POST /api/media/bursts/backfill`, `POST /api/metadata/backfill`, `POST /api/face/backfill`) have been removed.
- `POST /api/admin/tagging/backfill` body `{ from?, to?, force? }` - Bulk-enqueue auto-tagging jobs across all circles; 400 if `features.autoTagging` is disabled (Admin + system_settings:write)
- `POST /api/admin/bursts/backfill` body `{ from?, to?, force? }` - Bulk-enqueue burst_detection jobs across all circles; includes on-demand perceptual hashing for legacy photos; also runs `DuplicateDetectionService.evictExistingBurstOverlaps()` app-wide as a post-step (best-effort) to heal items already double-listed in both the burst and duplicate review queues; 400 if `features.burstDetection` is disabled; returns `{ enqueued, circles, evictedDuplicateOverlaps }` (Admin + system_settings:write)
- `POST /api/admin/metadata/backfill` body `{ from?, to?, force? }` - Bulk-enqueue metadata_extraction jobs across all circles; no feature gate (Admin + system_settings:write)
- `POST /api/admin/face/backfill` body `{ from?, to?, force? }` - Bulk-enqueue face_detection jobs across all circles; `from`/`to` (optional ISO-8601) bound `capturedAt` to control how far back detection is recreated; 400 if `features.faceRecognition` is disabled (Admin + face_settings:write)
- `POST /api/admin/face/auto-archive/backfill` - Backfill the auto-archive feature against the EXISTING unassigned-face backlog: enqueues one server-only `face_auto_archive_sweep` job per circle that already has at least one archived (hidden) unassigned face, hiding any LIVE unassigned face that closely matches that circle's archived reference set; 400 if `features.faceAutoArchive` is disabled; returns `{ data: { enqueued, circles } }` (Admin + face_settings:write)
- `POST /api/admin/duplicates/backfill` body `{ from?, to?, force? }` - Bulk-enqueue `duplicate_detection_batch` jobs (100 media-item IDs per job, chunked to stay under the enrichment worker's stuck-job reset threshold) across all circles; `force=false` (default) skips items that already have a `media_visual_embedding` row; 400 if `features.duplicateDetection` is disabled; returns `{ enqueued, circles, estimatedItems }` where `enqueued` = job rows created, `estimatedItems` = individual photos covered (Admin + system_settings:write)
- `POST /api/admin/location-inference/backfill` body `{ from?, to?, force? }` - Bulk-enqueue ONE `location_inference` sweep job (not chunked — see the Location Inference endpoints above) per eligible circle across all circles; 400 if `features.locationInference` is disabled; returns `{ enqueued, circles, estimatedItems }` (Admin + system_settings:write)
- `POST /api/admin/social-media/backfill` body `{ from?, to?, force? }` - Bulk-enqueue `social_media_detection` jobs across all circles, video items only; `force=false` (default) skips items whose `media_social_status` is already `processed`; 400 if `features.socialMediaDetection` is disabled; returns `{ enqueued, circles }` (Admin + system_settings:write)

### Admin: Settings UI (`/admin/settings/*`)
The admin settings UI is organized as a hub at `/admin/settings` with URL-addressable sub-pages. Old flat `/admin/*` routes redirect to the new nested paths. The sidebar shows a single "Settings" entry. Per-circle feature toggles and per-circle backfill panels have been removed from the circle detail page.

Sub-pages:
- `/admin/settings/general` — general app settings
- `/admin/settings/users` — user management
- `/admin/settings/ai` — AI provider credentials and model selection
- `/admin/settings/tagging` — global auto-tagging toggle (`features.autoTagging`), tag vocabulary, global backfill
- `/admin/settings/face` — global face recognition toggle (`features.faceRecognition`), provider configuration, global backfill, plus the face auto-archive toggle (`features.faceAutoArchive`), its match-threshold slider (`face.autoArchive.matchThreshold`), and a backlog sweep to auto-archive live unassigned faces matching already-archived ones
- `/admin/settings/bursts` — global burst detection toggle (`features.burstDetection`), parameters, the auto-resolve threshold (`burst.autoResolveThreshold`), global backfill; reachable directly from `/bursts` via an admin-only gear icon
- `/admin/settings/duplicates` — global near-duplicate detection toggle (`features.duplicateDetection`), threshold sliders including auto-resolve (`dedup.autoResolveThreshold`), global backfill, CLIP model status; reachable directly from `/duplicates` via an admin-only gear icon
- `/admin/settings/location-inference` — global location inference toggle (`features.locationInference`), all six `locationInference.*` parameters, global backfill
- `/admin/settings/social-media` — global social-media video detection toggle (`features.socialMediaDetection`), OCR/threshold tuning (`socialMedia.*`), global backfill
- `/admin/settings/geo` — geo provider settings (`geo.provider`, `geo.forwardSearchEnabled`)
- `/admin/settings/email` — email provider configuration (SES vs SMTP toggle, provider presets, test-connection, masked credentials, enable/disable)
- `/admin/settings/storage/providers` — storage provider configuration (replaces `/admin/storage-providers`)
- `/admin/settings/storage/insights` — storage insights dashboard
- `/admin/settings/jobs` — enrichment job queue (replaces `/admin/jobs`)
- `/admin/settings/jobs/insights` — job queue insights & ETA dashboard (jobs:read); KPI cards + per-type duration/throughput table; reachable from the Settings hub Operations group and from a "View insights & ETA" link on the Job Queue page
- `/admin/settings/nodes` — worker node fleet health, heartbeats, per-node job stats
- `/admin/settings/backup` — backup configuration and run history
- `/admin/settings/sharing` — public share management; per-row and bulk revoke/set-expiration/delete for all shares across the app (shares:manage_any)
- `/admin/settings/doctor` — configuration health diagnostics (Doctor); runs live checks and shows action items

### Storage Provider Configuration (Admin only — storage_settings:read / storage_settings:write)
Admins can configure multiple object-storage providers (AWS S3, Cloudflare R2, local disk), test connectivity, choose the ACTIVE provider for new uploads, and migrate existing objects between providers (COPY-ONLY: bytes are copied and the object is repointed; the source file is left in place as a fallback). Objects on different providers are served simultaneously via per-object routing.
- `GET /api/storage-settings` (storage_settings:read) — Return configured providers plus the active provider: `{ providers[], knownProviders[], activeProvider }`; provider rows include `provider, label, configured, enabled, requiresCredentials, accessKeyId, region, bucket, endpoint, last4, updatedAt`; secret/encryptedKey is NEVER returned
- `GET /api/storage-settings/providers` (storage_settings:read) — List registry descriptors for all known provider types: `{ key, label, requiresCredentials, fields[], endpointRequired }`
- `PUT /api/storage-settings/credentials/:provider` (storage_settings:write) body `{ accessKeyId?, secretAccessKey?, bucket?, region?, endpoint?, enabled? }` — Upsert provider credentials; omitting `secretAccessKey` on an update PRESERVES the stored secret; R2 requires `endpoint`
- `DELETE /api/storage-settings/credentials/:provider` (storage_settings:write) — Remove provider credentials; 400 if the provider is currently the active provider
- `POST /api/storage-settings/test` (storage_settings:read) body `{ provider, accessKeyId?, secretAccessKey?, bucket?, region?, endpoint? }` — Test provider connectivity before saving; performs a write→read→delete round-trip on a `__memoriahub_conn_test__/<uuid>` sentinel key; returns `{ ok, bucket?, region?, endpoint?, error? }`
- `PUT /api/storage-settings/active` (storage_settings:write) body `{ provider }` — Set the active provider for new uploads; returns `{ activeProvider }`; switching affects NEW uploads only — existing objects continue to be served from their own provider/bucket and are NOT migrated
- `POST /api/storage-settings/migrate` (storage_settings:write) body `{ sourceProvider, targetProvider }` — Start a copy-only migration run; returns `{ runId, totalCount }`; 400 if source === target or a run is already pending/running; enqueues one `storage_migration` enrichment job per object (priority 100, reason backfill)
- `GET /api/storage-settings/migrate` (storage_settings:read) — List recent migration runs
- `GET /api/storage-settings/migrate/:runId` (storage_settings:read) — Get migration run detail: `{ id, sourceProvider, targetProvider, status: pending|running|completed|failed|cancelled, totalCount, migratedCount, failedCount, skippedCount, startedAt, finishedAt, lastError }`; counts recomputed from item rows
- `POST /api/storage-settings/migrate/:runId/cancel` (storage_settings:write) — Cancel a pending or running migration run; in-flight items detect the cancelled run and skip

> **UI:** The Admin Settings page at `/admin/settings/storage/providers` (reachable from the Settings hub) shows provider cards with per-card "Test connection", an active-provider selector, and a copy-only migration panel with live progress and run history.

### Public Sharing (shares:manage / shares:manage_any)
Circle collaborators and admins can publish a single media item or an entire album to an unauthenticated public URL. Media bytes are **proxied** through the API — the storage URL is never exposed. Shares support optional expiration (`null` = forever) and can be soft-revoked at any time. A standalone admin page at `/admin/settings/sharing` allows per-row and bulk management of all shares.

**Authenticated management endpoints** (require JWT):
- `POST /api/shares` body `{ targetType: 'media_item'|'album', mediaItemId?, albumId?, expiresAt? }` → `{ share, publicUrl }` — create or return existing share (idempotent); requires shares:manage + per-circle collaborator role
- `GET /api/shares?scope=mine|all&status=&targetType=&page=&pageSize=` — list shares; `scope=all` requires shares:manage_any (Admin only)
- `PATCH /api/shares/:id` body `{ expiresAt }` (`null` = never expires) — update expiration; requires shares:manage (own) or shares:manage_any
- `DELETE /api/shares/:id` — soft-revoke (sets `revokedAt`); returns 204; requires shares:manage (own) or shares:manage_any
- `POST /api/shares/bulk` body `{ ids[], action: 'revoke'|'set_expiration'|'delete', expiresAt? }` → `{ affected }` — bulk revoke, update expiration, or hard-delete shares; requires shares:manage_any (Admin only)

**Unauthenticated public endpoints** (`@Public()` — no JWT required):
- `GET /api/public/shares/:token` — validate share and return **metadata-stripped** representation: `{ type: 'media_item', media: { mediaType, width, height } }` or `{ type: 'album', itemCount, items: [{ mediaType, width, height }] }`; revoked/expired/trashed targets → generic 404 (enumeration-resistant)
- `GET /api/public/shares/:token/media/:idx` — byte-proxy for the media file (`Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`); video responses support Range requests (206); `?variant=thumb` returns the thumbnail for album grid display; revoked/expired/trashed → generic 404

**Policy notes:**
- Archived items ARE served via public share (archive does not block public access).
- Albums exclude trashed members from both metadata and byte-proxy responses.
- Hard-deleting a media item or album cascades the share row away.
- **EXIF / GPS limitation:** bytes are served as raw originals; embedded EXIF metadata (including GPS) inside the file is NOT stripped. The no-metadata guarantee applies at the API layer only (no metadata fields in the JSON response, no download affordance, no storage URL). File-level stripping (piping through `apps/api/src/storage/processing/`) is a future improvement.

### Deterministic Search (search:use)
- `POST /api/search` - Execute deterministic media search with explicit filters; optionally add `semanticQuery: string` (1–512 chars) to rank results by vector similarity instead of sort order; also accepts `noFaces: true` boolean to return only items with no faces (detected or manually added); also accepts `excludeArchived: true` to exclude archived items from results (archived items are included by default in search, unlike browse surfaces); also accepts `missingCapturedAt: true` to return only items with no EXIF capture date (`capturedAt` is null) and `missingCamera: true` to return only items with no camera make/model; also accepts `near: { lat, lng, radiusKm }` to filter to items whose `takenLat`/`takenLng` fall within a bounding-box approximation of the given radius (geo-radius filter). **All filters are AND-composed** — every descriptor contributes to a shared `AND: []` array so combining multiple filters (including descriptors that each emit an internal `OR`) never silently drops criteria. Each item in the response includes a signed `thumbnailUrl` (media:read + search:use)
- `GET /api/search/fields` - List all searchable field descriptors from the registry plus the `semanticQuery` descriptor; includes `noFaces` (label "No faces detected"), `excludeArchived` (label "Exclude archived", boolean — opt-in filter to hide archived items from search results), `missingCapturedAt` (label "Missing capture date", boolean — items where `capturedAt` is null), `missingCamera` (label "Missing camera info", boolean — items with no camera make/model), and `near` (type `geo-radius`, label "Near location (map radius)" — value shape `{ lat, lng, radiusKm }`) (search:use)

### Agentic Search (search:use)
Agentic search is **stateless** — no conversation rows are stored server-side. The client holds the full message history in memory and sends it with every request.
- `POST /api/search/agent` - Send a message history and stream the AI response via SSE (text/event-stream). Body: `{ circleId: string; messages: Array<{ role: 'user'|'assistant'; content: string }> }` (last message must be `role: 'user'`). Verifies circle viewer membership. Stream events: `token`, `tool_call`, `results`, `done`, `error`. The agent's `search_media` tool also accepts a top-level `semanticQuery` parameter for visual/scene-based queries, a `noFaces: true` parameter to filter to photos with no faces, a `missingCapturedAt: true` parameter to filter to items with no EXIF capture date, a `missingCamera: true` parameter to filter to items with no camera make/model, and a `near: { lat, lng, radiusKm }` parameter for map-radius proximity search. Each item in `results` SSE events includes a signed `thumbnailUrl` so clients can render thumbnails directly without a second request. (search:use)

### Health
- `GET /api/health/live` - Liveness check
- `GET /api/health/ready` - Readiness check (includes DB)

## RBAC Model

### System Roles
- **Admin**: Full access, manage users, system settings, and all circles
- **Contributor**: Standard capabilities, manage own settings, create/manage circles
- **Viewer**: Least privilege (default), manage own settings, create/manage circles

### Key Permissions
- `system_settings:read/write` - System settings access
- `user_settings:read/write` - User settings access
- `users:read/write` - User management
- `rbac:manage` - Role assignment
- `allowlist:read/write` - Allowlist management (Admin only)
- `storage:read/write/delete` - Storage object access (own objects)
- `storage:read_any/write_any/delete_any` - Storage object access (all objects, Admin only)
- `storage_settings:read` - View storage provider configuration and test connectivity (Admin only)
- `storage_settings:write` - Configure storage provider credentials, set active provider, and run migrations (Admin only)
- `circles:read` - List and read circles the user is a member of (all roles)
- `circles:write` - Create circles and manage circles the user owns (all roles)
- `circles:manage_any` - Read/write/delete any circle regardless of membership (Admin only)
- `backup:run` - Trigger backup jobs (Admin only)
- `backup:read` - Read backup run history and object list (Admin only)
- `ai_settings:read` - View AI provider config, test connectivity, list models (Admin only)
- `ai_settings:write` - Configure AI provider credentials and set active search model (Admin only)
- `search:use` - Use deterministic search and conversational (agentic) search (all roles)
- `face_settings:read` - View face provider config, test connectivity, list models (Admin only)
- `face_settings:write` - Configure face provider credentials and set active detection provider/model (Admin only)
- `geo_settings:read` - View geo provider config, test provider connectivity (Admin only)
- `geo_settings:write` - Configure geo provider credentials, set active reverse provider, run app-wide geocode backfill (Admin only)
- `email_settings:read` - View email provider configuration and test connectivity (Admin only)
- `email_settings:write` - Configure email provider credentials, set active provider, and send test emails (Admin only)
- `jobs:read` - View enrichment job queue stats and list jobs (Admin only)
- `jobs:write` - Retry, reset, and delete enrichment jobs (Admin only)
- `shares:manage` - Create, list, update expiration, and revoke own public shares (Contributor + Admin)
- `shares:manage_any` - Manage all public shares regardless of owner; required for `scope=all` listing and bulk operations (Admin only)

### Per-Circle Roles
Each circle has its own role for each member, independent of the system role:

| Per-Circle Role | Rank | Capabilities |
|-----------------|------|--------------|
| `viewer`        | 1    | Browse and download media in the circle |
| `collaborator`  | 2    | Upload, tag, and organize media; invite others at viewer level |
| `circle_admin`  | 3    | All collaborator actions plus remove members, delete circle |

The circle owner is automatically assigned `circle_admin` on circle creation. Every user also has a personal circle (`isPersonal: true`) created at signup, where they are the sole member at `circle_admin`.

**Super-admin bypass:** A user holding `circles:manage_any`, `media:write_any`, or `media:read_any` bypasses per-circle role checks entirely. This lets system Admins moderate any circle without being a member.

## Database Tables

- `users` - User accounts with profile info
- `user_identities` - OAuth provider identities (provider + subject)
- `roles` / `permissions` / `role_permissions` - RBAC
- `user_roles` - User-to-role assignments
- `system_settings` - Global app settings (JSONB); `email.smtpPassword` is AES-256-GCM encrypted at rest via `SECRETS_ENCRYPTION_KEY` and redacted from the generic `GET /api/system-settings` response — surfaced only masked (last-4) via `GET /api/email-settings`
- `user_settings` - Per-user settings (JSONB); includes `activeCircleId` (UX convenience, never trusted for authz)
- `audit_events` - Action audit log
- `refresh_tokens` - JWT refresh tokens (hashed)
- `allowed_emails` - Allowlist for access control; circle invites also upsert here
- `device_codes` - Device authorization codes (RFC 8628)
- `storage_objects` - File metadata, status, storage references (no circle_id; auth resolves via media_item)
- `storage_object_chunks` - Multipart upload chunk tracking
- `storage_provider_credentials` - Configured object-storage providers; one row per provider key (`s3` | `r2` | `local`); `secretAccessKey` stored AES-256-GCM encrypted via `SECRETS_ENCRYPTION_KEY` (same key as AI/Face credentials); `accessKeyId`, `region`, `bucket`, and `endpoint` stored plaintext; `last4` of the secret exposed for display; `enabled` flag; `updatedAt` for audit; plaintext secret never stored or returned
- `storage_migration_runs` - Top-level record for a provider-to-provider copy migration; tracks `sourceProvider`, `targetProvider`, status (`pending` | `running` | `completed` | `failed` | `cancelled`), `totalCount`, `startedAt`, `finishedAt`, and `lastError`; counts (`migratedCount`, `failedCount`, `skippedCount`) are recomputed from item rows
- `storage_migration_items` - Per-object tracking row for a migration run; `@@unique([runId, objectId])` provides idempotency anchor; cascades on run delete and on storage object delete; records per-item status and `lastError`
- `personal_access_tokens` - User-created long-lived API tokens (hashed)
- `circles` - Family circles; `is_personal=true` circles cannot be deleted. Note: the `face_recognition_enabled`, `auto_tagging_enabled`, and `burst_detection_enabled` columns were dropped in migration `20260621050000_drop_circle_feature_flags` — these features are now controlled by global system settings (`features.faceRecognition`, `features.autoTagging`, `features.burstDetection`)
- `circle_members` - Per-circle memberships with `CircleRole` enum (`circle_admin` | `collaborator` | `viewer`)
- `circle_invites` - Email invites for circles; claimed on invited user's first login
- `ai_provider_credentials` - AI provider API keys (AES-256-GCM encrypted); one row per provider; `last4` exposed for display; plaintext never stored or returned
- `face_provider_credentials` - Face provider API keys/config (AES-256-GCM encrypted via same key as AI); one row per provider; `last4` exposed; plaintext never stored or returned. For keyless providers (`human`, `compreface`), the credential row (if present) stores only a `baseUrl` override — no API key is set or required.
- `people` - Per-circle identity records for recognized individuals; supports `mergedIntoId` self-FK for cluster merge audit; `deletedAt` soft-delete; `hiddenAt` (DateTime?, nullable) — set by `PATCH /api/people/bulk/hide` to remove the person/cluster from People UI surfaces (People page, unknown-faces review) without touching faces or media; independent of `deletedAt`; reversible via `PATCH /api/people/bulk/unhide`; hidden people's media remains fully searchable, in albums, and in browse; purge (`POST /api/people/bulk/purge`) hard-deletes the Person + its Face rows rather than soft-deleting, and re-enqueues `auto_tagging` for affected media items. Migration: `20260628000000_person_hidden_at`
- `faces` - Individual detected face records with bounding box, confidence, variable-dimension embedding (`Float[]` fallback or pgvector column; 128-d for `compreface` mobilenet, 1024-d for `human` WASM), and `externalFaceId` for Rekognition delegated path; keyed to `mediaItemId` + `circleId`; `manuallyAssigned` flag protects user-labeled faces from re-clustering; video-specific columns added in migration `20260627000000_face_video_columns`: `videoTimestampMs` (Int?, representative appearance time in ms from video start; null for photos), `videoTimestamps` (Int[], all frame timestamps where this identity was observed; empty for photos), `frameThumbnailKey` (Text?, storage key of the saved representative-frame JPEG; null for photos); `hiddenAt` (DateTime?, nullable; migration `20260704000000_add_face_hidden_at`) — archive flag for individual **unassigned** (`personId=null`) faces, mirroring `people.hiddenAt`; set/cleared via `PATCH /api/people/faces/bulk/hide|unhide`; archived faces are excluded from the unassigned-faces list and from clustering; permanent removal (`POST /api/people/faces/bulk/purge`) is a hard row delete (not a soft-delete) that reclaims the `embedding` column; new index `faces(circle_id, hidden_at)` added alongside a matching `people(circle_id, hidden_at)` index; `hiddenReason` (String?, `@map("hidden_reason")`; migration `20260712000000_add_face_hidden_reason`) — provenance of a hide: `'auto_archive_match'` when the auto-archive feature (`features.faceAutoArchive`) hid the face because it matched a previously-archived face, `null` for a manual `PATCH /api/people/faces/bulk/hide` call. `embedding_vec` (`vector(128)`, pgvector; migration `20260715000000_add_face_embedding_vector`) is a derived column automatically maintained by the `faces_sync_embedding_vec` trigger from `embedding` — application code never writes it directly — indexed with two HNSW cosine indexes (`faces_embedding_vec_hnsw_idx` main, `faces_embedding_vec_archive_hnsw_idx` partial on `person_id IS NULL AND hidden_at IS NOT NULL`) enabling indexed KNN face matching (`FACE_VECTOR_BACKEND=pgvector`, now the default); NULL for non-128-d (`human` 1024-d) or empty embeddings.
- `enrichment_jobs` - Generic background job queue for all enrichment handlers (face detection, video face detection, storage insights, etc.); statuses: `pending`, `running`, `succeeded`, `failed`; reasons: `upload`, `rerun`, `backfill`; `media_item_id` and `circle_id` are **NULLABLE** — null values indicate a global/system job that is not scoped to a single media item or circle (e.g. the `storage_insights` handler); idempotency for global jobs deduplicates on `(type, media_item_id IS NULL)`; three backoff columns: `scheduled_for` (DateTime?, when the job becomes eligible again — null = eligible now; the worker claim query skips jobs where `scheduled_for > now`), `rate_limited_at` (DateTime?, timestamp of the most recent rate-limit hit), `rate_limit_hits` (Int default 0, count of rate-limit deferrals tracked separately from `attempts`); `attempts` (Int default 0) is charged at CLAIM time — it means "attempts STARTED", not "attempts failed", so a job that takes the whole process down (OOM SIGKILL) and never reaches the in-process failure path still consumes its attempt; this is what lets the stuck-reset path (cron + `POST /api/admin/jobs/reset-stuck`) mark a stuck `running` job **failed** once `attempts >= ENRICHMENT_MAX_ATTEMPTS` instead of requeueing it forever, bounding a poison-pill/OOM job to `ENRICHMENT_MAX_ATTEMPTS` crashes; rate-limit deferrals un-charge the claim-time increment so they never consume an attempt; `storage_migration` copies a single object from source to target provider (copy→verify→repoint→leave source; one job per object; `skipDedup` option prevents the `(type, mediaItemId IS NULL)` dedup from collapsing per-object jobs); `video_face_detection` samples frames from a video via ffmpeg, runs the active face provider on each frame, deduplicates faces across frames by embedding similarity, and writes one `Face` row per identity cluster per video (skipped without downloading — marked `no_faces` — when the item is flagged social-media (`social_media_source` non-null), when `face.video.enabled=false`, or when the object exceeds `VIDEO_ENRICHMENT_MAX_BYTES`); `job_history_purge` is a global nightly job (`mediaItemId: null`, `circleId: null`) that batch-deletes terminal rows (`status IN (succeeded, failed)` with `finishedAt` older than `jobs.history.retentionDays`) in 5 000-row batches — pending and running rows are never deleted; before deleting each batch it folds the rows into the `job_stats_rollup` lifetime aggregate (in the same transaction) so all-time analytics survive the purge; enqueued by `JobHistoryPurgeTask` at midnight; `location_inference` has TWO shapes sharing one handler dispatched on `mediaItemId` presence — per-item mode (`mediaItemId` set: infer a single item's coordinates from timeline anchors) and sweep mode (`mediaItemId: null`, `circleId` set, `payload: {mode:'sweep', from?, to?, force?}`: one job per circle computes suggestions for every eligible GPS-less item in that circle via a single in-memory pass, used by both the admin backfill and — unlike every other global job type in this table — never chunked into multiple jobs, since the work is pure DB read + in-memory compute rather than compute-bound; see [Location Inference spec](docs/specs/location-inference.md)); `social_media_detection` is a video-only, per-item gate: when `features.socialMediaDetection` is on, video uploads enqueue `social_media_detection` INSTEAD OF `video_face_detection` (priority 10); the handler runs pre-flight size/duration caps (`VIDEO_ENRICHMENT_MAX_BYTES`, `socialMedia.maxDurationSeconds`, `socialMedia.maxSizeBytes` → treat as clean, `matchedRule: skip-*-cap`, no download) then a landscape-orientation gate (strictly-landscape videos are never downloaded — Tier-1-only, no OCR), then classifies via container-metadata/filename rules (Tier 1) falling back to on-server OCR (Tier 2) when inconclusive-but-suspicious — a DETECTED result applies "Social Media" + platform tags and stops (no further video enrichment is enqueued), a CLEAN result fans out the withheld `video_face_detection` job via `MediaEnrichmentService.enqueueVideoPostDetectionEnrichment`; see [Social Media Detection spec](docs/specs/social-media-detection.md)); `thumbnail_regen` is the async worker-side counterpart to the synchronous single-item `POST /api/media/:id/thumbnail/rerun` — its handler resolves the item's `StorageObject` and calls `StorageProcessingRecoveryService.reprocessObjectNow` on the enrichment worker so a bulk rerun across many items doesn't block the request; used by `POST /api/media/bulk/thumbnail/rerun`); `thumbnail_repair` is a global hourly job (`mediaItemId: null`, `circleId: null`, priority 100, dedup'd on pending/running) that self-heals media items whose thumbnail sync was missed even though the underlying `StorageObject` reached `status IN ('ready','failed')` — see the `thumbnail_repair` paragraph under Admin: Stuck StorageObject Recovery above for the two repair paths and attempts-cap detail. `face_auto_archive_sweep` is a global per-circle backfill job (`mediaItemId: null`, `circleId` set, priority 100, `skipDedup: true` since the type is shared across many circles — per-circle pending/running dedup is enforced by `FaceBackfillService` itself) that hides LIVE unassigned faces matching a circle's already-archived unassigned-face pool; **server-only, not node-claimable** (no `nodeResultSchema`/`persistNodeResult`; deliberately absent from the CLI's `NODE_JOB_TYPES`), mirroring the `location_inference` sweep precedent — see the auto-archive feature detail under `faces` table and Feature Toggles below. Three columns support distributed worker nodes (see the [Distributed Nodes spec](docs/specs/distributed-nodes.md)): `claimed_by_node_id` (FK → `worker_nodes`, SetNull on delete), `lease_expires_at` (DateTime?, set at claim time), and `executor` (`'server'`|`'node'`, which side ran the job). The in-process worker now claims through a shared, DB-atomic `EnrichmentClaimService` using `FOR UPDATE SKIP LOCKED`, making claiming safe across multiple API/worker processes as well as node claims via `POST /api/nodes/:id/claim`; a lease-expiry reaper requeues jobs whose `lease_expires_at` has passed without a renewal or completion
- `face_jobs` - Async face-detection job queue (no BullMQ); statuses: `pending`, `running`, `succeeded`, `failed`; reasons: `upload`, `rerun`, `backfill`
- `media_face_status` - Per-media-item detection status tracking (one row per item); records which provider/model processed the item and when; statuses: `not_processed`, `pending`, `processing`, `processed`, `failed`, `no_faces`
- `tag_labels` - Global AI tag vocabulary managed by admins; unique `name`; `enabled` flag controls whether a label is included in vision model prompts; labels are not circle-scoped; supports CSV export/import
- `media_tag_status` - Per-media-item auto-tagging status (one row per item); statuses: `not_processed`, `pending`, `processing`, `processed`, `failed`; records `provider_key`, `model_version`, `tag_count`, `processed_at`, `last_error`
- `albums` - Circle-scoped named media collections; `added_by_id` tracks the creating user; unique per `(circle_id, name)` is not enforced — names are for display only. Nullable `cover_media_item_id` column: FK → `media_items(id)`, `ON DELETE SET NULL`, added in migration `20260709000000_add_album_cover_media_item`
- `album_items` - Join table linking `albums` to `media_items`; `@@unique([albumId, mediaItemId])` prevents duplicates; `added_at` records when the item was placed in the album; cascades on album delete, cascades on media item delete
- `insights_snapshots` - Precomputed global storage metrics snapshot; at most one row survives after each successful recompute (older rows are pruned); statuses: `InsightsSnapshotStatus` enum (`computing` | `ready` | `failed`) — in the queue-based flow the handler writes `ready` directly, so `computing` is not used at runtime; `metrics` JSONB holds `{ totalBytes, photoBytes, videoBytes (STRINGS), totalItems, photoCount, videoCount, totalFaces, taggedItems (NUMBERS) }` when `ready`; `computed_at` and `duration_ms` track timing; in-flight and failure state is tracked on the `enrichment_jobs` row, not here
- `job_stats_rollup` - Lifetime per-type aggregate of terminal enrichment jobs (PK `type`); the nightly `job_history_purge` folds the rows it deletes into this table (same transaction) BEFORE deleting them, so all-time analytics survive history purging; columns: `succeeded_count`, `failed_count`, `sum_duration_ms` (DOUBLE PRECISION — exact for integers up to 2^53 ms, avoids the JSON-unsafe BigInt pitfall), `duration_samples` (avg denominator), `updated_at`; only exactly-mergeable aggregates (counts + total duration → average) are kept — percentiles are NOT stored here and remain computed live over the recent window; surfaced as `lifetime` in `GET /api/admin/jobs/insights` and cleared by `POST /api/admin/jobs/insights/reset-history`
- `media_item_embedding` - One row per media item; stores a 1536-d pgvector embedding of the item's description + tags + people names; written via raw SQL (Prisma cannot handle the `vector(1536)` column type); circle_id is denormalized for circle-scoped KNN filtering; requires the `vector` pgvector Postgres extension and a `pgvector/pgvector:pg16` database image; HNSW cosine index on `embedding`; upserted by the auto-tagging handler as a best-effort final step — embedding failures never fail the tagging job
- `burst_groups` - Circle-scoped burst review groups; one row per detected burst cluster; status `pending` | `resolved` | `dismissed`; `suggestedBestItemId` FK → `media_items` (SetNull on delete); `mediaCount` denormalized member count (updated whenever a member joins or leaves); `capturedAt` of the earliest member used for chronological queue sorting; `resolvedById` / `resolvedAt` track who resolved or dismissed the group; `resolutionAction` (TEXT?, `'archive'` | `'trash'`), `keptCount` (Int?), `removedCount` (Int?) record the outcome of a resolve; `confidence` (Float?, [0,1]) is a visual-cohesion score set at detection time — see [Burst Photo Detection spec](docs/specs/burst-detection.md) for the formula; new index `(circle_id, status, resolution_action)`; added in migration `20260713120000_add_burst_dup_resolution_tracking`
- `media_metadata_status` - Per-media-item metadata extraction re-run status (one row per item); statuses: `not_processed`, `pending`, `processing`, `processed`, `failed`; records `processed_at` and `last_error`; unique on `media_item_id`; cascade delete on both `media_items` and `circles`
- `geo_provider_credentials` - Reverse-geocoding provider API keys (AES-256-GCM encrypted via `SECRETS_ENCRYPTION_KEY`); one row per provider; currently only `google` is supported; `last4` exposed for display; `enabled` flag allows disabling without deleting; plaintext key never stored or returned
- `media_geocode_status` - Per-media-item geocoding status (one row per item); reuses `MediaMetadataStatusType` enum (`not_processed`, `pending`, `processing`, `processed`, `failed`); tracks `processed_at` and `last_error`; unique on `media_item_id`; cascade delete on both `media_items` and `circles`
- `media_shares` - Public share records; one row per published item or album; `targetType` enum (`media_item` | `album`) with a CHECK constraint enforcing XOR — exactly one of `mediaItemId` or `albumId` must be non-null; `token` is a unique random slug used in the public URL; `expiresAt` is nullable (null = never expires); soft-revoke via `revokedAt` (null = active); FK to `media_items` and `albums` both set to CASCADE DELETE so hard-deleting a target removes the share row; FK to `circles` (CASCADE DELETE) and `created_by` user (SET NULL); added in migration `20260628130000_add_media_shares`
- `duplicate_groups` - Circle-scoped near-duplicate review groups; one row per detected visual-duplicate cluster; status `pending` | `resolved` | `dismissed`; `suggestedBestItemId` FK → `media_items` (SetNull on delete), opportunistically refreshed at read time by the best-copy scoring formula; `mediaCount` denormalized member count (always ≥ 2 — no minimum-size gate the way `burst_groups` has); `capturedAt` of the earliest active member for chronological queue sorting (added in migration `20260702010000_duplicate_groups_captured_at`); `resolvedById` / `resolvedAt` track who resolved or dismissed the group; `resolutionAction` (TEXT?, `'archive'` | `'trash'`), `keptCount` (Int?), `removedCount` (Int?) record the outcome of a resolve — no `confidence` column here, unlike `burst_groups`, since duplicate confidence (tightest-pair CLIP similarity) is computed at read time, not persisted; new index `(circle_id, status, resolution_action)`; both added in migration `20260713120000_add_burst_dup_resolution_tracking`; added in migration `20260702000000_add_visual_embeddings_and_duplicate_groups`. **Burst membership wins over duplicate membership:** an item assigned to a `burst_group` is evicted from any `duplicate_group` it was already placed in (`DuplicateDetectionService.evictFromDuplicateGroups`, called from `BurstDetectionService.processMediaItem`), closing the upload-time race where dedup processes an item before burst detection does; see [duplicate-detection.md §3.2](docs/specs/duplicate-detection.md#32-burst-overlap-exclusion-rules)
- `media_visual_embedding` - One row per media item; stores a 512-d pgvector CLIP ViT-B/32 image embedding used for visual near-duplicate matching (distinct from `media_item_embedding`'s 1536-d text embedding — visual vs. semantic, do not conflate); written via raw SQL (Prisma cannot handle the `vector(512)` column type); `circle_id` denormalized for circle-scoped KNN filtering; HNSW cosine index (`m=16, ef_construction=64`); row existence doubles as the "already processed" marker for backfill eligibility — there is no separate per-item status table for duplicate detection; `model` column tags which model version produced the row (currently always `clip-vit-b32-q8`); cascades on `media_items` delete
- `media_social_status` - Per-media-item social-media video detection status (one row per item); statuses: `MediaSocialStatusType` enum (`not_processed`, `pending`, `processing`, `processed`, `failed`); records the detection outcome audit trail — `is_social_media`, `platform` (`tiktok`|`instagram`|`facebook`|`other`), `detection_method` (`metadata`|`filename`|`ocr`), `confidence`, `matched_rule` (winning rule/heuristic id), `processed_at`, `last_error`; unique on `media_item_id`, cascade delete on `media_items`; index on `status`; added in migration `20260705000100_add_social_media_detection` — see the [Social Media Detection spec](docs/specs/social-media-detection.md)
- `location_suggestions` - One row per media item that has (or had) a candidate GPS coordinate guess from the location-inference feature; `media_item_id` is unique (never more than one live suggestion per item); statuses: `LocationSuggestionStatus` enum (`pending` | `accepted` | `rejected` | `auto_applied` | `reverted`) — auto-applied inferences still write a row (status `auto_applied`) as the audited, revertible record of what happened; stores `lat`, `lng`, `confidence`, `method` (`interpolated`|`nearest`), `anchor_before_id`/`anchor_after_id` (**no DB-level FK** — denormalized like `media_visual_embedding.circle_id`, so deleting the referenced anchor media item never blocks or cascades a pending suggestion), `gap_before_seconds`/`gap_after_seconds`, `anchor_distance_km`, `implied_speed_kmh` (all null for the single-anchor/extrapolation case except the gap on the side that exists), `resolved_by_id`/`resolved_at`; cascade delete on both `media_items` and `circles`; `@@index([circleId, status])`; added in migration `20260703000000_add_coord_source_and_location_suggestions` alongside a raw-SQL-only composite index `idx_media_circle_device_captured` on `media_items (circle_id, camera_make, camera_model, captured_at) WHERE deleted_at IS NULL` (not representable in Prisma's schema DSL, same precedent as `people_circle_id_hidden_at_idx`) that serves both the per-item anchor lookup and the sweep's ordered full-circle load — see the [Location Inference spec](docs/specs/location-inference.md)
- `worker_nodes` - Registers CLI-driven machines that claim and process `enrichment_jobs` rows; columns: `name`, `hostname`, `platform`, `cliVersion`, `eligibleTypes` (text[]), `concurrency`, `status` (`NodeStatus` enum: `online` | `draining` | `offline` | `disabled`), `capabilities` (JSONB, latest `node doctor` summary), `registeredAt`, `lastHeartbeatAt`, `createdById` (FK → `users`); see the [Distributed Nodes spec](docs/specs/distributed-nodes.md)

**Note:** `media_items` has `description` (nullable, max 8 192 chars) written by the auto-tagging handler on each successful vision call. There is no `title` column. `media_items`, `albums`, and `tags` use `added_by_id` (not `owner_id`) to track the uploading user. Dedup uniqueness for `media_items` is `(circle_id, content_hash)`. Tag names are unique per `(circle_id, name)`. The `media_tags` join table has a `source` column (`MediaTagSource` enum: `manual` | `ai` | `system`, default `manual`) that tracks whether a tag was applied by a user manually, by the AI auto-tagging service, or by an automated system feature (currently only social-media video detection's "Social Media"/platform tags); AI re-runs are authoritative over `source='ai'` rows only and never modify `source='manual'` rows; `system` tags follow a similar one-directional protection rule — an existing `source='ai'` row for the same tag/item is promoted to `system` (never the reverse), and `source='manual'` rows are never overwritten or deleted by the system writer. The `system` value was added in its own migration (`20260705000000_add_media_tag_source_system`) because Postgres cannot add an enum value in the same transaction as statements referencing it. `media_items` also carries burst detection columns: `perceptual_hash` (**TEXT?**, unsigned 64-bit dHash stored as a decimal string — see storage rationale below), `sharpness_score` (Float?, variance-of-Laplacian sharpness measure), `burst_uuid` (String?, Apple BurstUUID from EXIF MakerNote — null for non-Apple cameras), `burst_score` (Float?, composite quality score within the group — null when not in a group), and `burst_group_id` (FK → `burst_groups`, SetNull on delete). `media_items` also carries `duplicate_group_id` (FK → `duplicate_groups`, SetNull on delete) for near-duplicate detection, plus a `(circle_id, perceptual_hash)` index added specifically to serve the duplicate-detection hash-candidate scan. The `perceptual_hash` column is omitted from default API responses via a Prisma global `omit` because it is an internal computation value; the burst matcher (whose Hamming-distance helper is shared with duplicate detection) parses it with `BigInt(string)` only when computing Hamming distance. **Why TEXT and not `bigint`:** Postgres `bigint` is a signed 64-bit integer (max 2^63-1); a dHash is an unsigned 64-bit value and hashes with the high bit set overflow, producing a "value out of range for type bigint" error. Additionally, Prisma maps `BigInt` to JavaScript's `BigInt` primitive, which throws "Do not know how to serialize a BigInt" on `JSON.stringify`, crashing any endpoint that returns the column. Storing the value as a decimal string avoids both problems. `media_items` also carries the archive column: `archived_at` (DateTime?, nullable; null = active/not-archived; non-null = archived). Trash reuses the existing `deleted_at` column (soft-delete). The two states are independent: `deleted_at` for Trash, `archived_at` for Archive. `media_items` also carries `coord_source` (TEXT?, `'exif'` | `'manual'` | `'inferred'`; null = no coordinates) — provenance of `taken_lat`/`taken_lng`, distinct from `geo_source` (which tracks the reverse-geocode *provider/trigger* and is overwritten on every geocode run; a `geocode` job overwriting `geo_source` after a location-inference auto-apply is expected and does not touch `coord_source`). Three writers: EXIF metadata sync (`MediaMetadataSyncService`, present-only — sets `'exif'` only when EXIF actually supplied latitude in that run), `bulkUpdateMedia`'s manual location edit (`'manual'`), and location inference (`'inferred'` for auto-apply/unmodified-accept, `'manual'` for an adjusted accept) — see the [Location Inference spec](docs/specs/location-inference.md). `GEO_CLEAR_COLUMNS` (used whenever a location is cleared) also nulls `coord_source`. `media_items` also carries `social_media_source` (TEXT?, `'tiktok'` | `'instagram'` | `'facebook'` | `'other'`; null = clean/unknown) — written only by the `social_media_detection` enrichment handler and used to gate video enrichment: `VideoFaceDetectionHandler` skips face detection entirely (marking `no_faces`) when this column is non-null, and `FaceBackfillService` excludes flagged videos from its eligibility query. Detaching the "Social Media" tag manually does NOT clear this column — only a detection rerun does; see the [Social Media Detection spec](docs/specs/social-media-detection.md). `media_items` also has a hand-authored, raw-SQL-only partial composite index `media_items_map_locations_idx` (migration `20260713130000_media_locations_index`, not representable in Prisma's schema DSL) serving the `GET /api/media/locations/aggregate` map clustering query.

**AI provider key encryption:** `SECRETS_ENCRYPTION_KEY` (base64-encoded 32-byte AES key) must be set at startup. Generate with `openssl rand -base64 32`. The API fails to start if the variable is missing or incorrectly sized.

## Access Control: Email Allowlist

The application uses an **email allowlist** to restrict access to pre-authorized users only.

### How It Works
1. Admins add email addresses to the allowlist before users can login
2. During OAuth login, the user's email is checked against the allowlist
3. If the email is not in the allowlist, login is denied with a clear error message
4. Exception: `INITIAL_ADMIN_EMAIL` always bypasses the allowlist check

### Configuration
- `INITIAL_ADMIN_EMAIL` environment variable grants initial admin access
- This email is automatically added to the allowlist during database seeding

### Admin Management
- Access allowlist management at `/admin/users` (Allowlist tab)
- Two tabs available:
  - **Users**: Manage existing registered users
  - **Allowlist**: Pre-authorize email addresses for future logins

### Status Tracking
- **Pending**: Email added to allowlist but user hasn't logged in yet
- **Claimed**: User has successfully logged in and created an account
- Claimed entries cannot be removed (prevents accidentally removing existing user access)

## Security Guidelines

- Secrets via environment variables only (see `.env.example`)
- JWT access tokens are short-lived (15 min default)
- Refresh tokens in HttpOnly cookies with rotation
- Input validation on all endpoints
- File uploads: images only, size/type limits, randomized filenames
- Email allowlist restricts application access to pre-authorized users

## Testing Requirements

- Unit tests: isolated logic (services, guards, validators)
- Integration tests: API + DB + RBAC flows with test DB
- Mock OAuth in CI (no real Google dependency)
- Frontend: component and hook tests

## Environment Variables

Key variables (see `infra/compose/.env.example` for full list):

**Application:**
- `NODE_ENV` - Environment (development/production)
- `PORT` - API port (default: 3000)
- `APP_URL` - Base URL (default: http://localhost:3535)

**Database (individual connection parameters):**
- `POSTGRES_HOST` - Database hostname (default: localhost)
- `POSTGRES_PORT` - Database port (default: 5432)
- `POSTGRES_USER` - Database user (default: postgres)
- `POSTGRES_PASSWORD` - Database password (default: postgres)
- `POSTGRES_DB` - Database name (default: appdb)
- `POSTGRES_SSL` - Enable SSL connection (default: false)

Note: `DATABASE_URL` is constructed automatically from these variables at runtime.

**Authentication:**
- `JWT_SECRET` - JWT signing secret (min 32 chars)
- `JWT_ACCESS_TTL_MINUTES` - Access token TTL (default: 15)
- `JWT_REFRESH_TTL_DAYS` - Refresh token TTL (default: 14)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - Google OAuth credentials
- `INITIAL_ADMIN_EMAIL` - First user with this email becomes Admin
- `DEVICE_CODE_EXPIRY_MINUTES` - Device code lifetime (default: 15)
- `DEVICE_CODE_POLL_INTERVAL` - Device polling interval in seconds (default: 5)
- `DEVICE_TOKEN_EXPIRY_DAYS` - Token lifetime for device sessions in days (default: 7)

**Observability:**
- `OTEL_ENABLED` - Enable OpenTelemetry (default: true)
- `OTEL_EXPORTER_OTLP_ENDPOINT` - OTEL Collector endpoint
- `UPTRACE_DSN` - Uptrace connection string

**Geo Services:**
- `GEO_PROVIDER` - Default reverse-geocoding provider used when `system_settings.geo.reverseProvider` is not set: `offline` (default, on-server GeoNames dataset) or `nominatim` (HTTP, sends GPS off-server). **Note:** the active provider is now primarily managed in the Admin Settings → Geo page (`/admin/settings/geo`) and persisted in `system_settings.geo.reverseProvider`. Google Maps is also available as a provider once a Google API key is configured via `PUT /api/geo/credentials/google`. `GEO_PROVIDER` acts as the startup fallback only.
- `NOMINATIM_BASE_URL` - Nominatim endpoint (default: `https://nominatim.openstreetmap.org`)
- `GEO_FORWARD_SEARCH_ENABLED` - Enable `GET /api/media/geo/search` forward geocoding (default: `false`; only typed query leaves server, never GPS). Also configurable at runtime via system setting `geo.forwardSearchEnabled`.
- `GEO_FORWARD_PROVIDER` - Forward geocoding provider: `nominatim` (default, OSM) or `google`; Google option requires `GOOGLE_MAPS_API_KEY`
- `GOOGLE_MAPS_API_KEY` - Google Maps API key for forward geocoding via `GEO_FORWARD_PROVIDER=google`; server-side only, never exposed to clients. For **reverse** geocoding the Google API key is stored encrypted in the `geo_provider_credentials` table and configured via the Admin UI — this env var does not affect reverse geocoding.

**Email:**
- `EMAIL_PROVIDER` - Bootstrap default for `email.provider`: `ses` or `smtp`; only seeds the system setting's default before an explicit value is saved via the admin UI (`/admin/settings/email`)
- `AWS_SES_REGION` - Bootstrap default for `email.sesRegion`; AWS credentials for SES are NOT set via env vars here — they are reused from the S3 storage provider's `storage_provider_credentials` row (see Storage Provider Configuration above)
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USE_TLS` / `SMTP_USERNAME` - Bootstrap defaults for the corresponding `email.smtp*` settings
- `SMTP_PASSWORD` - Bootstrap default for `email.smtpPassword`; encrypted into the setting via `SECRETS_ENCRYPTION_KEY` on first boot, then managed exclusively through the admin UI thereafter
- `EMAIL_FROM_ADDRESS` / `EMAIL_FROM_NAME` - Bootstrap defaults for `email.fromAddress` / `email.fromName`

**AWS SES IAM note:** the AWS IAM user used for S3 storage must additionally have `ses:SendEmail` and `ses:SendRawEmail` permissions for the `ses` provider to work. SES reuse assumes real AWS keys — if the S3 provider points at a non-AWS/custom endpoint (MinIO/R2), `sesCredentialAvailable` is false and SES cannot authenticate. Unverified SES (sandbox) accounts can only send to/from verified identities.

**Face Recognition:**
- `FACE_COMPREFACE_URL` - Base URL of the CompreFace core sidecar (default: `http://compreface-core:3000`); used as the default `baseUrl` for the CompreFace provider. The provider is keyless — no API key is required.
- `FACE_AUTO_DETECT` - Environment kill-switch for auto-enqueue on upload; set to `false` to disable globally regardless of system settings. The runtime toggle is `features.faceRecognition` in system settings; this env var is a hard override for CI/test environments (default: `true`)
- `FACE_JOB_POLL_MS` - Polling interval for the face-job worker in milliseconds (default: `5000`)
- `FACE_WORKER_ENABLED` - Set to `false` to disable the FaceJobWorker (useful in test/CI environments; default: `true`)
- `FACE_MATCH_THRESHOLD` - Cosine-similarity threshold for assigning a detected face to a known `Person` (default: `0.38`)
- `FACE_CLUSTER_THRESHOLD` - Cosine-similarity threshold for grouping unknown faces during clustering (default: `0.45`; stricter than match threshold)
- `FACE_CLUSTER_MIN_SIZE` - Minimum cluster size to create a provisional Person; singletons remain unknown (default: `2`)
- `FACE_VECTOR_BACKEND` - Vector storage and matching backend: `pgvector` (default; indexed KNN candidate selection via the `faces.embedding_vec` HNSW index, requires the pgvector extension) or `app` (`Float[]` column + in-process cosine scan; one-release rollback option)
- `FACE_MATCH_KNN_CANDIDATES` - Number of nearest-neighbor candidate faces fetched from the pgvector HNSW index before the bounded centroid recompute (person match) or nearest-archive pick (archive match); `hnsw.ef_search` is raised to `max(100, this value)` per query (default: `40`)
- `FACE_AUTO_ARCHIVE` - Environment kill-switch for the auto-archive-on-match feature; set to `false` to disable globally regardless of system settings. The runtime toggle is `features.faceAutoArchive` in system settings; this env var is a hard override for CI/test environments (default: `true`)
- `FACE_ARCHIVE_MATCH_THRESHOLD` - Cosine-similarity threshold for auto-archiving a face that matches a previously-archived (hidden, unassigned) face; seeds `face.autoArchive.matchThreshold`'s default before an explicit value is saved via the admin UI (default: `0.45`)
- `FACE_ARCHIVE_MAX_CANDIDATES` - Maximum archived faces loaded per circle as the reference set for archive matching (detection-time, retroactive sweep, and admin backfill all share this cap); bounds memory to `cap × embeddingDim × 8 bytes` (default: `5000`)

**Auto-Tagging and Semantic Search:**
- `AUTO_TAG_ENABLED` - Environment kill-switch for auto-enqueue on upload; set to `false` to disable globally regardless of system settings. The runtime toggle is `features.autoTagging` in system settings; this env var is a hard override for CI/test environments (default: `true`)
- `TAG_MAX_IMAGE_DIM` - Maximum image long-edge in pixels before downscaling prior to the vision model call; 1568 matches Anthropic's auto-downscale threshold (default: `1568`)

Note: Semantic search (pgvector embeddings) requires a pgvector-capable Postgres image (`pgvector/pgvector:pg16`). The embedding feature is configured in the Admin UI via `PUT /api/ai/features/embedding` — only OpenAI supports `embedText` (`text-embedding-3-small` recommended). If the embedding feature is not configured, `semanticQuery` silently falls back to filter-only search.

Note: The enrichment worker shared by face detection, storage insights computation, auto-tagging, metadata re-extraction, and trash purge is controlled by `ENRICHMENT_WORKER_ENABLED` (default: `true`), `ENRICHMENT_JOB_POLL_MS` (default: `5000`), and `ENRICHMENT_WORKER_CONCURRENCY` (default: `1`). The legacy `FACE_WORKER_ENABLED` and `FACE_JOB_POLL_MS` aliases are still respected for backward compatibility. The `metadata_extraction` job type re-runs the `exif`, `dimensions`, `geocode`, and `video-probe` processors and syncs typed columns directly WITHOUT emitting `OBJECT_PROCESSED_EVENT`, so it does not cascade to auto-tagging, face detection, or burst detection. There is no upload-time enqueue and no per-circle opt-in for metadata extraction. Per-item rerun remains available to circle collaborators; global backfill is now an admin-only endpoint (`POST /api/admin/metadata/backfill`). The `trash_purge` job type is a global job (`mediaItemId: null`, `circleId: null`) that hard-deletes trashed items past the retention cutoff; it is enqueued by an hourly cron and never triggered on upload or by a user rerun.

Note: The rate-limit classifier (`classifyRateLimit`) treats HTTP 429 **and** HTTP 529 (Anthropic "Overloaded") as rate-limit signals that route to the deferral path rather than the normal-failure retry path. `geocode` jobs now **defer** when the active provider signals quota exhaustion (Google `OVER_QUERY_LIMIT` / `RESOURCE_EXHAUSTED`, Nominatim HTTP 429 / 5xx) instead of returning null and being marked `processed` with no geo data. This means items with GPS coordinates will always be retried until geo data is written successfully.

**Upload enrichment trigger:** `MediaService.createMedia` calls `MediaEnrichmentService.enqueueUploadEnrichment(...)` synchronously before returning 201, so `face_detection`, `auto_tagging`, `burst_detection`, `duplicate_detection`, and `location_inference` job rows exist in the database before any client receives a response — eliminating the timing gap that previously caused CLI uploads to miss enrichment jobs. A single `MediaEnrichmentEnqueueListener` on `OBJECT_PROCESSED_EVENT` acts as an idempotent backstop for any path where processing completes after item registration. Each job type is gated by its global feature flag (`features.faceRecognition`, `features.autoTagging`, `features.burstDetection`, `features.duplicateDetection`, `features.locationInference`, all default off) plus its env kill-switch; clients never enqueue enrichment directly. Metadata columns (`capturedAt`, dimensions, geo) are synced separately via `MediaMetadataSyncService` and are not part of this trigger. Feature flags are read through a single cached `SystemSettingsService.getSettings()` call per upload (5-second TTL cache) to avoid per-upload DB hits during bulk imports.

**Enrichment retry and rate-limit backoff:**
- `ENRICHMENT_MAX_ATTEMPTS` - Maximum processing attempts before a job is permanently failed (default: `3`)
- `ENRICHMENT_RETRY_BASE_MS` - Base backoff delay in ms for the first normal-error retry; equal-jitter exponential (default: `2000`)
- `ENRICHMENT_RETRY_MAX_MS` - Maximum backoff cap in ms for normal-error retries (default: `60000`)
- `ENRICHMENT_RATELIMIT_BASE_MS` - Base backoff delay in ms for the first rate-limit deferral (default: `30000`)
- `ENRICHMENT_RATELIMIT_MAX_MS` - Maximum backoff cap in ms for rate-limit deferrals (default: `900000`, i.e. 15 minutes)
- `ENRICHMENT_RATELIMIT_MAX_HITS` - Maximum rate-limit deferrals before a job is permanently failed; tracked separately from `ENRICHMENT_MAX_ATTEMPTS` (default: `10`)
- `ENRICHMENT_JOB_TIMEOUT_MS` - Active per-job execution timeout in ms applied to all job types except the two video types below; a handler running longer is aborted, its worker slot freed, and the job routed through the normal-failure retry path; `0` disables (default: `600000`, i.e. 10 minutes)
- `ENRICHMENT_VIDEO_JOB_TIMEOUT_MS` - Per-type execution-timeout override for the `video_face_detection` and `social_media_detection` job types; every other type keeps using `ENRICHMENT_JOB_TIMEOUT_MS`; `0` disables the timeout for these types (default: `1200000`, i.e. 20 minutes). Video enrichment legitimately runs far longer than the global default on low-compute VPSes — a multi-GB download plus ffmpeg frame extraction plus per-frame provider calls routinely exceeds 10 minutes — and the queue's design goal is slow-but-alive over crashing, so these types get a wider budget instead of being killed as "hung"
- `VIDEO_ENRICHMENT_MAX_BYTES` - Optional hard cap (bytes) on the size of videos processed by BOTH `video_face_detection` and `social_media_detection`; a single shared knob for both handlers. `0` (default) disables the cap. An over-cap video is skipped WITHOUT downloading a single byte — video face detection marks the item `no_faces`; social-media detection routes through its clean/skip path (recorded as `matchedRule: skip-size-cap`, downstream video enrichment still fanned out) (default: `0`)
- `ENRICHMENT_STUCK_MINUTES` - **Legacy fallback only.** The stuck-job threshold is now the runtime `jobs.stuckThresholdMinutes` system setting (see Job History Retention below); this env var seeds that setting's default (clamped to 120) only until an explicit value is saved via the admin UI, after which it has no effect. `attempts` is now charged at CLAIM time (see the `enrichment_jobs` table note below), so a job that takes the whole process down (OOM SIGKILL) still consumes its attempt: the automatic stuck-job reset cron (`EnrichmentStuckResetTask`, runs every 10 min) and `POST /api/admin/jobs/reset-stuck` now mark a stuck `running` job **failed** once `attempts >= ENRICHMENT_MAX_ATTEMPTS` instead of requeueing it, bounding a poison-pill/OOM job to `ENRICHMENT_MAX_ATTEMPTS` container crashes rather than an infinite crash loop; jobs still under budget (including zombie rows with `startedAt IS NULL`, aged by `createdAt`) are reset to `pending` so the worker can re-claim them. Rate-limit deferrals do NOT consume an attempt. `resetStuck` returns `{ reset, failed }`. The threshold must exceed the longest expected single-job runtime
- `ENRICHMENT_LEASE_MS` - Lease duration in ms granted to a job at claim time, both for the in-process worker (`EnrichmentClaimService`) and for distributed worker nodes claiming via `POST /api/nodes/:id/claim` (default: `1800000`, i.e. 30 minutes); a node extends its lease with `POST /api/nodes/:id/jobs/:jobId/renew` before it expires, and the stuck-reset reaper requeues jobs whose `lease_expires_at` has passed without a renewal or completion — see the [Distributed Nodes spec](docs/specs/distributed-nodes.md)

**Storage object processing recovery** (separate from the `enrichment_jobs` queue above — this covers the content-hash/exif/dimensions/video-probe/geocode/thumbnail/visual-hash pipeline that runs synchronously in-process off `OBJECT_UPLOADED_EVENT`, not a queued job type). Video downloads in `video-probe` and thumbnail generation now **stream to a temp file with constant memory** instead of buffering the whole video in RAM — this was the primary OOM source on memory-constrained VPS deployments before this fix. Frame extraction is a three-attempt fallback ladder (seek 1s → seek 0s → ffmpeg `thumbnail` filter), each attempt's output validated non-empty since ffmpeg can exit `0` without writing a frame, and both ffmpeg and ffprobe calls are bounded by hard timeouts (`FFMPEG_TIMEOUT_MS`, `FFPROBE_TIMEOUT_MS`) so a hung process no longer blocks a worker slot indefinitely:
- `STORAGE_PROCESSING_STUCK_MINUTES` - Threshold in minutes for `StorageProcessingRecoveryTask` (runs every 10 min, mirrors `EnrichmentStuckResetTask`); `StorageObject` rows stuck at `status='processing'` beyond this threshold — left behind when the API process is OOM-killed, crashed, or restarted mid-pipeline — are re-processed automatically (default: `10`)
- `STORAGE_PROCESSING_MAX_RETRIES` - Maximum automatic recovery attempts per object, tracked in `StorageObject.metadata._processingRetryCount`; an object that exhausts the cap is marked `status='failed'` instead of retried further (default: `3`)
- `STORAGE_PROCESSING_STUCK_RESET_ENABLED` - Set to `false` to disable the recovery cron (default: `true`)
- `FFMPEG_TIMEOUT_MS` - Hard timeout in ms before an in-flight ffmpeg frame-extraction is killed with `SIGKILL` (default: `60000`)
- `FFPROBE_TIMEOUT_MS` - Hard timeout in ms before an in-flight ffprobe call is killed (default: `30000`)
- `THUMBNAIL_REPAIR_ENABLED` - Set to `false` to disable the hourly `ThumbnailRepairTask` cron (default: `true`)
- `THUMBNAIL_REPAIR_BATCH_SIZE` - Maximum number of media items repaired per cron run, processed sequentially (default: `25`)
- `THUMBNAIL_REPAIR_MAX_ATTEMPTS` - Maximum repair attempts per item, tracked in `StorageObject.metadata._thumbnailRepairAttempts`; an item that exhausts the cap sets `_thumbnailRepairExhausted` instead of retrying further (default: `3`)
- `THUMBNAIL_REPAIR_MIN_AGE_MINUTES` - Minimum age of the underlying `StorageObject` before it becomes eligible for repair, so freshly-uploaded objects aren't raced against normal processing (default: `30`)

Two further guards protect the video-enrichment download path (`video_face_detection` / `social_media_detection`), which stream multi-GB videos to a `memoriaHub-*` temp file in `os.tmpdir()`:
- **Disk-space pre-flight guard** (`assertDiskSpaceForDownload`, in `stream-utils.ts`): before a video download, the handler `statfs`-checks the temp filesystem and requires free space `>= object size × 1.2` (20% headroom). When the disk cannot hold the download, the job fails fast through the normal retry/backoff path instead of filling the disk with a partial temp file — no env var, the headroom factor is fixed.
- **Temp-file janitor** (`TempFileJanitorTask`): on startup and every hour, sweeps `os.tmpdir()` for `memoriaHub-*` files older than 6h (mtime) and deletes them, cleaning orphans left behind when a job is SIGKILLed (e.g. OOM) mid-download before its `finally`-block cleanup runs. Best-effort per-file; only active on worker instances — it respects the same `ENRICHMENT_WORKER_ENABLED=false` disable flag as the worker, since only worker instances create these files.

**Bulk Import Tuning:**

When importing thousands of photos onto a VPS with limited RAM, tune these settings to keep enrichment stable:

- `ENRICHMENT_WORKER_CONCURRENCY` — keep at 1 for AI-bound work (auto-tagging, face detection) during the initial import; the new per-provider throttle gate makes higher values safe once you confirm throughput is stable, but each concurrent job buffers a full decoded image in memory.
- `NODE_OPTIONS=--max-old-space-size=<MB>` — set to leave headroom above the Node.js heap default (e.g. `--max-old-space-size=512` on a 1 GB VPS); image handlers buffer the full image per job, so heap pressure scales with concurrency.
- `TAG_MAX_IMAGE_DIM` / `FACE_MAX_IMAGE_DIM` — reduce from the default 1568 to 768–1024 on memory-constrained hosts; lower resolution reduces per-job peak memory at the cost of slightly lower tagging accuracy.
- `VIDEO_ENRICHMENT_MAX_BYTES` — set a byte cap to skip huge videos entirely (no download) in both `video_face_detection` and `social_media_detection`; the single biggest disk/memory offender during a bulk import is a multi-GB video download, and a cap keeps the temp filesystem from filling. `0` (default) processes all sizes. The disk-space pre-flight guard above is the fail-safe for videos under the cap.
- `ENRICHMENT_VIDEO_JOB_TIMEOUT_MS` — the video job types get their own, longer execution-timeout budget (default 20 min vs. the 10-min `ENRICHMENT_JOB_TIMEOUT_MS` global) because a legitimate multi-GB video download + ffmpeg + per-frame provider run routinely exceeds the global default on a slow VPS; raise it further if large videos are being killed as "timed out" mid-flight, or set `0` to disable the timeout for video jobs entirely.
- `ENRICHMENT_RATELIMIT_MAX_HITS` / `ENRICHMENT_RATELIMIT_MAX_MS` — raise for very large runs where a single provider quota window may take hours to recover; the defaults (10 hits, 15 min max) are designed for short bursts, not sustained 10 000-item backfills.
- `jobs.stuckThresholdMinutes` (system setting, not an env var — see Job History Retention below) — raise above the default 3 minutes if you are using a slow face provider or other handler where single-item processing legitimately takes longer than that; a value too low will reset legitimately-running jobs, which can then be re-claimed and run a second time concurrently with the original. `ENRICHMENT_STUCK_MINUTES` remains as a legacy env-var fallback that only seeds this setting's default.
- `STORAGE_PROCESSING_STUCK_MINUTES` / `STORAGE_PROCESSING_MAX_RETRIES` — the thumbnail/EXIF/dimensions pipeline is a separate recovery path from the enrichment settings above; if an OOM incident during a bulk import leaves photos stuck without thumbnails, `StorageProcessingRecoveryTask` auto-recovers them within this threshold — no manual intervention needed for the common case, but `POST /api/admin/media/reprocess-stuck` triggers it immediately if you don't want to wait for the next tick.

See [Bulk Import Resilience](docs/specs/bulk-import-resilience.md) for the full provider rate-limit classification matrix, stuck-job recovery runbook, and CLI durable resume details. For **memory sizing on a cheap/constrained VPS** — the V8-heap-vs-off-heap model, why bulk imports OOM-loop, the `--max-old-space-size` / concurrency / `*_MAX_IMAGE_DIM` levers, per-container-size presets, `dmesg` OOM diagnosis, and real ~20k-job throughput/failure numbers — see [Bulk Uploads on a Cheap VPS](docs/specs/bulk-upload-vps-tuning.md).

**Storage (S3 / Cloudflare R2):**
- `S3_MAX_ATTEMPTS` - Maximum SDK-level retry attempts for server-initiated S3 operations (upload, complete multipart, signed-URL generation, download, delete, head); does not cover presigned part PUTs which are retried client-side by the CLI (default: `5`)
- `S3_RETRY_MODE` - AWS SDK v3 retry strategy: `adaptive` (default; uses client-side congestion control that backs off on S3 `503 SlowDown` and R2 `429`), `standard`, or `legacy`
- `S3_ENDPOINT` - S3-compatible endpoint URL; set to the Cloudflare R2 endpoint (e.g. `https://<account>.r2.cloudflarestorage.com`) to use R2 instead of AWS S3; adaptive retry handles R2 HTTP 429 and S3 503 SlowDown transparently

Note: Storage provider credentials (S3, R2, local) are now configurable in the Admin UI under Storage Providers. The `S3_*` environment variables and `STORAGE_PROVIDER` serve as bootstrap defaults and fallback for objects created before Admin UI configuration. The active provider for new uploads is controlled by the `storage.activeProvider` system setting (string; default: env `STORAGE_PROVIDER` or `'s3'`); switching the active provider affects new uploads only — existing objects are NOT migrated automatically.

**Burst Detection:**
- `BURST_DETECTION_ENABLED` - Environment kill-switch for auto-enqueue on upload; set to `false` to disable `BurstEnqueueListener` regardless of system settings. The runtime toggle is `features.burstDetection` in system settings; this env var is a hard override for CI/test environments (default: `true`)

The following burst detection parameters are controlled via system settings (not environment variables), editable in the Admin UI under `burst.*`:
- `burst.timeGapSeconds` — integer, 1–300, default 10; maximum capture-time gap (seconds) between consecutive items from the same device for temporal proximity to apply
- `burst.hashDistance` — integer, 0–32, default 10; maximum Hamming distance (bits, out of 64) for two items to be considered visual near-duplicates
- `burst.minGroupSize` — integer, 2–20, default 3; minimum number of items required for a group to be surfaced in the review queue
- `burst.autoResolveThreshold` — integer, 0–100, default 60; score at/above which the burst review page's "Archive above N"/"Delete above N" buttons resolve pending groups via `POST /api/media/bursts/bulk/resolve-by-threshold`

**Duplicate Detection:**
- `DUPLICATE_DETECTION_ENABLED` - Environment kill-switch for auto-enqueue on upload; set to `false` to disable the upload-time `duplicate_detection` enqueue regardless of system settings. The runtime toggle is `features.duplicateDetection` in system settings; this env var is a hard override for CI/test environments (default: `true`)
- `MODELS_DIR` - Persistent-volume directory the CLIP ViT-B/32 ONNX vision model (`onnxruntime-node`, int8-quantized, 512-d, ~87 MB) is downloaded to on first use and loaded from thereafter; mount as a Docker volume in production so the model survives container recreation (default: `./data/models`). For air-gapped installs, place the model file manually at `MODELS_DIR/clip-vit-b32-vision-quantized.onnx` before starting the API. If the model cannot be downloaded/loaded, the feature runs in degraded (dHash-only) mode rather than failing jobs — see [Duplicate Detection spec](docs/specs/duplicate-detection.md).

The following duplicate-detection parameters are controlled via system settings (not environment variables), editable in the Admin UI under `dedup.*`:
- `dedup.similarityThreshold` — number, 0.80–0.995, default 0.96; minimum CLIP cosine similarity for two photos to be linked as duplicates
- `dedup.hashMaxDistance` — integer, 0–16, default 6; maximum dHash Hamming distance (bits, out of 64) for two photos to be linked as duplicates
- `dedup.knnCandidates` — integer, 5–50, default 20; number of nearest-neighbor candidates fetched per item from the pgvector HNSW index before threshold filtering
- `dedup.autoResolveThreshold` — integer, 0–100, default 60; score at/above which the duplicate review page's "Archive above N"/"Delete above N" buttons resolve pending groups via `POST /api/media/duplicates/bulk/resolve-by-threshold`

**Location Inference:**
- `LOCATION_INFERENCE_ENABLED` - Environment kill-switch for auto-enqueue on upload; set to `false` to disable the upload-time `location_inference` enqueue regardless of system settings. The runtime toggle is `features.locationInference` in system settings; this env var is a hard override for CI/test environments (default: `true`)

The following location-inference parameters are controlled via system settings (not environment variables), editable in the Admin UI under `locationInference.*`; see the [Location Inference spec](docs/specs/location-inference.md) for the full algorithm this configures:
- `locationInference.maxGapMinutes` — integer, 1–1440, default 30; maximum time gap (either side) for a two-anchor interpolation window
- `locationInference.maxExtrapolationGapMinutes` — integer, 1–240, default 10; maximum time gap for the single-anchor (extrapolation) case — the ExifTool `GeoMaxExtSecs` analog; tighter than `maxGapMinutes` by design
- `locationInference.autoApplyMaxGapMinutes` — integer, 0–60, default 5; maximum gap (both sides) for auto-apply eligibility; `0` disables auto-apply while still generating review-queue suggestions
- `locationInference.requireSameDevice` — boolean, default true; when true, anchors must share the target's camera make/model and auto-apply is possible; when false, cross-device anchors are allowed but results are always suggestion-only (never auto-applied)
- `locationInference.maxAnchorDistanceKm` — number, 0.1–100, default 2; maximum distance between two anchors for them to be considered "agreeing" (interpolation vs. nearer-in-time fallback; also an auto-apply gate)
- `locationInference.maxImpliedSpeedKmh` — number, 10–1000, default 150; ceiling on implied travel speed between anchors; exceeding it caps confidence at 0.4 and blocks auto-apply

**Social Media Detection:**

- `SOCIAL_MEDIA_DETECTION_ENABLED` - Environment kill-switch for auto-enqueue on video upload; set to `false` to disable regardless of system settings. The runtime toggle is `features.socialMediaDetection` in system settings; this env var is a hard override for CI/test environments (default: `true`). When disabled, videos fall back to the legacy direct `video_face_detection` enqueue path.

The following social-media-detection parameters are controlled via system settings (not environment variables), editable in the Admin UI under `socialMedia.*`; see the [Social Media Detection spec](docs/specs/social-media-detection.md) for the full two-tier algorithm this configures:
- `socialMedia.ocrEnabled` — boolean, default true; whether the Tier-2 OCR fallback runs at all; when false the feature is Tier-1-only (metadata/filename) even when Tier 1 recommends OCR
- `socialMedia.ocrLanguages` — string array, 1–5 entries, default `['eng']`; tesseract language codes to load
- `socialMedia.ocrMaxFrames` — integer, 2–6, default 4; hard cap on frames OCR'd per video
- `socialMedia.ocrTimeoutSeconds` — integer, 10–300, default 60; soft timeout for the whole OCR phase; partial results are kept on timeout
- `socialMedia.minConfidence` — number, 0.5–1.0, default 0.8; decision threshold shared by both tiers — the minimum confidence a Tier-1 or Tier-2 candidate must meet to classify a video as detected
- `socialMedia.maxDurationSeconds` — integer, 60–3600, default 300; a video longer than this is treated as CLEAN without downloading or OCR'ing a single byte — genuine social-media clips never exceed ~5 minutes. Recorded in `media_social_status.matchedRule` as `skip-duration-cap`
- `socialMedia.maxSizeBytes` — integer, min 10_000_000, default 500_000_000 (500 MB); size fallback used only when the video's duration is unknown (no persisted ffprobe metadata) — an over-cap video is treated as CLEAN, `matchedRule: skip-size-cap`. (The separate `VIDEO_ENRICHMENT_MAX_BYTES` env var is an unconditional hard cap checked first and shared with video face detection; this setting is the duration-unknown fallback specific to social-media detection)

> **Cap + orientation ordering:** the two size/duration caps are checked FIRST (cheapest — no download), then the **orientation gate**: a strictly-landscape video (width > height) is never downloaded for this job. TikTok/Instagram videos are never landscape; Facebook can be, but landscape FB re-shares are accepted as covered by the Tier-1 filename/metadata rules alone. A landscape video therefore runs Tier-1 on its filename + whatever metadata is already persisted, skips the legacy re-probe download, and never runs Tier-2 OCR — a deliberate precision-over-compute tradeoff (a landscape clip detectable only via watermark OCR is missed). See the [Social Media Detection spec](docs/specs/social-media-detection.md).

**Feature Toggles (System Settings):**

These boolean system settings replace the former per-circle feature columns dropped in migration `20260621050000_drop_circle_feature_flags`. Editable in Admin Settings (`/admin/settings/*`).
- `features.autoTagging` — boolean, default false; global on/off for AI auto-tagging; env `AUTO_TAG_ENABLED=false` overrides this
- `features.faceRecognition` — boolean, default false; global on/off for face detection and recognition; env `FACE_AUTO_DETECT=false` overrides this
- `features.burstDetection` — boolean, default false; global on/off for burst photo detection; env `BURST_DETECTION_ENABLED=false` overrides this
- `features.duplicateDetection` — boolean, default false; global on/off for near-duplicate photo detection; env `DUPLICATE_DETECTION_ENABLED=false` overrides this
- `features.locationInference` — boolean, default false; global on/off for GPS-from-timeline location inference; env `LOCATION_INFERENCE_ENABLED=false` overrides this
- `features.socialMediaDetection` — boolean, default false; global on/off for social-media video detection (TikTok/Instagram/Facebook re-upload classification); env `SOCIAL_MEDIA_DETECTION_ENABLED=false` overrides this
- `features.faceAutoArchive` — boolean, default false; global on/off for auto-archiving a newly-detected unassigned face that matches a previously-archived face; env `FACE_AUTO_ARCHIVE=false` overrides this; see `face.autoArchive.matchThreshold` below and the [Face Recognition spec](docs/specs/face-recognition.md)

**Video Face Detection Settings (System Settings):**

Controlled via `face.video.*` in system settings, editable in Admin Settings → Face (`/admin/settings/face`). All three settings require `features.faceRecognition=true` to have any effect.
- `face.video.enabled` — boolean, default true; when false, video uploads are skipped (job marks `no_faces` immediately)
- `face.video.sampleIntervalSeconds` — integer, 1–60, default 5; desired gap between sampled frames in seconds; the actual interval expands automatically when the video is long enough that `durationSec / maxFramesPerVideo` exceeds this value
- `face.video.maxFramesPerVideo` — integer, 1–300, default 60; hard cap on frames extracted per video; combined with `sampleIntervalSeconds` this bounds compute per video (e.g. a 1-hour video at cap 60 produces one frame every ~60 s)

**Face Auto-Archive Settings (System Settings):**

Requires `features.faceAutoArchive=true` to have any effect. Editable in Admin Settings → Face (`/admin/settings/face`).
- `face.autoArchive.matchThreshold` — number, 0.30–0.90, default 0.45; cosine-similarity threshold for auto-archiving a face against the circle's archived (hidden, unassigned) face pool. Deliberately the same value as `DEFAULT_FACE_CLUSTER_THRESHOLD` (face-to-face pairwise geometry) and stricter than the 0.38 face-to-centroid `FACE_MATCH_THRESHOLD`, since auto-archive is a silent action and biases toward precision over recall.

**Geo Settings (System Settings):**

The geo provider is now configurable at runtime in addition to the env vars (env vars remain as fallback defaults):
- `geo.provider` — string `'offline'` | `'nominatim'`, default resolved from `GEO_PROVIDER` env var; editable in `/admin/settings/geo`
- `geo.forwardSearchEnabled` — boolean, default resolved from `GEO_FORWARD_SEARCH_ENABLED` env var; editable in `/admin/settings/geo`

**Email Settings (System Settings):**

Stored under the `email.*` namespace in `system_settings` JSONB; editable in Admin Settings → Email (`/admin/settings/email`).
- `email.provider` — `'ses'` | `'smtp'` | `null`, default `null`; selects the active transactional email provider
- `email.enabled` — boolean, default false; global on/off for sending circle-invitation and membership-confirmation emails
- `email.sesRegion` — string, nullable; AWS region used for SES sends. AWS credentials themselves are NOT stored here — when `provider='ses'`, credentials are read from `storage_provider_credentials` (provider='s3'), reusing the S3 storage provider's AWS keys rather than duplicating a credential
- `email.smtpHost`, `email.smtpPort` (default 587), `email.smtpUseTls` (default true), `email.smtpUsername` — SMTP connection settings for the `smtp` provider (nodemailer; Gmail/M365/SendGrid/Mailgun/WorkMail/Custom presets)
- `email.smtpPassword` — **AES-256-GCM encrypted at rest via `SECRETS_ENCRYPTION_KEY`** (the same key used for AI/Face/Storage/Geo provider credentials); redacted from the generic `GET /api/system-settings` response; surfaced only masked (last-4) via `GET /api/email-settings` as `smtp.passwordLast4`
- `email.fromAddress`, `email.fromName` — sender identity used on outgoing mail

Two transactional emails are driven by this configuration: circle invitation (on `POST /api/circles/:id/invites`) and circle membership confirmation (on member-add / invite-claim). Both are fire-and-forget — a failed send never blocks or fails the triggering user action — and gracefully no-op when `email.enabled` is false or `email.provider` is unset.

**Storage Insights:**

The refresh cadence for the precomputed storage metrics snapshot is controlled via a system setting (not an environment variable):

- `storage.insights.refreshIntervalHours` — integer, 1–168, default 4; editable in the System Settings admin page. Controls how many hours must elapse between automatic cron-driven refreshes. The cron (`InsightsRefreshTask`) fires every hour; when the configured interval has elapsed (and no `storage_insights` job is already pending/running), it **enqueues** a `storage_insights` enrichment job at priority 100 (low priority, background). Computation is performed asynchronously by the enrichment worker with up to 3 retries. Manual refreshes via `POST /api/admin/insights/refresh` enqueue a job at priority 0 (highest priority, pre-empts the scheduled job) and return immediately — they do not wait for the compute to finish.

**Trash:**

- `storage.trash.retentionDays` — integer, 1–365, default 30; editable in the System Settings admin page. Controls how many days trashed items are kept before automatic permanent deletion. The hourly cron (`TrashPurgeTask`) enqueues a global `trash_purge` enrichment job (priority 100, `mediaItemId: null`, `circleId: null`) whenever no such job is already pending or running. The worker hard-deletes all `media_items` where `deletedAt IS NOT NULL AND deletedAt < now() - retentionDays * 86400s`, including their linked S3 blobs, using `MediaService.purgeMediaItems`. The job is visible in the `/admin/jobs` dashboard under `type='trash_purge'`.

**Job History Retention:**

- `jobs.history.retentionDays` — integer, 1–365, default 30; editable in the System Settings admin page. Controls how many days of terminal `enrichment_jobs` rows (`status IN (succeeded, failed)`) are retained before nightly purge. Pending and running rows are never deleted regardless of age.
- `jobs.history.purgeEnabled` — boolean, default true; editable in the System Settings admin page. When false, the nightly `JobHistoryPurgeTask` cron does not enqueue a purge job — useful when preserving full job history for forensic investigation. The nightly cron (`JobHistoryPurgeTask`) runs `@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)`; when enabled and no `job_history_purge` job is already pending or running, it enqueues a global `job_history_purge` enrichment job at priority 100. The handler batch-deletes eligible rows in 5 000-row chunks (lock-safe) and is visible in the `/admin/jobs` dashboard under `type='job_history_purge'`. See [Job Queue Insights spec](docs/specs/job-insights.md) for the full retention model.
- `jobs.stuckThresholdMinutes` — integer, 1–120, default **3**; editable in the System Settings admin page (jobs section, next to job history retention). Shared by `GET /api/admin/jobs/stats` (`stuckRunning`/`stuckThresholdMinutes`), `POST /api/admin/jobs/reset-stuck` (its default when `olderThanMinutes` is omitted), and the `EnrichmentStuckResetTask` cron — a `running` enrichment job (including a zombie row with `startedAt IS NULL`, aged by `createdAt` instead) older than this threshold is treated as stuck and auto-reset to `pending`. Falls back to the legacy `ENRICHMENT_STUCK_MINUTES` env var (clamped to 120) only to seed the setting's default before it has ever been explicitly saved. **Must exceed the longest legitimate single-job runtime** — too low a value resets still-running jobs and can cause the same job to be claimed and run twice concurrently.

## Common Patterns

### Adding a New API Endpoint
1. Create controller method with decorators for auth/RBAC
2. Add service method with business logic
3. Update OpenAPI annotations
4. Add unit + integration tests
5. Update API.md if needed

### Adding a New Setting
1. Update Zod schema for validation
2. Add migration if schema structure changes
3. Update TypeScript types
4. Add frontend UI if user-facing

### Writing an Image Enrichment Handler
- Always obtain pixels via `prepareImageForProcessing` (`apps/api/src/storage/processing/image-orientation.util.ts`) — never decode raw bytes directly — so EXIF orientation is applied before processing.
- An `ObjectProcessor` can be marked `optional: true` (currently only `video-probe`); an optional processor's failure is recorded to `_processing.<name>_error` but no longer flips the whole `StorageObject` to `status='failed'` as long as a non-optional processor (e.g. thumbnail generation) still succeeded — so a video with a broken probe but a working thumbnail is still usable.

### Gotchas / Lessons Learned

- **Never store an unsigned 64-bit value in a Postgres `bigint` / Prisma `BigInt` column.** Postgres `bigint` is signed (max 2^63-1); values with the high bit set overflow with "value out of range for type bigint". Use a `TEXT` column (decimal or hex string) or the `numeric` type instead. Parse back to `BigInt()` in application code only where arithmetic is needed.
- **`BigInt` is not JSON-serializable.** `JSON.stringify` throws "Do not know how to serialize a BigInt" for any object that contains a JS `BigInt`. Never return a Prisma `BigInt` column directly in an API response. Store large integers as strings, and/or use a Prisma global `omit` to keep internal-only columns out of default selects so they cannot accidentally leak into response serialization.
- **Public shares proxy raw bytes — EXIF/GPS is NOT stripped at the file level.** `GET /api/public/shares/:token/media/:idx` streams raw original bytes from storage. The API response contains no metadata fields and no download link, but the file itself may contain embedded EXIF including GPS. If file-level stripping is required, pipe the stream through `apps/api/src/storage/processing/` before sending. See [Public Sharing spec](docs/specs/public-sharing.md).

## Feature Specifications

Detailed specs live under `docs/specs/`:
- [Enrichment Queue](docs/specs/enrichment-queue.md) — worker lifecycle, retry, priority, adding new handlers
- [Face Recognition](docs/specs/face-recognition.md) — face detection (photos + videos), video frame sampling, cross-frame dedup, recognition, clustering, people management, global feature toggle, global admin backfill
- [AI Auto-Tagging](docs/specs/auto-tagging.md) — vocabulary-driven vision model tagging, description generation, global feature toggle, global admin backfill, embedding step
- [Semantic Search](docs/specs/semantic-search.md) — pgvector embedding storage, KNN-then-filter algorithm, `semanticQuery` param, graceful degradation, backfill and re-embed on people change
- [Agentic Search](docs/specs/agentic-search.md) — stateless agentic search, SSE streaming, tool-call protocol
- [Storage Insights](docs/specs/storage-insights.md) — precomputed global storage metrics, snapshot lifecycle, interval-gated cron, admin dashboard
- [Burst Photo Detection](docs/specs/burst-detection.md) — on-server dHash + temporal proximity grouping, best-shot scoring, non-destructive review queue, global feature toggle, global admin backfill with optional capturedAt range and on-demand retroactive perceptual hashing
- [Metadata Extraction Re-run](docs/specs/metadata-rerun.md) — on-demand per-item rerun and global admin backfill of EXIF/dimensions/geocode/video-probe processors via enrichment queue; direct column sync without cascading to tagging, face, or burst
- [Geocoding](docs/specs/geocoding.md) — three-provider reverse-geocoding model (offline/nominatim/google), dynamic provider resolution via system setting, encrypted Google credential store, geocode enrichment job type, media_geocode_status lifecycle, app-wide admin backfill
- [Archive & Trash Bin](docs/specs/archive-trash.md) — two independent soft-state columns (`archivedAt` / `deletedAt`), search-inclusion asymmetry, automatic purge via `trash_purge` enrichment job, dedup-on-restore conflict handling
- [Storage Provider Configuration](docs/specs/storage-providers.md) — multi-provider credential management, per-object routing with env fallback, copy-only migration model, active-provider selection
- [Bulk Import Resilience](docs/specs/bulk-import-resilience.md) — dual-path retry model, per-provider throttle gate, stuck-job auto-reset cron, provider rate-limit classification matrix, CLI durable multipart resume, PAT pre-flight, recovery runbook
- [Bulk Uploads on a Cheap VPS](docs/specs/bulk-upload-vps-tuning.md) — operator runbook for memory-constrained bulk imports: V8-heap-vs-off-heap memory model, why bulk imports OOM-loop, the `--max-old-space-size` / `ENRICHMENT_WORKER_CONCURRENCY` / `*_MAX_IMAGE_DIM` levers, per-container-size presets, `dmesg` OOM diagnosis, post-run recovery, and reference throughput/failure numbers from a real ~20k-job import
- [Job Queue Insights](docs/specs/job-insights.md) — on-demand live aggregate, lock-safety rationale, ETA formula and basis semantics, web dashboard, CLI TUI, nightly job_history_purge retention model
- [Public Media Sharing](docs/specs/public-sharing.md) — token-based unauthenticated access, byte-proxy rationale, metadata-stripping contract, EXIF/GPS limitation, RBAC, enumeration-resistant 404 policy, archived/trashed item handling
- [Near-Duplicate Detection](docs/specs/duplicate-detection.md) — two-tier CLIP ViT-B/32 visual embedding + dHash matching, union-find grouping with burst-overlap exclusion rules, read-time best-copy scoring and kind classification, CLIP model lifecycle and degraded mode, chunked backfill job architecture, database footprint and archive/trash lifecycle
- [Location Inference](docs/specs/location-inference.md) — coord_source provenance model and its three writers, antimeridian-safe interpolation/extrapolation algorithm with exact confidence formula and auto-apply gate, single-sweep-job-per-circle backfill architecture with snapshot invariant and force semantics, review/admin API, algorithm positioning vs. ExifTool/gpscorrelate/PhotoPrism/Immich/Google Photos
- [Social Media Detection](docs/specs/social-media-detection.md) — gate-then-fan-out video routing that withholds `video_face_detection` pending classification, two-tier (ffprobe metadata/filename rule catalog + on-server OCR) detection engine, `media_social_status`/`social_media_source`/`MediaTagSource.system` data model and tag-protection rules, settings/env configuration, admin backfill and status API, Doctor `ai.socialMedia` check, precision-over-recall rationale and WhatsApp/Telegram re-encode limitation
- [Doctor Diagnostics](docs/specs/doctor.md) — on-demand configuration health sweep, 25-check catalog across 8 sections, status semantics, `runCheck` concurrency/timeout/exception-normalization design, reuse of existing settings test-connection services
- [Distributed Nodes](docs/specs/distributed-nodes.md) — CLI-driven worker node registration and lifecycle, PAT-auth node control plane, presigned-URL byte streaming (no storage credentials on the node), DB-atomic `FOR UPDATE SKIP LOCKED` job claiming shared with the in-process worker, lease/renewal/reaper model, admin fleet monitoring

See also: [Worker Node Setup & Troubleshooting](docs/worker-node-setup.md) — a practical setup/troubleshooting companion (not an architecture spec) covering the one-command `node install-deps` automated installer, per-OS ffmpeg install, native dependency (sharp/onnxruntime/Human/tesseract) installed-vs-operational troubleshooting, model manifest download, and common doctor error remediation.

## Audits

Post-implementation audit records live under `docs/audits/`:
- [Search Overhaul](docs/audits/search-audit.md) — root causes and fixes for filter-collision bugs, missing thumbnail signing, geocode data gaps, and person-name search; documents the `near` map-radius filter and `facets/locations` endpoint added in this sprint
- [Mobile Top Bar](docs/audits/mobile-topbar-audit.md) — root cause and fix for GitHub issue #95 (collapsed phone search button missing `flexGrow: 1`, leaving the AppBar's icons packed to the left with unused space on the right)

## Specialized Subagents (MANDATORY)

**CRITICAL REQUIREMENT**: This project uses specialized subagents for all development work. You MUST delegate tasks to the appropriate subagent. Do NOT attempt to perform development tasks directly without using the designated agent.

### Why Subagents Are Mandatory
- Each agent contains domain-specific knowledge from the System Specification
- Agents ensure consistent patterns and conventions across the codebase
- Agents have the full context needed for their specialized area
- Direct implementation without agents risks missing requirements

### Available Agents

| Agent | Domain | MUST Use For |
|-------|--------|--------------|
| `backend-dev` | NestJS API, Fastify, auth, RBAC | **ANY** backend code: endpoints, services, guards, middleware, JWT, OAuth |
| `frontend-dev` | React, MUI, TypeScript | **ANY** frontend code: components, pages, hooks, theming, responsive design |
| `database-dev` | PostgreSQL, Prisma | **ANY** database work: schema changes, migrations, seeds, queries |
| `testing-dev` | Jest, Supertest, RTL | **ANY** testing: unit tests, integration tests, typecheck, test fixtures |
| `docs-dev` | Technical documentation | **ANY** documentation: ARCHITECTURE.md, SECURITY.md, API.md, README updates |
| `ops-dev` | Routine operations (Haiku) | Rebuilding/restarting containers, running Prisma migrations, running typecheck. NEVER for state-changing git operations |

### Mandatory Delegation Rules

1. **Backend code changes** → ALWAYS use `backend-dev`
2. **Frontend code changes** → ALWAYS use `frontend-dev`
3. **Database/Prisma changes** → ALWAYS use `database-dev`
4. **Writing or updating tests** → ALWAYS use `testing-dev`
5. **Documentation updates** → ALWAYS use `docs-dev`
6. **Routine ops (container rebuilds, migrations, typecheck)** → use `ops-dev`. IMPORTANT: `ops-dev` must NEVER perform state-changing git operations (pull, merge, push, commit, worktree management, branch operations) — those are always handled by the main agent directly, and `ops-dev` is instructed to refuse them

### Multi-Domain Tasks

For tasks spanning multiple domains, you MUST invoke multiple agents sequentially:

**Example: "Add a new user preference setting"**
1. `database-dev` → Add migration for schema change
2. `backend-dev` → Implement API endpoint
3. `frontend-dev` → Build UI component
4. `testing-dev` → Write tests for all layers
5. `docs-dev` → Update API documentation

### Usage Examples
```
# Backend work - MUST use backend-dev
"Use backend-dev to implement the user settings endpoint"

# Frontend work - MUST use frontend-dev
"Use frontend-dev to create the theme toggle component"

# Database work - MUST use database-dev
"Use database-dev to add audit_events table migration"

# Testing work - MUST use testing-dev
"Use testing-dev to write integration tests for auth"

# Documentation work - MUST use docs-dev
"Use docs-dev to update SECURITY.md with new auth flow"

# Routine ops - use ops-dev (never for git operations)
"Use ops-dev to rebuild the api container and run migrations"
```

### What You Should NOT Do Directly
- Do NOT write NestJS controllers, services, or guards without `backend-dev`
- Do NOT create React components or pages without `frontend-dev`
- Do NOT modify Prisma schema or create migrations without `database-dev`
- Do NOT write Jest/RTL tests without `testing-dev`
- Do NOT update documentation files without `docs-dev`

The only exceptions are:
- Reading files to understand context
- Answering questions about the codebase
- Planning and coordination between agents
- Running simple commands (git status, npm install, etc.)
