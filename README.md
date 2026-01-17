# MemoriaHub

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

### Prereqs
- Node.js 20+ (or 18+), npm or pnpm
- Docker + Docker Compose
- PostgreSQL client tools (optional)

### 1) Configure environment
Create `.env` files:
- `apps/api/.env`
- `apps/worker/.env`
- `apps/web/.env`

See `REQUIREMENTS.md` and `SECURITY.md` for required secrets and safe handling.

### 2) Start dependencies
From repo root:

```bash
docker compose -f infra/compose/dev.compose.yml up -d
```

### 3) Run services
In separate terminals:

```bash
cd apps/api && npm i && npm run dev
cd apps/worker && npm i && npm run dev
cd apps/web && npm i && npm run dev
```

Open:
- Web UI: `http://localhost:5173`
- API: `http://localhost:8080`
- OpenAPI: `http://localhost:8080/api/docs`

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
- Unit tests: fast, hermetic
- Integration tests: DB + S3 mocked or containerized
- “No test, no merge” (see `CLAUDE.md` Definition of Done)

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
