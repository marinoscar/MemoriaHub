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
- `GET /api/auth/google` - Initiate Google OAuth
- `GET /api/auth/google/callback` - OAuth callback
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout and invalidate session
- `POST /api/auth/logout-all` - Logout from all devices
- `GET /api/auth/me` - Get current user

### Device Authorization (RFC 8628)
- `POST /api/auth/device/code` - Generate device code (Public)
- `POST /api/auth/device/token` - Poll for authorization (Public)
- `GET /api/auth/device/activate` - Get activation info
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

### Admin: Job Queue (Admin role + jobs:read / jobs:write)
An admin dashboard at `/admin/settings/jobs` provides monitoring and control over the generic `enrichment_jobs` queue (used by face detection, storage insights computation, and all future enrichment handlers).
- `GET /api/admin/jobs/stats` (jobs:read) - Queue stats: total, byStatus, byType breakdown, stuckRunning count, and `scheduled` (count of pending jobs currently in backoff, i.e. `scheduledFor > now`)
- `GET /api/admin/jobs?status=&type=&page=&pageSize=&scheduled=` (jobs:read) - Paginated job list with optional filters; add `scheduled=true` to show only pending jobs currently in backoff (`scheduledFor > now`; forces status=pending, `type` still applies); each item includes `scheduledFor` (ISO 8601 | null), `rateLimitedAt` (ISO 8601 | null), and `rateLimitHits` (number)
- `POST /api/admin/jobs/:id/retry` (jobs:write) - Reset a single failed/succeeded job to pending; also clears `scheduledFor` and resets `rateLimitHits` to 0 (400 if running, 404 if not found)
- `POST /api/admin/jobs/retry-failed` (jobs:write) - Bulk-retry all failed jobs; optional `{type}` body to scope by job type; also clears `scheduledFor` and resets `rateLimitHits` to 0
- `POST /api/admin/jobs/reset-stuck` (jobs:write) - Reset jobs stuck in `running` past a threshold; optional `{olderThanMinutes}` body (default 10)
- `DELETE /api/admin/jobs/:id` (jobs:write) - Delete a job row (400 if running, 404 if not found)

### Media — Bulk Operations (circle-scoped, collaborator role required)
- `PATCH /api/media/bulk` - Bulk update location / favorite on 1–500 items
- `POST /api/media/bulk/tags` - Bulk add/remove tags on 1–500 items
- `POST /api/media/bulk/delete` - Bulk soft-delete 1–500 items

### Media — Geo Services
- `GET /api/media/geo/reverse?lat=&lng=` - On-demand reverse geocoding; provider resolved per-call from system setting `geo.provider` (fallback: `GEO_PROVIDER` env var; default `offline`)
- `GET /api/media/geo/search?q=&limit=` - Forward geocoding via Nominatim; requires system setting `geo.forwardSearchEnabled=true` (fallback: `GEO_FORWARD_SEARCH_ENABLED=true`)

### Media — Circle Dashboard
- `GET /api/media/dashboard?circleId=` - On This Day + recent/favorites + review-queue counts; also returns `pendingBurstGroups` count when `features.burstDetection` is enabled globally

### Media — Burst Detection (media:read / media:write / media:delete + per-circle roles)
Burst detection is enabled globally via `features.burstDetection` system setting (default off) and non-destructive — no photo is deleted until a human confirms. Groups are surfaced in a review queue only once they reach `burst.minGroupSize`. `GET /api/media/dashboard` returns a `pendingBurstGroups` count that feeds the review-queue section of the dashboard UI.
- `GET /api/media/bursts?circleId=&status=&page=&pageSize=` - List burst groups (review queue); items `{ id, status, mediaCount, suggestedBestItemId, capturedAt, suggestedBestThumbnailUrl, coverThumbnailUrls[] }`; response `{ items, meta:{total,page,pageSize} }` (media:read + viewer)
- `GET /api/media/bursts/:id` - Group detail; ordered members `{ id, capturedAt, burstScore, sharpnessScore, thumbnailUrl, width, height, isSuggestedBest }` (media:read + viewer)
- `POST /api/media/bursts/:id/resolve` body `{ keepIds[] }` - Keep selected members, soft-delete the rest, mark resolved (media:delete + collaborator)
- `POST /api/media/bursts/:id/dismiss` - Mark "not a burst": ungroup members, status=dismissed (media:write + collaborator)

### Media — Metadata Extraction Re-run (media:read / media:write + per-circle roles)
Metadata re-run re-extracts EXIF, dimensions, geocode, and video-probe data on demand via the enrichment queue without re-triggering tagging, face detection, or burst detection. There is no per-circle opt-in and no upload-time enqueue — EXIF extraction already runs in the normal upload chain; this feature provides on-demand rerun and backfill only. The `metadata_extraction` enrichment handler runs the four allowlisted processors (`exif`, `dimensions`, `geocode`, `video-probe`), merges results into `StorageObject.metadata._processing`, then calls `MediaMetadataSyncService.syncFromStorageObject` to write typed columns directly. It deliberately does NOT emit `OBJECT_PROCESSED_EVENT`, so auto-tagging, face detection, and burst detection are not re-triggered.
- `POST /api/media/:id/metadata/rerun` - Re-enqueue a `metadata_extraction` enrichment job at priority 0 for a single item; upserts `media_metadata_status` to `pending`; returns `{ jobId, status }` (media:write + collaborator)
- `GET /api/media/:id/metadata/status` - Get per-item metadata extraction status: `{ status, processedAt, lastError }` (status `not_processed|pending|processing|processed|failed`); returns `not_processed` with null fields when no status row exists (media:read + viewer)

> **UI:** A "Re-run metadata extraction" button appears in the media properties pane (MediaDetailDrawer) and calls `POST /api/media/:id/metadata/rerun`. For bulk backfill, Admins use the global backfill panel in Admin Settings (see `POST /api/admin/metadata/backfill` below).

### Media — Explore
- `GET /api/media/explore/places?circleId=` - List distinct places with item counts and cover thumbnails; returns `Array<{ name: string; count: number; coverThumbnailUrl: string | null }>` (media:read + viewer)
- `GET /api/media/explore/tags?circleId=` - List tags with item counts and cover thumbnails; same response shape (media:read + viewer)

### Albums (media:read / media:write / media:delete)
Albums are circle-scoped named collections; deleting an album removes join rows only — `MediaItem` records are preserved.
- `GET /api/media/albums?circleId=&page=&pageSize=&sortBy=&sortOrder=` - List albums in a circle (paginated; sortBy `name`|`createdAt`|`updatedAt`) (media:read + viewer)
- `POST /api/media/albums` body `{circleId, name, description?}` - Create an album (media:write + collaborator)
- `GET /api/media/albums/:id` - Get album with its ordered item list (media:read + viewer)
- `PATCH /api/media/albums/:id` body `{name?, description?}` - Rename / update album; `description: null` clears it (media:write + collaborator)
- `DELETE /api/media/albums/:id` - Delete album; cascades AlbumItems, preserves MediaItems (media:delete + collaborator)
- `POST /api/media/albums/:id/items` body `{mediaItemIds[]}` (1–500) - Add specific media items to the album; idempotent (media:write + collaborator)
- `DELETE /api/media/albums/:id/items/:itemId` - Remove one item from the album; `:itemId` is the MediaItem UUID (media:write + collaborator) — 204 No Content
- `POST /api/media/albums/:id/items/by-filter` body `{circleId, ...mediaFilterFields}` - Add ALL media matching the given filters to the album in one operation; reuses `GET /api/media` filter semantics (minus pagination/sort); inserts with `skipDuplicates`; returns `{added: number}` (media:write + collaborator)

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
- `GET /api/media/:id/faces` - List detected faces on a media item: id, boundingBox (normalized 0–1), confidence, landmarks, personId, providerKey, modelVersion, manuallyAssigned (media:read + viewer)
- `GET /api/media/:id/faces/status` - Get per-item detection status: status, faceCount, providerKey, modelVersion, processedAt, lastError (media:read + viewer)
- `POST /api/media/:id/faces/rerun` - Re-enqueue face detection for a media item; returns `{jobId, status}` (media:write + collaborator)

### Face Recognition — People (media:read / media:write + per-circle viewer/collaborator/circle_admin role)
- `GET /api/people?circleId=&includeUnlabeled=&page=&pageSize=` - List person records in a circle; paginated (media:read + viewer)
- `GET /api/people/:id` - Get a person with their associated faces (media:read + viewer)
- `POST /api/people` body `{circleId, name?, faceIds?}` - Create a person, optionally assigning initial faces (media:write + collaborator)
- `PATCH /api/people/:id` body `{name?, coverFaceId?}` - Rename a person or set cover face (media:write + collaborator)
- `POST /api/people/:id/faces` body `{faceIds[]}` - Assign faces to a person (sets manuallyAssigned=true) (media:write + collaborator)
- `DELETE /api/people/:id/faces/:faceId` - Unassign a face; face returns to unknown pool (media:write + collaborator) — 204 No Content
- `POST /api/people/cluster` body `{circleId}` - Cluster unknown faces into provisional Person records; requires `features.faceRecognition` enabled globally (media:write + circle_admin)
- `POST /api/people/merge` body `{sourceId, targetId}` - Reassign all faces source→target, soft-delete source with mergedIntoId audit breadcrumb (media:write + collaborator)
- `DELETE /api/people/:id` - Soft-delete a person; all faces return to unknown pool (media:write + collaborator) — 204 No Content
- `GET /api/media?personId=` - Filter media list to items containing faces assigned to a specific person (media:read + viewer)
- `GET /api/media?noFaces=true` - Filter media list to items with no faces at all (detected or manually added) — useful for finding untagged photos; semantically `faces: { none: {} }` (media:read + viewer)

### Face Recognition — Manual People Association (media:write + per-circle collaborator role)
These endpoints let users associate people with a photo from the media properties pane when face detection misses a face. No bounding box is required. Internally each association is stored as a `Face` row with `providerKey='manual'`, `manuallyAssigned=true`, empty embedding, and zeroed bounding box — so all existing people filters and person galleries work without changes. Manual faces are preserved across face-detection reruns (the rerun delete is scoped to `manuallyAssigned=false`). Adding or removing a manual association re-enqueues `auto_tagging` so description/embedding refresh.
- `POST /api/media/:id/people` body `{ personId }` OR `{ name }` (exactly one) — associate a person with the photo; find-or-create by name when `name` is given; idempotent (no duplicate if the person is already associated); returns `{ personId, personName, faceId, mediaItemId }` (media:write + collaborator)
- `DELETE /api/media/:id/people/:personId` — remove the manual association only (does not touch detected faces); 404 if no manual association exists; 204 No Content (media:write + collaborator)

### Admin: Global Backfill Endpoints (Admin role + system_settings:write or face_settings:write)
These endpoints replace the former per-circle backfill endpoints. Each iterates all circles and returns `{ enqueued, circles }`. The per-circle backfill endpoints (`POST /api/tagging/backfill`, `POST /api/media/bursts/backfill`, `POST /api/metadata/backfill`, `POST /api/face/backfill`) have been removed.
- `POST /api/admin/tagging/backfill` body `{ from?, to?, force? }` - Bulk-enqueue auto-tagging jobs across all circles; 400 if `features.autoTagging` is disabled (Admin + system_settings:write)
- `POST /api/admin/bursts/backfill` body `{ from?, to?, force? }` - Bulk-enqueue burst_detection jobs across all circles; includes on-demand perceptual hashing for legacy photos; 400 if `features.burstDetection` is disabled (Admin + system_settings:write)
- `POST /api/admin/metadata/backfill` body `{ from?, to?, force? }` - Bulk-enqueue metadata_extraction jobs across all circles; no feature gate (Admin + system_settings:write)
- `POST /api/admin/face/backfill` body `{ force? }` - Bulk-enqueue face_detection jobs across all circles; 400 if `features.faceRecognition` is disabled (Admin + face_settings:write)

### Admin: Settings UI (`/admin/settings/*`)
The admin settings UI is organized as a hub at `/admin/settings` with URL-addressable sub-pages. Old flat `/admin/*` routes redirect to the new nested paths. The sidebar shows a single "Settings" entry. Per-circle feature toggles and per-circle backfill panels have been removed from the circle detail page.

Sub-pages:
- `/admin/settings/general` — general app settings
- `/admin/settings/users` — user management
- `/admin/settings/ai` — AI provider credentials and model selection
- `/admin/settings/tagging` — global auto-tagging toggle (`features.autoTagging`), tag vocabulary, global backfill
- `/admin/settings/face` — global face recognition toggle (`features.faceRecognition`), provider configuration, global backfill
- `/admin/settings/bursts` — global burst detection toggle (`features.burstDetection`), parameters, global backfill
- `/admin/settings/geo` — geo provider settings (`geo.provider`, `geo.forwardSearchEnabled`)
- `/admin/settings/storage/providers` — storage provider configuration (replaces `/admin/storage-providers`)
- `/admin/settings/storage/insights` — storage insights dashboard
- `/admin/settings/jobs` — enrichment job queue (replaces `/admin/jobs`)
- `/admin/settings/backup` — backup configuration and run history

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

### Deterministic Search (search:use)
- `POST /api/search` - Execute deterministic media search with explicit filters; optionally add `semanticQuery: string` (1–512 chars) to rank results by vector similarity instead of sort order; also accepts `noFaces: true` boolean to return only items with no faces (detected or manually added) (media:read + search:use)
- `GET /api/search/fields` - List all searchable field descriptors from the registry plus the `semanticQuery` descriptor; includes `noFaces` (label "No faces detected") (search:use)

### Agentic Search (search:use)
Agentic search is **stateless** — no conversation rows are stored server-side. The client holds the full message history in memory and sends it with every request.
- `POST /api/search/agent` - Send a message history and stream the AI response via SSE (text/event-stream). Body: `{ circleId: string; messages: Array<{ role: 'user'|'assistant'; content: string }> }` (last message must be `role: 'user'`). Verifies circle viewer membership. Stream events: `token`, `tool_call`, `results`, `done`, `error`. The agent's `search_media` tool also accepts a top-level `semanticQuery` parameter for visual/scene-based queries and a `noFaces: true` parameter to filter to photos with no faces. (search:use)

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
- `jobs:read` - View enrichment job queue stats and list jobs (Admin only)
- `jobs:write` - Retry, reset, and delete enrichment jobs (Admin only)

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
- `system_settings` - Global app settings (JSONB)
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
- `people` - Per-circle identity records for recognized individuals; supports `mergedIntoId` self-FK for cluster merge audit; `deletedAt` soft-delete
- `faces` - Individual detected face records with bounding box, confidence, variable-dimension embedding (`Float[]` fallback or pgvector column; 128-d for `compreface` mobilenet, 1024-d for `human` WASM), and `externalFaceId` for Rekognition delegated path; keyed to `mediaItemId` + `circleId`; `manuallyAssigned` flag protects user-labeled faces from re-clustering
- `enrichment_jobs` - Generic background job queue for all enrichment handlers (face detection, storage insights, etc.); statuses: `pending`, `running`, `succeeded`, `failed`; reasons: `upload`, `rerun`, `backfill`; `media_item_id` and `circle_id` are **NULLABLE** — null values indicate a global/system job that is not scoped to a single media item or circle (e.g. the `storage_insights` handler); idempotency for global jobs deduplicates on `(type, media_item_id IS NULL)`; three backoff columns: `scheduled_for` (DateTime?, when the job becomes eligible again — null = eligible now; the worker claim query skips jobs where `scheduled_for > now`), `rate_limited_at` (DateTime?, timestamp of the most recent rate-limit hit), `rate_limit_hits` (Int default 0, count of rate-limit deferrals tracked separately from `attempts`); `storage_migration` copies a single object from source to target provider (copy→verify→repoint→leave source; one job per object; `skipDedup` option prevents the `(type, mediaItemId IS NULL)` dedup from collapsing per-object jobs)
- `face_jobs` - Async face-detection job queue (no BullMQ); statuses: `pending`, `running`, `succeeded`, `failed`; reasons: `upload`, `rerun`, `backfill`
- `media_face_status` - Per-media-item detection status tracking (one row per item); records which provider/model processed the item and when; statuses: `not_processed`, `pending`, `processing`, `processed`, `failed`, `no_faces`
- `tag_labels` - Global AI tag vocabulary managed by admins; unique `name`; `enabled` flag controls whether a label is included in vision model prompts; labels are not circle-scoped; supports CSV export/import
- `media_tag_status` - Per-media-item auto-tagging status (one row per item); statuses: `not_processed`, `pending`, `processing`, `processed`, `failed`; records `provider_key`, `model_version`, `tag_count`, `processed_at`, `last_error`
- `albums` - Circle-scoped named media collections; `added_by_id` tracks the creating user; unique per `(circle_id, name)` is not enforced — names are for display only
- `album_items` - Join table linking `albums` to `media_items`; `@@unique([albumId, mediaItemId])` prevents duplicates; `added_at` records when the item was placed in the album; cascades on album delete, cascades on media item delete
- `insights_snapshots` - Precomputed global storage metrics snapshot; at most one row survives after each successful recompute (older rows are pruned); statuses: `InsightsSnapshotStatus` enum (`computing` | `ready` | `failed`) — in the queue-based flow the handler writes `ready` directly, so `computing` is not used at runtime; `metrics` JSONB holds `{ totalBytes, photoBytes, videoBytes (STRINGS), totalItems, photoCount, videoCount, totalFaces, taggedItems (NUMBERS) }` when `ready`; `computed_at` and `duration_ms` track timing; in-flight and failure state is tracked on the `enrichment_jobs` row, not here
- `media_item_embedding` - One row per media item; stores a 1536-d pgvector embedding of the item's description + tags + people names; written via raw SQL (Prisma cannot handle the `vector(1536)` column type); circle_id is denormalized for circle-scoped KNN filtering; requires the `vector` pgvector Postgres extension and a `pgvector/pgvector:pg16` database image; HNSW cosine index on `embedding`; upserted by the auto-tagging handler as a best-effort final step — embedding failures never fail the tagging job
- `burst_groups` - Circle-scoped burst review groups; one row per detected burst cluster; status `pending` | `resolved` | `dismissed`; `suggestedBestItemId` FK → `media_items` (SetNull on delete); `mediaCount` denormalized member count (updated whenever a member joins or leaves); `capturedAt` of the earliest member used for chronological queue sorting; `resolvedById` / `resolvedAt` track who resolved or dismissed the group
- `media_metadata_status` - Per-media-item metadata extraction re-run status (one row per item); statuses: `not_processed`, `pending`, `processing`, `processed`, `failed`; records `processed_at` and `last_error`; unique on `media_item_id`; cascade delete on both `media_items` and `circles`

**Note:** `media_items` has `description` (nullable, max 8 192 chars) written by the auto-tagging handler on each successful vision call. There is no `title` column. `media_items`, `albums`, and `tags` use `added_by_id` (not `owner_id`) to track the uploading user. Dedup uniqueness for `media_items` is `(circle_id, content_hash)`. Tag names are unique per `(circle_id, name)`. The `media_tags` join table has a `source` column (`manual` | `ai`, default `manual`) that tracks whether a tag was applied by the AI auto-tagging service or by a user manually; AI re-runs are authoritative over `source='ai'` rows only and never modify `source='manual'` rows. `media_items` also carries burst detection columns: `perceptual_hash` (**TEXT?**, unsigned 64-bit dHash stored as a decimal string — see storage rationale below), `sharpness_score` (Float?, variance-of-Laplacian sharpness measure), `burst_uuid` (String?, Apple BurstUUID from EXIF MakerNote — null for non-Apple cameras), `burst_score` (Float?, composite quality score within the group — null when not in a group), and `burst_group_id` (FK → `burst_groups`, SetNull on delete). The `perceptual_hash` column is omitted from default API responses via a Prisma global `omit` because it is an internal computation value; the burst matcher parses it with `BigInt(string)` only when computing Hamming distance. **Why TEXT and not `bigint`:** Postgres `bigint` is a signed 64-bit integer (max 2^63-1); a dHash is an unsigned 64-bit value and hashes with the high bit set overflow, producing a "value out of range for type bigint" error. Additionally, Prisma maps `BigInt` to JavaScript's `BigInt` primitive, which throws "Do not know how to serialize a BigInt" on `JSON.stringify`, crashing any endpoint that returns the column. Storing the value as a decimal string avoids both problems.

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
- `GEO_PROVIDER` - Reverse geocoding provider: `offline` (default, on-server GeoNames dataset) or `nominatim` (HTTP, sends GPS off-server). This env var is used as the fallback default; the runtime value is now also configurable via system setting `geo.provider` (editable in Admin Settings → `/admin/settings/geo`).
- `NOMINATIM_BASE_URL` - Nominatim endpoint (default: `https://nominatim.openstreetmap.org`)
- `GEO_FORWARD_SEARCH_ENABLED` - Enable `GET /api/media/geo/search` forward geocoding (default: `false`; only typed query leaves server, never GPS). Also configurable at runtime via system setting `geo.forwardSearchEnabled`.

**Face Recognition:**
- `FACE_COMPREFACE_URL` - Base URL of the CompreFace core sidecar (default: `http://compreface-core:3000`); used as the default `baseUrl` for the CompreFace provider. The provider is keyless — no API key is required.
- `FACE_AUTO_DETECT` - Environment kill-switch for auto-enqueue on upload; set to `false` to disable globally regardless of system settings. The runtime toggle is `features.faceRecognition` in system settings; this env var is a hard override for CI/test environments (default: `true`)
- `FACE_JOB_POLL_MS` - Polling interval for the face-job worker in milliseconds (default: `5000`)
- `FACE_WORKER_ENABLED` - Set to `false` to disable the FaceJobWorker (useful in test/CI environments; default: `true`)
- `FACE_MATCH_THRESHOLD` - Cosine-similarity threshold for assigning a detected face to a known `Person` (default: `0.38`)
- `FACE_CLUSTER_THRESHOLD` - Cosine-similarity threshold for grouping unknown faces during clustering (default: `0.45`; stricter than match threshold)
- `FACE_CLUSTER_MIN_SIZE` - Minimum cluster size to create a provisional Person; singletons remain unknown (default: `2`)
- `FACE_VECTOR_BACKEND` - Vector storage and matching backend: `app` (default; `Float[]` column + in-process cosine) or `pgvector` (requires the pgvector extension)

**Auto-Tagging and Semantic Search:**
- `AUTO_TAG_ENABLED` - Environment kill-switch for auto-enqueue on upload; set to `false` to disable globally regardless of system settings. The runtime toggle is `features.autoTagging` in system settings; this env var is a hard override for CI/test environments (default: `true`)
- `TAG_MAX_IMAGE_DIM` - Maximum image long-edge in pixels before downscaling prior to the vision model call; 1568 matches Anthropic's auto-downscale threshold (default: `1568`)

Note: Semantic search (pgvector embeddings) requires a pgvector-capable Postgres image (`pgvector/pgvector:pg16`). The embedding feature is configured in the Admin UI via `PUT /api/ai/features/embedding` — only OpenAI supports `embedText` (`text-embedding-3-small` recommended). If the embedding feature is not configured, `semanticQuery` silently falls back to filter-only search.

Note: The enrichment worker shared by face detection, storage insights computation, auto-tagging, and metadata re-extraction is controlled by `ENRICHMENT_WORKER_ENABLED` (default: `true`), `ENRICHMENT_JOB_POLL_MS` (default: `5000`), and `ENRICHMENT_WORKER_CONCURRENCY` (default: `1`). The legacy `FACE_WORKER_ENABLED` and `FACE_JOB_POLL_MS` aliases are still respected for backward compatibility. The `metadata_extraction` job type re-runs the `exif`, `dimensions`, `geocode`, and `video-probe` processors and syncs typed columns directly WITHOUT emitting `OBJECT_PROCESSED_EVENT`, so it does not cascade to auto-tagging, face detection, or burst detection. There is no upload-time enqueue and no per-circle opt-in for metadata extraction. Per-item rerun remains available to circle collaborators; global backfill is now an admin-only endpoint (`POST /api/admin/metadata/backfill`).

**Enrichment retry and rate-limit backoff:**
- `ENRICHMENT_MAX_ATTEMPTS` - Maximum processing attempts before a job is permanently failed (default: `3`)
- `ENRICHMENT_RETRY_BASE_MS` - Base backoff delay in ms for the first normal-error retry; equal-jitter exponential (default: `2000`)
- `ENRICHMENT_RETRY_MAX_MS` - Maximum backoff cap in ms for normal-error retries (default: `60000`)
- `ENRICHMENT_RATELIMIT_BASE_MS` - Base backoff delay in ms for the first rate-limit deferral (default: `30000`)
- `ENRICHMENT_RATELIMIT_MAX_MS` - Maximum backoff cap in ms for rate-limit deferrals (default: `900000`, i.e. 15 minutes)
- `ENRICHMENT_RATELIMIT_MAX_HITS` - Maximum rate-limit deferrals before a job is permanently failed; tracked separately from `ENRICHMENT_MAX_ATTEMPTS` (default: `10`)

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

**Feature Toggles (System Settings):**

These boolean system settings replace the former per-circle feature columns dropped in migration `20260621050000_drop_circle_feature_flags`. Editable in Admin Settings (`/admin/settings/*`).
- `features.autoTagging` — boolean, default false; global on/off for AI auto-tagging; env `AUTO_TAG_ENABLED=false` overrides this
- `features.faceRecognition` — boolean, default false; global on/off for face detection and recognition; env `FACE_AUTO_DETECT=false` overrides this
- `features.burstDetection` — boolean, default false; global on/off for burst photo detection; env `BURST_DETECTION_ENABLED=false` overrides this

**Geo Settings (System Settings):**

The geo provider is now configurable at runtime in addition to the env vars (env vars remain as fallback defaults):
- `geo.provider` — string `'offline'` | `'nominatim'`, default resolved from `GEO_PROVIDER` env var; editable in `/admin/settings/geo`
- `geo.forwardSearchEnabled` — boolean, default resolved from `GEO_FORWARD_SEARCH_ENABLED` env var; editable in `/admin/settings/geo`

**Storage Insights:**

The refresh cadence for the precomputed storage metrics snapshot is controlled via a system setting (not an environment variable):

- `storage.insights.refreshIntervalHours` — integer, 1–168, default 4; editable in the System Settings admin page. Controls how many hours must elapse between automatic cron-driven refreshes. The cron (`InsightsRefreshTask`) fires every hour; when the configured interval has elapsed (and no `storage_insights` job is already pending/running), it **enqueues** a `storage_insights` enrichment job at priority 100 (low priority, background). Computation is performed asynchronously by the enrichment worker with up to 3 retries. Manual refreshes via `POST /api/admin/insights/refresh` enqueue a job at priority 0 (highest priority, pre-empts the scheduled job) and return immediately — they do not wait for the compute to finish.

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

### Gotchas / Lessons Learned

- **Never store an unsigned 64-bit value in a Postgres `bigint` / Prisma `BigInt` column.** Postgres `bigint` is signed (max 2^63-1); values with the high bit set overflow with "value out of range for type bigint". Use a `TEXT` column (decimal or hex string) or the `numeric` type instead. Parse back to `BigInt()` in application code only where arithmetic is needed.
- **`BigInt` is not JSON-serializable.** `JSON.stringify` throws "Do not know how to serialize a BigInt" for any object that contains a JS `BigInt`. Never return a Prisma `BigInt` column directly in an API response. Store large integers as strings, and/or use a Prisma global `omit` to keep internal-only columns out of default selects so they cannot accidentally leak into response serialization.

## Feature Specifications

Detailed specs live under `docs/specs/`:
- [Enrichment Queue](docs/specs/enrichment-queue.md) — worker lifecycle, retry, priority, adding new handlers
- [Face Recognition](docs/specs/face-recognition.md) — face detection, recognition, clustering, people management, global feature toggle, global admin backfill
- [AI Auto-Tagging](docs/specs/auto-tagging.md) — vocabulary-driven vision model tagging, description generation, global feature toggle, global admin backfill, embedding step
- [Semantic Search](docs/specs/semantic-search.md) — pgvector embedding storage, KNN-then-filter algorithm, `semanticQuery` param, graceful degradation, backfill and re-embed on people change
- [Agentic Search](docs/specs/agentic-search.md) — stateless agentic search, SSE streaming, tool-call protocol
- [Storage Insights](docs/specs/storage-insights.md) — precomputed global storage metrics, snapshot lifecycle, interval-gated cron, admin dashboard
- [Burst Photo Detection](docs/specs/burst-detection.md) — on-server dHash + temporal proximity grouping, best-shot scoring, non-destructive review queue, global feature toggle, global admin backfill with optional capturedAt range and on-demand retroactive perceptual hashing
- [Metadata Extraction Re-run](docs/specs/metadata-rerun.md) — on-demand per-item rerun and global admin backfill of EXIF/dimensions/geocode/video-probe processors via enrichment queue; direct column sync without cascading to tagging, face, or burst
- [Storage Provider Configuration](docs/specs/storage-providers.md) — multi-provider credential management, per-object routing with env fallback, copy-only migration model, active-provider selection

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

### Mandatory Delegation Rules

1. **Backend code changes** → ALWAYS use `backend-dev`
2. **Frontend code changes** → ALWAYS use `frontend-dev`
3. **Database/Prisma changes** → ALWAYS use `database-dev`
4. **Writing or updating tests** → ALWAYS use `testing-dev`
5. **Documentation updates** → ALWAYS use `docs-dev`

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
