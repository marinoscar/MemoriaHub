# MemoriaHub Project

This document consolidates the product vision, requirements, and roadmap for MemoriaHub.

---

## Vision

### Purpose
MemoriaHub is a **family memory hub** that stores photos and videos safely, keeps them searchable and organized, and guarantees you always have a copy, even when a cloud service is unavailable.

### Why this exists
- Photos and videos are among a family's most valuable assets.
- Cloud libraries are convenient, but **control** and **portability** matter.
- A system you cannot observe is a system you cannot trust.

### Product promise
1. **You own your media** (no vendor lock-in).
2. **Redundancy by design** (cloud + local options; replication).
3. **Privacy-first** (private by default; sharing is explicit).
4. **Searchable and intelligent** (metadata, location, people, objects).
5. **Transparent operations** (logs, metrics, traces, audits).

### Guiding principles
- **API-first**: everything the UI can do is exposed via the API.
- **Agent-built**: coding agents implement; humans own architecture and acceptance.
- **Observable-by-default**: every user journey is traceable end-to-end.
- **Fail safely**: uploads should not be lost; partial failures are diagnosable.
- **Small increments**: ship vertical slices (upload -> process -> view) early.

### Core user outcomes
- Upload/sync photos and videos easily.
- Browse timeline/grid and view details.
- Search by:
  - Date
  - Location
  - People
  - Tags/objects
- Share safely:
  - Private libraries
  - Shared libraries (invites)
  - Public links (explicit)
- Ask natural-language questions (chat-driven retrieval) that are converted into safe, authorized filters.

### What "done right" feels like
- A parent can find "Lucia at the beach in Costa Rica" in seconds.
- You can verify where any upload is in the pipeline (trace + job status).
- When something fails, the UI points you to a diagnosable reason.

### Non-negotiables
- OAuth auth (no password storage)
- HTTPS everywhere
- Audit logging for sensitive actions
- OpenTelemetry instrumentation in every service
- Tests + CI are mandatory from day one

---

## Requirements

This section defines **MVP functional requirements (FR)** and **non-functional requirements (NFR)** in acceptance-style statements.

### MVP Functional Requirements (FR)

#### FR-001 OAuth login
**Given** a user visits MemoriaHub
**When** they choose an OAuth provider and authenticate
**Then** they are logged in and can access their profile

Acceptance:
- No password storage
- Session token issued
- Login event is auditable

#### FR-010 Libraries
**Given** an authenticated user
**When** they create a library
**Then** it is private by default and only they can access it

Acceptance:
- Visibility: private/shared/public
- Membership management for shared

#### FR-020 WebDAV upload
**Given** a user has a valid WebDAV token scoped to a library
**When** they upload a file via WebDAV
**Then** the asset is stored in object storage and an ingestion event is recorded

Acceptance:
- TraceId persisted on asset/event
- Upload audit event recorded
- File validation (type/size)

#### FR-030 Processing pipeline
**Given** an uploaded asset
**When** the worker processes it
**Then** metadata is extracted and derivatives are created

Acceptance:
- EXIF extraction where available
- Thumbnail + preview generation
- Asset transitions through statuses and ends in READY

#### FR-040 Browse UI
**Given** a library with assets
**When** a user opens the timeline/grid
**Then** they can browse thumbnails and open the viewer

Acceptance:
- Pagination/virtualization for performance
- Viewer shows basic metadata

#### FR-050 Search
**Given** assets in a library
**When** a user filters by date or location
**Then** results match the filters

Acceptance:
- Search respects authorization

#### FR-060 People + Tags (basic)
**Given** enrichment is enabled
**When** a user views an asset
**Then** they can see detected tags and manage person labels

Acceptance:
- Human-in-the-loop labeling exists

#### FR-070 Chat retrieval (basic)
**Given** a user asks a natural language query
**When** the system interprets it
**Then** it produces a structured filter and returns authorized results

Acceptance:
- System returns the interpreted filter (explainability)

### Non-Functional Requirements (NFR)

#### NFR-001 Observability
- Every service uses OpenTelemetry
- Logs are structured JSON and include traceId
- Prometheus metrics exist for all critical flows
- Jaeger trace can show one asset's lifecycle

#### NFR-010 Security
- Strict object-level authorization (no IDOR)
- Tokens never logged
- Audit logging for sensitive actions

#### NFR-020 Reliability
- Upload must not be lost; failures are retried or clearly reported
- Worker jobs have retry policy with backoff

#### NFR-030 Performance
- UI supports large libraries (virtualized scrolling)
- API p95 latency targets defined and monitored

#### NFR-040 Agent optimization
- Small, well-scoped tasks
- Deterministic commands and scripts
- Strong lint/typecheck/test gates

### Acceptance template (use in issues)
- User story
- Acceptance criteria
- API endpoints
- UI screens
- Tests required
- Telemetry required (logs/metrics/traces)
- Security notes

---

## Roadmap

This roadmap is intentionally milestone-based (agent-friendly). Each milestone should be turned into epics/issues.

### Milestone 0: Repo foundation
- Monorepo scaffolding (apps + packages)
- CI: lint, typecheck, tests
- Docker Compose dev stack
- Base docs complete

### Milestone 1: Vertical slice (upload -> process -> view)
- OAuth login (one provider)
- Create a library
- WebDAV upload to S3
- DB records with traceId
- Worker generates thumbnail
- UI grid shows uploaded asset
- Jaeger trace shows full lifecycle

### Milestone 2: Metadata + search basics
- EXIF extraction + display
- GPS extraction + normalized location
- Search by date + location

### Milestone 3: Enrichment (incremental)
- Face detection + person labeling
- Object tagging
- Basic people/tags UI

### Milestone 4: Chat retrieval
- Query -> structured filter -> results
- Guardrails (authorization + safe filtering)

### Milestone 5: Sharing + audits
- Shared libraries (invites)
- Public link sharing
- Audit log UI + API

### Milestone 6: Redundancy
- Storage adapter interface solidified
- Replication jobs + status UI

### Ongoing: Observability maturity
- Dashboards + alerts
- SLOs and error budgets
- Runbooks expanded
