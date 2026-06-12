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

### 5.5 Content-Hash Deduplication

#### Overview

The system performs **byte-exact (tier-1) deduplication** on media items. Two files are considered identical if and only if their SHA-256 content hashes match. Re-encoded or visually similar files are NOT caught by this mechanism; near-duplicate detection via perceptual hashing is a planned tier-2 enhancement (see [Phase 09 — Long-Term Enrichment](plan/phase-09-longterm-enrichment.md)).

The dedup key is the tuple `(owner_id, content_hash)`. Deduplication is scoped to the owner — two users can independently hold files with the same content hash.

#### Database Backstop

A partial unique index on `media_items` enforces the invariant at the database level:

```sql
CREATE UNIQUE INDEX "media_items_owner_content_hash_active_key"
  ON "media_items" ("owner_id", "content_hash")
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

## 6. Data Architecture

### 6.1 Entity Relationship Diagram

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
  }
}
```

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

### 7.3 RBAC Model

```
                    ┌─────────────────────────────────────────────┐
                    │                 PERMISSIONS                  │
                    ├─────────────────────────────────────────────┤
                    │ system_settings:read  │ system_settings:write│
                    │ user_settings:read    │ user_settings:write  │
                    │ users:read            │ users:write          │
                    │ rbac:manage           │ allowlist:read       │
                    │ allowlist:write       │                      │
                    └────────────┬───────────┴──────────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│     ADMIN     │      │  CONTRIBUTOR  │      │    VIEWER     │
├───────────────┤      ├───────────────┤      ├───────────────┤
│ ALL           │      │ user_settings:│      │ user_settings:│
│ PERMISSIONS   │      │   read/write  │      │   read        │
│               │      │               │      │               │
│ (Full Access) │      │ (Standard     │      │ (Least        │
│               │      │  User)        │      │  Privilege)   │
└───────────────┘      └───────────────┘      └───────────────┘
        │                        │                        │
        └────────────────────────┼────────────────────────┘
                                 │
                                 ▼
                        ┌───────────────┐
                        │     USERS     │
                        │  (Many-to-Many│
                        │   Assignment) │
                        └───────────────┘
```

### 7.4 Access Control Layers

```
Request → Nginx → JwtAuthGuard → RolesGuard → PermissionsGuard → Controller
            │           │             │              │
            │           │             │              └── Check @Permissions()
            │           │             │                  AND logic (all required)
            │           │             │
            │           │             └── Check @Roles() decorator
            │           │                 OR logic (any role matches)
            │           │
            │           └── Validate JWT, load user+roles+permissions
            │               Check user is active
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
| Home | `/` | Required | Any | Dashboard |
| User Settings | `/settings` | Required | Any | User preferences |
| System Settings | `/admin/settings` | Required | Admin | App configuration |
| User Management | `/admin/users` | Required | Admin | User/allowlist mgmt |
| Device Activation | `/device` | Required | Any | Device auth approval |
| Test Login | `/testing/login` | Public | - | Test auth bypass (dev only) |

**Note:** The `/testing/login` route is excluded from production builds via `import.meta.env.PROD` check.

### 9.2 Context Providers

```tsx
<App>
  <ThemeProvider>        {/* MUI theme + dark mode */}
    <AuthProvider>       {/* Authentication state */}
      <SettingsProvider> {/* User settings */}
        <RouterProvider> {/* React Router */}
          <Layout>
            <Pages />
          </Layout>
        </RouterProvider>
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
