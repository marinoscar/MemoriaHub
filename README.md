# MemoriaHub

![CI](https://github.com/marinoscar/MemoriaHub/actions/workflows/ci.yml/badge.svg)
[![codecov](https://codecov.io/gh/marinoscar/MemoriaHub/branch/main/graph/badge.svg)](https://codecov.io/gh/marinoscar/MemoriaHub)

MemoriaHub is a **family memory hub**: a privacy-first photo + media platform that keeps your library searchable, shareable (when you choose), and resilient through redundancy.

This repo is intentionally **optimized for coding agents** (Claude Code, Codex, etc.): predictable structure, explicit requirements, tight definitions of done, and minimal ambiguity.

---

## Quick orientation

- **Web UI**: React + TypeScript + MUI
- **API**: Node.js + TypeScript (REST; OpenAPI)
- **Ingestion**: WebDAV endpoint for sync clients
- **Worker**: background jobs (EXIF, thumbnails, enrichment, replication)
- **DB**: PostgreSQL
- **Storage**: S3-compatible object storage (AWS S3 first; MinIO later)
- **Observability**: OpenTelemetry (mandatory), Prometheus, Grafana, Loki, Jaeger

If you’re new here, read these in order:
1. `VISION.md`
2. `REQUIREMENTS.md`
3. `ARCHITECTURE.md`
4. `SECURITY.md`
5. `OBSERVABILITY.md`
6. `ROADMAP.md`
7. `CLAUDE.md` (agent rules)

---

## Repository structure

```text
memoriahub/
  apps/
    web/                # React + MUI frontend
    api/                # Node API + WebDAV (or split later)
    worker/             # async processing pipeline
  packages/
    shared/             # shared types, validation schemas, API client
  infra/
    compose/            # docker compose files (dev + prod)
    nginx/              # reverse proxy config
    observability/      # prometheus/grafana/loki/jaeger configs
  docs/
    diagrams/           # Mermaid diagrams + exported images
    adr/                # Architecture Decision Records (optional, recommended)
  scripts/              # one-shot scripts (db migrate, seed, backups)
  .github/
    workflows/          # CI
    ISSUE_TEMPLATE/     # issue templates
    PULL_REQUEST_TEMPLATE.md

  README.md
  VISION.md
  REQUIREMENTS.md
  ARCHITECTURE.md
  SECURITY.md
  OBSERVABILITY.md
  ROADMAP.md
  CLAUDE.md
```

### Folder rules (agent-friendly)
- **No cross-service imports** from `apps/*` (share code via `packages/shared`).
- Each service is independently runnable and testable.
- Each service has **consistent** scripts: `dev`, `test`, `lint`, `typecheck`, `build`.

---

## Local development (recommended path)

### Prerequisites
- Node.js 20+
- Docker Desktop (with Docker Compose v2)
- Git

### Quick Start

**Option A: Infrastructure only (apps run locally)**

Best for active development with hot-reload:

```bash
# Start PostgreSQL, MinIO, and observability stack
docker compose -f infra/compose/infra-only.compose.yml up -d

# In separate terminals, run each service:
cd apps/api && npm install && npm run dev
cd apps/worker && npm install && npm run dev
cd apps/web && npm install && npm run dev
```

**Option B: Full containerized stack**

Best for testing the complete system:

```bash
# Start everything in containers
docker compose -f infra/compose/dev.compose.yml up -d

# View logs
docker compose -f infra/compose/dev.compose.yml logs -f
```

### Access Points

| Service | URL | Description |
|---------|-----|-------------|
| Web UI | http://localhost:5173 | React frontend (Vite) |
| API | http://localhost:3000 | REST API |
| API (via Nginx) | http://localhost/api | Proxied API |
| OpenAPI Docs | http://localhost:3000/api/docs | API documentation |
| MinIO Console | http://localhost:9001 | S3 storage admin |
| Grafana | http://localhost:3001 | Dashboards (admin/admin) |
| Prometheus | http://localhost:9090 | Metrics |
| Jaeger | http://localhost:16686 | Distributed tracing |

### Environment Configuration

1. Copy the environment template:
   ```bash
   cp infra/compose/.env.example infra/compose/.env
   ```

2. Edit `.env` with your configuration (OAuth credentials, secrets, etc.)

3. For local development, create service-specific `.env` files:
   - `apps/api/.env`
   - `apps/worker/.env`
   - `apps/web/.env`

See `SECURITY.md` for secret management guidelines.

### Docker Commands

```bash
# Start services
docker compose -f infra/compose/dev.compose.yml up -d

# Stop services
docker compose -f infra/compose/dev.compose.yml down

# View logs
docker compose -f infra/compose/dev.compose.yml logs -f [service]

# Rebuild after changes
docker compose -f infra/compose/dev.compose.yml up -d --build

# Reset everything (including volumes)
docker compose -f infra/compose/dev.compose.yml down -v
```

---

## One-command dev (goal)

Once implemented, this should work:

```bash
./scripts/dev-up.sh
./scripts/dev-down.sh
```

Agent tasks should prioritize making these scripts reliable.

---

## Coding standards

### TypeScript
- `strict: true` everywhere
- Prefer runtime validation at boundaries (e.g., zod)
- Use explicit error types and consistent error responses

### API
- OpenAPI must stay in sync with handlers
- Every endpoint MUST:
  - propagate `traceId`
  - emit structured logs
  - emit metrics

### Testing

Run tests using the dev scripts or npm:

```bash
# Using dev scripts (recommended)
./scripts/dev.sh test              # Run all tests once
./scripts/dev.sh test ui           # Open Vitest UI (visual test browser)
./scripts/dev.sh test watch        # Run tests in watch mode
./scripts/dev.sh test coverage     # Run tests with coverage report

# Windows PowerShell
.\scripts\dev.ps1 test ui

# Using npm directly
npm run test                       # Run tests in watch mode
npm run test:unit                  # Run all tests once
npm run test:ui                    # Open Vitest UI
npm run test:coverage              # Run with coverage report
```

- Unit tests: fast, hermetic
- Integration tests: DB + S3 mocked or containerized
- "No test, no merge" (see `CLAUDE.md` Definition of Done)

---

## How work gets done (agent-first)

1. Put the work in `REQUIREMENTS.md` (or an issue) with acceptance criteria.
2. An agent implements with tests + telemetry.
3. PR review checks:
   - acceptance criteria
   - security requirements
   - observability requirements
   - docs updates

See `CLAUDE.md` for exact rules and checklists.
