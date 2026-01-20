# CLAUDE.md - MemoriaHub Development Guide

This file provides guidance to Claude Code (claude.ai/code) when working on this codebase.

## Prime Directive

Build MemoriaHub in **small, testable, observable increments**. Every change must:
1. Meet acceptance criteria from docs/PROJECT.md
2. Include tests (unit + integration where applicable)
3. Include observability (logs, metrics, traces)
4. Pass lint + typecheck
5. Never expose secrets

**Operating Model**: You (human) are the Architect and Acceptance Authority. Claude Code implements, tests, and documents.

## Specialized Agents (MANDATORY)

> **CRITICAL**: This project uses specialized agents via the `Task` tool. You MUST invoke these agents - they are NOT optional. Failure to invoke agents when required is a workflow violation.

### Agent Invocation Syntax

To invoke an agent, use the `Task` tool with the appropriate `subagent_type`:

```
Task(subagent_type="testing", prompt="Write tests for the new LibraryService.create method")
Task(subagent_type="security", prompt="Review the authentication changes in auth.controller.ts")
```

### Available Agents

| Agent | Purpose | MUST Invoke When |
|-------|---------|------------------|
| **backend** | Express routes, services, repositories, middleware | Creating/modifying API endpoints, services, or repositories |
| **frontend** | React components, MUI styling, state management | Creating/modifying React components, pages, or hooks |
| **database** | PostgreSQL schema, migrations, queries | Any schema change, new migration, or query optimization |
| **testing** | Unit tests, integration tests, coverage | **ALWAYS after ANY code change** (non-negotiable) |
| **security** | Vulnerability detection, auth review | **ALWAYS after code touching auth, input, data access, or secrets** |
| **documentation** | Technical docs, API docs, user guides | After completing features that change user-facing behavior |

### MANDATORY Agent Workflow

**You MUST follow this workflow. No exceptions.**

```
┌─────────────────────────────────────────────────────────────────────┐
│  AFTER WRITING OR MODIFYING ANY CODE, YOU MUST:                     │
│                                                                     │
│  1. STOP and invoke the **testing** agent                          │
│     → Creates/updates tests                                         │
│     → Runs `npm run typecheck`                                      │
│     → Runs `npm run test -- --run`                                 │
│                                                                     │
│  2. STOP and invoke the **security** agent (if applicable)         │
│     → Reviews for vulnerabilities                                   │
│     → Checks auth, input validation, data access                   │
│                                                                     │
│  3. Only THEN is the implementation complete                        │
└─────────────────────────────────────────────────────────────────────┘
```

### Workflow By Task Type

**Feature Development (API):**
```
1. backend agent → implement endpoint
2. testing agent → MANDATORY: write tests, run typecheck
3. security agent → MANDATORY: review for vulnerabilities
4. documentation agent → if user-facing changes
```

**Feature Development (UI):**
```
1. frontend agent → implement component
2. testing agent → MANDATORY: write tests, run typecheck
3. security agent → if handles user input or auth
4. documentation agent → if user-facing changes
```

**Database Changes:**
```
1. database agent → create migration, update schema
2. backend agent → update repository if needed
3. testing agent → MANDATORY: write tests, run typecheck
4. security agent → MANDATORY: review data access patterns
```

**Bug Fixes:**
```
1. Fix the bug directly (or via backend/frontend agent)
2. testing agent → MANDATORY: add regression test
3. security agent → if fix touches auth/input/data
```

### Agent Invocation Checklist

Before marking ANY task as complete, verify:

- [ ] **testing** agent invoked? (REQUIRED for all code changes)
- [ ] **security** agent invoked? (REQUIRED if code touches auth, input validation, data access, or secrets)
- [ ] **documentation** agent invoked? (Required if user-facing behavior changed)

### Examples of Required Agent Invocations

| You Just Did This | You MUST Invoke |
|-------------------|-----------------|
| Added a new API endpoint | `testing` then `security` |
| Modified a React component | `testing` |
| Changed authentication logic | `testing` then `security` |
| Added a database migration | `testing` then `security` |
| Fixed a bug in a service | `testing` |
| Added input validation | `testing` then `security` |
| Modified user permissions | `testing` then `security` |
| Updated a form component | `testing` |
| Changed how data is fetched | `testing` then `security` |

### What Happens If You Skip Agents

If you complete code changes WITHOUT invoking the required agents:
1. Tests may be missing → bugs slip through
2. Type errors may exist → build failures
3. Security vulnerabilities may be introduced → data breaches
4. The task is NOT actually complete

**The testing agent is your quality gate. The security agent is your safety net. USE THEM.**

## Project Overview

MemoriaHub is a privacy-first family photo platform with:
- Full user ownership (no vendor lock-in)
- Redundant storage (cloud + local sync)
- AI-powered search (faces, objects, natural language)
- Complete observability

## Tech Stack (Locked Decisions)

| Layer | Technology |
|-------|------------|
| Frontend | React + TypeScript (strict) + MUI + Vite |
| Backend | Node.js + TypeScript (strict) + Express |
| Database | PostgreSQL |
| Storage | S3-compatible (AWS S3, MinIO) |
| Auth | OAuth (Google, Microsoft, GitHub) + JWT |
| Observability | OpenTelemetry + Prometheus + Grafana + Loki + Jaeger |
| Deployment | Docker Compose + Nginx |

## Repository Structure

```
memoriahub/
├── apps/
│   ├── web/              # React frontend (port 5173 dev)
│   ├── api/              # REST API + WebDAV (port 3000)
│   └── worker/           # Background job processor
├── packages/
│   └── shared/           # Shared types, validation, API client
├── infra/
│   ├── compose/          # Docker Compose configs
│   │   ├── dev.compose.yml
│   │   └── prod.compose.yml
│   ├── nginx/            # Reverse proxy config
│   └── observability/    # Prometheus/Grafana/Loki/Jaeger
├── scripts/              # Dev scripts, DB migrations, seeds, utilities
│   ├── dev.ps1           # Windows development script
│   └── dev.sh            # Linux/macOS development script
└── docs/                 # All documentation
    ├── PROJECT.md        # Vision, requirements, roadmap
    ├── ARCHITECTURE.md   # System design
    ├── SECURITY.md       # Security requirements
    ├── OBSERVABILITY.md  # Telemetry standards
    ├── SETUP.md          # First-time setup
    ├── DATABASE.md       # DB configuration
    ├── USER_GUIDE.md     # End-user docs
    ├── LIBRARIES_AND_SHARING.md  # Libraries & sharing guide
    ├── ADMIN_GUIDE.md    # Admin docs
    ├── TROUBLESHOOTING.md
    └── diagrams/         # Mermaid diagrams
```

## Common Commands

### Development Scripts (Recommended)

Use the convenience scripts for common operations:

```bash
# Linux/macOS
./scripts/dev.sh start      # Start all services
./scripts/dev.sh stop       # Stop all services
./scripts/dev.sh restart    # Restart services
./scripts/dev.sh rebuild    # Rebuild and restart all services
./scripts/dev.sh logs api   # View API logs
./scripts/dev.sh status     # Check service status
./scripts/dev.sh clean      # Reset everything (destroys data)
./scripts/dev.sh help       # Show all available commands

# Windows (PowerShell)
.\scripts\dev.ps1 start
.\scripts\dev.ps1 stop
.\scripts\dev.ps1 restart
.\scripts\dev.ps1 rebuild
.\scripts\dev.ps1 logs api
.\scripts\dev.ps1 status
.\scripts\dev.ps1 clean
.\scripts\dev.ps1 help

# Testing via dev scripts
.\scripts\dev.ps1 test              # Run all tests once
.\scripts\dev.ps1 test ui           # Open Vitest UI in browser
.\scripts\dev.ps1 test watch        # Run tests in watch mode
.\scripts\dev.ps1 test coverage     # Run with coverage report
.\scripts\dev.ps1 test unit         # Run only unit tests
.\scripts\dev.ps1 test integration  # Run only integration tests
```

### Docker Compose (Manual)
```bash
# Start all services (from repo root)
docker compose -f infra/compose/dev.compose.yml up -d

# View logs
docker compose -f infra/compose/dev.compose.yml logs -f [service]

# Stop all services
docker compose -f infra/compose/dev.compose.yml down

# Rebuild after Dockerfile changes
docker compose -f infra/compose/dev.compose.yml up -d --build
```

### Service Development
```bash
# API service
cd apps/api && npm install && npm run dev

# Worker service
cd apps/worker && npm install && npm run dev

# Web frontend
cd apps/web && npm install && npm run dev
```

### Testing & Quality
```bash
# Run tests (IMPORTANT: use --run flag to avoid watch mode)
npm run test -- --run --reporter=default    # All tests (single run)
npm run test:unit -- --run                  # Unit tests only
npm run test:integration -- --run           # Integration tests only

# Linting and type checking
npm run lint
npm run typecheck

# Build
npm run build
```

### Database
```bash
# Run migrations
npm run db:migrate

# Seed data
npm run db:seed

# Reset database
npm run db:reset
```

## Coding Standards

### TypeScript Rules
- **Strict mode always**: `"strict": true` in all tsconfig.json
- **No `any` type**: Use `unknown` + type guards, or explicit types
- **Validate at boundaries**: Use Zod for HTTP requests, WebDAV, job payloads
- **Explicit error types**: Define error classes, no generic throws

```typescript
// GOOD: Explicit types with validation
import { z } from 'zod';

const CreateLibrarySchema = z.object({
  name: z.string().min(1).max(255),
  visibility: z.enum(['private', 'shared', 'public']),
});

type CreateLibraryInput = z.infer<typeof CreateLibrarySchema>;

// BAD: Using any
function processData(data: any) { ... }
```

### Import Rules
- **No cross-service imports**: `apps/api` cannot import from `apps/worker`
- **Shared code goes to `packages/shared`**: Types, validation schemas, API client
- **Relative imports within service**: Use relative paths inside each app

### File Naming
- **Components**: PascalCase (`PhotoGrid.tsx`)
- **Utilities/hooks**: camelCase (`useMediaQuery.ts`)
- **Types**: PascalCase in dedicated files (`MediaAsset.types.ts`)
- **Tests**: Same name with `.test.ts` suffix (`auth.service.test.ts`)

## API Conventions

### URL Structure (Single Domain)
```
https://domain/           # Frontend (React SPA)
https://domain/api/*      # REST API
https://domain/dav/*      # WebDAV endpoint
https://domain/api/docs   # OpenAPI documentation
```

### Endpoint Patterns
```
GET    /api/libraries           # List libraries
POST   /api/libraries           # Create library
GET    /api/libraries/:id       # Get library
PUT    /api/libraries/:id       # Update library
DELETE /api/libraries/:id       # Delete library
GET    /api/libraries/:id/media # List media in library
```

### Response Format
```typescript
// Success
{ data: T, meta?: { page, limit, total } }

// Error
{ error: { code: string, message: string, details?: object } }
```

### Required Headers
- `X-Request-Id`: Unique request identifier (generated if missing)
- `Authorization`: Bearer token for authenticated endpoints

### OpenAPI Sync
- **OpenAPI spec MUST match implementation**
- Update spec when adding/changing endpoints
- Run validation in CI

## Observability Requirements (CRITICAL)

Every feature MUST include proper observability. This is non-negotiable.

### Logging Rules
```typescript
// Required log fields (structured JSON)
{
  timestamp: string,      // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error',
  service: 'api' | 'worker' | 'web',
  env: string,
  traceId: string,        // REQUIRED - propagate everywhere
  requestId: string,
  eventType: string,      // e.g., 'library.created', 'upload.started'
  durationMs?: number,
  userId?: string,
  libraryId?: string,
  assetId?: string,
  jobId?: string,
  error?: { message: string, stack?: string }
}

// NEVER LOG: tokens, secrets, OAuth payloads, passwords, PII
```

### Every API Endpoint Must:
1. Log request start with method, path, userId, traceId
2. Log request end with status, durationMs
3. Increment request counter metric
4. Record latency histogram
5. Create OpenTelemetry span

### Every Worker Job Must:
1. Log job start with jobId, type, traceId
2. Log job completion/failure with durationMs
3. Increment job counter metric (success/failure)
4. Record job duration histogram
5. Create parent span with child spans for substeps

### Metrics (Prometheus Format)
```
# API Metrics
http_requests_total{method, path, status}
http_request_duration_seconds{method, path}
auth_failures_total{reason}

# Worker Metrics
jobs_processed_total{type, status}
jobs_duration_seconds{type}
job_queue_depth{type}
job_retries_total{type}

# Storage Metrics
s3_operations_total{operation, status}
s3_operation_duration_seconds{operation}

# Database Metrics
db_connections_active
db_query_duration_seconds{query_type}
```

### Health Endpoints
```typescript
// Every service must implement:
GET /healthz  // Process alive: { status: 'ok' }
GET /readyz   // Dependencies ready: { status: 'ok', db: 'ok', s3: 'ok' }
GET /metrics  // Prometheus metrics
```

### Trace Context Propagation
```typescript
// traceId MUST flow through entire asset lifecycle:
// Upload → Ingestion → Processing → Indexing → Ready

// Store traceId on entities:
MediaAsset.traceId
IngestionEvent.traceId
ProcessingJob.traceId
```

## Security Requirements

### Authentication
- **OAuth only** (no password storage)
- **JWT tokens**: Short-lived access (15min), longer refresh (7d)
- **Never log tokens** in any form

### Authorization Checks (EVERY ENDPOINT)
```typescript
// REQUIRED: Object-level authorization
// User → Library → Asset chain must be validated

async function getMedia(userId: string, libraryId: string, assetId: string) {
  // 1. Verify user has access to library
  const access = await checkLibraryAccess(userId, libraryId);
  if (!access) throw new ForbiddenError();

  // 2. Verify asset belongs to library
  const asset = await getAsset(assetId);
  if (asset.libraryId !== libraryId) throw new NotFoundError();

  return asset;
}
```

### Security Checklist
- [ ] No IDOR vulnerabilities (validate ownership chain)
- [ ] No SQL injection (use parameterized queries)
- [ ] No XSS (sanitize output, CSP headers)
- [ ] No secrets in logs or responses
- [ ] Rate limiting on auth endpoints
- [ ] HTTPS only (no mixed content)

### WebDAV Security
- HTTPS required
- App-specific tokens with scopes (user, library, path)
- Rate limiting + upload size limits
- MIME type validation
- Path traversal prevention

### Audit Logging
Track sensitive actions (append-only):
- Login/logout events
- Library visibility changes
- Membership changes
- Public link creation/revocation
- Media access in shared/public contexts

## Testing Requirements

### Test Types
1. **Unit tests**: Fast, no external deps, mock boundaries
2. **Integration tests**: With DB + S3 (containerized)
3. **API tests**: Full request/response cycle
4. **E2E tests**: Critical user flows

### Running Tests
**IMPORTANT**: Always use `--run` flag to avoid watch mode:
```bash
npm run test -- --run --reporter=default
```

### Rules
- **No test = No merge** (enforced in CI)
- **Deterministic**: No flaky tests, no time-dependent logic
- **Fast**: Unit tests < 100ms each
- **Isolated**: Tests don't affect each other

### Coverage Targets
- Business logic: 80%+
- API endpoints: 100% happy path + error cases
- Authorization: 100% (every protected endpoint)

### Test Naming
```typescript
describe('LibraryService', () => {
  describe('createLibrary', () => {
    it('creates a private library for authenticated user', async () => {});
    it('rejects invalid library names', async () => {});
    it('requires authentication', async () => {});
  });
});
```

## PR Workflow

### Before Creating PR
1. [ ] All tests pass locally (`npm run typecheck && npm run test -- --run`)
2. [ ] Lint + typecheck pass
3. [ ] Observability added (logs, metrics, traces)
4. [ ] **Security agent** reviewed (auth, validation, no secrets)
5. [ ] OpenAPI spec updated (if API changed)
6. [ ] **Testing agent** verified coverage targets met

### PR Description Template
```markdown
## Summary
Brief description of changes

## Acceptance Criteria
- [ ] Criteria from issue/requirement
- [ ] Additional criteria discovered

## Testing
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing performed

## Observability
- [ ] Logs added with traceId
- [ ] Metrics exposed
- [ ] Spans created

## Security
- [ ] Auth enforced
- [ ] Input validated
- [ ] No secrets exposed
```

### Commit Message Format
```
type(scope): description

feat(api): add library creation endpoint
fix(worker): handle missing EXIF data gracefully
docs(readme): update setup instructions
test(api): add auth middleware tests
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`

## Task Sizing

Prefer small, focused changes:
- **One endpoint** per task
- **One UI component/page** per task
- **One worker job type** per task
- **One DB migration** per task

Target: 1-3 commits per task, each independently deployable.

## Definition of Done

A feature is DONE when:
- [ ] Code merged to main
- [ ] All tests passing in CI (`npm run typecheck && npm run test -- --run`)
- [ ] OpenAPI spec updated and in sync
- [ ] Telemetry flowing (logs visible, metrics scraped, traces linked)
- [ ] Documentation updated (if behavior changed)
- [ ] No secrets in code or logs
- [ ] **MANDATORY: `testing` agent was invoked** and verified tests + typecheck pass
- [ ] **MANDATORY: `security` agent was invoked** (if code touches auth/input/data) and no findings or all addressed

> **REMINDER**: If you did not invoke the `testing` and `security` agents via the Task tool, the feature is NOT done. Go back and invoke them now.

## Entity Status Lifecycle

```
MediaAsset Status:
UPLOADED → METADATA_EXTRACTED → DERIVATIVES_READY → ENRICHED → INDEXED → READY
```

Each transition:
1. Logged with traceId
2. Metrics incremented
3. Span created

## Environment Variables

### Required (All Services)
```bash
NODE_ENV=development|production
LOG_LEVEL=debug|info|warn|error
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
```

### API Service
```bash
DATABASE_URL=postgresql://user:pass@host:5432/db
JWT_SECRET=<secret>
JWT_EXPIRES_IN=15m
OAUTH_GOOGLE_CLIENT_ID=<id>
OAUTH_GOOGLE_CLIENT_SECRET=<secret>
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY=<key>
S3_SECRET_KEY=<secret>
S3_BUCKET=memoriahub
```

### Worker Service
```bash
DATABASE_URL=postgresql://user:pass@host:5432/db
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY=<key>
S3_SECRET_KEY=<secret>
S3_BUCKET=memoriahub
WORKER_CONCURRENCY=4
```

## Quick Reference

### Ports (Development)
| Service | Port | Notes |
|---------|------|-------|
| Web (Vite) | 5173 | Main development URL |
| API | 3000 | Direct API access |
| Nginx | 8888 | Reverse proxy (production-like) |
| PostgreSQL | 5432 | Database |
| MinIO API | 9000 | S3-compatible storage |
| MinIO Console | 9001 | Storage web UI |
| Grafana | 3001 | Dashboards (admin/admin) |
| Prometheus | 9090 | Metrics |
| Jaeger | 16686 | Distributed tracing |
| Loki | 3100 | Log aggregation |

**Note:** Port 80/8080 are often reserved on Windows. Use port 8888 for nginx.

### Key Documentation
- [docs/PROJECT.md](docs/PROJECT.md) - Product vision, requirements, and roadmap
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - System design and data model
- [docs/SECURITY.md](docs/SECURITY.md) - Security requirements and threat model
- [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) - Telemetry standards
- [docs/SETUP.md](docs/SETUP.md) - **First-time setup guide**
- [docs/DATABASE.md](docs/DATABASE.md) - Database configuration, migrations, and governance
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) - Common issues and solutions
- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) - End-user documentation
- [docs/LIBRARIES_AND_SHARING.md](docs/LIBRARIES_AND_SHARING.md) - Libraries, media ownership, and sharing guide
- [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) - Administrator documentation

## Troubleshooting

For detailed troubleshooting, see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

### Quick Fixes

```bash
# Reset everything (nuclear option)
docker compose -f infra/compose/dev.compose.yml down -v
docker compose -f infra/compose/dev.compose.yml up -d --build

# Check logs for errors
docker compose -f infra/compose/dev.compose.yml logs -f api

# Force recreate container (picks up env var changes)
docker compose -f infra/compose/dev.compose.yml up -d --force-recreate api

# Verify env vars are correct
docker compose -f infra/compose/dev.compose.yml exec api printenv | grep OAUTH
```

### Common Issues

| Issue | Quick Fix |
|-------|-----------|
| Port in use | Check `netstat -ano \| findstr :PORT` and kill process |
| OAuth 404 callback | Set `OAUTH_CALLBACK_BASE_URL=http://localhost:5173/api/auth` and recreate API |
| CORS errors | Set `VITE_API_URL=/api` (relative path) and recreate web |
| Env vars not updating | Use `--force-recreate` not `restart` |
| npm ci fails | Run `npm install` from repo root to generate lock file |

### Database Quick Commands
```bash
# Connect to PostgreSQL
docker compose -f infra/compose/dev.compose.yml exec postgres psql -U memoriahub

# Check migrations
SELECT * FROM schema_migrations;

# Reset database (destroys data)
docker compose -f infra/compose/dev.compose.yml down -v
docker compose -f infra/compose/dev.compose.yml up -d postgres
```

### Observability Quick Commands
```bash
# Check Prometheus targets
curl http://localhost:9090/api/v1/targets

# View Jaeger traces
open http://localhost:16686

# View Grafana dashboards
open http://localhost:3001  # admin/admin
```
