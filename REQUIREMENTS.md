# MemoriaHub Requirements

This document defines **MVP functional requirements (FR)** and **non-functional requirements (NFR)** in acceptance-style statements.

## MVP Functional Requirements (FR)

### FR-001 OAuth login
**Given** a user visits MemoriaHub
**When** they choose an OAuth provider and authenticate
**Then** they are logged in and can access their profile

Acceptance:
- No password storage
- Session token issued
- Login event is auditable

### FR-010 Libraries
**Given** an authenticated user
**When** they create a library
**Then** it is private by default and only they can access it

Acceptance:
- Visibility: private/shared/public
- Membership management for shared

### FR-020 WebDAV upload
**Given** a user has a valid WebDAV token scoped to a library
**When** they upload a file via WebDAV
**Then** the asset is stored in object storage and an ingestion event is recorded

Acceptance:
- TraceId persisted on asset/event
- Upload audit event recorded
- File validation (type/size)

### FR-030 Processing pipeline
**Given** an uploaded asset
**When** the worker processes it
**Then** metadata is extracted and derivatives are created

Acceptance:
- EXIF extraction where available
- Thumbnail + preview generation
- Asset transitions through statuses and ends in READY

### FR-040 Browse UI
**Given** a library with assets
**When** a user opens the timeline/grid
**Then** they can browse thumbnails and open the viewer

Acceptance:
- Pagination/virtualization for performance
- Viewer shows basic metadata

### FR-050 Search
**Given** assets in a library
**When** a user filters by date or location
**Then** results match the filters

Acceptance:
- Search respects authorization

### FR-060 People + Tags (basic)
**Given** enrichment is enabled
**When** a user views an asset
**Then** they can see detected tags and manage person labels

Acceptance:
- Human-in-the-loop labeling exists

### FR-070 Chat retrieval (basic)
**Given** a user asks a natural language query
**When** the system interprets it
**Then** it produces a structured filter and returns authorized results

Acceptance:
- System returns the interpreted filter (explainability)

## Non-Functional Requirements (NFR)

### NFR-001 Observability
- Every service uses OpenTelemetry
- Logs are structured JSON and include traceId
- Prometheus metrics exist for all critical flows
- Jaeger trace can show one asset’s lifecycle

### NFR-010 Security
- Strict object-level authorization (no IDOR)
- Tokens never logged
- Audit logging for sensitive actions

### NFR-020 Reliability
- Upload must not be lost; failures are retried or clearly reported
- Worker jobs have retry policy with backoff

### NFR-030 Performance
- UI supports large libraries (virtualized scrolling)
- API p95 latency targets defined and monitored

### NFR-040 Agent optimization
- Small, well-scoped tasks
- Deterministic commands and scripts
- Strong lint/typecheck/test gates

## Acceptance template (use in issues)
- User story
- Acceptance criteria
- API endpoints
- UI screens
- Tests required
- Telemetry required (logs/metrics/traces)
- Security notes
