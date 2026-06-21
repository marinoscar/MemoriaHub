# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- **Media classification feature** — The `MediaClassification` enum (`memory | low_value | unreviewed`) and the `classification` column on `media_items` (including its database index) have been removed entirely. This field was originally introduced in Phase 01 and partially surfaced in bulk editing (`PATCH /api/media/bulk`) and a review-queue UI, but the full automatic heuristic processors and dedicated review mode were never completed. Stored classification values were intentionally dropped as part of the schema migration. Removed surface area:
  - `MediaClassification` Prisma enum and `media_items.classification` column + index (migration)
  - `classification` filter on `GET /api/media` and `POST /api/search`
  - `classification` field in the searchable-field registry (`GET /api/search/fields`)
  - `set.classification` from the `PATCH /api/media/bulk` request body
  - `classification` from `POST /api/media` create body and `PATCH /api/media/:id` mutable fields
  - `counts.unreviewed` and `counts.lowValue` from `GET /api/media/dashboard` response
  - All classification UI: filter controls, `ClassificationBadge` component, classification selects in `MediaDetailDrawer` and `BulkActionToolbar`, and review-queue card filtering

- **Media `caption` field** — The `caption` column has been removed from `media_items`; `description` is retained and unchanged. Removed surface area:
  - `media_items.caption` DB column and the migration that drops it
  - `caption` from `POST /api/media` create body and `PATCH /api/media/:id` mutable fields
  - AI auto-tagging caption generation — the vision prompt now returns a JSON object with two keys (`tags`, `description`) instead of three; parse and persist logic updated accordingly
  - Caption term in the semantic-search embedding text composition — embeddings are now built from `description + tags + people names`
  - Caption UI field in `MediaDetailDrawer`
  - Existing embeddings are intentionally left as-is; no re-embed backfill is required

## [1.3.0] - 2026-06-15

### Added

- **Circle Dashboard** (`GET /api/media/dashboard`): New home page (`/`) shows a per-circle dashboard. Returns On This Day (up to 24 items where `MONTH(capturedAt) = today` and `DAY(capturedAt) = today` across all years), recent imports (12), favorites (12), and review-queue counts (`total`, `missingGeo`). Includes deep-links to `/media?missingGeo=1` and other review filters.

- **Bulk media editing** — three new circle-scoped endpoints requiring `collaborator` per-circle role:
  - `PATCH /api/media/bulk` (`media:write`) — update `location` (with on-demand reverse geocode, `geoSource='manual'`) and/or `favorite` on 1–500 items. Setting `location: null` clears all geo columns
  - `POST /api/media/bulk/tags` (`media:write`) — add and/or remove tags on 1–500 items atomically inside a single transaction
  - `POST /api/media/bulk/delete` (`media:delete`) — soft-delete 1–500 items. All bulk endpoints validate that every ID belongs to the stated circle before any write; mismatches return 404 without partial side-effects

- **Geo endpoints** (`media:read`):
  - `GET /api/media/geo/reverse?lat=&lng=` — on-demand reverse geocoding using the configured provider (default: offline on-server GeoNames dataset)
  - `GET /api/media/geo/search?q=&limit=` — forward geocoding (place-name search) via Nominatim. Disabled by default; enable with `GEO_FORWARD_SEARCH_ENABLED=true`. Only the typed query leaves the server — photo GPS coordinates are never sent

- **`GET /api/media/:id` now returns `tags: string[]`** — flat array of tag names attached to the item

- **New `GET /api/media` query parameters**: `cameraMake`, `cameraModel`, `sourceDeviceId`, `sourceDeviceName`, `missingGeo` (boolean: `true` = no GPS, `false` = has GPS)

- **On-This-Day functional index** (`migration 20260615000000_media_oncethisday_index`): a PostgreSQL expression index on `(EXTRACT(MONTH FROM captured_at), EXTRACT(DAY FROM captured_at)) WHERE deleted_at IS NULL` accelerates the dashboard query. Hand-authored because Prisma's DSL cannot express functional indexes

- **New environment variable**: `GEO_FORWARD_SEARCH_ENABLED` (default `false`) — gates the forward-geocoding endpoint. `NOMINATIM_BASE_URL` (already present) configures the Nominatim endpoint for both reverse (`nominatim` provider) and forward search

- **Web UI**: redesigned home page is now a circle dashboard (On This Day, recent, favorites, review queue with deep-links); media library supports multi-select with a bulk-action toolbar (location via map-pin + place search, tags, classification, favorite, delete); `MediaDetailDrawer` now allows editing location and tags inline

## [1.2.0] - 2026-06-14

### Added

- **Family Circles**: Collaborative shared-media library feature. Every media item, album, and tag belongs to exactly one circle. All circle members see the same content, scoped by per-circle role.
  - `circles`, `circle_members`, and `circle_invites` database tables
  - `CircleRole` enum: `circle_admin` | `collaborator` | `viewer`
  - Personal circle created automatically on first login (`isPersonal: true`); cannot be deleted
  - 13 new API endpoints under `GET/POST/PATCH/DELETE /api/circles` for circle CRUD, member management, and invite management
  - Invite flow: sending an invite upserts the invited email into `allowed_emails`; pending invites are claimed automatically when the invitee logs in for the first time
  - Two-layer authorization: system RBAC guard (`circles:read` / `circles:write`) followed by per-circle role check (`CircleMembershipService.assertCircleAccess`); Admins holding `circles:manage_any` bypass per-circle checks
  - New permissions: `circles:read`, `circles:write`, `circles:manage_any`
  - `activeCircleId` in user settings JSONB for UX circle persistence (not trusted for authz)
  - Web UI: `CircleContext`, `CircleSwitcher` in AppBar, `/circles`, `/circles/:id` pages
  - CLI: `circles list`, `circles use <id>` commands; per-folder circle binding in SQLite sync state v3; `--circle <id>` flag on `sync` and `backup` commands

- **Backup Job**: Local-disk backup for circle media via `LocalDiskStorageProvider`.
  - 5 new API endpoints under `POST/GET /api/admin/backup` for triggering and inspecting backup runs (Admin only)
  - New permissions: `backup:run`, `backup:read`
  - New environment variables: `BACKUP_LOCAL_PATH`, `STORAGE_BACKUP_PROVIDER`
  - Web UI: `/admin/backup` page with run history and object browser

### Changed

- **Media, Album, Tag ownership field renamed**: `ownerId` → `addedById` (`@map("added_by_id")`) on `media_items`, `albums`, and `tags` tables. All API responses use `addedById`.
- **Media deduplication key changed**: uniqueness constraint on `media_items` is now `(circle_id, content_hash)` instead of `(owner_id, content_hash)`. The `GET /api/media?contentHash=<hash>` dedup pre-check now requires a `circleId` query parameter.
- **Tag name uniqueness**: tags are now unique per `(circle_id, name)` instead of `(owner_id, name)`.
- **Storage download authorization**: `GET /api/storage/objects/:id/download` verifies access by resolving `storageObject → mediaItem → circleId → circle membership`. Direct owner checks are replaced by circle membership checks.
- **POST /api/media**: now requires `circleId` in the request body. The `source` field accepts `android` for mobile sync uploads.
- **GET /api/media**: now requires `circleId` as a query parameter to scope results to a circle.
- **POST /api/circles/:id/invites**: also upserts the invited email into `allowed_emails` so the invitee can log in without a separate admin allowlist action.

## [1.1.0] - 2026-06-10

### Changed

- **Dependencies**: Major upgrade across the stack — React 19, MUI 9, react-router 7, Vite 8, TypeScript 6 (web); Prisma 7 (now using the `@prisma/adapter-pg` driver adapter), zod 4 + nestjs-zod 5, Jest 30, @fastify/multipart 10, and OpenTelemetry updates (API). class-validator bumped to 0.15.1. NestJS remains on 11.x. Runtime is Node.js 22.

### Removed

- **CLI Tool**: Removed the `tools/app` cross-platform CLI and the `tools/*` workspace.

## [1.0.1] - 2026-01-24

### Added

- **CLI Storage Commands**: New storage commands for interacting with the storage API
  - File upload support with `storage upload` command
  - Interactive storage menu for browsing and managing files
- **CLI Sync Feature**: Full folder synchronization functionality
  - Sync database layer with better-sqlite3 for local state tracking
  - Sync engine for bidirectional folder synchronization
  - Sync commands (`sync push`, `sync pull`, `sync status`)
  - Interactive sync menu for easy sync management
- **API Improvements**: DatabaseSeedException for better seed-related error handling

### Fixed

- **Authentication**: Enhanced OAuth callback error logging for easier debugging
- **Authentication**: Improved error handling for missing database seeds
- **API**: Fixed metadata casting to `Prisma.InputJsonValue` in processing service
- **API**: Fixed metadata casting to `Prisma.InputJsonValue` in objects service
- **API**: Handle unknown error types in S3 storage provider
- **CLI**: Use ESM import for `existsSync` in sync-database module
- **Tests**: Convert ISO strings to timestamps for date comparison

### Changed

- **Database**: Squashed migrations into single initial migration
- **Infrastructure**: Added AWS environment variables to compose file

### Dependencies

- Added AWS SDK dependencies for S3 storage provider
- Added better-sqlite3 and related dependencies for CLI sync feature

### Documentation

- Added storage and folder sync documentation to CLI README

## [1.0.0] - 2026-01-24

### Initial Release

Enterprise Application Foundation - A production-grade full-stack application foundation built with React, NestJS, and PostgreSQL.

### Features

#### Authentication
- Google OAuth 2.0 with JWT access tokens and refresh token rotation
- Short-lived access tokens (15 min default) with secure refresh rotation
- HttpOnly cookie storage for refresh tokens

#### Device Authorization (RFC 8628)
- Device Authorization Flow for CLI tools, mobile apps, and IoT devices
- Secure device code generation and polling
- Device session management and revocation

#### Authorization
- Role-Based Access Control (RBAC) with three roles:
  - **Admin**: Full access, manage users and system settings
  - **Contributor**: Standard capabilities, manage own settings
  - **Viewer**: Least privilege (default), manage own settings
- Flexible permission system for feature expansion

#### Access Control
- Email allowlist restricts application access to pre-authorized users
- Pending/Claimed status tracking for allowlist entries
- Initial admin bootstrap via `INITIAL_ADMIN_EMAIL` environment variable

#### User Management
- Admin interface for managing users and role assignments
- User activation/deactivation controls
- Allowlist management UI at `/admin/users`

#### Settings Framework
- System-wide settings with type-safe Zod schemas
- Per-user settings with validation
- JSONB storage in PostgreSQL

#### API
- RESTful API built with NestJS and Fastify (2-3x better performance than Express)
- Swagger/OpenAPI documentation at `/api/docs`
- Health check endpoints (liveness and readiness probes)
- Input validation on all endpoints

#### Frontend
- React 18 with TypeScript
- Material-UI (MUI) component library
- Theme support with responsive design
- Protected routes with role-based access
- Vite build tool with hot module replacement

#### CLI Tool
- Cross-platform CLI (`app`) for development and API management
- Device authorization flow for secure CLI authentication
- Interactive menu-driven mode and command-line interface
- Support for multiple server environments (local, staging, production)

#### Infrastructure
- Docker Compose configurations:
  - `base.compose.yml`: Core services (api, web, db, nginx)
  - `dev.compose.yml`: Development overrides with hot reload
  - `prod.compose.yml`: Production overrides with resource limits
  - `otel.compose.yml`: Observability stack
- Nginx reverse proxy for same-origin architecture
- PostgreSQL 16 with Prisma ORM
- Automated database migrations and seeding

#### Observability
- OpenTelemetry instrumentation for traces and metrics
- Uptrace integration for visualization (UI at localhost:14318)
- Pino structured logging
- OTEL Collector configuration included

#### Testing
- Backend: Jest + Supertest for unit and integration tests
- Frontend: Vitest + React Testing Library
- CI pipeline with GitHub Actions

### API Endpoints

#### Authentication
- `GET /api/auth/providers` - List enabled OAuth providers
- `GET /api/auth/google` - Initiate Google OAuth
- `GET /api/auth/google/callback` - OAuth callback
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout and invalidate session
- `GET /api/auth/me` - Get current user

#### Device Authorization
- `POST /api/auth/device/code` - Generate device code
- `POST /api/auth/device/token` - Poll for authorization
- `GET /api/auth/device/sessions` - List device sessions
- `DELETE /api/auth/device/sessions/:id` - Revoke device session

#### Users (Admin only)
- `GET /api/users` - List users (paginated)
- `GET /api/users/:id` - Get user by ID
- `PATCH /api/users/:id` - Update user

#### Allowlist (Admin only)
- `GET /api/allowlist` - List allowlisted emails
- `POST /api/allowlist` - Add email to allowlist
- `DELETE /api/allowlist/:id` - Remove from allowlist

#### Settings
- `GET /api/user-settings` - Get user settings
- `PUT /api/user-settings` - Update user settings
- `GET /api/system-settings` - Get system settings
- `PUT /api/system-settings` - Update system settings (Admin)

#### Health
- `GET /api/health/live` - Liveness probe
- `GET /api/health/ready` - Readiness probe

### Technical Stack
- **Backend**: Node.js + TypeScript, NestJS with Fastify adapter
- **Frontend**: React + TypeScript, Material-UI (MUI)
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: Passport strategies (Google OAuth)
- **Testing**: Jest, Supertest, Vitest, React Testing Library
- **Observability**: OpenTelemetry, Uptrace, Pino
- **Infrastructure**: Docker, Docker Compose, Nginx
