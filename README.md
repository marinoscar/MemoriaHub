# MemoriaHub

[![CI](https://github.com/marinoscar/MemoriaHub/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/marinoscar/MemoriaHub/actions/workflows/ci.yml)

MemoriaHub is a personal media-ownership platform that gives families full control over their photos and videos, independent of any single cloud provider. Store, organize, enrich, import, sync, replicate, and export your family memories while keeping data portable and in your hands. The guiding principle: **your family memories should belong to you, not to a platform.**

## Features

### Family Circles (Collaborative Library)
- **Shared Circle Library**: Every media item belongs to exactly one circle and is visible to all circle members — photos uploaded by any collaborator appear in the shared timeline
- **Multiple Circles per User**: Belong to your personal library and several family circles simultaneously; switch active circle in the web app or CLI
- **Per-Circle Roles**: `circle_admin` manages members and content; `collaborator` adds and organizes media; `viewer` has read-only access
- **Email Invites**: Circle admins invite by email; the invite automatically allowlists the recipient so they can log in and join immediately on first sign-in
- **Two-Layer Admin Model**: The global system Admin bypasses per-circle membership for full cross-circle management; per-circle roles govern everyday access
- **Local-Drive Backup**: Admin-triggered server-side backup replicates S3 blobs to `BACKUP_LOCAL_PATH`; CLI `memoriahub backup` command lets operators pull blobs to their own drive

### Media and Storage
- **Media Domain**: Photos and videos as first-class `MediaItem` records with typed columns for capture date, camera make/model, GPS coordinates, reverse-geocoded country/region/city, tags, albums, favorites, classification, and soft-delete. All items are circle-scoped (`circleId` required on create and list endpoints)
- **Circle Dashboard**: The home page (`/`) shows a per-circle dashboard — On This Day (same month/day across all years), recent imports, favorites, and a review queue with deep-links to unreviewed and missing-location items
- **Bulk Editing**: Multi-select media library with a bulk-action toolbar for setting location (map pin + place search), tags, classification, favorite flag, and soft-delete across up to 500 items at once. The location picker reverse-geocodes the dropped pin using the offline on-server provider by default
- **Geo Services**: On-demand reverse geocoding (`GET /api/media/geo/reverse`) and optional place-name forward search (`GET /api/media/geo/search`, requires `GEO_FORWARD_SEARCH_ENABLED=true`). Forward search sends only the typed query to Nominatim — GPS coordinates never leave the server
- **Pluggable Storage**: AWS S3 (primary) and local-disk (backup); additional providers are interchangeable by design
- **Resumable Uploads**: Multipart upload with pre-signed URLs and event-driven post-upload processing pipeline
- **Personal Access Tokens**: Long-lived tokens for CLI tools, scripts, and automation workflows
- **Metadata-First**: All media metadata stored in typed columns and queryable; exportable in JSON and CSV

### Foundation
- **Authentication**: Google OAuth 2.0 with JWT access tokens and refresh token rotation
- **Device Authorization**: RFC 8628 Device Authorization Flow for CLI tools, mobile apps, and IoT devices
- **Authorization**: Role-Based Access Control (RBAC) with three global roles (Admin, Contributor, Viewer) plus per-circle roles
- **Access Control**: Email allowlist restricts application access; circle invites upsert the allowlist automatically
- **User Management**: Admin interface for managing users, role assignments, and allowlist
- **Settings Framework**: System-wide and per-user settings with type-safe schemas (includes `activeCircleId`)
- **Observability**: OpenTelemetry instrumentation with traces, metrics, and structured logging
- **API Documentation**: Swagger/OpenAPI documentation at `/api/docs`
- **Same-Origin Architecture**: Frontend and API served from the same host via Nginx reverse proxy

### Planned Capabilities
The roadmap covers memory prioritization (Phase 07), Android sync (Phase 08 — circle-scoped from day one), and long-term enrichment such as face recognition, object detection, and duplicate detection (Phase 09). See [docs/plan/ROADMAP.md](docs/plan/ROADMAP.md) for details.

## Technology Stack

### Backend
- **Framework**: NestJS with Fastify adapter
- **Database**: PostgreSQL with Prisma ORM
- **Authentication**: Passport.js (Google OAuth)
- **Observability**: OpenTelemetry + Uptrace
- **Testing**: Jest + Supertest

### Frontend
- **Framework**: React 18 with TypeScript
- **UI Library**: Material-UI (MUI)
- **State Management**: React Context API
- **Testing**: Vitest + React Testing Library
- **Build Tool**: Vite

### Infrastructure
- **Containerization**: Docker + Docker Compose
- **Reverse Proxy**: Nginx
- **Database**: PostgreSQL

## Prerequisites

- Node.js 22+
- Docker Desktop
- Google OAuth credentials (from [Google Cloud Console](https://console.cloud.google.com))

## Quick Start

### 1. Clone and Configure

```bash
git clone <repository-url>
cd MemoriaHub

# Set up environment variables
cd infra/compose
cp .env.example .env
```

### 2. Configure Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or select existing)
3. Enable Google+ API
4. Create OAuth 2.0 credentials
5. Add authorized redirect URI: `http://localhost:3535/api/auth/google/callback`
6. Copy Client ID and Client Secret to `.env`:

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

### 3. Start Application

```bash
# From infra/compose directory
docker compose -f base.compose.yml -f dev.compose.yml up
```

### 4. Seed Database (CRITICAL - Must run before first login)

```bash
# In a new terminal
docker compose exec api sh
cd /app/apps/api
npx tsx prisma/seed.ts
exit
```

**Why seeding is required:**
- Creates RBAC roles (admin, contributor, viewer)
- Creates permissions (users:read, users:write, media:read, media:write, etc.)
- Without seeds, first login will fail with "Default role not found"

### 5. Access Application

- **Frontend**: http://localhost:3535
- **API**: http://localhost:3535/api
- **Swagger Docs**: http://localhost:3535/api/docs

### 6. First Login

The first user to login with email matching `INITIAL_ADMIN_EMAIL` (from `.env`) will automatically be granted the **admin** role. All subsequent users get **viewer** role by default.

**Important:** Only email addresses in the **allowlist** can login. The `INITIAL_ADMIN_EMAIL` is automatically added to the allowlist during seeding. After your first login as admin, use the Admin Panel to manage the allowlist.

## Development

### Running with Observability Stack

To enable full observability (Uptrace UI for traces, metrics, logs):

```bash
cd infra/compose
docker compose -f base.compose.yml -f dev.compose.yml -f otel.compose.yml up
```

Access Uptrace UI at: http://localhost:14318

### Running Tests

**Backend Tests:**
```bash
cd apps/api
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:cov      # With coverage
npm run test:e2e      # E2E tests only
```

**Frontend Tests:**
```bash
cd apps/web
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage
```

**E2E Tests (Playwright):**
```bash
cd tests/e2e
npm install              # First time setup
npx playwright install   # Install browsers
npm test                 # Run E2E tests
npm run test:ui          # Run with visual UI
```

Note: E2E tests use a test authentication bypass (`/testing/login`) that is only available in development/test environments. See [TESTING.md](docs/TESTING.md#e2e-testing-with-playwright) for details.

### Database Migrations

```bash
cd apps/api

# Create a new migration (uses npm script to construct DATABASE_URL from env vars)
npm run prisma:migrate:dev -- --name migration_name

# Apply migrations (production)
npm run prisma:migrate

# Generate Prisma Client after schema changes
npm run prisma:generate
```

### Hot Reload

Development mode (`dev.compose.yml`) includes hot reload for both frontend and backend:
- Backend: Changes to `apps/api/src/**` trigger restart
- Frontend: Vite HMR updates immediately

## Project Structure

```
MemoriaHub/
├── apps/
│   ├── api/                    # Backend API (NestJS + Fastify)
│   │   ├── src/
│   │   │   ├── auth/          # Authentication & authorization
│   │   │   ├── media/         # Media domain (MediaItem, Album, Tag)
│   │   │   ├── storage/       # Storage providers, objects, processing pipeline
│   │   │   ├── users/         # User management
│   │   │   ├── allowlist/     # Email allowlist
│   │   │   ├── pat/           # Personal access tokens
│   │   │   ├── settings/      # Settings endpoints
│   │   │   ├── device-auth/   # RFC 8628 device authorization
│   │   │   └── health/        # Liveness and readiness probes
│   │   ├── prisma/
│   │   │   ├── schema.prisma  # Database schema
│   │   │   ├── seed.ts        # Database seeds
│   │   │   └── migrations/    # Migration history
│   │   └── test/              # Integration tests
│   └── web/                    # Frontend (React + MUI)
│       ├── src/
│       │   ├── components/    # Reusable components
│       │   ├── contexts/      # React contexts (Auth, Theme)
│       │   ├── pages/         # Page components
│       │   ├── hooks/         # Custom React hooks
│       │   └── services/      # API client
│       └── src/__tests__/     # Component tests
├── docs/
│   ├── plan/                  # Implementation roadmap and phase specs
│   │   ├── ROADMAP.md         # Phase-by-phase implementation plan
│   │   └── phase-01-media-domain.md  # (and other phase docs)
│   ├── ARCHITECTURE.md        # System architecture
│   ├── API.md                 # Complete API reference
│   ├── DEVELOPMENT.md         # Development guide (start here!)
│   ├── SECURITY-ARCHITECTURE.md  # Security design
│   ├── TESTING.md             # Testing guide
│   ├── DEVICE-AUTH.md         # Device Authorization Flow guide
│   └── ssl-nginx-setup.md     # VPS/HTTPS deployment with Nginx
├── infra/
│   ├── compose/               # Docker Compose configs
│   │   ├── base.compose.yml   # Core services
│   │   ├── dev.compose.yml    # Development overrides
│   │   ├── prod.compose.yml   # Production overrides
│   │   └── otel.compose.yml   # Observability stack
│   ├── nginx/                 # Nginx config
│   └── otel/                  # OpenTelemetry config
├── tests/e2e/                 # Playwright E2E tests
├── VISION.MD                  # Product vision and MVP definition
└── CLAUDE.md                  # AI assistant guidance
```

## Documentation

- **[VISION.MD](VISION.MD)** - Product vision, MVP definition, and guiding principles
- **[docs/plan/ROADMAP.md](docs/plan/ROADMAP.md)** - Phase-by-phase implementation plan
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** - System architecture and design decisions
- **[docs/API.md](docs/API.md)** - Complete API reference
- **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** - Development setup, common patterns, and troubleshooting
- **[docs/SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md)** - Security design and implementation
- **[docs/TESTING.md](docs/TESTING.md)** - Testing strategy and best practices
- **[docs/DEVICE-AUTH.md](docs/DEVICE-AUTH.md)** - Device Authorization Flow guide and integration examples
- **[docs/ssl-nginx-setup.md](docs/ssl-nginx-setup.md)** - VPS deployment with HTTPS and Nginx

## API Documentation

Interactive API documentation is available at `/api/docs` when running the application.

### Key Endpoints

**Authentication:**
- `GET /api/auth/providers` - List OAuth providers
- `GET /api/auth/google` - Initiate Google OAuth
- `GET /api/auth/me` - Get current user
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout

**Device Authorization (RFC 8628):**
- `POST /api/auth/device/code` - Generate device code for CLI/IoT devices
- `POST /api/auth/device/token` - Poll for device authorization
- `GET /api/auth/device/sessions` - List authorized devices
- `DELETE /api/auth/device/sessions/:id` - Revoke device access

**Family Circles:**
- `POST /api/circles` - Create a new circle
- `GET /api/circles` - List circles you belong to (`?all=true` for admin)
- `GET /api/circles/:id` - Get circle details
- `PATCH /api/circles/:id` - Update circle (circle_admin or super-admin)
- `DELETE /api/circles/:id` - Delete circle (not personal circles)
- `GET /api/circles/:id/members` - List circle members
- `POST /api/circles/:id/members` - Add a member by user ID (circle_admin)
- `PATCH /api/circles/:id/members/:userId` - Change member role
- `DELETE /api/circles/:id/members/:userId` - Remove member or self-leave
- `GET /api/circles/:id/invites` - List invites (circle_admin)
- `POST /api/circles/:id/invites` - Create invite + upsert allowlist entry
- `DELETE /api/circles/:id/invites/:inviteId` - Revoke pending invite

**Admin — Backup:**
- `POST /api/admin/backup` - Trigger local-drive backup replication
- `GET /api/admin/backup/runs` - List recent backup runs
- `GET /api/admin/backup/status` - Alias for `/runs`
- `GET /api/admin/backup/runs/:runId` - Get status of a specific run
- `GET /api/admin/backup/objects` - List media objects with signed download URLs

**Media (circle-scoped — `circleId` required):**
- `GET /api/media/dashboard` - Circle dashboard (On This Day, recent, favorites, review-queue counts)
- `POST /api/media` - Register an uploaded file as a MediaItem (body: `circleId` required)
- `GET /api/media` - List media (query: `circleId` required; filter by type, date, classification, album, tag, location, cameraMake, missingGeo, etc.)
- `GET /api/media/:id` - Get a single MediaItem (includes `tags[]`)
- `PATCH /api/media/:id` - Update mutable fields (title, caption, favorite, classification, etc.)
- `DELETE /api/media/:id` - Soft-delete MediaItem (moves to trash; blob preserved)
- `PATCH /api/media/bulk` - Bulk update location / classification / favorite on 1–500 items
- `POST /api/media/bulk/tags` - Bulk add/remove tags on 1–500 items
- `POST /api/media/bulk/delete` - Bulk soft-delete 1–500 items
- `GET /api/media/geo/reverse` - On-demand reverse geocoding
- `GET /api/media/geo/search` - Forward place-name search (requires `GEO_FORWARD_SEARCH_ENABLED=true`)
- `GET /api/media/tags` - List tags for active circle (query: `circleId` required)
- `POST /api/media/:id/tags` - Attach tags to a MediaItem
- `POST /api/media/albums` - Create album (body: `circleId` required)
- `GET /api/media/albums` - List albums (query: `circleId` required)
- `POST /api/media/albums/:id/items` - Add items to album

**Storage:**
- `POST /api/storage/objects/upload/init` - Initialize resumable multipart upload
- `POST /api/storage/objects/:id/upload/complete` - Complete multipart upload
- `POST /api/storage/objects` - Simple file upload
- `GET /api/storage/objects/:id/download` - Get signed download URL
- `DELETE /api/storage/objects/:id` - Delete object

**Personal Access Tokens:**
- `POST /api/pat` - Create token
- `GET /api/pat` - List tokens
- `DELETE /api/pat/:id` - Revoke token

**Users (Admin only):**
- `GET /api/users` - List users
- `PATCH /api/users/:id` - Update user

**Allowlist (Admin only):**
- `GET /api/allowlist` - List allowlisted emails
- `POST /api/allowlist` - Add email to allowlist
- `DELETE /api/allowlist/:id` - Remove email from allowlist

**Settings:**
- `GET /api/user-settings` - Get user settings
- `PUT /api/user-settings` - Update user settings
- `GET /api/system-settings` - Get system settings (Admin)
- `PUT /api/system-settings` - Update system settings (Admin)

**Health:**
- `GET /api/health/live` - Liveness probe
- `GET /api/health/ready` - Readiness probe

## Environment Variables

Key configuration (see `infra/compose/.env.example` for full list):

```bash
# Application
NODE_ENV=development
PORT=3000
APP_URL=http://localhost:3535

# Database (DATABASE_URL is constructed automatically from these)
POSTGRES_HOST=db
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=appdb

# JWT
JWT_SECRET=your-secret-min-32-chars
JWT_ACCESS_TTL_MINUTES=15
JWT_REFRESH_TTL_DAYS=14

# Google OAuth
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3535/api/auth/google/callback

# Admin Bootstrap
INITIAL_ADMIN_EMAIL=admin@example.com

# Storage (AWS S3)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
S3_BUCKET=your-bucket-name

# Backup / Local-Drive Replication (Admin only)
# BACKUP_LOCAL_PATH=/mnt/external-drive/memoriahub-backup
# STORAGE_BACKUP_PROVIDER=local

# Observability
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

## Important Notes for Developers

### NestJS with Fastify (Not Express)

This application uses **Fastify** as the HTTP adapter, not Express. Key differences:

**Response methods:**
- Fastify: `res.code(200).send(data)`
- Express (do not use): `res.status(200).json(data)`

**Best practice:** Let NestJS handle responses automatically (do not use the `@Res()` decorator).

See [DEVELOPMENT.md](docs/DEVELOPMENT.md) for detailed guidance.

### Database Seeding is Required

Before your first login, you MUST seed the database:

```bash
docker compose exec api sh
cd /app/apps/api
npx tsx prisma/seed.ts
```

This creates roles, permissions, and default settings. Without seeding, OAuth login will fail.

### Database Migrations Use npm Scripts

Use the project npm scripts rather than raw `npx prisma` commands — the scripts automatically construct `DATABASE_URL` from the individual `POSTGRES_*` environment variables:

```bash
cd apps/api
npm run prisma:migrate:dev -- --name <name>   # development
npm run prisma:migrate                         # production
npm run prisma:generate                        # after schema changes
```

### OAuth with Fastify

Passport OAuth strategies expect Express-style objects. The `GoogleOAuthGuard` handles compatibility by returning raw Node.js request/response objects to Passport. See [SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md) for details.

## Troubleshooting

### "Default role not found" error
**Solution:** Run database seeds (see step 4 in Quick Start)

### "Email not authorized" error during login
**Solution:** The email must be in the allowlist. If you're the first admin:
1. Ensure your email matches `INITIAL_ADMIN_EMAIL` in `.env` exactly
2. Restart containers to apply environment variable changes
3. Re-run database seeds if needed

If you're not the first admin, ask an existing admin to add your email to the allowlist at `/admin/users` (Allowlist tab).

### OAuth redirect fails
**Solution:**
1. Verify `GOOGLE_CALLBACK_URL` matches Google Cloud Console exactly
2. Check container logs: `docker compose logs api -f`

### Database connection error
**Solution:**
1. Ensure containers are running: `docker compose ps`
2. Check the `POSTGRES_*` variables in `.env`
3. Restart: `docker compose restart db`

### Port already in use
**Solution:** Change `PORT` in `.env` or stop the conflicting service

For more troubleshooting, see [DEVELOPMENT.md](docs/DEVELOPMENT.md#debugging-tips).

## Production Deployment

For local `docker compose`-based production:

1. Use `prod.compose.yml` overrides
2. Set `NODE_ENV=production`
3. Use strong secrets (generate with `openssl rand -base64 32`)
4. Enable HTTPS with valid certificates
5. Set `secure: true` on cookies
6. Configure proper OAuth callback URLs
7. Set up database backups
8. Configure monitoring and alerting

For VPS deployment with HTTPS and Nginx (the setup used at https://memoriahub.dev.marin.cr), see [docs/ssl-nginx-setup.md](docs/ssl-nginx-setup.md).

See [SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md) for the production security checklist.

## Architecture Decisions

- **Fastify over Express**: 2-3x better performance, better TypeScript support
- **Prisma**: Type-safe ORM with excellent migration tooling
- **Same-origin hosting**: Simplifies security, no CORS complexity
- **JWT + Refresh tokens**: Short-lived access tokens with secure refresh rotation
- **RBAC**: Flexible permission system supporting media:read/write/delete and _any admin variants
- **Pluggable storage providers**: `StorageProvider` interface abstracts AWS S3 today, local/Azure in future phases
- **Event-driven processing**: `OBJECT_UPLOADED_EVENT` pipeline decouples upload from enrichment processors
- **OpenTelemetry**: Vendor-neutral observability
- **Docker Compose**: Reproducible local development environment

## License

[Your License Here]

## Support

For issues, questions, or contributions:
- Review [DEVELOPMENT.md](docs/DEVELOPMENT.md) for common issues
- Check [documentation](docs/) for detailed guides
- Submit issues via GitHub Issues
