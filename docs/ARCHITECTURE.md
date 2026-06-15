# System Architecture

**Enterprise Application Foundation**
**Version:** 1.0
**Last Updated:** January 2026

This document provides a comprehensive architectural overview of the Enterprise Application Foundation designed for AI-assisted development with specialized coding agents.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Overview](#2-system-overview)
3. [Architecture Principles](#3-architecture-principles)
4. [Technology Stack](#4-technology-stack)
5. [Component Architecture](#5-component-architecture)
6. [Data Architecture](#6-data-architecture)
7. [Security Architecture](#7-security-architecture)
8. [API Architecture](#8-api-architecture)
9. [Frontend Architecture](#9-frontend-architecture)
10. [Infrastructure Architecture](#10-infrastructure-architecture)
11. [Observability Architecture](#11-observability-architecture)
12. [Testing Architecture](#12-testing-architecture)
13. [Agent-Based Development Model](#13-agent-based-development-model)
14. [Development Workflows](#14-development-workflows)
15. [Appendices](#15-appendices)

---

## 1. Executive Summary

### Purpose

The Enterprise Application Foundation is a production-grade web application template that establishes:

- **Secure Authentication**: OAuth 2.0 with Google (extensible to other providers)
- **Fine-Grained Authorization**: Role-Based Access Control (RBAC) with permissions
- **Flexible Configuration**: JSONB-based settings framework for system and user preferences
- **Enterprise Observability**: OpenTelemetry instrumentation with traces, metrics, and structured logs
- **Agent-Friendly Development**: Modular architecture designed for AI coding agent collaboration

### Key Characteristics

| Aspect | Description |
|--------|-------------|
| **Architecture Style** | Monorepo with API-first design |
| **Hosting Model** | Same-origin (UI and API share base URL) |
| **Auth Strategy** | OAuth 2.0 + JWT with refresh token rotation |
| **Access Control** | Email allowlist + RBAC (Admin/Contributor/Viewer) |
| **Data Storage** | PostgreSQL with Prisma ORM |
| **Extensibility** | JSONB settings, modular NestJS structure |

### Target Audience

- **AI Coding Agents**: Primary consumers for automated development tasks
- **Backend Developers**: NestJS/Node.js engineers
- **Frontend Developers**: React/TypeScript engineers
- **DevOps Engineers**: Infrastructure and deployment specialists
- **Security Teams**: Security review and compliance

---

## 2. System Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              NGINX REVERSE PROXY                             │
│                           (Security Headers, Routing)                        │
│                              http://localhost:3535                           │
├────────────────────────────────────┬────────────────────────────────────────┤
│         /* → Frontend (Web)        │           /api/* → Backend (API)       │
├────────────────────────────────────┼────────────────────────────────────────┤
│                                    │                                        │
│  ┌──────────────────────────────┐  │  ┌──────────────────────────────────┐  │
│  │       REACT FRONTEND         │  │  │       NESTJS + FASTIFY           │  │
│  │                              │  │  │                                  │  │
│  │  ┌────────────────────────┐  │  │  │  ┌────────────────────────────┐  │  │
│  │  │      Pages/Routes      │  │  │  │  │    Controllers/Guards      │  │  │
│  │  │  • Login               │  │  │  │  │  • AuthController          │  │  │
│  │  │  • Home                │  │  │  │  │  • UsersController         │  │  │
│  │  │  • User Settings       │  │  │  │  │  • SettingsController      │  │  │
│  │  │  • System Settings     │  │  │  │  │  • HealthController        │  │  │
│  │  │  • Device Activation   │  │  │  │  └────────────────────────────┘  │  │
│  │  └────────────────────────┘  │  │  │                                  │  │
│  │                              │  │  │  ┌────────────────────────────┐  │  │
│  │  ┌────────────────────────┐  │  │  │  │    Services/Business       │  │  │
│  │  │  Contexts/State        │  │  │  │  │    Logic Layer             │  │  │
│  │  │  • AuthContext         │  │  │  │  │  • AuthService             │  │  │
│  │  │  • ThemeContext        │  │  │  │  │  • UsersService            │  │  │
│  │  │  • SettingsContext     │  │  │  │  │  • SettingsService         │  │  │
│  │  └────────────────────────┘  │  │  │  │  • AllowlistService        │  │  │
│  │                              │  │  │  └────────────────────────────┘  │  │
│  │  ┌────────────────────────┐  │  │  │                                  │  │
│  │  │  Material UI (MUI)     │  │  │  │  ┌────────────────────────────┐  │  │
│  │  │  • Components          │  │  │  │  │    Prisma ORM              │  │  │
│  │  │  • Theming             │  │  │  │  │  • Database Access         │  │  │
│  │  │  • Responsive Design   │  │  │  │  │  • Query Building          │  │  │
│  │  └────────────────────────┘  │  │  │  │  • Migrations              │  │  │
│  │                              │  │  │  └────────────────────────────┘  │  │
│  └──────────────────────────────┘  │  └──────────────────────────────────┘  │
│                                    │                │                       │
│              Port 5173             │                │      Port 3000        │
└────────────────────────────────────┴────────────────┼───────────────────────┘
                                                      │
                                                      ▼
                                     ┌────────────────────────────────┐
                                     │        POSTGRESQL              │
                                     │                                │
                                     │  Tables:                       │
                                     │  • users, user_identities      │
                                     │  • roles, permissions          │
                                     │  • user_roles, role_permissions│
                                     │  • user_settings               │
                                     │  • system_settings             │
                                     │  • refresh_tokens              │
                                     │  • device_codes                │
                                     │  • allowed_emails              │
                                     │  • audit_events                │
                                     │                                │
                                     │           Port 5432            │
                                     └────────────────────────────────┘
                                                      │
                                                      ▼
                                     ┌────────────────────────────────┐
                                     │    OBSERVABILITY STACK         │
                                     │                                │
                                     │  • OTEL Collector              │
                                     │  • Uptrace (Traces/Metrics)    │
                                     │  • ClickHouse (Storage)        │
                                     │                                │
                                     │        Port 14318 (UI)         │
                                     └────────────────────────────────┘
```

### Request Flow

```
┌──────┐    ┌───────┐    ┌─────────────┐    ┌──────────────┐    ┌────────────┐
│Client│───▶│ Nginx │───▶│ JwtAuthGuard│───▶│ RolesGuard   │───▶│ Controller │
└──────┘    └───────┘    └─────────────┘    └──────────────┘    └────────────┘
                              │                    │                   │
                              ▼                    ▼                   ▼
                         Validate JWT       Check Roles/        Business Logic
                         Load User          Permissions         Response
```

---

## 3. Architecture Principles

### 3.1 Separation of Concerns

| Layer | Responsibility | Location |
|-------|---------------|----------|
| **Presentation** | User interaction, rendering, UX | `apps/web/` |
| **API Gateway** | HTTP handling, validation, auth | `apps/api/src/*/controllers/` |
| **Business Logic** | Domain rules, orchestration | `apps/api/src/*/services/` |
| **Data Access** | Database operations, queries | Prisma via services |
| **Infrastructure** | Routing, containers, config | `infra/` |

**Rule**: Frontend handles presentation only. All business logic resides in the API.

### 3.2 Same-Origin Hosting

All components served from the same base URL via Nginx reverse proxy:

| Path | Component | Purpose |
|------|-----------|---------|
| `/` | Frontend (React) | User interface |
| `/api/*` | Backend (NestJS) | REST API |
| `/api/docs` | Swagger UI | API documentation |
| `/api/openapi.json` | OpenAPI spec | Machine-readable API schema |

**Benefits**: No CORS complexity, simplified cookie handling, unified deployment.

### 3.3 Security by Default

- **Authentication Required**: All API endpoints require JWT unless explicitly marked `@Public()`
- **Authorization Enforced**: RBAC guards verify roles/permissions before controller execution
- **Input Validated**: Zod schemas validate all request payloads
- **Secrets Protected**: Environment variables only, never committed to source

### 3.4 API-First Design

- **Contract-Driven**: OpenAPI specification generated from code annotations
- **Versioned**: API paths support future versioning (`/api/v1/`)
- **Consistent**: Standardized response format for success and errors
- **Documented**: Every endpoint documented with Swagger decorators

### 3.5 Observable by Design

- **Traced**: OpenTelemetry auto-instrumentation for all HTTP and DB operations
- **Metered**: Request counts, durations, error rates exposed as metrics
- **Logged**: Structured JSON logging with correlation IDs
- **Health-Checked**: Liveness and readiness endpoints for orchestration

---

## 4. Technology Stack

### 4.1 Core Technologies

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| **Runtime** | Node.js | 18+ | Server runtime |
| **Language** | TypeScript | 5.x | Type safety |
| **Backend Framework** | NestJS | 10.x | API structure |
| **HTTP Adapter** | Fastify | 4.x | High-performance HTTP |
| **Frontend Framework** | React | 18.x | UI rendering |
| **UI Library** | Material UI (MUI) | 5.x | Component library |
| **Database** | PostgreSQL | 14+ | Data persistence |
| **ORM** | Prisma | 5.x | Database access |

### 4.2 Authentication & Security

| Component | Technology | Purpose |
|-----------|------------|---------|
| **OAuth Strategy** | Passport.js | OAuth flow handling |
| **OAuth Provider** | Google OAuth 2.0 | Primary identity provider |
| **Token Format** | JWT (HS256) | Stateless authentication |
| **Validation** | Zod | Runtime schema validation |
| **Security Headers** | Helmet (via Nginx) | HTTP security headers |

### 4.3 Infrastructure

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Containerization** | Docker | Application packaging |
| **Orchestration** | Docker Compose | Local development environment |
| **Reverse Proxy** | Nginx | Routing, SSL termination, headers |
| **Observability** | OpenTelemetry + Uptrace | Traces, metrics, logs |
| **Logging** | Pino | Structured JSON logging |

### 4.4 Testing

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Backend Unit Tests** | Jest + jest-mock-extended | Service/guard testing with mocked Prisma |
| **Backend Integration** | Jest + Supertest | HTTP endpoint testing with mocked database |
| **Prisma Mocking** | jest-mock-extended (DeepMockProxy) | Type-safe database mocking |
| **Frontend Tests** | Vitest + React Testing Library | Component and context testing |
| **Frontend API Mocking** | MSW (Mock Service Worker) | Network request interception |
| **E2E (Optional)** | Playwright | Full system testing |

**Key Testing Characteristics:**
- Backend tests use **mocked PrismaService** by default (no real database required)
- Integration tests verify full HTTP request/response cycle with mocked data layer
- Frontend tests run in jsdom environment with MSW intercepting API calls
- Coverage thresholds: 70% minimum for frontend (enforced in vitest.config.ts)

---

## 5. Component Architecture

### 5.1 Repository Structure

```
EnterpriseAppBase/
├── apps/
│   ├── api/                          # Backend API (NestJS + Fastify)
│   │   ├── src/
│   │   │   ├── auth/                 # Authentication module
│   │   │   │   ├── controllers/
│   │   │   │   ├── services/
│   │   │   │   ├── guards/
│   │   │   │   ├── strategies/
│   │   │   │   └── decorators/
│   │   │   ├── users/                # User management module
│   │   │   ├── settings/             # Settings module (user + system)
│   │   │   ├── allowlist/            # Email allowlist module
│   │   │   ├── health/               # Health check module
│   │   │   ├── prisma/               # Prisma service
│   │   │   ├── common/               # Shared utilities
│   │   │   │   ├── constants/
│   │   │   │   ├── filters/
│   │   │   │   └── interceptors/
│   │   │   ├── config/               # Configuration module
│   │   │   └── main.ts               # Application entry
│   │   ├── prisma/
│   │   │   ├── schema.prisma         # Database schema
│   │   │   ├── migrations/           # Migration history
│   │   │   └── seed.ts               # Database seeding
│   │   ├── test/                     # Integration tests
│   │   └── Dockerfile
│   │
│   └── web/                          # Frontend (React + MUI)
│       ├── src/
│       │   ├── components/           # Reusable UI components
│       │   ├── pages/                # Page components
│       │   ├── contexts/             # React context providers
│       │   ├── hooks/                # Custom hooks
│       │   ├── services/             # API client
│       │   ├── theme/                # MUI theme configuration
│       │   ├── types/                # TypeScript types
│       │   └── __tests__/            # Component tests
│       └── Dockerfile
│
├── docs/                             # Documentation
│   ├── ARCHITECTURE.md               # This document
│   ├── SECURITY-ARCHITECTURE.md      # Security details
│   ├── API.md                        # API reference
│   ├── DEVELOPMENT.md                # Development guide
│   ├── TESTING.md                    # Testing guide
│   ├── DEVICE-AUTH.md                # Device auth guide
│   ├── System_Specification_Document.md  # Full specification
│   └── specs/                        # Implementation specifications
│       ├── 01-project-setup.md
│       ├── 02-database-schema.md
│       └── ... (24 specs total)
│
├── infra/                            # Infrastructure configuration
│   ├── compose/
│   │   ├── base.compose.yml          # Core services
│   │   ├── dev.compose.yml           # Development overrides
│   │   ├── prod.compose.yml          # Production overrides
│   │   ├── otel.compose.yml          # Observability stack
│   │   └── .env.example              # Environment template
│   ├── nginx/
│   │   └── nginx.conf                # Reverse proxy config
│   └── otel/
│       ├── otel-collector-config.yaml
│       └── uptrace.yml
│
├── .claude/                          # AI agent configuration
│   └── agents/
│       ├── backend-dev.md            # Backend specialist
│       ├── frontend-dev.md           # Frontend specialist
│       ├── database-dev.md           # Database specialist
│       ├── testing-dev.md            # Testing specialist
│       └── docs-dev.md               # Documentation specialist
│
├── CLAUDE.md                         # AI assistant guidance
└── README.md                         # Project overview
```

### 5.2 Backend Module Structure

Each NestJS module follows a consistent pattern:

```
module-name/
├── module-name.module.ts         # Module definition
├── module-name.controller.ts     # HTTP endpoints
├── module-name.service.ts        # Business logic
├── dto/                          # Data Transfer Objects
│   ├── create-item.dto.ts
│   └── update-item.dto.ts
├── interfaces/                   # TypeScript interfaces
├── guards/                       # Module-specific guards
└── module-name.controller.spec.ts  # Unit tests
```

### 5.3 Frontend Component Structure

```
components/
├── ComponentName/
│   ├── ComponentName.tsx         # Component implementation
│   ├── ComponentName.test.tsx    # Component tests
│   └── index.ts                  # Barrel export

pages/
├── PageName/
│   ├── PageName.tsx              # Page component
│   ├── PageName.test.tsx         # Page tests
│   └── index.ts                  # Barrel export
```

### 5.4 Storage Subsystem

The storage system provides file upload and management capabilities with support for large files through resumable multipart uploads.

#### Architecture Overview

The storage system uses a provider abstraction pattern to support multiple cloud storage backends while maintaining a consistent API.

```
┌─────────────────────────────────────────────────────────────┐
│                    Storage Module                            │
├─────────────────────────────────────────────────────────────┤
│  Objects Controller                                          │
│  └── Upload/Download/CRUD endpoints                          │
├─────────────────────────────────────────────────────────────┤
│  Objects Service                                             │
│  └── Business logic, ownership validation                    │
├─────────────────────────────────────────────────────────────┤
│  Storage Provider Interface                                  │
│  ├── S3StorageProvider (implemented)                         │
│  └── AzureStorageProvider (future)                          │
├─────────────────────────────────────────────────────────────┤
│  Object Processing Pipeline                                  │
│  └── Async post-upload processing with pluggable processors  │
└─────────────────────────────────────────────────────────────┘
```

#### Upload Flow

**1. Resumable Upload (Large Files)**:
   - Client calls `/api/storage/objects/upload/init` with file metadata
   - Server creates DB record, initializes S3 multipart, returns presigned URLs
   - Client uploads parts directly to S3 (bypasses application server)
   - Client calls `/api/storage/objects/:id/upload/complete` with part ETags
   - Server finalizes upload with S3, triggers processing pipeline

**2. Simple Upload (Small Files < 100MB)**:
   - Client sends file via multipart/form-data to `/api/storage/objects`
   - Server streams directly to S3
   - Processing pipeline triggered on completion

#### Processing Pipeline

Post-upload processing is handled asynchronously via NestJS EventEmitter:

```
ObjectUploadedEvent (emitted)
         ↓
ObjectProcessingService (orchestrator)
         ↓
Registered Processors (run in priority order)
         ↓
Results aggregated into object metadata
         ↓
Status updated: ready | failed
```

**Key Features:**
- Pluggable processor architecture
- Priority-based execution order
- Processors run asynchronously (non-blocking)
- Results stored in object metadata JSONB field
- Extensible for future processing needs (virus scanning, image resizing, etc.)

#### Database Schema

**storage_objects**:
- File metadata, status, storage key
- Owner reference (user_id)
- Processing results in JSONB metadata field

**storage_object_chunks**:
- Tracks multipart upload progress
- Part number, ETag, upload status
- Enables resume capability

#### Module Structure

```
apps/api/src/storage/
├── storage.module.ts                # Module definition
├── objects/
│   ├── objects.controller.ts        # HTTP endpoints
│   ├── objects.service.ts           # Business logic
│   ├── dto/                         # Data transfer objects
│   └── interfaces/
├── providers/
│   ├── storage-provider.interface.ts
│   └── s3-storage.provider.ts
└── processing/
    ├── object-processing.service.ts
    └── processors/
        └── base-processor.interface.ts
```

### 5.5 Family Circles Module

The `circles/` module provides the shared-library collaboration layer. It is the authorization root for all circle-scoped resources.

#### Module Structure

```
apps/api/src/circles/
├── circles.module.ts
├── circles.controller.ts          # CRUD + members + invites endpoints
├── circles.service.ts             # Business logic (create, list, members, invites)
├── circle-membership.service.ts   # resolveRole, assertCircleAccess (separate service
│                                  # to avoid circular imports with MediaModule/StorageModule)
├── guards/
│   └── circle-member.guard.ts
├── decorators/
│   └── circle-role.decorator.ts
└── dto/
    ├── create-circle.dto.ts
    ├── update-circle.dto.ts
    ├── circles-query.dto.ts
    ├── add-member.dto.ts
    ├── update-member-role.dto.ts
    └── create-invite.dto.ts
```

#### Authorization Flow

```
API request with circleId
        │
        ▼
CircleMembershipService.assertCircleAccess(userId, circleId, permissions, required)
        │
        ├── isSuperAdmin = permissions includes circles:manage_any
        │   OR media:read_any OR media:write_any
        │   └── if true: bypass membership check, return { role, isSuperAdmin: true }
        │
        ├── circle existence check (404 if not found)
        │
        ├── resolveRole(userId, circleId) → CircleRole | null
        │   └── null → 403 "not a member of this circle"
        │
        └── ROLE_RANK[role] >= ROLE_RANK[required]
            └── if insufficient → 403 "requires <role> or higher"
```

Per-circle role ranking: `viewer (1) < collaborator (2) < circle_admin (3)`.

#### Backup Module

```
apps/api/src/jobs/backup/
├── backup.module.ts
├── backup.controller.ts           # @Controller('admin/backup')
├── backup.service.ts              # runBackup, getRecentRuns, getRunStatus, listObjects
└── dto/
    └── trigger-backup.dto.ts
```

The backup job mirrors ready `MediaItem` blobs from S3 to the local provider rooted at `BACKUP_LOCAL_PATH`. Runs are tracked as `audit_events` records.

#### LocalDiskStorageProvider

```
apps/api/src/storage/providers/local/
└── local-disk.provider.ts         # Implements StorageProvider interface
```

Selected when `STORAGE_BACKUP_PROVIDER=local`. Used exclusively by the backup job; the primary upload path continues to use the S3 provider.

---

### 5.6 Bulk Media Editing

The `MediaService` provides three bulk-operation methods invoked by the static routes registered before `/:id` in `MediaController`:

| Route | Permission | Min per-circle role | Operation |
|-------|------------|---------------------|-----------|
| `PATCH /api/media/bulk` | `media:write` | `collaborator` | Update location, classification, or favorite on 1–500 items |
| `POST /api/media/bulk/tags` | `media:write` | `collaborator` | Add/remove tags on 1–500 items (transactional) |
| `POST /api/media/bulk/delete` | `media:delete` | `collaborator` | Soft-delete 1–500 items |

#### Authorization pattern

All three bulk methods share the same private helper `assertAllInCircle`:

```
assertAllInCircle(ids, circleId, userId, perms, 'collaborator')
  1. CircleMembershipService.assertCircleAccess → 403 if not a collaborator
  2. prisma.mediaItem.findMany where id IN ids AND circleId = ? AND deletedAt IS NULL
  3. If found.length !== uniqueIds.length → 404 (missing, deleted, or wrong circle)
```

No partial writes occur: the full ID list is validated before any update or delete is executed.

#### Bulk location update flow

When `set.location = {lat, lng, altitude?}` is provided, `bulkUpdateMedia` calls `geoProvider.reverseGeocode(lat, lng)` synchronously and propagates the result through `geoResultToMediaColumns(result, 'manual')` before issuing a single `prisma.mediaItem.updateMany`. This sets `geoSource = 'manual'` and overwrites all geo tier columns. When `set.location = null`, `GEO_CLEAR_COLUMNS` nulls every coordinate and derived field in the same `updateMany`.

#### Bulk tag operation flow

`bulkTags` runs inside a single Prisma `$transaction`:

```
for each name in dto.add → upsert Tag (circleId_name unique); collect tagIds
prisma.mediaTag.createMany({ data: ids × tagIds, skipDuplicates: true })

for each name in dto.remove → findMany Tag by name in circle; collect removeTagIds
prisma.mediaTag.deleteMany where tagId IN removeTagIds AND mediaItemId IN ids
```

Returns `{ added: number, removed: number }` counts.

---

### 5.7 Circle Dashboard

`GET /api/media/dashboard?circleId=<uuid>` is handled by `MediaService.getDashboard` and executes seven parallel database operations after a single circle-access check:

| Data | Query |
|------|-------|
| On This Day IDs | Raw SQL using `EXTRACT(MONTH/DAY FROM captured_at)` filtered by the functional index |
| On This Day items | `findMany where id IN onThisDayIds`, ordered `capturedAt DESC`, limit 24 |
| Recent items | `findMany where circleId`, ordered `importedAt DESC`, limit 12 |
| Favorites | `findMany where circleId AND favorite = true`, ordered `capturedAt DESC`, limit 12 |
| Total count | `count where circleId AND deletedAt IS NULL` |
| Unreviewed count | `count where classification = 'unreviewed'` |
| Low-value count | `count where classification = 'low_value'` |
| Missing-geo count | `count where takenLat IS NULL` |

Thumbnail URLs are signed in parallel via `signThumb` after the DB queries complete.

#### On-This-Day functional index

The raw SQL query that drives the On-This-Day panel reads:

```sql
SELECT id FROM media_items
WHERE circle_id = $1::uuid
  AND deleted_at IS NULL
  AND captured_at IS NOT NULL
  AND EXTRACT(MONTH FROM captured_at) = $2
  AND EXTRACT(DAY FROM captured_at) = $3
ORDER BY captured_at DESC
LIMIT 24
```

PostgreSQL cannot use a plain B-tree index on `captured_at` for this pattern. A dedicated functional partial index accelerates it:

```sql
CREATE INDEX "media_items_captured_md_idx"
  ON "media_items" (EXTRACT(MONTH FROM "captured_at"), EXTRACT(DAY FROM "captured_at"))
  WHERE "deleted_at" IS NULL;
```

This index is hand-authored in migration `20260615000000_media_oncethisday_index` and is not represented in `schema.prisma` (Prisma's DSL cannot express expression indexes).

---

### 5.8 Geo Services

The media module maintains two distinct geocoding paths:

#### Reverse geocoding (on-server, offline by default)

The `GeoLocationProvider` interface is injected as `GEO_LOCATION_PROVIDER`. The active provider is selected by the `GEO_PROVIDER` environment variable:

| Value | Provider | Data leaves server? |
|-------|----------|---------------------|
| `offline` (default) | `OfflineGeoLocationProvider` — local-reverse-geocoder backed by GeoNames dataset | No — GPS stays on server |
| `nominatim` | `NominatimGeoLocationProvider` — OSM Nominatim HTTP `/reverse` API | Yes — GPS sent to Nominatim |

Reverse geocoding fires in two contexts:
1. **Post-upload (automatic)**: `MediaMetadataSyncService.syncFromStorageObject` after EXIF extraction
2. **On-demand (manual bulk)**: `PATCH /api/media/bulk` triggers `geoProvider.reverseGeocode` when `set.location` contains coordinates

The on-demand path is also exposed directly as `GET /api/media/geo/reverse?lat=&lng=` for the UI location picker.

#### Forward geocoding (Nominatim, opt-in)

`ForwardGeocodeService` sends a typed place-name query to Nominatim's `/search` endpoint and returns `[{lat, lng, label}]`. **Photo GPS coordinates are never sent by this path** — only the text query the user typed.

The service is gated by `GEO_FORWARD_SEARCH_ENABLED` (default `false`). When disabled, `GET /api/media/geo/search` returns 503. The `NOMINATIM_BASE_URL` variable (default `https://nominatim.openstreetmap.org`) can point the service at a private Nominatim instance.

```
apps/api/src/media/geo/
├── geo-location-provider.interface.ts   # GeoLocationProvider + GeoLocationResult
├── geo-location.module.ts               # Selects provider by GEO_PROVIDER env var
├── offline-geo-location.provider.ts     # local-reverse-geocoder backed by GeoNames
├── nominatim-geo-location.provider.ts   # Nominatim HTTP reverse geocoding
├── forward-geocode.service.ts           # Nominatim forward search (opt-in)
└── geo-result.mapper.ts                 # geoResultToMediaColumns + GEO_CLEAR_COLUMNS
```

---

### 5.9 Content-Hash Deduplication

#### Overview

The system performs **byte-exact (tier-1) deduplication** on media items. Two files are considered identical if and only if their SHA-256 content hashes match. Re-encoded or visually similar files are NOT caught by this mechanism; near-duplicate detection via perceptual hashing is a planned tier-2 enhancement (see [Phase 09 — Long-Term Enrichment](plan/phase-09-longterm-enrichment.md)).

The dedup key is the tuple `(circle_id, content_hash)`. Deduplication is scoped to the circle — the same file may legitimately exist in different circles (e.g., a user's personal circle and a shared family circle), but within one circle only one copy is kept.

#### Database Backstop

A partial unique index on `media_items` enforces the invariant at the database level:

```sql
CREATE UNIQUE INDEX "media_items_circle_content_hash_active_key"
  ON "media_items" ("circle_id", "content_hash")
  WHERE "content_hash" IS NOT NULL AND "deleted_at" IS NULL;
```

The `WHERE` predicate serves two purposes:

- `content_hash IS NOT NULL` — rows where no hash has been computed yet are never constrained, so the pipeline can still ingest files whose hash is not yet known.
- `deleted_at IS NULL` — soft-deleted rows are excluded, allowing a user to re-import a file they previously trashed without triggering a constraint violation.

**Note:** This index is hand-authored in a migration and is not represented in `schema.prisma`. Prisma cannot express partial unique indexes, and a plain `@@unique` directive would wrongly constrain `NULL` hash rows.

#### Full Deduplication Flow

```
Client                         API                             DB
  │                              │                               │
  │  1. Compute SHA-256          │                               │
  │     (streaming, in-memory)   │                               │
  │                              │                               │
  │  2. GET /api/media           │                               │
  │     ?contentHash=<hash>      │                               │
  │◀─────────────────────────────│  Query media_items            │
  │                              │◀──────────────────────────────│
  │  If items.length > 0 →       │                               │
  │    skip upload entirely      │                               │
  │    show "Already in library" │                               │
  │                              │                               │
  │  3. Upload file bytes        │                               │
  │     (multipart to S3)        │                               │
  │                              │                               │
  │  4. POST /api/media          │                               │
  │     { storageObjectId,       │                               │
  │       contentHash, ... }     │                               │
  │─────────────────────────────▶│                               │
  │                              │  Fast-path check:             │
  │                              │  findFirst where hash = ?     │
  │                              │◀──────────────────────────────│
  │                              │  If duplicate found:          │
  │                              │    delete redundant blob      │
  │                              │    return existing item       │
  │                              │    HTTP 200, dedup: true      │
  │                              │  Else:                        │
  │                              │    INSERT media_item          │
  │                              │◀──────────────────────────────│
  │                              │  If P2002 (race):             │
  │                              │    fetch winner               │
  │                              │    delete redundant blob      │
  │                              │    return winner              │
  │                              │    HTTP 200, dedup: true      │
  │                              │  Else:                        │
  │                              │    HTTP 201, dedup: false     │
  │◀─────────────────────────────│                               │
```

#### Race Handling

The fast-path pre-check and the DB `INSERT` are not atomic. If two sessions upload the same content concurrently the unique index fires a `P2002` constraint violation on the second write. The service catches that error, fetches the winning row, cleans up the redundant blob, and returns the winner — so callers always receive a valid item regardless of which session "won".

#### Redundant Blob Cleanup

When a dedup hit is detected (either via the pre-check or the P2002 race path) the newly-uploaded `StorageObject` blob is deleted from the storage backend and the `StorageObject` row is removed from the database. Both operations are wrapped independently and log warnings on failure rather than failing the request, so a transient storage error does not block the caller from receiving their item.

#### Hash Source and Trust

| Source | Hash origin | Notes |
|--------|-------------|-------|
| Web UI (`MediaUploadDialog`) | Client-side, via `hash-wasm` streaming SHA-256 | `apps/web/src/utils/sha256.ts` |
| CLI (`SyncEngine`) | Node.js `crypto`, cached by size + `mtime_ms` | `apps/cli/src/sync/sync-engine.ts` |
| Post-upload processor | Server-side `content-hash` `ObjectProcessor` | Stored in `StorageObject.metadata._processing['content-hash'].sha256` |
| `MediaMetadataSyncService` | Reads server hash from `_processing`; sets `contentHash` only when `NULL` | Warns on client/server mismatch but keeps the client-supplied value |

The server-computed hash is authoritative for integrity verification. If the client-supplied hash and the server-computed hash disagree (tampered upload or encoding difference), a warning is logged and the client-supplied value is retained.

#### Where Each Piece Lives

| Piece | Location |
|-------|----------|
| Partial unique index migration | `apps/api/prisma/migrations/20260612000000_add_media_content_hash_unique/` |
| `POST /api/media` dedup logic | `apps/api/src/media/media.service.ts` → `createMedia` |
| Redundant blob cleanup | `apps/api/src/media/media.service.ts` → `cleanupRedundantStorageObject` |
| Metadata sync / hash backfill | `apps/api/src/media/sync/media-metadata-sync.service.ts` → `syncFromStorageObject` |
| `contentHash` field definition | `apps/api/src/media/dto/create-media.dto.ts` |
| `?contentHash=` query param | `apps/api/src/media/dto/media-query.dto.ts` |
| Web client SHA-256 utility | `apps/web/src/utils/sha256.ts` |
| Web pre-check + dedup UI | `apps/web/src/components/media/MediaUploadDialog.tsx` |
| CLI hash cache + dedup flow | `apps/cli/src/sync/sync-engine.ts` |

---

### 5.10 AI / Search Subsystem

The AI / Search subsystem provides two complementary modes for finding media within a circle:

| Mode | Endpoint | Description |
|------|----------|-------------|
| **Deterministic** | `POST /api/search` | Explicit filter criteria; same semantics as `GET /api/media` |
| **Agentic / Conversational** | `POST /api/search/conversations/:id/messages` | Natural-language queries streamed via SSE |

Both modes are driven by the same `SearchableFieldRegistry` — the registry is the single source of truth for all filter dimensions. Adding a new search dimension (e.g. people via face recognition) requires only one edit to `searchable-fields.registry.ts` and both modes gain the capability automatically.

```
apps/api/src/
├── ai/
│   ├── ai-settings.controller.ts    # Admin credential + feature config endpoints
│   ├── ai-settings.service.ts       # Encrypt/decrypt credentials; settings CRUD
│   └── providers/
│       ├── ai-provider.interface.ts  # AiProvider interface (chat/listModels/testModel)
│       ├── ai-provider.registry.ts   # Registry: anthropic, openai
│       ├── anthropic.provider.ts     # Anthropic SDK adapter
│       └── openai.provider.ts        # OpenAI SDK adapter (also handles compatible APIs)
└── search/
    ├── search.controller.ts          # POST /search, GET /search/fields
    ├── searchable-fields.registry.ts # SEARCHABLE_FIELDS + buildWhereFromFields
    ├── media-where.builder.ts        # Leaf Prisma where-clause helpers
    ├── agent/
    │   ├── search-agent.service.ts   # Multi-turn tool-call loop + SSE emitter
    │   └── search-tool-schema.ts     # Derives search_media JSON Schema from registry
    ├── conversations/
    │   ├── conversations.controller.ts
    │   └── conversations.service.ts
    └── tasks/
        └── conversation-lifecycle.task.ts  # Daily cron: archive + soft-delete
```

**Key design properties:**

- The `search_media` tool schema is derived at runtime from `SEARCHABLE_FIELDS` on every agent turn — the tool and the deterministic endpoint always accept the same fields with no divergence risk.
- The agent's `circleId` is pinned server-side from the `SearchConversation` row; the model cannot redirect a search to a different circle.
- AI provider API keys are stored AES-256-GCM encrypted via `SECRETS_ENCRYPTION_KEY`. Plaintext keys are never stored or returned.
- Conversations auto-archive after `ai.conversations.archiveAfterDays` days of inactivity and are soft-deleted after a further `deleteAfterArchiveDays` days. Favorites are exempt.

For the complete specification including the extensibility recipe, provider abstraction, SSE protocol, and security details, see **[docs/specs/agentic-search.md](specs/agentic-search.md)**.

---

## 6. Data Architecture

### 6.1 Entity Relationship Diagram

#### Family Circles (new in FC)

```
┌────────────────────┐       ┌─────────────────────────┐
│      circles       │       │     circle_members      │
├────────────────────┤       ├─────────────────────────┤
│ id (PK, UUID)      │──┐    │ id (PK, UUID)           │
│ name               │  │    │ circle_id (FK)    ◀─────┘
│ description        │  └───▶│ user_id (FK)            │
│ owner_id (FK)      │       │ role (CircleRole enum)  │
│ is_personal        │       │ created_at              │
│ created_at         │       │ updated_at              │
│ updated_at         │       │ UNIQUE(circle_id,user_id)│
└────────────────────┘       └─────────────────────────┘
         │
         ▼
┌────────────────────┐
│   circle_invites   │
├────────────────────┤
│ id (PK, UUID)      │
│ circle_id (FK)     │
│ email              │
│ role (CircleRole)  │
│ added_by_id (FK)   │
│ added_at           │
│ claimed_by_id (FK) │
│ claimed_at         │
│ notes              │
│ UNIQUE(circle_id,  │
│   email)           │
└────────────────────┘
```

`CircleRole` enum values: `circle_admin`, `collaborator`, `viewer`.

`circles.owner_id` is a display/seed convenience. Authorization always derives from `circle_members.role`, never from `owner_id` directly.

#### Media Domain (circle-scoped since FC)

`media_items`, `albums`, and `tags` all carry a `circle_id (FK → circles)` and `added_by_id (FK → users)`. The field was renamed from `owner_id` to `added_by_id` (mapped column `added_by_id`) to reflect the shared-library semantic — any collaborator can add items; the field records who added it, not who "owns" it.

Tag uniqueness is `(circle_id, name)` (was `(owner_id, name)`).
Content-hash dedup is `(circle_id, content_hash)` (was `(owner_id, content_hash)`).

`storage_objects` has no `circle_id`. Download authorization resolves via `storage_object → media_item → circle_id`.

#### Legacy ERD

```
┌────────────────────┐       ┌────────────────────┐
│       users        │       │   user_identities  │
├────────────────────┤       ├────────────────────┤
│ id (PK, UUID)      │──┐    │ id (PK, UUID)      │
│ email (UNIQUE)     │  │    │ user_id (FK)       │──┘
│ display_name       │  └───▶│ provider           │
│ provider_display   │       │ provider_subject   │
│ profile_image_url  │       │ provider_email     │
│ provider_image_url │       │ created_at         │
│ is_active          │       └────────────────────┘
│ created_at         │
│ updated_at         │       ┌────────────────────┐
└────────────────────┘       │    user_settings   │
         │                   ├────────────────────┤
         │                   │ id (PK, UUID)      │
         │                   │ user_id (FK, UNIQUE)│◀─┐
         │                   │ value (JSONB)      │  │
         │                   │ version            │  │
         ▼                   │ updated_at         │  │
┌────────────────────┐       └────────────────────┘  │
│    user_roles      │                               │
├────────────────────┤                               │
│ user_id (FK, PK)   │───────────────────────────────┘
│ role_id (FK, PK)   │──┐
└────────────────────┘  │    ┌────────────────────┐
                        │    │       roles        │
                        │    ├────────────────────┤
                        └───▶│ id (PK, UUID)      │
                             │ name (UNIQUE)      │
                             │ description        │
                             └────────────────────┘
                                       │
                                       ▼
                             ┌────────────────────┐
                             │  role_permissions  │
                             ├────────────────────┤
                             │ role_id (FK, PK)   │
                             │ permission_id (PK) │──┐
                             └────────────────────┘  │
                                                     │
                             ┌────────────────────┐  │
                             │    permissions     │  │
                             ├────────────────────┤  │
                             │ id (PK, UUID)      │◀─┘
                             │ name (UNIQUE)      │
                             │ description        │
                             └────────────────────┘

┌────────────────────┐       ┌────────────────────┐
│  system_settings   │       │   refresh_tokens   │
├────────────────────┤       ├────────────────────┤
│ id (PK, UUID)      │       │ id (PK, UUID)      │
│ key (UNIQUE)       │       │ user_id (FK)       │
│ value (JSONB)      │       │ token_hash (UNIQUE)│
│ version            │       │ expires_at         │
│ updated_by_user_id │       │ created_at         │
│ updated_at         │       │ revoked_at         │
└────────────────────┘       └────────────────────┘

┌────────────────────┐       ┌────────────────────┐
│   allowed_emails   │       │    device_codes    │
├────────────────────┤       ├────────────────────┤
│ id (PK, UUID)      │       │ id (PK, UUID)      │
│ email (UNIQUE)     │       │ device_code_hash   │
│ added_by_id (FK)   │       │ user_code (UNIQUE) │
│ added_at           │       │ user_id (FK)       │
│ claimed_by_id (FK) │       │ client_info (JSONB)│
│ claimed_at         │       │ status             │
│ notes              │       │ expires_at         │
└────────────────────┘       │ last_polled_at     │
                             └────────────────────┘

┌────────────────────┐
│    audit_events    │
├────────────────────┤
│ id (PK, UUID)      │
│ actor_user_id (FK) │
│ action             │
│ target_type        │
│ target_id          │
│ meta (JSONB)       │
│ created_at         │
└────────────────────┘

┌────────────────────┐       ┌────────────────────────┐
│  storage_objects   │       │ storage_object_chunks  │
├────────────────────┤       ├────────────────────────┤
│ id (PK, UUID)      │──┐    │ id (PK, UUID)          │
│ owner_id (FK)      │  │    │ object_id (FK)         │──┘
│ name               │  └───▶│ part_number            │
│ size               │       │ e_tag                  │
│ mime_type          │       │ size                   │
│ storage_key        │       │ status                 │
│ storage_provider   │       │ created_at             │
│ upload_id          │       │ completed_at           │
│ status             │       └────────────────────────┘
│ metadata (JSONB)   │
│ created_at         │
│ updated_at         │
└────────────────────┘
```

### 6.2 JSONB Schema Definitions

#### User Settings Shape

```json
{
  "theme": "light | dark | system",
  "profile": {
    "displayName": "string | null",
    "useProviderImage": true,
    "customImageUrl": "string | null"
  },
  "activeCircleId": "uuid | null"
}
```

`activeCircleId` is a UX convenience: it records which circle the user last selected in the web app or CLI. It is **never trusted for authorization** — the API always re-verifies membership via `circle_members`.


#### System Settings Shape

```json
{
  "ui": {
    "allowUserThemeOverride": true
  },
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "features": {
    "exampleFlag": false
  }
}
```

### 6.3 Database Design Principles

| Principle | Implementation |
|-----------|---------------|
| **UUID Primary Keys** | All tables use UUID v4 for primary keys |
| **Timestamptz** | All timestamps use `timestamptz` for timezone awareness |
| **JSONB for Flexibility** | Settings stored as JSONB for schema-less extensibility |
| **Cascade Deletes** | Foreign keys cascade on user deletion |
| **Soft Deletes** | Users deactivated via `is_active` flag, not hard deleted |
| **Audit Trail** | `audit_events` table logs all security-relevant actions |

---

## 7. Security Architecture

### 7.1 Authentication Flow

```
┌─────────┐          ┌─────────┐          ┌─────────┐          ┌─────────┐
│  User   │          │ Frontend│          │   API   │          │ Google  │
└────┬────┘          └────┬────┘          └────┬────┘          └────┬────┘
     │                    │                    │                    │
     │  1. Click Login    │                    │                    │
     │───────────────────▶│                    │                    │
     │                    │                    │                    │
     │                    │ 2. Redirect to     │                    │
     │                    │    /api/auth/google│                    │
     │                    │───────────────────▶│                    │
     │                    │                    │                    │
     │                    │                    │ 3. Redirect to     │
     │◀───────────────────┼────────────────────┼────────────────────│
     │                    │                    │    Google OAuth    │
     │                    │                    │                    │
     │  4. Grant Consent  │                    │                    │
     │────────────────────┼────────────────────┼───────────────────▶│
     │                    │                    │                    │
     │                    │                    │ 5. Callback with   │
     │                    │                    │◀───────────────────│
     │                    │                    │    auth code       │
     │                    │                    │                    │
     │                    │                    │ 6. Exchange code   │
     │                    │                    │    for tokens      │
     │                    │                    │───────────────────▶│
     │                    │                    │                    │
     │                    │                    │◀───────────────────│
     │                    │                    │    User profile    │
     │                    │                    │                    │
     │                    │                    │ 7. Check allowlist │
     │                    │                    │    Provision user  │
     │                    │                    │    (new user only) │
     │                    │                    │    Create personal │
     │                    │                    │    circle + admin  │
     │                    │                    │    membership      │
     │                    │                    │    Claim pending   │
     │                    │                    │    circle invites  │
     │                    │                    │    Generate JWT    │
     │                    │                    │    Store refresh   │
     │                    │                    │                    │
     │                    │ 8. Redirect with   │                    │
     │                    │◀───────────────────│                    │
     │                    │    access token    │                    │
     │                    │    + refresh cookie│                    │
     │                    │                    │                    │
     │ 9. Authenticated   │                    │                    │
     │◀───────────────────│                    │                    │
     │                    │                    │                    │
```

### 7.2 Token Strategy

| Token Type | Storage (Client) | Storage (Server) | Lifetime | Purpose |
|------------|-----------------|------------------|----------|---------|
| **Access Token** | Memory only | None (stateless) | 15 min | API authorization |
| **Refresh Token** | HttpOnly cookie | SHA256 hash in DB | 14 days | Obtain new access tokens |

**Security Properties:**
- Access tokens never touch localStorage (XSS protection)
- Refresh tokens in HttpOnly cookies (JavaScript cannot access)
- Refresh token rotation on each use (reuse detection)
- Database allows server-side revocation

### 7.3 RBAC Model (Two-Layer Authorization)

The system uses two independent authorization layers that work together.

**Layer 1: Global system RBAC** (unchanged from the foundation)

```
                    ┌─────────────────────────────────────────────┐
                    │         GLOBAL PERMISSIONS (excerpt)         │
                    ├─────────────────────────────────────────────┤
                    │ system_settings:read/write                   │
                    │ user_settings:read/write                     │
                    │ users:read/write  │  rbac:manage             │
                    │ allowlist:read/write                         │
                    │ media:read/write/delete                      │
                    │ media:read_any / write_any / delete_any      │
                    │ circles:read  │  circles:write               │
                    │ circles:manage_any (Admin)                   │
                    │ backup:run  │  backup:read (Admin)           │
                    └────────────┬─────────────────────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│     ADMIN     │      │  CONTRIBUTOR  │      │    VIEWER     │
├───────────────┤      ├───────────────┤      ├───────────────┤
│ ALL perms     │      │ circles:read/ │      │ circles:read/ │
│ incl. _any    │      │   write       │      │   write       │
│ backup:run/   │      │ media:read/   │      │ media:read/   │
│   read        │      │   write/delete│      │   write/delete│
│               │      │ user_settings:│      │ user_settings:│
│ Super-admin   │      │   read/write  │      │   read/write  │
│ bypass for    │      │               │      │               │
│ all circles   │      │ (Standard     │      │ (Least        │
│               │      │  user)        │      │  privilege)   │
└───────────────┘      └───────────────┘      └───────────────┘
```

Note: `circles:read` and `circles:write` are granted to all three global roles. They grant API access to the circles endpoints; the per-circle role (Layer 2) governs what a user can do within a specific circle.

**Layer 2: Per-circle roles** (new in FC)

Each `circle_members` row carries a `CircleRole` enum. This layer is enforced by `CircleMembershipService.assertCircleAccess()` inside service methods, not by NestJS guards.

| Per-circle Role | Rank | Capabilities |
|-----------------|------|--------------|
| `viewer` | 1 | Read media, albums, tags in the circle |
| `collaborator` | 2 | All viewer capabilities + add/edit/delete media, albums, tags |
| `circle_admin` | 3 | All collaborator capabilities + manage members and invites |

**Super-admin bypass**: If the caller's global permissions include `circles:manage_any`, `media:read_any`, or `media:write_any`, the per-circle membership check is skipped entirely (`isSuperAdmin: true`). This allows the global Admin to manage any circle's content without being a member.

### 7.4 Access Control Layers

```
Request → Nginx → JwtAuthGuard → RolesGuard → PermissionsGuard → Controller
            │           │             │              │                  │
            │           │             │              └── Check @Permissions()   │
            │           │             │                  AND logic (all required)│
            │           │             │                                          │
            │           │             └── Check @Roles()                        │
            │           │                 OR logic (any role matches)           │
            │           │                                                        │
            │           └── Validate JWT, load user+roles+permissions           │
            │               Check user is active                                │
            │                                                          ▼
            │                                              (circle-scoped endpoints only)
            │                                              CircleMembershipService
            │                                              .assertCircleAccess()
            │                                              per-circle role check
            │
            └── Security headers, rate limiting (optional)
```

### 7.5 Email Allowlist

Before OAuth authentication completes:

1. Check if email matches `INITIAL_ADMIN_EMAIL` (bypass check)
2. Check if email exists in `allowed_emails` table
3. If not found, reject with "Email not authorized"
4. If found, proceed with user provisioning
5. Mark allowlist entry as "claimed" with user ID

**Management:**
- Admins add emails via `/api/allowlist` before users can login
- Claimed entries cannot be removed (protects existing users)
- Use user deactivation (`is_active: false`) to revoke access

---

## 8. API Architecture

### 8.1 Endpoint Categories

| Category | Base Path | Auth Required | Description |
|----------|-----------|---------------|-------------|
| **Health** | `/api/health/*` | No | Liveness/readiness probes |
| **Auth** | `/api/auth/*` | Varies | OAuth, JWT, sessions |
| **Users** | `/api/users/*` | Yes (Admin) | User management |
| **Settings** | `/api/user-settings/*` | Yes | User preferences |
| **System Settings** | `/api/system-settings/*` | Yes (Admin) | App configuration |
| **Allowlist** | `/api/allowlist/*` | Yes (Admin) | Access control |
| **Circles** | `/api/circles/*` | Yes | Circle CRUD, members, invites |
| **Admin Circles** | `/api/admin/circles` | Yes (Admin) | Cross-circle admin view |
| **Admin Backup** | `/api/admin/backup/*` | Yes (Admin) | Local-drive backup/replication |
| **Media Bulk** | `/api/media/bulk*` | Yes (`media:write` / `media:delete`) | Bulk update/tag/delete media items |
| **Geo** | `/api/media/geo/*` | Yes (`media:read`) | Reverse and forward geocoding |
| **Dashboard** | `/api/media/dashboard` | Yes (`media:read`) | Circle dashboard aggregation |

### 8.2 Complete Endpoint Reference

#### Authentication Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/auth/providers` | Public | List enabled OAuth providers |
| `GET` | `/api/auth/google` | Public | Initiate Google OAuth |
| `GET` | `/api/auth/google/callback` | Public | OAuth callback handler |
| `POST` | `/api/auth/refresh` | Cookie | Refresh access token |
| `POST` | `/api/auth/logout` | JWT | Single session logout |
| `POST` | `/api/auth/logout-all` | JWT | All sessions logout |
| `GET` | `/api/auth/me` | JWT | Current user info |
| `POST` | `/api/auth/test/login` | Public | Test login bypass (dev only) |

#### Device Authorization (RFC 8628)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/auth/device/code` | Public | Generate device code |
| `POST` | `/api/auth/device/token` | Public | Poll for authorization |
| `GET` | `/api/auth/device/activate` | JWT | Get activation info |
| `POST` | `/api/auth/device/authorize` | JWT | Approve/deny device |
| `GET` | `/api/auth/device/sessions` | JWT | List device sessions |
| `DELETE` | `/api/auth/device/sessions/:id` | JWT | Revoke device session |

#### User Management (Admin)

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/api/users` | `users:read` | List users (paginated) |
| `GET` | `/api/users/:id` | `users:read` | Get user details |
| `PATCH` | `/api/users/:id` | `users:write` | Update user |
| `PUT` | `/api/users/:id/roles` | `rbac:manage` | Update user roles |

#### Settings

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/api/user-settings` | `user_settings:read` | Get user settings |
| `PUT` | `/api/user-settings` | `user_settings:write` | Replace settings |
| `PATCH` | `/api/user-settings` | `user_settings:write` | Partial update |
| `GET` | `/api/system-settings` | `system_settings:read` | Get system settings |
| `PUT` | `/api/system-settings` | `system_settings:write` | Replace settings |
| `PATCH` | `/api/system-settings` | `system_settings:write` | Partial update |

#### Allowlist (Admin)

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/api/allowlist` | `allowlist:read` | List allowlisted emails |
| `POST` | `/api/allowlist` | `allowlist:write` | Add email |
| `DELETE` | `/api/allowlist/:id` | `allowlist:write` | Remove email (if pending) |

#### Health

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/health` | Public | Full health check |
| `GET` | `/api/health/live` | Public | Liveness probe |
| `GET` | `/api/health/ready` | Public | Readiness probe (+ DB) |

#### Circles

| Method | Path | Permission | Per-circle Role | Purpose |
|--------|------|------------|-----------------|---------|
| `POST` | `/api/circles` | `circles:write` | — | Create circle |
| `GET` | `/api/circles` | `circles:read` | — | List member circles (`?all=true` admin) |
| `GET` | `/api/circles/:id` | `circles:read` | viewer | Get circle details |
| `PATCH` | `/api/circles/:id` | `circles:write` | circle_admin | Update circle |
| `DELETE` | `/api/circles/:id` | `circles:write` | circle_admin | Delete circle (not personal) |
| `GET` | `/api/circles/:id/members` | `circles:read` | viewer | List members |
| `POST` | `/api/circles/:id/members` | `circles:write` | circle_admin | Add member by user ID |
| `PATCH` | `/api/circles/:id/members/:userId` | `circles:write` | circle_admin | Change member role |
| `DELETE` | `/api/circles/:id/members/:userId` | `circles:read` | viewer (self-leave) or circle_admin | Remove member |
| `GET` | `/api/circles/:id/invites` | `circles:read` | circle_admin | List invites |
| `POST` | `/api/circles/:id/invites` | `circles:write` | circle_admin | Create invite + allowlist upsert |
| `DELETE` | `/api/circles/:id/invites/:inviteId` | `circles:write` | circle_admin | Revoke pending invite |

#### Media Bulk Operations

| Method | Path | Permission | Per-circle Role | Purpose |
|--------|------|------------|-----------------|---------|
| `PATCH` | `/api/media/bulk` | `media:write` | collaborator | Bulk update location / classification / favorite |
| `POST` | `/api/media/bulk/tags` | `media:write` | collaborator | Bulk add/remove tags |
| `POST` | `/api/media/bulk/delete` | `media:delete` | collaborator | Bulk soft-delete |

#### Geo Services

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/api/media/geo/reverse` | `media:read` | On-demand reverse geocode (offline by default) |
| `GET` | `/api/media/geo/search` | `media:read` | Forward geocoding via Nominatim (requires `GEO_FORWARD_SEARCH_ENABLED=true`) |

#### Circle Dashboard

| Method | Path | Permission | Per-circle Role | Purpose |
|--------|------|------------|-----------------|---------|
| `GET` | `/api/media/dashboard` | `media:read` | viewer | On This Day, recent, favorites, review-queue counts |

#### Admin Backup

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `POST` | `/api/admin/backup` | `backup:run` (Admin role required) | Trigger local-drive replication |
| `GET` | `/api/admin/backup/runs` | `backup:read` (Admin) | List recent backup runs |
| `GET` | `/api/admin/backup/status` | `backup:read` (Admin) | Alias for `/runs` |
| `GET` | `/api/admin/backup/runs/:runId` | `backup:read` (Admin) | Get specific run status |
| `GET` | `/api/admin/backup/objects` | `backup:read` (Admin) | List objects with signed URLs |

### 8.3 Response Format

#### Success Response

```json
{
  "data": {
    // Response payload
  },
  "meta": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "total": 100,
    "page": 1,
    "pageSize": 20,
    "totalPages": 5
  }
}
```

#### Error Response

```json
{
  "statusCode": 400,
  "message": "Human readable error message",
  "error": "BadRequest",
  "details": {
    // Additional context
  }
}
```

---

## 9. Frontend Architecture

### 9.1 Page Structure

| Page | Route | Auth | Role | Purpose |
|------|-------|------|------|---------|
| Login | `/login` | Public | - | OAuth provider selection |
| Auth Callback | `/auth/callback` | Public | - | Token handling |
| Home | `/` | Required | Any | Circle dashboard — On This Day, recent, favorites, review queue |
| User Settings | `/settings` | Required | Any | User preferences |
| Media Library | `/media` | Required | Any | Browse and upload media; multi-select with bulk geo/tag/classification/delete toolbar |
| Map | `/map` | Required | Any | Clustered map of geotagged media (active circle) |
| Circle List | `/circles` | Required | Any | List and create circles |
| Circle Detail | `/circles/:id` | Required | Any | Members, invites, and content for one circle |
| System Settings | `/admin/settings` | Required | Admin | App configuration |
| User Management | `/admin/users` | Required | Admin | User/allowlist mgmt |
| Admin Circles | `/admin/circles` | Required | Admin | Cross-circle admin view |
| Admin Backup | `/admin/backup` | Required | Admin | Trigger and monitor backup runs |
| Device Activation | `/device` | Required | Any | Device auth approval |
| Test Login | `/testing/login` | Public | - | Test auth bypass (dev only) |

**Note:** The `/testing/login` route is excluded from production builds via `import.meta.env.PROD` check.

### 9.2 Context Providers

```tsx
<App>
  <ThemeProvider>        {/* MUI theme + dark mode */}
    <AuthProvider>       {/* Authentication state */}
      <SettingsProvider> {/* User settings (includes activeCircleId) */}
        <CircleProvider> {/* Active circle, member circles, per-circle role */}
          <RouterProvider> {/* React Router */}
            <Layout>       {/* AppBar includes CircleSwitcher */}
              <Pages />
            </Layout>
          </RouterProvider>
        </CircleProvider>
      </SettingsProvider>
    </AuthProvider>
  </ThemeProvider>
</App>
```

### 9.3 Authentication State

```typescript
interface AuthContext {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  accessToken: string | null;
  login: (provider: string) => void;
  logout: () => Promise<void>;
  refreshToken: () => Promise<void>;
}
```

### 9.4 Protected Routes

```tsx
<Route path="/admin/*" element={
  <ProtectedRoute requiredRole="admin">
    <AdminLayout />
  </ProtectedRoute>
} />
```

### 9.5 Media Viewing

The media library ships three specialised viewing components beyond the basic thumbnail grid.

#### Video player (`apps/web/src/components/media/VideoPlayer.tsx`)

Built on [Vidstack](https://www.vidstack.io/) (`@vidstack/react`) using `DefaultVideoLayout`. Key capabilities:

- Full playback controls: play/pause, scrubber, elapsed/remaining time, volume, fullscreen, Picture-in-Picture.
- Playback-speed menu (0.25× – 2×) provided by `DefaultVideoLayout` out of the box.
- Double-tap seek gestures (YouTube-mobile style): left half of the player = −10 s, right half = +10 s. Implemented via Vidstack `<Gesture event="dblpointerup" action="seek:±10" />` declarative descriptors.
- 16:9 aspect-ratio wrapper so the player scales to the containing column width.
- Video source is the signed S3 `downloadUrl` returned by `GET /api/media/:id`; the URL supports HTTP range requests, enabling seeking without buffering the entire file.

The player is rendered inside `MediaDetailDrawer` for items of type `"video"`. The drawer fetches the full item via `getMedia(id)` before opening so that `downloadUrl` is available.

#### Location mini-map (`apps/web/src/components/media/LocationMiniMap.tsx`)

A compact Leaflet map pinning a single GPS coordinate. Rendered in the Location section of `MediaDetailDrawer` when `takenLat` and `takenLng` are non-null. Characteristics:

- Fixed 200 px height, full container width, 8 px border-radius.
- Scroll-wheel zoom disabled to avoid hijacking page scroll inside the drawer.
- Zoom level 13 (neighbourhood level) centred on the coordinate.
- Tile source: OpenStreetMap (`https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`). The OSM copyright attribution is rendered inside the map as required by the [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/). No API key or third-party map provider is needed.
- An optional label string is shown in a Leaflet `Popup` attached to the marker.

#### Clustered map page (`apps/web/src/pages/MediaMapPage/MediaMapPage.tsx`)

The `/map` route renders a full-viewport Leaflet map of all the caller's geotagged media.

| Aspect | Detail |
|--------|--------|
| Data source | `GET /api/media/locations` — single unbounded request; all geotagged items loaded once on mount |
| Tile source | OpenStreetMap (same tiles as the mini-map; OSM attribution displayed) |
| Clustering | `leaflet.markercluster` via the custom `MarkerClusterGroup` wrapper (`apps/web/src/components/map/MarkerClusterGroup.tsx`). The wrapper manages the cluster group imperatively via `useMap()` and uses a `WeakMap` to associate each `L.Marker` with its media ID without attaching non-standard properties to Leaflet objects. |
| Cluster click | Emits the collected media IDs → opens a right-side `Drawer` ("album panel") showing a thumbnail grid of the items at that location. |
| Single-marker click | Calls `getMedia(id)` to obtain the full item (including `downloadUrl`) then opens `MediaDetailDrawer` — the same drawer used in the library view. |
| Fit-bounds | After locations load the map auto-fits to the bounding box of all points (single point: zoom 13; multiple: `fitBounds` with 40 px padding). |
| Empty state | When the user has no geotagged media a centred empty-state message is shown over the map. |

---

## 10. Infrastructure Architecture

### 10.1 Docker Services

```yaml
# Core Services (base.compose.yml)
services:
  nginx:        # Reverse proxy (port 3535)
  api:          # NestJS backend (port 3000)
  web:          # React frontend (port 5173)
  db:           # PostgreSQL (port 5432)

# Observability (otel.compose.yml)
services:
  otel-collector:  # OpenTelemetry Collector
  uptrace:         # Trace/metric visualization (port 14318)
  clickhouse:      # Uptrace storage backend
```

### 10.2 Network Topology

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Network                           │
│                                                             │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐  │
│  │  nginx  │    │   api   │    │   web   │    │   db    │  │
│  │  :3535  │───▶│  :3000  │    │  :5173  │    │  :5432  │  │
│  │         │    └─────────┘    └─────────┘    └─────────┘  │
│  │         │         │                            ▲        │
│  │         │─────────┼────────────────────────────┘        │
│  └─────────┘         │                                     │
│       │              ▼                                     │
│       │         ┌─────────┐                                │
│       │         │  otel   │                                │
│       │         │collector│                                │
│       │         └─────────┘                                │
│       │              │                                     │
│       │              ▼                                     │
│       │         ┌─────────┐    ┌─────────┐                 │
│       │         │ uptrace │───▶│clickhse │                 │
│       │         │ :14318  │    │         │                 │
│       │         └─────────┘    └─────────┘                 │
└───────┼─────────────────────────────────────────────────────┘
        │
        ▼
   External Access
   http://localhost:3535
```

### 10.3 Environment Configuration

Key environment variables (see `infra/compose/.env.example`):

```bash
# Application
NODE_ENV=development
PORT=3000
APP_URL=http://localhost:3535

# Database
POSTGRES_HOST=db
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=appdb

# JWT
JWT_SECRET=<min-32-character-secret>
JWT_ACCESS_TTL_MINUTES=15
JWT_REFRESH_TTL_DAYS=14

# OAuth
GOOGLE_CLIENT_ID=<from-google-console>
GOOGLE_CLIENT_SECRET=<from-google-console>
GOOGLE_CALLBACK_URL=http://localhost:3535/api/auth/google/callback

# Admin Bootstrap
INITIAL_ADMIN_EMAIL=admin@example.com

# Observability
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

---

## 11. Observability Architecture

### 11.1 Signal Types

| Signal | Collection | Storage | Purpose |
|--------|------------|---------|---------|
| **Traces** | OTEL SDK auto-instrumentation | Uptrace/ClickHouse | Request flow tracking |
| **Metrics** | OTEL SDK | Uptrace/ClickHouse | Performance monitoring |
| **Logs** | Pino structured logs | Uptrace/ClickHouse | Debugging, audit |

### 11.2 Trace Propagation

```
Request → Nginx → API → Database
   │         │       │       │
   └─────────┴───────┴───────┴──▶ trace_id: abc123
                                  spans: [nginx, api, db-query]
```

### 11.3 Log Correlation

```json
{
  "level": "info",
  "time": 1704067200000,
  "msg": "User logged in",
  "requestId": "req-123",
  "traceId": "abc123",
  "spanId": "span456",
  "userId": "user-789"
}
```

### 11.4 Health Checks

| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `/api/health/live` | Kubernetes liveness | Process running |
| `/api/health/ready` | Kubernetes readiness | Process + DB connection |

---

## 12. Testing Architecture

### 12.1 Testing Strategy Overview

The project uses a **mocked database approach** for all tests by default. This provides fast, isolated tests without requiring a running PostgreSQL instance.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         TESTING ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  BACKEND (apps/api/)                    FRONTEND (apps/web/)            │
│  ┌─────────────────────────────┐       ┌─────────────────────────────┐  │
│  │  Jest + Supertest           │       │  Vitest + RTL               │  │
│  │                             │       │                             │  │
│  │  Unit Tests (*.spec.ts)     │       │  Component Tests            │  │
│  │  • Co-located with source   │       │  (*.test.tsx)               │  │
│  │  • Mock all dependencies    │       │  • In __tests__/ folder     │  │
│  │                             │       │  • MSW for API mocking      │  │
│  │  Integration Tests          │       │                             │  │
│  │  (*.integration.spec.ts)    │       │  Context Tests              │  │
│  │  • In test/ directory       │       │  • AuthContext              │  │
│  │  • Full HTTP cycle          │       │  • ThemeContext             │  │
│  │  • Mocked PrismaService     │       │                             │  │
│  │                             │       │                             │  │
│  │  Mocking:                   │       │  Mocking:                   │  │
│  │  • jest-mock-extended       │       │  • MSW (Mock Service Worker)│  │
│  │  • DeepMockProxy<Prisma>    │       │  • vi.fn() for functions    │  │
│  └─────────────────────────────┘       └─────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 12.2 Backend Test Structure

```
apps/api/
├── src/
│   ├── auth/
│   │   ├── auth.service.spec.ts          # Unit test (co-located)
│   │   ├── auth.controller.spec.ts
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.spec.ts
│   │   │   ├── roles.guard.spec.ts
│   │   │   └── permissions.guard.spec.ts
│   │   └── strategies/
│   │       ├── jwt.strategy.spec.ts
│   │       └── google.strategy.spec.ts
│   ├── users/
│   │   └── users.service.spec.ts
│   ├── settings/
│   │   ├── user-settings/
│   │   │   └── user-settings.service.spec.ts
│   │   └── system-settings/
│   │       └── system-settings.service.spec.ts
│   └── common/
│       ├── filters/http-exception.filter.spec.ts
│       └── interceptors/transform.interceptor.spec.ts
│
└── test/
    ├── jest.config.js                    # Jest configuration
    ├── setup.ts                          # Global test setup
    ├── teardown.ts                       # Global cleanup
    ├── helpers/
    │   ├── test-app.helper.ts            # Creates test NestJS app
    │   ├── auth-mock.helper.ts           # Creates mock users with JWTs
    │   └── fixtures.helper.ts            # Test data utilities
    ├── fixtures/
    │   ├── users.fixture.ts              # User test data
    │   ├── roles.fixture.ts              # Role test data
    │   ├── settings.fixture.ts           # Settings test data
    │   ├── test-data.factory.ts          # Factory functions
    │   └── mock-setup.helper.ts          # Base mock configuration
    ├── mocks/
    │   ├── prisma.mock.ts                # Mocked PrismaService
    │   └── google-oauth.mock.ts          # Mocked OAuth strategy
    ├── auth/
    │   ├── auth.integration.spec.ts      # Auth endpoint tests
    │   ├── oauth.integration.spec.ts     # OAuth flow tests
    │   └── allowlist-enforcement.integration.spec.ts
    ├── rbac/
    │   ├── rbac.integration.spec.ts
    │   └── guard-integration.integration.spec.ts
    ├── settings/
    │   ├── user-settings.integration.spec.ts
    │   └── system-settings.integration.spec.ts
    ├── users.integration.spec.ts
    ├── health/
    │   └── health.integration.spec.ts
    └── integration/
        └── device-auth.integration.spec.ts
```

### 12.3 Backend Mocking Strategy

#### Prisma Mocking with jest-mock-extended

All backend tests use a **mocked PrismaService** via `jest-mock-extended`:

```typescript
// test/mocks/prisma.mock.ts
import { DeepMockProxy, mockDeep, mockReset } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

export type MockPrismaClient = DeepMockProxy<PrismaClient>;
export const prismaMock: MockPrismaClient = mockDeep<PrismaClient>();

export function resetPrismaMock(): void {
  mockReset(prismaMock);
}
```

#### Test App Helper

The `createTestApp()` helper creates a fully configured NestJS application with mocked database:

```typescript
// test/helpers/test-app.helper.ts
export async function createTestApp(
  options: { useMockDatabase?: boolean } = {}
): Promise<TestContext> {
  const shouldUseMock = options.useMockDatabase ?? true;  // Default: MOCKED

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(PrismaService)
    .useValue(prismaMock)  // Inject mock instead of real Prisma
    .compile();

  // ... app configuration
  return { app, prisma, prismaMock, module, isMocked: true };
}
```

#### Integration Test Pattern

```typescript
// test/auth/auth.integration.spec.ts
describe('Auth Controller (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();      // Clear all mock calls
    setupBaseMocks();        // Set up default mock responses
  });

  it('should return current user for authenticated request', async () => {
    const user = await createMockTestUser(context);  // Creates user + JWT

    const response = await request(context.app.getHttpServer())
      .get('/api/auth/me')
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(response.body.data).toMatchObject({
      id: user.id,
      email: user.email,
    });
  });
});
```

### 12.4 Frontend Test Structure

```
apps/web/src/
└── __tests__/
    ├── setup.ts                          # Vitest setup (MSW, mocks)
    ├── mocks/
    │   ├── server.ts                     # MSW server instance
    │   ├── handlers.ts                   # API mock handlers
    │   └── data.ts                       # Mock response data
    ├── utils/
    │   ├── test-utils.tsx                # Custom render with providers
    │   ├── mock-providers.tsx            # Test provider wrappers
    │   └── hook-utils.tsx                # Hook testing utilities
    ├── components/
    │   ├── common/
    │   │   ├── LoadingSpinner.test.tsx
    │   │   └── ProtectedRoute.test.tsx
    │   ├── navigation/
    │   │   ├── AppBar.test.tsx
    │   │   ├── Sidebar.test.tsx
    │   │   └── UserMenu.test.tsx
    │   └── admin/
    │       ├── UserList.test.tsx
    │       ├── AllowlistTable.test.tsx
    │       └── AddEmailDialog.test.tsx
    ├── contexts/
    │   ├── AuthContext.test.tsx
    │   └── ThemeContext.test.tsx
    ├── pages/
    │   ├── LoginPage.test.tsx
    │   ├── UserSettingsPage.test.tsx
    │   └── SystemSettingsPage.test.tsx
    └── services/
        └── api.test.ts
```

### 12.5 Frontend Mocking Strategy

#### MSW (Mock Service Worker)

API calls are intercepted at the network level using MSW:

```typescript
// __tests__/mocks/handlers.ts
import { http, HttpResponse } from 'msw';

export const handlers = [
  http.get('/api/auth/me', () => {
    return HttpResponse.json({
      data: {
        id: 'user-1',
        email: 'test@example.com',
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
      },
    });
  }),

  http.get('/api/auth/providers', () => {
    return HttpResponse.json({
      data: {
        providers: [{ name: 'google', displayName: 'Google' }],
      },
    });
  }),

  http.post('/api/auth/logout', () => {
    return new HttpResponse(null, { status: 204 });
  }),
];
```

#### Test Setup

```typescript
// __tests__/setup.ts
import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, afterAll, vi } from 'vitest';
import { server } from './mocks/server';

// Browser API mocks
Object.defineProperty(window, 'matchMedia', { /* ... */ });
global.ResizeObserver = class ResizeObserverMock { /* ... */ };

// MSW lifecycle
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); server.resetHandlers(); });
afterAll(() => server.close());
```

#### Custom Render with Providers

```typescript
// __tests__/utils/test-utils.tsx
import { render } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { AuthProvider } from '../../contexts/AuthContext';

export function renderWithProviders(ui: React.ReactElement, options = {}) {
  return render(ui, {
    wrapper: ({ children }) => (
      <BrowserRouter>
        <ThemeProvider>
          <AuthProvider>
            {children}
          </AuthProvider>
        </ThemeProvider>
      </BrowserRouter>
    ),
    ...options,
  });
}
```

### 12.6 Test Commands

#### Backend

```bash
cd apps/api

npm test                    # Run all tests (unit + integration)
npm run test:unit           # Unit tests only (excludes e2e pattern)
npm run test:watch          # Watch mode
npm run test:cov            # With coverage report
npm run test:debug          # Debug mode with inspector
npm run test:ci             # CI mode (coverage + JUnit reporter)
```

#### Frontend

```bash
cd apps/web

npm test                    # Run tests in watch mode
npm run test:run            # Run once and exit
npm run test:watch          # Interactive watch mode
npm run test:coverage       # With coverage report
npm run test:ui             # Open Vitest UI (browser-based)
npm run test:ci             # CI mode (coverage + JUnit reporter)
```

### 12.7 Test Configuration

#### Backend (Jest)

```javascript
// apps/api/test/jest.config.js
module.exports = {
  testRegex: '.*\\.spec\\.ts$',
  roots: ['<rootDir>/src/', '<rootDir>/test/'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  testTimeout: 30000,
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
```

#### Frontend (Vitest)

```typescript
// apps/web/vitest.config.ts
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      thresholds: {
        lines: 70, branches: 70, functions: 70, statements: 70,
      },
    },
    testTimeout: 10000,
  },
});
```

### 12.8 Key Testing Patterns

| Pattern | Backend | Frontend |
|---------|---------|----------|
| **Database** | Mocked via jest-mock-extended | N/A |
| **API Calls** | Direct HTTP via Supertest | MSW network interception |
| **Authentication** | Mock JWT tokens generated | MSW handlers return user |
| **Test Isolation** | `resetPrismaMock()` in beforeEach | `server.resetHandlers()` in afterEach |
| **Async Handling** | `async/await` with Jest | `waitFor()` from RTL |
| **User Interactions** | N/A | `userEvent` from @testing-library |

### 12.9 Important Notes

1. **No Real Database Required**: All tests run with mocked Prisma - no PostgreSQL needed
2. **Test File Naming**:
   - Backend unit: `*.spec.ts` (co-located with source)
   - Backend integration: `*.integration.spec.ts` (in test/ directory)
   - Frontend: `*.test.tsx` (in __tests__/ directory)
3. **Coverage Thresholds**: Frontend enforces 70% minimum coverage
4. **MSW Strict Mode**: Unhandled API requests fail tests (`onUnhandledRequest: 'error'`)
5. **Type Safety**: Prisma mocks are fully typed via `DeepMockProxy<PrismaClient>`

---

## 13. Agent-Based Development Model

### 13.1 Specialized Agents

This project uses specialized AI coding agents for different domains:

| Agent | File | Domain | Responsibilities |
|-------|------|--------|------------------|
| `backend-dev` | `.claude/agents/backend-dev.md` | API Layer | NestJS controllers, services, guards, OAuth, JWT |
| `frontend-dev` | `.claude/agents/frontend-dev.md` | UI Layer | React components, pages, hooks, MUI theming |
| `database-dev` | `.claude/agents/database-dev.md` | Data Layer | Prisma schema, migrations, seeds, queries |
| `testing-dev` | `.claude/agents/testing-dev.md` | Quality | Jest, Supertest, Vitest, RTL, type checking |
| `docs-dev` | `.claude/agents/docs-dev.md` | Documentation | Architecture, API, security docs |

### 13.2 Agent Invocation Rules

**MANDATORY**: All development tasks MUST be delegated to the appropriate agent.

| Task Type | Required Agent | Example |
|-----------|---------------|---------|
| Add API endpoint | `backend-dev` | "Implement user search endpoint" |
| Create component | `frontend-dev` | "Build user avatar component" |
| Schema change | `database-dev` | "Add email verification table" |
| Write tests | `testing-dev` | "Add integration tests for auth" |
| Update docs | `docs-dev` | "Document new endpoint in API.md" |

### 13.3 Multi-Agent Workflow

For features spanning multiple domains, invoke agents sequentially:

```
Feature: "Add user notification preferences"

1. database-dev  → Add preferences to user_settings schema
2. backend-dev   → Implement API endpoints
3. frontend-dev  → Build settings UI
4. testing-dev   → Write tests for all layers
5. docs-dev      → Update documentation
```

### 13.4 Agent Context

Each agent has full context of:
- System specification document
- Technology stack requirements
- Code patterns and conventions
- Security requirements
- Testing standards

### 13.5 Orchestration Responsibilities

The orchestrating agent (Claude) handles:
- Reading files to understand context
- Answering questions about the codebase
- Planning and coordinating between agents
- Running simple commands (git, npm)
- Reviewing agent outputs

**What NOT to do directly:**
- Write NestJS code (use `backend-dev`)
- Create React components (use `frontend-dev`)
- Modify Prisma schema (use `database-dev`)
- Write tests (use `testing-dev`)
- Update documentation (use `docs-dev`)

---

## 14. Development Workflows

### 14.1 Local Development Setup

```bash
# 1. Clone repository
git clone <repository-url>
cd EnterpriseAppBase

# 2. Configure environment
cp infra/compose/.env.example infra/compose/.env
# Edit .env with your Google OAuth credentials

# 3. Start services
cd infra/compose
docker compose -f base.compose.yml -f dev.compose.yml up

# 4. Seed database (first time only)
docker compose exec api sh
cd /app/apps/api && npx tsx prisma/seed.ts
exit

# 5. Access application
# UI: http://localhost:3535
# API: http://localhost:3535/api
# Swagger: http://localhost:3535/api/docs
```

### 14.2 Database Changes

```bash
# 1. Modify schema
# Edit apps/api/prisma/schema.prisma

# 2. Create migration
cd apps/api
npm run prisma:migrate:dev -- --name descriptive_name

# 3. Generate client
npm run prisma:generate

# 4. Update seeds if needed
# Edit apps/api/prisma/seed.ts
```

### 14.3 Adding New Features

1. **Plan**: Identify which agents are needed
2. **Database**: Schema changes via `database-dev`
3. **Backend**: API implementation via `backend-dev`
4. **Frontend**: UI implementation via `frontend-dev`
5. **Testing**: Test coverage via `testing-dev`
6. **Documentation**: Updates via `docs-dev`

### 14.4 Testing

See [Section 12: Testing Architecture](#12-testing-architecture) for comprehensive testing documentation.

```bash
# Backend tests (all use mocked database)
cd apps/api
npm test                    # All tests (unit + integration)
npm run test:watch          # Watch mode
npm run test:cov            # With coverage

# Frontend tests
cd apps/web
npm test                    # Watch mode
npm run test:run            # Run once
npm run test:coverage       # With coverage
npm run test:ui             # Visual Vitest UI

# Type checking
cd apps/api && npm run typecheck
cd apps/web && npm run typecheck
```

---

## 15. Appendices

### 15.1 Quick Reference

#### Service URLs (Development)

| Service | URL |
|---------|-----|
| Application | http://localhost:3535 |
| Swagger UI | http://localhost:3535/api/docs |
| Uptrace | http://localhost:14318 |
| PostgreSQL | localhost:5432 |

#### Key Commands

```bash
# Start dev environment
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml up

# Start with observability
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f otel.compose.yml up

# Run migrations
cd apps/api && npm run prisma:migrate:dev -- --name <name>

# Generate Prisma client
cd apps/api && npm run prisma:generate

# Run tests
cd apps/api && npm test
cd apps/web && npm test
```

### 15.2 Related Documents

| Document | Purpose |
|----------|---------|
| [System_Specification_Document.md](System_Specification_Document.md) | Full system requirements |
| [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md) | Detailed security documentation |
| [API.md](API.md) | API endpoint reference |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Development guide |
| [TESTING.md](TESTING.md) | Testing framework guide |
| [DEVICE-AUTH.md](DEVICE-AUTH.md) | Device authorization guide |
| [CLAUDE.md](../CLAUDE.md) | AI assistant guidance |

### 15.3 Specification Index

Implementation specs in `docs/specs/`:

| Phase | Specs | Description |
|-------|-------|-------------|
| Foundation | 01-03 | Project setup, database schema, seeds |
| API Core | 04-07 | NestJS setup, OAuth, JWT, RBAC |
| API Features | 08-12 | Users, settings, health, observability |
| Frontend | 13-18 | React setup, pages, components |
| Testing | 19-24 | Test frameworks, unit/integration tests |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | January 2026 | AI Assistant | Initial comprehensive architecture document |
