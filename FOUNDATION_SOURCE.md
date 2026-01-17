# MemoriaHub — Project Vision, Architecture, and Build Blueprint (Foundation Doc)

> **This is the merged “best-of-both” foundation doc.** It keeps the full product + architecture blueprint and upgrades the stack to treat **Observability + OpenTelemetry** as a first-class, non-negotiable capability.

---

## 0) What this document is

This is the **foundational source of truth** for building **MemoriaHub**, a photo + media platform focused on:

* **Preserving family memories**
* **Full ownership and control** of your media (not locked into any cloud)
* **Redundant storage** (cloud + local) to survive outages and failures
* **Powerful search** via metadata, location, faces, objects, and an AI chat experience
* **Operational clarity through observability** (logs, metrics, traces, audit)
* **AI-agent-driven delivery**: you are the architect; coding agents implement

This document is structured so you can:

* Give feedback section-by-section
* Convert sections into GitHub epics/issues
* Feed directly to coding agents (Claude Code) as project context

---

## 1) Product vision and principles

### 1.1 Vision

MemoriaHub is a **family memory hub** that stores photos and videos safely, keeps them searchable and organized, and guarantees you always have a copy—whether the cloud is available or not.

### 1.2 Why you’re building it

* Photos are one of a family’s most valuable assets.
* Convenience is great (cloud sync), but **control is non-negotiable**:
  * You want your own **authoritative library**
  * You want a **local hard drive / NAS copy**
  * You want **cloud as optional convenience**, not a single point of failure
* A system you cannot observe is a system you cannot trust.

### 1.3 Guiding principles (non-negotiables)

1. **You own your media**: no vendor lock-in
2. **Redundancy**: multiple storage backends can be enabled and kept in sync
3. **Privacy-first**: private libraries by default; sharing is explicit
4. **API-first**: the backend exposes everything via documented APIs
5. **Observability by design**: everything is measurable, traceable, and diagnosable
6. **Agent-built**: coding agents generate implementation; you supervise architecture and acceptance
7. **Test-driven**: automated tests and CI are mandatory from the start

---

## 2) High-level user experience (what users can do)

### 2.1 Core user flows

1. **Sign in with OAuth** (Google, Microsoft, GitHub, etc.)
2. **Create or select a Library**
3. **Upload / auto-sync photos and videos**
4. MemoriaHub **extracts metadata** and enriches the media:
   * EXIF/metadata (camera, timestamp, lens, etc.)
   * GPS (lat/long) + reverse geocoding to city/state/country
   * Face recognition (people tags)
   * Object/scene detection (beach, car, dog, etc.)
5. Users **browse** their photos (timeline, grid, albums)
6. Users **search** by:
   * Date range
   * Location (“San Juan, Puerto Rico”)
   * People (“Lucia”, “Valeria”)
   * Tags/objects (“beach”, “cars”)
7. Users can ask a **chat agent**:
   * “Show me all photos I took in Costa Rica in 2025”
   * “Find photos of Lucia at the beach”
8. Users manage **privacy & sharing** of libraries:
   * **Private** (only me)
   * **Shared** (invite specific users)
   * **Public** (anyone can view, typically link-based)

### 2.2 Differentiators vs typical photo apps

* **Hybrid ownership**: cloud convenience + local always-on copy
* **Self-host friendly**: deployable on your VPS using Docker Compose
* **Control**: multi-storage sync options
* **AI-powered retrieval** without requiring fully managed vendor services
* **Trustworthiness**: failures are detectable and diagnosable via observability

---

## 3) Technology decisions (locked)

### 3.1 Frontend

* **React + TypeScript**
* **MUI (Material UI)** for the component framework and UI consistency

### 3.2 Backend

* **Node.js + TypeScript**
* **API-first** with OpenAPI docs

### 3.3 Database

* **PostgreSQL** for persistence (users, libraries, metadata, tags, search indexes, jobs)

### 3.4 Storage + Ingestion

* **WebDAV ingestion endpoint** (for mobile/desktop sync apps)
* **S3-compatible object storage** for durable media storage
  * Start with **AWS S3**
  * Keep design compatible with self-hosted S3 endpoints (e.g., MinIO) for future independence

### 3.5 Security

* **OAuth** for authentication (no password storage)
* **JWT** for session/API authorization tokens
* **HTTPS everywhere**

### 3.6 AI + enrichment

Face recognition, object detection, reverse geocoding, and tagging will be integrated in the backend workflow (implementation can evolve, but the functional requirement is locked).

### 3.7 Delivery approach

* **Built primarily by Claude Code** (AI coding agents)
* You provide architecture, requirements, acceptance criteria, and review

---

## 4) Observability & Telemetry (FIRST-CLASS CAPABILITY)

### 4.1 Observability goals

MemoriaHub must always be able to answer:

* Is the system healthy?
* Are uploads working?
* Are background jobs progressing?
* Where did a specific photo fail?
* Who accessed what, and when?

Observability is required for:

* Reliability
* Debuggability
* Security auditing
* Long-term maintainability
* AI-agent-generated code validation

### 4.2 Baseline observability stack (self-hosted, Docker-friendly)

**Core tools (baseline recommendation):**

* **OpenTelemetry** — instrumentation standard (**mandatory**)
* **Prometheus** — metrics collection
* **Grafana** — dashboards + alerting
* **Loki** — log aggregation
* **Promtail** — Docker log shipping
* **Jaeger** — distributed tracing (initially)

All components must run via **Docker Compose**.

### 4.3 OpenTelemetry (mandatory)

OpenTelemetry is required in:

* API service
* WebDAV ingestion layer
* Worker/background job service

#### What must be instrumented

* HTTP requests (API + WebDAV)
* Background jobs
* Database calls
* Object storage calls
* Internal processing stages (EXIF, thumbnails, AI enrichment, replication)

#### Context propagation

A single `traceId` must follow:

Upload → DB record → job enqueue → worker execution → replication

`traceId` must be stored on:

* `MediaAsset`
* `IngestionEvent`
* `ProcessingJob`

### 4.4 Structured logging (required)

All services emit **JSON structured logs** to stdout.

**Required log fields (minimum):**

* `timestamp`
* `level`
* `service` (api | worker | web | proxy)
* `env`
* `traceId`
* `requestId`
* `userId` (if applicable)
* `libraryId`
* `assetId`
* `jobId` (worker)
* `eventType` (UPLOAD_RECEIVED, EXIF_DONE, TAGGING_DONE, etc.)
* `durationMs`
* `error` (message + stack, if applicable)
* `remoteIp`
* `userAgent`

Logs are collected via **Promtail → Loki** and queried in Grafana.

### 4.5 Metrics (Prometheus)

Each service must expose `/metrics`.

**Mandatory metrics:**

**API**

* request count
* latency (p50/p95/p99)
* error rate (4xx / 5xx)
* auth failures

**WebDAV**

* uploads count
* bytes uploaded
* upload latency
* upload failures

**Worker**

* job queue depth
* job duration (by type)
* job failures
* retry count

**Storage**

* S3 latency
* S3 error rate

**Database**

* active connections
* connection saturation
* disk usage

### 4.6 Tracing (Jaeger)

Distributed traces must show:

* API request span
* DB spans
* Storage spans
* Job enqueue span
* Worker job execution span
* Sub-steps (metadata, thumbnails, AI enrichment)

**Goal:** one trace = one photo’s lifecycle.

### 4.7 Health and readiness

Each service must expose:

* `/healthz` — process health (is it running)
* `/readyz` — dependency readiness (DB reachable, S3 reachable, etc.)

These endpoints must be lightweight and safe to call frequently.

### 4.8 Alerting (minimal but high-signal)

Initial alerts:

* API error rate > threshold
* API p95 latency > threshold
* Worker backlog growing
* Job failure spike
* Disk space low (critical)
* Storage failures spike

Alerting is handled via **Grafana Alerting**.

### 4.9 Audit logging (security & privacy)

Audit events must be persisted (append-only):

* Login events
* Library visibility changes
* Member invites/removals
* Public link creation/revocation
* Media access in shared/public contexts
* WebDAV uploads

Audit logs must be queryable (admin UI + API).

---

## 5) Domain model (product concepts)

### 5.1 Key entities

* **User**
  * Identity from OAuth provider(s)
  * Profile and preferences
* **Library**
  * Owner user
  * Visibility: Private / Shared / Public
  * Membership list (for shared)
* **Album** (optional in v1, but recommended)
  * User-curated grouping of media inside a library
* **MediaAsset**
  * Photo/video stored in S3
  * Original + derived versions (thumbnails, previews)
  * Metadata and enrichment fields
  * Observability fields: `traceId`, lifecycle timestamps, status
* **Person**
  * A known person label (e.g., Lucia, Valeria)
  * Face embeddings / reference set
* **Tag**
  * Objects/scenes (beach, car, dog)
  * User tags and AI tags
* **Location**
  * GPS coordinates
  * Reverse-geocoded fields (country/state/city)
* **IngestionEvent**
  * Tracking uploads from WebDAV
  * Status and processing pipeline
  * Observability fields: `traceId`, raw client info
* **ProcessingJob**
  * Background jobs for metadata extraction, thumbnails, AI enrichment, sync replication
  * Observability fields: `traceId`, attempts, timing, last_error

### 5.2 Privacy and access control model

Each Library has:

* `owner`
* `visibility`
* `members` (for shared)

Rules:

* Private: only owner
* Shared: owner + invited members
* Public: accessible by anyone (typically via a public link or public listing setting)

---

## 6) System architecture (software)

### 6.1 URL structure (single URL approach)

Keep one main domain (simple operations, simpler for agents) and expose API as a path:

* Frontend: `https://memoriahub.com/`
* Backend API: `https://memoriahub.com/api`
* WebDAV ingestion: `https://memoriahub.com/dav` (recommended distinct path)
* OpenAPI docs: `https://memoriahub.com/api/docs`

Operational endpoints per service:

* `/metrics`
* `/healthz`
* `/readyz`

This avoids cross-domain complexity (CORS, cookies across subdomains) and keeps deployment simpler.

### 6.2 Component overview

1. **React Web App**
   * Auth UI
   * Library management UI
   * Photo timeline, grid, viewer
   * Search UI
   * Sharing & permissions UI
   * Chat UI for natural language search

2. **Node.js API**
   * OAuth login initiation + callbacks
   * JWT issuance and refresh logic
   * Library CRUD and permissions enforcement
   * Media metadata APIs
   * Search APIs
   * Chat-agent orchestration API (query → results)

3. **WebDAV Server (within backend or as a dedicated service)**
   * Handles PUT/PROPFIND/LOCK etc. as needed
   * Enforces auth (token or basic auth mapped to a user/service account)
   * Writes incoming files into a staging area or directly into object storage
   * Emits an ingestion event for processing

4. **Object Storage (S3)**
   * Stores original media
   * Stores derived media (thumbnails, previews)
   * Stores optional sidecar metadata exports

5. **PostgreSQL**
   * Stores metadata, indexes, users, libraries, jobs

6. **Job Runner / Worker**
   * Handles asynchronous processing:
     * EXIF extraction
     * Thumbnail generation
     * Face detection/recognition
     * Object detection
     * Reverse geocoding
     * Storage replication/sync
     * Search indexing

> Strong recommendation: separate worker process/container from API for reliability.

---

## 7) Ingestion and processing pipeline (the “how”)

### 7.1 Core decision: event-driven vs polling

With WebDAV ingestion you control uploads at the server, so best practice is:

* **Event-driven ingestion**: on successful upload, create an `IngestionEvent` and enqueue processing jobs immediately.
* Keep a fallback **reconciler job** that periodically checks for orphaned/unprocessed items.

### 7.2 Proposed pipeline stages (observable by design)

Each stage emits:

* structured logs with `eventType`
* metrics (duration + success/failure)
* traces with child spans

**Stage A — Upload (WebDAV)**

1. Client (mobile sync app) uploads file via WebDAV `PUT`.
2. Server:
   * Authenticates user
   * Determines target Library (based on path mapping)
   * Writes file to staging disk OR streams directly into S3 (recommended: stream to S3 to avoid disk bloat)
3. Create DB records:
   * `MediaAsset` (status: `UPLOADED`)
   * `IngestionEvent` (status: `RECEIVED`)
   * Persist `traceId`, uploader info, and request metadata

**Stage B — Metadata extraction**

4. Worker extracts:
   * EXIF: timestamp, camera make/model, lens, orientation
   * GPS: lat/long if present
5. Store fields in `MediaAsset` metadata columns (or related tables)

**Stage C — Derivatives**

6. Worker generates:
   * Thumbnails (small/medium)
   * Preview image (web optimized)
7. Upload derivatives to S3 and store links in DB

**Stage D — Enrichment**

8. Face detection + embeddings
9. Object/scene detection → tags
10. Reverse geocoding: lat/long → city/state/country

**Stage E — Indexing**

11. Update search index tables (or internal vector/text indexes)
12. Mark `MediaAsset` status: `READY`

**Stage F — Replication (optional but in vision)**

13. If multi-storage is enabled:
   * replicate from primary store to secondary stores asynchronously
   * record replication status per backend

### 7.3 Handling “apps might not upload metadata”

Most photo transfers preserve EXIF metadata, but do not rely on that assumption.

Your system should:

* Treat metadata extraction as mandatory
* If EXIF is missing:
  * Use upload timestamp as fallback
  * Allow user to edit date/location manually

---

## 8) Storage strategy (control + redundancy)

### 8.1 Storage abstractions

Create a **Storage Adapter Interface** so you can support:

* AWS S3
* S3-compatible endpoint (future)
* Local/NAS filesystem target (future)
* Multiple targets concurrently (replication)

Minimum adapter operations:

* putObject
* getObject (stream)
* deleteObject
* listPrefix (optional)
* exists
* generateSignedUrl (optional)

### 8.2 Multi-storage sync model

You want “three storages in sync” (example: block/local, AWS, NAS).

Recommended architecture:

* Choose a **Primary store** (initially S3)
* Configure **Secondary stores** (NAS/local block)
* Replicate **asynchronously** via worker jobs
* Track replication state per asset: `PENDING`, `IN_PROGRESS`, `SUCCESS`, `FAILED`, `last_error`

Rules:

* Never block user upload on replication
* Provide admin UI to re-run failed replications
* Optional checksum verification for integrity

Replication jobs must emit metrics and logs, and be trace-linked to the originating upload lifecycle.

---

## 9) AI features (functional requirements)

### 9.1 Face recognition

User goal:

* “Show me all photos of Lucia / Valeria / my wife / my brother”

Functional requirements:

* Detect faces on upload
* Create face embeddings
* Match against known persons
* Allow user confirmation/override (human-in-the-loop improves accuracy)
* Allow manual labeling to build reference dataset over time

### 9.2 Object and scene detection

User goal:

* “Show me beach photos from 2005”
* “Show me photos with cars and animals”

Functional requirements:

* Tag media with detected objects/scenes
* Store tags with confidence score
* Allow user to add/remove tags manually
* Search by tags + date ranges

### 9.3 Location enrichment (geotagging)

User goal:

* Photos with lat/long should map to country/state/city

Functional requirements:

* Extract GPS EXIF when available
* Reverse geocode to place names
* Store normalized location records
* Allow user to fix location if wrong/missing

### 9.4 Natural language chat agent (photo retrieval)

User goal:

* Ask questions like:
  * “All photos I took in Costa Rica in 2025”
  * “Photos of Lucia at the beach”

Functional requirements:

* Chat UI
* Backend agent endpoint:
  * Convert query → structured filter (date range, location, people, tags)
  * Execute search
  * Return results + explanation (what filters used)
* Guardrails:
  * Only search within user’s authorized libraries
  * Avoid leaking other users’ media

Each AI enrichment step must be observable: spans, duration metrics, and logs (including confidence scores).

---

## 10) Authentication, authorization, and WebDAV security

### 10.1 OAuth

* Support multiple providers: Google, Microsoft, GitHub
* Persist provider identity mapping to a MemoriaHub user
* Use OAuth for login; do not store passwords

### 10.2 JWT

* After OAuth login, issue JWT for:
  * Web app API calls
  * Optional: WebDAV auth strategy (see below)

### 10.3 WebDAV security model

WebDAV is “just HTTP,” so security is:

* **HTTPS**
* **Authentication**
* **Authorization**

Recommended approach for WebDAV clients:

* Use **app-specific tokens** (preferred) or basic auth with a long random token
* Map tokens to a user and a target library path
* Restrict WebDAV paths: `/dav/{libraryId}/...`

Important:

* The WebDAV endpoint must enforce:
  * who can upload to which library
  * rate limits / size limits
  * content validation (image/video MIME types)
* Logging and audit:
  * record uploader, timestamp, IP, asset id, traceId

---

## 11) UI/UX direction (React + MUI)

### 11.1 Core UI principles

* Clean, modern, photo-first
* Fast browsing (infinite scroll, virtualization)
* Minimal clicks to find memories
* Strong filtering and search

### 11.2 Primary screens

1. Login
2. Home (recent photos, quick filters)
3. Library selector / settings
4. Timeline view
5. Grid view
6. Photo viewer (metadata + tags + people)
7. Search (chips + filters)
8. People (face clusters → assign name)
9. Places (city/state/country browsing)
10. Chat (query + results gallery + interpreted filters)

### 11.3 Admin/Diagnostics (recommended early)

* Ingestion status
* Processing job queue visibility
* Replication status per backend
* Failed job retry button
* Observability quick links:
  * Grafana dashboard
  * Logs in Loki
  * Trace lookup in Jaeger by traceId

---

## 12) API design and OpenAPI

### 12.1 API-first rule

All backend capabilities must be accessible via API endpoints and included in OpenAPI docs.

### 12.2 Endpoint categories (high-level)

* Auth: `/api/auth/*`
* Users: `/api/me`
* Libraries: `/api/libraries` CRUD
* Media: `/api/media` list/search
* Search: `/api/search` (structured filter)
* Chat: `/api/chat/query`
* Admin: `/api/admin/jobs`, `/api/admin/ingestion`
* WebDAV: `/dav/*`

### 12.3 “Single URL but strict separation”

Even if under one domain, keep strict internal separation:

* API routes under `/api`
* WebDAV routes under `/dav`
* UI routes under `/`

---

## 13) Development workflow optimized for Claude Code (agent-driven)

### 13.1 The “agent-built” operating model

You are:

* Chief Architect
* Product owner
* Acceptance authority

Claude Code (agents) are:

* Implementers
* Test writers
* Documentation writers

Everything is driven via:

* Requirements written as GitHub Issues (or Markdown specs)
* Agent prompts that reference those requirements
* Automated tests + CI as the gatekeeper

### 13.2 Core repo documents (must exist)

At repo root:

* `README.md` — how to run, test, build, deploy
* `VISION.md` — shortened version of this document
* `ARCHITECTURE.md` — diagrams + service boundaries
* `SECURITY.md` — auth, token handling, WebDAV security
* `CLAUDE.md` — agent instructions + commands + rules

### 13.3 CLAUDE.md (critical)

This is how Claude Code stays consistent. It should include:

* Tech stack summary
* Folder structure overview
* Commands (install/dev/test/lint/build/docker compose up/down)
* Coding standards (TypeScript strictness, naming, error handling)
* Testing rules (TDD expectation, naming conventions, coverage targets)
* Definition of Done checklist
* **Observability rules (mandatory):**
  * Every endpoint logs start/end, propagates traceId, and emits latency + error metrics
  * Every job emits lifecycle logs, duration metrics, and trace-linked spans
  * No feature is complete without telemetry

### 13.4 Sub-agent strategy (Claude Code sub-agents)

Recommended sub-agents:

1. Product Spec Agent
2. API Agent
3. WebDAV Agent
4. Worker/Processing Agent
5. DB Agent
6. UI Agent
7. Test Agent
8. DevOps/Infra Agent

---

## 14) GitHub strategy (use the full ecosystem)

### 14.1 Repo structure

Single monorepo recommended:

* `/apps/web` (React)
* `/apps/api` (Node API + WebDAV)
* `/apps/worker` (processing jobs)
* `/packages/shared` (types, utilities, API client)
* `/infra` (docker compose, deployment configs)
* `/docs` (architecture, diagrams, decisions)

### 14.2 Issues and templates

Create issue templates:

* Feature
* Bug
* Tech Debt
* Spike/Research
* Security

Each feature issue must include:

* user story
* acceptance criteria
* API endpoints impacted
* UI pages impacted
* tests required
* telemetry required (logs/metrics/traces)
* rollout notes

### 14.3 Branching and PR policy

* `main` is always deployable
* feature branches per issue
* PR required; no direct pushes to main
* PR checklist enforced

### 14.4 GitHub Actions (CI/CD)

Pipelines to include:

* CI: install, lint, typecheck, unit tests, integration tests
* Build: build web + api + worker
* Docker: build images, optional push
* Release: semantic versioning, changelog, release notes

---

## 15) Testing strategy (TDD-first)

### 15.1 Testing layers

1. Unit tests
2. API integration tests
3. Worker tests
4. UI tests

### 15.2 Golden rule

No feature is “done” unless:

* tests exist
* CI passes
* docs updated
* telemetry exists (logs + metrics + traces)

---

## 16) Deployment (Docker Compose on VPS)

### 16.1 Core containers

* `web` (React build served via web server)
* `api` (Node API + WebDAV)
* `worker` (background processing)
* `db` (Postgres)
* optional: `redis`/queue (if used), `proxy` (nginx/traefik)

### 16.2 Observability containers (first-class)

* `grafana`
* `prometheus`
* `loki`
* `promtail`
* `jaeger`

MemoriaHub is not considered “running” unless:

* Metrics are scraping
* Logs are visible
* Traces are flowing

### 16.3 Environment variables

Use `.env` for secrets and configuration:

* database connection
* OAuth credentials
* JWT signing keys
* S3 credentials and bucket names
* WebDAV settings
* worker concurrency
* reverse geocoding configuration
* OpenTelemetry exporter config
* Prometheus scrape labels and ports

---

## 17) v1 scope (recommended to ship)

### 17.1 v1 must-have

* OAuth login
* Libraries (private/shared/public)
* WebDAV upload path
* S3 storage for originals
* Metadata extraction (EXIF + GPS)
* Thumbnails + preview
* Browse timeline/grid/viewer
* Search by date and location
* Basic face detection + person labeling (even if matching is basic)
* Basic object tagging
* Basic chat query → structured search (even if limited)
* **Observability baseline**: OpenTelemetry + Prometheus metrics + Loki logs + Jaeger traces + a starter Grafana dashboard

### 17.2 v1 nice-to-have

* Multi-storage replication (at least “secondary backup”)
* Places UI
* People clusters UI
* Admin job dashboard

### 17.3 v2+ (defer)

* Advanced collaboration features
* Extensive media editing
* Smart albums and highlights
* Full offline client apps (beyond WebDAV sync apps)

---

## 18) Immediate next steps (execution plan)

### Step 1 — Create the GitHub repo foundation

* Add the repo documents: README.md, CLAUDE.md, VISION.md, ARCHITECTURE.md, SECURITY.md
* Add issue templates and PR templates
* Add GitHub Actions baseline CI
* Add an initial Observability dashboard and scrape targets

### Step 2 — Deliver the first vertical slice (end-to-end)

Goal: upload → process → view

* WebDAV upload to S3
* DB records created with traceId
* worker generates thumbnail
* UI shows uploaded photo in a simple grid
* trace shows full lifecycle in Jaeger

### Step 3 — Add enrichment incrementally

* EXIF details panel
* GPS → city/state/country
* Face detection → People page
* Object tagging → Tags filter

### Step 4 — Add chat retrieval

* Build query → structured filter → results pipeline

### Step 5 — Add replication

* Secondary storage adapter + async replication jobs

---

## 19) Open questions to capture (keep this list updated)

* WebDAV auth approach (app tokens vs basic auth mapping)
* Job queue mechanism for workers
* Search indexing approach (SQL-based indexes first vs more advanced later)
* Reverse geocoding dataset strategy
* Face recognition model approach and storage format for embeddings
* Object detection model approach and tag taxonomy

---

## 20) Definition of Done (project-wide)

A feature is done when:

* Code merged to main via PR
* Tests exist and pass in CI
* OpenAPI updated for any API changes
* UI documented with screenshots (if UI)
* Release notes updated
* No secrets committed
* Docker Compose still runs end-to-end
* **Logs emitted** (structured)
* **Metrics exposed** (Prometheus)
* **Traces created** (OpenTelemetry)

---

## 21) Short positioning (for README)

**MemoriaHub** is a privacy-first photo and media platform that preserves family memories with full ownership: cloud convenience, local control, intelligent search, resilient backups, and **full observability**.

