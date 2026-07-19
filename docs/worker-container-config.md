# Worker Container Configuration Reference

| Field | Value |
|-------|-------|
| **Version** | 1.2 |
| **Last Updated** | July 2026 |
| **Status** | Implemented |

This is the single operator-facing page for every configuration setting that shapes MemoriaHub's distributed worker-container architecture — the API control plane, `memoriahub-worker` containers, and the CompreFace face-detection sidecar. It consolidates settings that are otherwise scattered across [Worker Node Setup & Troubleshooting](worker-node-setup.md), [Distributed Nodes spec](specs/distributed-nodes.md), [Bulk Uploads on a Cheap VPS](specs/bulk-upload-vps-tuning.md), [Bulk Import Resilience](specs/bulk-import-resilience.md), `infra/compose/.env.example`, and `.env.worker.example`. It is a reference and a decision guide, not a replacement for those documents — each section links back to the deep-dive material for the "why."

## Table of Contents

1. [Overview / Architecture at a Glance](#1-overview--architecture-at-a-glance)
2. [API-Side Settings](#2-api-side-settings)
3. [Worker-Container Settings](#3-worker-container-settings)
4. [CompreFace](#4-compreface)
5. [Credentials](#5-credentials)
6. [Recommended Presets](#6-recommended-presets)
7. [Verifying It's Working](#7-verifying-its-working)
8. [Cross-Links](#8-cross-links)

---

## 1. Overview / Architecture at a Glance

Three tiers make up the running system:

```
┌───────────────────────────┐     HTTPS, PAT/nod_ auth      ┌──────────────────────────┐
│  API (control plane)      │◄──────────────────────────────►│  memoriahub-worker        │
│  - sole Postgres writer   │   register / claim / renew /   │  container(s)             │
│  - sole storage-credential│   result / failure / heartbeat │  - claims jobs            │
│    holder                 │                                 │  - downloads media via    │
│  - can ALSO run some/all  │   presigned GET/PUT URLs        │    presigned URL          │
│    job types in-process   │────────────────────────────────►│  - runs compute locally   │
│    (ENRICHMENT_WORKER_MODE)│   (S3/R2, never through API)   │  - uploads results        │
└───────────────────────────┘                                 └────────────┬─────────────┘
                                                                            │ localhost:3000
                                                                            ▼
                                                                 ┌──────────────────────────┐
                                                                 │  CompreFace core sidecar  │
                                                                 │  (128-d face embeddings)  │
                                                                 └──────────────────────────┘
```

The API remains the sole source of truth for the job queue, the sole writer to Postgres, and the sole holder of storage-provider (S3/R2) credentials. A worker container is a compute contributor only: it authenticates, claims eligible `enrichment_jobs` rows, downloads media bytes directly from the storage provider via a short-lived presigned URL, runs compute, and submits a validated result back to the API for persistence. See the [Distributed Nodes spec §2](specs/distributed-nodes.md#2-security-model) for the full security model this diagram compresses.

**Two invariants hold everywhere below:**

1. **Nodes never touch the database.** Every interaction between a worker container and the API — register, heartbeat, claim, lease renew, result submission, failure report — flows over authenticated HTTPS to `/api/nodes/*`. A node cannot run SQL, read another circle's data, or see a storage-provider secret (`storage_provider_credentials` never leaves the API process).
2. **Direct node→provider calls use transient, per-job credentials, never long-lived secrets.** For `auto_tagging` (Anthropic/OpenAI vision) and `geocode` (Nominatim/Google), a node fetches a credential scoped to the one job it currently holds via `POST /api/nodes/:id/jobs/:jobId/credentials`, held in memory only for that call and never persisted to disk, config, or logs (redacted by the CLI's `redactSensitive()`). CompreFace calls go to the node's own locally-run sidecar (`http://compreface-core:3000`), never through the API. See [Distributed Nodes spec §2.7](specs/distributed-nodes.md#27-security-tradeoff-transient-per-job-credentials-instead-of-an-ai-proxy).

**Where each class of setting lives:**

| Setting class | Where it's set | Applies to | Restart required? |
|---|---|---|---|
| API worker-mode, retry/backoff, timeouts, storage-recovery, thumbnail-repair | API's `.env` (`infra/compose/.env`) | The API process (its in-process worker, the always-on lease reaper) | Yes (API restart) |
| Worker-container identity, tuning, face provider, image | `.env.worker` passed to `docker-compose.worker.yml` | Each `memoriahub-worker` container replica | Yes (container restart) |
| Feature toggles (`features.*`), per-feature tuning (`burst.*`, `dedup.*`, `face.*`, `jobs.stuckThresholdMinutes`, etc.) | Admin UI (`/admin/settings/*`), persisted in `system_settings` (Postgres JSONB) | Whole deployment, read live on next job/request | No — takes effect on the next relevant call |
| Node credential (`nod_` token) | Admin UI `/admin/settings/nodes` → Node Credentials, or `memoriahub node enroll` | One worker's `MEMORIAHUB_TOKEN` | No (until rotated) |

---

## 2. API-Side Settings

Set in the API's `.env` (see `infra/compose/.env.example`). Restarting the API process is required for any change here to take effect.

### 2.1 Worker mode — the master switch

| Setting | Default | Range / values | What it controls | When to change |
|---|---|---|---|---|
| `ENRICHMENT_WORKER_MODE` | `all` (effectively — see below) | `all` \| `system` \| `off` | Whether, and which job types, the API's own in-process worker claims. See table below for exact type lists. An unrecognized value warns once and is treated as `all` (fail-open, per `resolveWorkerMode()` in `apps/api/src/enrichment/enrichment-job.worker.ts`). | Set to `system` once a healthy worker-container fleet is running; `off` only once you are certain every claimable type is covered by nodes. |
| `ENRICHMENT_WORKER_ENABLED` | `true` | boolean | **Legacy fallback**, consulted only when `ENRICHMENT_WORKER_MODE` is unset: `false` → mode `off`, anything else → mode `all`. | Prefer `ENRICHMENT_WORKER_MODE`; kept for back-compat. |
| `FACE_WORKER_ENABLED` | `true` | boolean | Older legacy alias, same effect as `ENRICHMENT_WORKER_ENABLED`. | Prefer `ENRICHMENT_WORKER_MODE`. |
| `ENRICHMENT_SYSTEM_MODE_EXTRA_TYPES` | *(empty)* | comma-separated job-type names | Escape hatch: pins additional job types to the in-process worker even in `system` mode. Unregistered type names are dropped with a warning. | Rare — only if a future job type needs to stay server-only but isn't yet in the hard-coded server-only set. |

**What `system` mode keeps in-process vs. offloads** (from `EnrichmentHandlerRegistry.serverOnlyTypes()` — handlers *without* a `nodeResultSchema`/`persistNodeResult` pair — plus `thumbnail_repair`, added explicitly for interface-parity reasons; verified against `apps/api/src/enrichment/server-only-types.spec.ts`, which asserts this exact list against the real handler registry):

| Kept in-process by `system` mode (server-only, 9 types) | Offloaded to the worker-container fleet (media compute, 8 types) |
|---|---|
| `burst_detection` | `face_detection` |
| `duplicate_detection_batch` | `video_face_detection` |
| `face_auto_archive_sweep` | `auto_tagging` |
| `job_history_purge` | `geocode` |
| `location_inference` | `duplicate_detection` |
| `storage_insights` | `metadata_extraction` |
| `storage_migration` | `social_media_detection` |
| `trash_purge` | `thumbnail_regen` |
| `thumbnail_repair` *(global sweep, no `inputUrl` — kept server-side for interface parity only, never actually node-claimable; see [Distributed Nodes spec §8.1](specs/distributed-nodes.md#81-high-value-no-secrets-needed-freely-node-eligible--final-status))* | |

> **Warning — `system`/`off` mode with no healthy worker requires a node fleet.** In `system` or `off` mode, none of the 8 media-compute job types above will ever be processed unless at least one worker container is registered, online, and heartbeating. Uploaded photos/videos will sit at `pending` indefinitely — face detection, tagging, thumbnails for new uploads, etc. all stall. Always confirm fleet health (§7) immediately after switching to `system` or `off`.

### 2.2 The lease reaper (always on, independent of worker mode)

| Setting | Default | Range / values | What it controls | When to change |
|---|---|---|---|---|
| `ENRICHMENT_REAPER_ENABLED` | `true` | boolean | `EnrichmentStuckResetTask`, which requeues jobs whose `leaseExpiresAt` has passed without renewal — runs regardless of `ENRICHMENT_WORKER_MODE`, including `off`, because an external node fleet is exactly where claimed jobs die mid-flight most often. | Set `false` only on a secondary API instance that must never touch the queue (another instance must run the reaper). |

### 2.3 In-process worker concurrency and polling

| Setting | Default | Range / values | What it controls | When to change |
|---|---|---|---|---|
| `ENRICHMENT_WORKER_CONCURRENCY` | `1` | integer ≥ 1 | Concurrent job slots for the API's own in-process worker (irrelevant to worker containers, which have their own `MEMORIAHUB_CONCURRENCY`). | Raise cautiously — each slot holds a full decoded-image buffer in memory; see [bulk-upload-vps-tuning.md §3](specs/bulk-upload-vps-tuning.md#3-the-levers-in-priority-order). |
| `ENRICHMENT_JOB_POLL_MS` | `5000` | ms | Poll interval for the in-process worker's claim loop. | Lower for faster pickup latency at the cost of more idle-poll DB queries; rarely needs changing. |

### 2.4 Retry, backoff, and rate-limit handling (shared logic — `EnrichmentTerminalService`)

These apply identically whether a job was executed in-process or its result/failure was submitted by a worker container (§6.1 of the [Distributed Nodes spec](specs/distributed-nodes.md#61-the-computepersist-split)).

| Setting | Default | Range / values | What it controls | When to change |
|---|---|---|---|---|
| `ENRICHMENT_MAX_ATTEMPTS` | `3` | integer | Max processing attempts (charged at claim time) before a normal-failure job is permanently `failed`. | Raise if transient failures (network blips) are common and you want more automatic retries. |
| `ENRICHMENT_RETRY_BASE_MS` | `2000` | ms | Base delay for the first normal-error retry (doubles each attempt, equal-jitter exponential). | Rarely changed. |
| `ENRICHMENT_RETRY_MAX_MS` | `60000` | ms | Cap on normal-error retry backoff. | Rarely changed. |
| `ENRICHMENT_RATELIMIT_BASE_MS` | `30000` | ms | Base delay for the first rate-limit deferral. | Rarely changed. |
| `ENRICHMENT_RATELIMIT_MAX_MS` | `900000` (15 min) | ms | Cap on rate-limit deferral backoff. | Raise for very large runs where a provider quota window may take hours to clear. |
| `ENRICHMENT_RATELIMIT_MAX_HITS` | `10` | integer | Rate-limit deferrals (tracked separately from `ENRICHMENT_MAX_ATTEMPTS`) before permanent failure. | Raise for sustained multi-thousand-item backfills against a tight provider quota. |

A node reporting `POST /api/nodes/:id/jobs/:jobId/failure` with `rateLimited: true` routes through this exact same deferral machinery and trips the shared `ProviderThrottleService` gate — a node-reported 429 backs off sibling server-side jobs of the same provider too.

### 2.5 Timeouts and lease duration

| Setting | Default | Range / values | What it controls | When to change |
|---|---|---|---|---|
| `ENRICHMENT_JOB_TIMEOUT_MS` | `600000` (10 min) | ms, `0` disables | Active per-job execution timeout for every job type except the two video types below; a handler running longer is aborted and routed through normal-failure retry. | Must exceed the longest legitimate single-job runtime for the remaining (non-video) types. |
| `ENRICHMENT_VIDEO_JOB_TIMEOUT_MS` | `1200000` (20 min) | ms, `0` disables | Per-type override for `video_face_detection` and `social_media_detection` — legitimately slower (multi-GB download + ffmpeg + per-frame provider calls) on a low-compute host. | Raise if large videos are being killed as "timed out" on a slow node/VPS. |
| `ENRICHMENT_LEASE_MS` | `1800000` (30 min) | ms | Lease duration granted at claim time to BOTH the in-process worker (`EnrichmentClaimService`) and a worker container claiming via `POST /api/nodes/:id/claim`. A container renews the lease with `POST /api/nodes/:id/jobs/:jobId/renew` (default renewal cadence: every 30s, `leaseRenewIntervalMs` in `apps/cli/src/node/node-engine.ts`) before it expires; an expired, unrenewed lease is requeued by the reaper (§2.2). | Raise if legitimate compute (e.g. a very large video on a slow node) routinely exceeds 30 minutes even with renewal happening; lower to detect a dead node faster (at the cost of more false-positive requeues on a flaky network). |

### 2.6 Video, disk, and worker-fleet bookkeeping

| Setting | Default | Range / values | What it controls | When to change |
|---|---|---|---|---|
| `VIDEO_ENRICHMENT_MAX_BYTES` | `0` (no cap) | bytes | Hard cap on video size for BOTH `video_face_detection` and `social_media_detection`; an over-cap video is skipped without downloading a single byte. | Set a cap (a few hundred MB) during a bulk import to keep a multi-GB clip from filling temp disk on the executing side (server or node). |
| `FFMPEG_TIMEOUT_MS` | `60000` | ms | Hard timeout before an in-flight ffmpeg frame-extraction is `SIGKILL`ed. | Raise on a very slow/constrained host if legitimate extractions are being killed. |
| `FFPROBE_TIMEOUT_MS` | `30000` | ms | Hard timeout before an in-flight ffprobe call is killed. | Same rationale as above. |
| `NODE_OFFLINE_RETENTION_DAYS` | `14` | days | `NodeOfflinePruneTask` (daily) deletes `worker_nodes` rows offline this long AND with no jobs currently claimed/running. | Shorten to keep the admin fleet view tidier on a deployment that churns worker containers often; lengthen to retain history longer. |

### 2.7 Storage-processing recovery and thumbnail repair (brief — separate recovery path from the `enrichment_jobs` queue)

These cover the synchronous, in-process upload pipeline (content-hash/EXIF/dimensions/video-probe/thumbnail), not the queued job types above. Full detail: [Bulk Import Resilience](specs/bulk-import-resilience.md), and the "Admin: Stuck StorageObject Recovery" section of [CLAUDE.md](../CLAUDE.md).

| Setting | Default | What it controls |
|---|---|---|
| `STORAGE_PROCESSING_STUCK_MINUTES` | `10` | Threshold before `StorageProcessingRecoveryTask` (every 10 min) auto-recovers a `StorageObject` stuck at `status='processing'`. |
| `STORAGE_PROCESSING_MAX_RETRIES` | `3` | Cap on automatic recovery attempts per object before it's marked `failed`. |
| `STORAGE_PROCESSING_STUCK_RESET_ENABLED` | `true` | Kill switch for the recovery cron. |
| `THUMBNAIL_REPAIR_ENABLED` | `true` | Kill switch for the hourly `ThumbnailRepairTask` cron. |
| `THUMBNAIL_REPAIR_BATCH_SIZE` | `25` | Items repaired per cron run, processed sequentially. |
| `THUMBNAIL_REPAIR_MAX_ATTEMPTS` | `3` | Repair attempts per item before it's marked exhausted. |
| `THUMBNAIL_REPAIR_MIN_AGE_MINUTES` | `30` | Minimum object age before it's eligible for repair (avoids racing fresh uploads). |

### 2.8 Runtime system settings that also matter (not env vars)

Two settings live in the admin UI / `system_settings` JSONB, not the API's `.env`, but are directly relevant to fleet health:

- **`jobs.stuckThresholdMinutes`** (default **3**, range 1–120; `/admin/settings/jobs`) — how long a `running` job (including a zombie row) is tolerated before the stuck-reset cron/`POST /api/admin/jobs/reset-stuck` treats it as abandoned. Must exceed the longest legitimate single-item processing time on your slowest worker (server or node) or you risk the same job being claimed and run twice concurrently.
- **`features.*`** (e.g. `features.faceRecognition`, `features.autoTagging`, `features.burstDetection`, `features.duplicateDetection`, `features.locationInference`, `features.socialMediaDetection`, `features.faceAutoArchive`, `features.pictureEnhancement`) — global feature toggles, default off, edited per-feature under `/admin/settings/*`. A feature toggled on with `ENRICHMENT_WORKER_MODE=system`/`off` and no healthy node serving its job type will enqueue jobs that never process — see the Doctor `jobs.workerEnabled` check in §7.

---

## 3. Worker-Container Settings

Set in `.env.worker`, passed to `docker-compose.worker.yml`. A container restart (or `docker compose ... up -d` re-apply) is required for a change to take effect. Full walkthrough: [Worker Node Setup & Troubleshooting — Quick Start](worker-node-setup.md#quick-start-container-bundle-recommended).

### 3.1 `MEMORIAHUB_*` — worker identity and tuning

| Setting | Default | Range / values | What it controls | When to change |
|---|---|---|---|---|
| `MEMORIAHUB_URL` | *(required)* | URL | Base URL of the API this worker connects to (e.g. `https://your-domain/api`). | Always set. |
| `MEMORIAHUB_TOKEN` | *(required)* | `nod_...` or `pat_...` | Bearer credential. A `nod_` node credential (minted at `/admin/settings/nodes`) is preferred — least-privilege, `/api/nodes/*`-only, non-expiring, individually revocable. A PAT also works for back-compat. | Always set; prefer `nod_` for any long-running/unattended worker. |
| `MEMORIAHUB_NODE_NAME` | `worker` (compose default) | string | Display name for this host/replica. Registration is idempotent per `(owner, name)` — a restart re-attaches to the same node record. | **Must be unique per host/replica** — two containers sharing a name fight over job leases (`job not owned by this node`). |
| `MEMORIAHUB_NODE_ID` | *(unset)* | UUID | Resume an existing node registration explicitly. | Normally left unset; register-or-reattach resolves it via `MEMORIAHUB_NODE_NAME`. |
| `MEMORIAHUB_CONCURRENCY` | `2` (bundle default in `docker-compose.worker.yml`); CLI-native default is now core/RAM-aware (2–4 on a capable host) instead of a flat `1`, when neither this env var, `--concurrency`, nor persisted node config set an explicit value | integer ≥ 1 | Jobs this replica processes simultaneously. | Keep at 1–2 on memory-constrained hosts / AI-bound work; raise on beefier machines (see §6d). |
| `MEMORIAHUB_ELIGIBLE_TYPES` | *(unset — advertises everything the local capability probe supports)* | CSV of job-type names | Restricts which job types this node claims. | Narrow if you want a worker dedicated to one job type (e.g. only `face_detection`). |
| `MEMORIAHUB_POLL_INTERVAL_MS` | `5000` | ms | Claim-loop poll interval when idle. | Rarely changed. |
| `MEMORIAHUB_FACE_PROVIDER` | `human` (CLI-native); the bundle sets `compreface` | `human` \| `compreface` | Which face-detection provider this node uses locally. | Set to `compreface` whenever the server's active face provider (`PUT /api/face/features/detection`) is `compreface` — mismatched providers land in different embedding spaces (§4). The bundle already does this. |
| `MEMORIAHUB_COMPREFACE_URL` | `http://localhost:3000` (CLI-native); the bundle sets `http://compreface-core:3000` | URL | Base URL of the node's own local CompreFace sidecar; only consulted when `MEMORIAHUB_FACE_PROVIDER=compreface`. | Only if you point at a non-default port or a remote sidecar. |
| `MEMORIAHUB_STATE_DIR` | `~/.memoriahub` | path | Relocates the state directory (config, pidfile, IPC socket, logs, models); the bundle maps this to the `/data` volume. | Only for custom volume layouts. |
| `MEMORIAHUB_HEADLESS` | *(image entrypoint always headless regardless)* | `1` | Implies `--headless`: drains in-flight jobs and exits WITHOUT deregistering on `SIGTERM` (so a restart re-attaches instead of accumulating a new node record). | N/A for the published image; relevant only for a custom entrypoint. |
| `MODELS_DIR` | `~/.memoriahub/models` (CLI-native; the image already bakes models at `/app/models`, distinct from the API-side `MODELS_DIR` default of `./data/models` used for its own CLIP model copy) | path | Overrides where model resolution looks for CLIP/Human files. | Only to point at a different/mounted model directory (e.g. an air-gapped install). |

### 3.2 Bundle/compose knobs (`docker-compose.worker.yml` / `.env.worker`)

| Setting | Default | What it controls |
|---|---|---|
| `COMPREFACE_PROCESSES` | `2` | `UWSGI_PROCESSES` for the bundled `compreface-core` sidecar. Rule of thumb: `cores − 2`, capped around 6. Measured impact: bumping from 1→6 processes on an 8-core/32GB host cut `face_detection` job time from ~17–20s to ~2–3s (~8x). |
| `WORKER_VERSION` | `latest` | Image tag for `ghcr.io/marinoscar/memoriahub-worker`. Pin to a specific version (e.g. `cli-1.2.4`) for reproducibility and to guarantee compute parity with a known server CLI version. |
| `WORKER_STOP_GRACE` | `180s` | `stop_grace_period` — SIGTERM drain budget on `docker compose down`/stop. A job killed past this is requeued by the server's lease reaper (≤ `ENRICHMENT_LEASE_MS`, default 30 min), so this need not cover a full 20-minute video job. |

### 3.3 Memory/perf knobs on the worker itself

| Setting | Default | What it controls | When to change |
|---|---|---|---|
| `NODE_OPTIONS=--max-old-space-size=<MB>` | *(unset — Node default)* | V8 old-space heap cap for the worker's Node process. | Set explicitly on a memory-constrained worker host, same two-regime sizing logic as the API (§6, [bulk-upload-vps-tuning.md §3](specs/bulk-upload-vps-tuning.md#3-the-levers-in-priority-order)) — leave ~1 GB headroom above the cap for off-heap decode/inference buffers on a larger box, or size to ~55% of a small container's limit. Superseded in practice by `MEMORIAHUB_MAX_OLD_SPACE_MB` below — the worker node now sets its own heap ceiling automatically at startup unless that variable is set to `0`. |
| `MEMORIAHUB_MAX_OLD_SPACE_MB` | *(auto — ~50% of physical RAM, clamped 4000–12000 MB; 8000 MB on a 16 GB baseline host)* | Overrides the worker's automatically-computed `--max-old-space-size` re-exec value (see §3.5); integer MB, or `0` to disable heap re-tuning entirely and keep Node's default ~2 GB ceiling. | Set explicitly on a memory-limited container where 50% of the *host's* RAM would exceed the container's own cgroup memory limit — see §3.5. |
| `MEMORIAHUB_HEAP_SNAPSHOT` | `1` (enabled) | Whether the worker also passes `--heapsnapshot-near-heap-limit=1` alongside the raised heap ceiling, so a genuine near-OOM recurrence writes one heap snapshot (in the process's current working directory) pinpointing the retainer; `1` \| `0`. | Set `0` to suppress — a near-OOM snapshot of an 8 GB+ heap can be multi-GB on disk. |
| `MEMORIAHUB_SHARP_CONCURRENCY` | *(auto — half the cores, clamped 1–4)* | Per-pipeline libvips thread cap sharp uses (integer, 1–4); bounds peak native memory so it doesn't scale with cores × in-flight jobs. Paired with disabling sharp's per-process operation cache (a worker sees only distinct images, so the cache never hits and only pins native memory). | Override if the auto-computed default doesn't fit the host's available cores/memory. |
| `MEMORIAHUB_MEMWATCH` | `1` (enabled) | The memory watchdog samples `process.memoryUsage()` on an interval into the worker log (rss / heapUsed / heapTotal / external / arrayBuffers / heapLimit), escalating to `warn` past 85% of the ceiling so a slow climb is visible (see §3.5); `1` \| `0`. | Set `0` to silence the periodic sample line. |
| `MEMORIAHUB_HEAP_RESTART_FRACTION` | `0.90` | heapUsed/heapLimit fraction at which the pre-OOM safety valve fires: `node start` drains in-flight jobs (bounded 60 s) and exits `75` for a supervised restart; the TUI dashboard stops its embedded engine instead (see §3.5). A fraction in (0,1]; `0` disables. | Lower (e.g. `0.85`) to recycle sooner on a tight box; `0` to opt out entirely. |
| `FACE_MAX_IMAGE_DIM` | `2000` | Max long-edge pixels before downscaling for face detection. | Lower to 768–1024 on memory-constrained workers to shrink the per-job decoded-image buffer. |
| `TAG_MAX_IMAGE_DIM` | `1568` | Max long-edge pixels before downscaling for the auto-tagging vision call. | Same rationale as above; 1568 matches Anthropic's own auto-downscale threshold. |

### 3.4 Per-replica rules (repeated here because getting this wrong is the single most common fleet misconfiguration)

- **Every replica needs a distinct `MEMORIAHUB_NODE_NAME`.** Whether scaled via `--scale memoriahub-worker=N` or run on separate machines, two containers sharing an identity fight over job leases (`job not owned by this node`).
- **Never share the `/data` state volume between replicas.** It holds a pidfile and a Unix-domain-socket IPC channel that assume a single running instance.

### 3.5 Memory & OOM hardening

The worker node (`apps/cli/src/node/runtime-tuning.ts`) hardens its own memory posture for sustained multi-hour image-upload load, assuming a worker host has at least **16 GB RAM and 8 cores**. Previously a long-running worker slowly climbed V8's old-space heap and eventually crashed with "Ineffective mark-compacts near heap limit — JavaScript heap out of memory" at Node's ~2 GB default ceiling, even on a 32 GB machine.

On startup the worker re-execs itself once with `--max-old-space-size` raised to ~50% of physical RAM (clamped 4–12 GB; 8 GB on the 16 GB baseline), giving the same slow climb many more hours of headroom, plus `--heapsnapshot-near-heap-limit=1` so a genuine recurrence writes a single heap snapshot — **landing in the process's current working directory** — pinpointing the retainer. This applies to `node start` (foreground, `--daemon`, the systemd unit, and the container image entrypoint) and to the interactive Tools > Worker Node dashboard's embedded engine. Alongside the heap ceiling, sharp's per-process operation cache is disabled and per-pipeline libvips concurrency is capped so peak native memory doesn't scale with cores × in-flight jobs, and `MEMORIAHUB_CONCURRENCY`'s default is now core/RAM-aware (2–4) instead of a flat `1` (§3.1).

**Memory-limited container caveat:** the auto-computed heap size is 50% of the *host's* physical RAM, which can exceed what a container's own cgroup memory limit allows when the container is capped well below the host total. In that case, set `MEMORIAHUB_MAX_OLD_SPACE_MB` explicitly to a value below the container's memory limit (or `0` to disable heap re-tuning and fall back to Node's default ceiling).

**Raising the ceiling is necessary but not always sufficient.** A raised heap only buys time against a genuine (e.g. native-dependency) memory leak — the climb is slower but still terminal. Two runtime aids exist for exactly that case, plus a mitigation on the CLIP path:

**Memory watchdog (`MEMORIAHUB_MEMWATCH`, default on).** The worker samples `process.memoryUsage()` on an interval (default 60 s) and writes one structured line per sample to the worker log — `rss`, `heapUsed`, `heapTotal`, `external`, `arrayBuffers`, `heapLimit` (MB) and the heapUsed fraction — escalating to a `warn` line past 85% of the ceiling. This makes a slow climb visible in `memoriahub node logs` and, crucially, tells you **which pool** is growing: `heapUsed` climbing → a JS-object/string/typed-array leak (V8-managed); `external`/`arrayBuffers` climbing → native buffers (sharp / onnxruntime / undici); `rss` ≫ `heapUsed` → off-heap/native allocator. Pair it with the heap snapshot (`MEMORIAHUB_HEAP_SNAPSHOT`): the log says which pool, the snapshot names the exact retainer.

**Pre-OOM safety valve (`MEMORIAHUB_HEAP_RESTART_FRACTION`, default 0.90).** The first time `heapUsed` crosses this fraction of the ceiling, the worker pre-empts the OOM instead of crashing:
- **`node start` (container / systemd / daemon):** drains in-flight jobs (bounded to 60 s so a stuck job can't wedge the exit) then exits with code `75`, so the supervisor starts a **fresh** process — the container's `restart: unless-stopped` restarts on any exit, and the `node service` systemd unit's `Restart=on-failure` restarts on the non-zero code. **No work is lost:** drained/expired job leases are re-queued server-side. This turns an OOM crash-loop into a clean pre-emptive recycle. It **requires a supervisor** — a bare, unsupervised foreground `node start` will exit and stay down, so run sustained imports via the container or the systemd service, not a raw foreground process.
- **Tools > Worker Node TUI dashboard:** never kills the interactive session (and restarting only the in-process engine wouldn't free native singletons like the CLIP session), so it drains and stops the embedded engine and logs a message telling you to relaunch — ideally as a daemon/container for sustained loads.

Set `MEMORIAHUB_HEAP_RESTART_FRACTION=0` to disable the valve.

**CLIP-path mitigation.** The shared onnxruntime CLIP path (`duplicate_detection`) now disables the CPU mem arena / mem-pattern pools and disposes input/output tensors after each inference — parity-safe (the embedding is unchanged), reducing steady-state growth on that hot path. This lowers the likelihood of the leak; it is not a guaranteed cure, which is why the watchdog and safety valve exist.

**Capturing a heap snapshot to pin a leak.** On any version, run the worker with `NODE_OPTIONS="--heapsnapshot-near-heap-limit=2"`; when it nears OOM Node writes a `Heap.*.heapsnapshot` file to the process's working directory. Open it in Chrome DevTools → Memory → **Load**, sort by **Retained Size**, and the top constructor names the retainer. (On this build the flag is already applied automatically unless `MEMORIAHUB_HEAP_SNAPSHOT=0`.)

See §3.3 above for the full env-var reference: `MEMORIAHUB_MAX_OLD_SPACE_MB`, `MEMORIAHUB_HEAP_SNAPSHOT`, `MEMORIAHUB_SHARP_CONCURRENCY`, `MEMORIAHUB_MEMWATCH`, `MEMORIAHUB_HEAP_RESTART_FRACTION`.

---

## 4. CompreFace

The bundled `compreface-core` sidecar (`exadel/compreface-core:1.2.0-mobilenet`) produces 128-dimensional ArcFace/MobileFaceNet embeddings — the codebase is **committed to CompreFace** as its face-embedding space (all existing production face rows live in it), so a worker container defaults `MEMORIAHUB_FACE_PROVIDER=compreface` rather than the CLI's native default (`human`, 1024-d). Running Human on a node while the server is configured for CompreFace lands that node's faces in a different, non-comparable embedding space — person-matching cosine similarity silently produces false negatives or spurious matches. See [Worker Node Setup & Troubleshooting §5](worker-node-setup.md#5-matching-the-servers-face-detection-provider-compreface) for the full rationale and the native (non-container) setup path.

| Setting | Default | What it controls |
|---|---|---|
| `UWSGI_PROCESSES` | `${COMPREFACE_PROCESSES:-2}` | Parallel inference processes — CompreFace serves one request per uwsgi worker process, so this is the real parallelism knob (threads alone contend on Python's GIL and don't help). |
| `UWSGI_THREADS` | `1` | Left at 1 always — see above. |

**Health gating, not silent fallback.** The worker's `depends_on: compreface-core: condition: service_healthy` orders container startup, but the real guarantee against a silent fallback to Human is the worker's own start-time `verifyCompreface` gate: when `MEMORIAHUB_FACE_PROVIDER=compreface` and the node's eligible types include a face job, `node start` blocks on a bounded ~40s wait polling CompreFace's `/status` endpoint before claiming any jobs, and **fails outright** (not falling back to Human) if the sidecar never reports healthy. This matters because CompreFace takes ~15–30s to load its model on (re)create.

**Why not just use Human on the node?** The committed-to-CompreFace decision means every face row across the whole deployment must stay in one 128-d space for cosine-similarity person matching to work at all. Human's 1024-d space is not comparable, so it is never an acceptable substitute once CompreFace is the server's active provider — regardless of Human's lower operational overhead (it needs no sidecar container).

See [Worker Node Setup & Troubleshooting §5.2](worker-node-setup.md#52-prerequisite-run-your-own-local-compreface-sidecar) for the equivalent core-aware sizing guidance on a native (non-container) install.

---

## 5. Credentials

Two credential types authenticate a worker to `/api/nodes/*`:

| Type | Prefix | Scope | Expiry | Revocation | Preferred for |
|---|---|---|---|---|---|
| **Node credential** | `nod_` | `/api/nodes/*` ONLY — can never reach media/settings/admin endpoints, even for an Admin-owned credential | Nullable — may never expire | Individually revocable at any time | Any long-running/unattended worker (systemd service, fleet container) |
| **Personal Access Token (PAT)** | `pat_` | Every `jobs:write`-gated endpoint, including the admin job-queue dashboard's retry/reset/delete actions | Configurable TTL | Revoke via `DELETE /api/pat/{id}` | Back-compat / ad-hoc use; still fully valid on node endpoints |

Mint a node credential at `/admin/settings/nodes` → Node Credentials → Create (raw token shown once, never retrievable again), or run `memoriahub node enroll` for the interactive device-flow login + auto-mint path. No new permission was introduced — minting/listing/revoking a node credential requires the same `jobs:write` permission that already gates every node-facing endpoint; the credential itself, once minted, is what enforces the `/api/nodes/*`-only route allowlist. See [Distributed Nodes spec §13](specs/distributed-nodes.md#13-durable-node-credentials-nod_-tokens) for the full model, including why PATs alone were judged insufficient for an always-on worker.

---

## 6. Recommended Presets

### (a) Single box — default posture, change nothing

`ENRICHMENT_WORKER_MODE=all` (the default). The API's in-process worker claims every job type. No worker containers needed. This is correct for a household running MemoriaHub on one VPS with no spare hardware.

### (b) VPS + a home worker node, API stays `all`

```
# API .env — unchanged, still all
ENRICHMENT_WORKER_MODE=all
```
```
# .env.worker on the home machine
MEMORIAHUB_URL=https://your-domain/api
MEMORIAHUB_TOKEN=nod_...
MEMORIAHUB_NODE_NAME=home-laptop
MEMORIAHUB_CONCURRENCY=2
```
The node adds opportunistic capacity on top of the API's own worker; both share the queue safely via `FOR UPDATE SKIP LOCKED` claiming — no coordination needed between them. **Face-provider parity matters:** if the server's active face provider is `compreface`, the node must also run `MEMORIAHUB_FACE_PROVIDER=compreface` (the container bundle default) or its face rows will land in a different, non-comparable embedding space.

### (c) Control-plane VPS + worker fleet

```
# API .env
ENRICHMENT_WORKER_MODE=system
```
```
# .env.worker (one or more replicas / hosts)
MEMORIAHUB_URL=https://your-domain/api
MEMORIAHUB_TOKEN=nod_...
MEMORIAHUB_NODE_NAME=worker-1     # unique per replica/host
MEMORIAHUB_CONCURRENCY=2
```
The API stops doing heavy per-item compute (face detection, tagging, dedup embeddings, etc.) and stays responsive for HTTP traffic; the fleet handles all media-compute job types. Confirm at least one node is online and heartbeating **before** relying on `system` mode in production (§7) — an empty or unhealthy fleet under `system` mode means uploaded media simply never gets enriched.

### (d) Bulk-import survival (the ~14k-item scenario)

```
# API .env
ENRICHMENT_WORKER_MODE=system
```
```
# .env.worker
MEMORIAHUB_URL=https://your-domain/api
MEMORIAHUB_TOKEN=nod_...
MEMORIAHUB_NODE_NAME=bulk-worker-1
MEMORIAHUB_CONCURRENCY=1          # start at 1, step up one at a time
```
```
# docker run / compose override on the worker container
NODE_OPTIONS=--max-old-space-size=<container_MB - 1024>   # e.g. 1024 for a 2G container
FACE_MAX_IMAGE_DIM=1024
TAG_MAX_IMAGE_DIM=1024
VIDEO_ENRICHMENT_MAX_BYTES=500000000   # skip anything over ~500MB during the import
```
Give the worker container an explicit memory limit and a matching heap cap using the same two-regime rule as the API (`≤1GB → ~55% of the limit`; `≥2GB → limit − 1GB`) — see [bulk-upload-vps-tuning.md §3](specs/bulk-upload-vps-tuning.md#3-the-levers-in-priority-order). **The point of moving compute off the API is defeated if the worker container itself now OOM-loops** — size its container limit and heap cap with the same care documented for the API, don't assume "it's not the API anymore" means memory sizing no longer matters. Lower `*_MAX_IMAGE_DIM` and cap video size the same way you would on a constrained API host, because the memory-pressure mechanics (V8 heap vs. off-heap decoded-image/inference buffers) are identical on a worker container.

---

## 7. Verifying It's Working

- **`memoriahub node doctor`** (CLI, or Tools ▸ Worker Node ▸ Node doctor in the TUI) — reports API access, installed-vs-operational capability status per dependency, per-job-type readiness, model manifest verification, and daemon liveness. See [Worker Node Setup & Troubleshooting §8](worker-node-setup.md#8-reading-node-doctor-output) for how to read installed vs. operational.
- **Admin Doctor sweep** (`POST /api/admin/doctor/run`, or `/admin/settings/doctor`) — the `nodes` section reports registered-node count, heartbeat freshness (stale past `NODE_HEARTBEAT_STALE_SECONDS`, default 60s — verified in `apps/api/src/doctor/doctor.service.ts`, not documented elsewhere), expired/un-reaped leases, and per-node capability health. The `jobs.workerEnabled` check is mode-aware: under `system` or `off` mode it specifically checks for at least one online, fresh-heartbeat node whose `eligibleTypes` cover heavy media compute (`face_detection`, `auto_tagging`) — **`system`/`off` mode with zero healthy such nodes reports a `warning`** ("media enrichment jobs will not be processed") whenever any relevant feature toggle is on, rather than silently doing nothing.
- **`/admin/settings/nodes`** — live fleet view: registered nodes, status (`online`/`draining`/`offline`/`disabled`), last heartbeat, eligible types, per-node job counts (claimed/running/succeeded/failed).
- **`/admin/settings/jobs`** — the queue itself. A `system`/`off`-mode deployment with no healthy node shows the tell-tale symptom directly: media-compute job types (`face_detection`, `auto_tagging`, etc.) accumulating at `status='pending'` with a growing count and no matching drop in `running`/`succeeded` — nothing is claiming them.

**What "system mode with no healthy node" looks like end-to-end:** uploads still succeed (the upload path only enqueues jobs, it doesn't wait for enrichment), but photos never get face detection, tags, or auto-generated data; the Doctor `jobs.workerEnabled` check turns `warning`; and `/admin/settings/jobs` shows a pending backlog for every media-compute type that never shrinks. This is the single most common misconfiguration after switching to `system`/`off` mode — always verify fleet health immediately after the switch, not just once at initial setup.

---

## 8. Cross-Links

- [Worker Node Setup & Troubleshooting](worker-node-setup.md) — practical install/troubleshooting companion: the container Quick Start, native install path, CompreFace setup, model manifest, `node doctor` output, and a troubleshooting table.
- [Distributed Nodes spec](specs/distributed-nodes.md) — full architecture: security model, data model, multi-process-safe claim (`FOR UPDATE SKIP LOCKED`), result contracts, embedding/model parity, worker modes (§14), durable node credentials (§13), container fleet topology (§15).
- [Bulk Uploads on a Cheap VPS](specs/bulk-upload-vps-tuning.md) — the memory-sizing model (V8 heap vs. off-heap), the two heap-cap regimes, per-container-size presets, and `dmesg`-based OOM diagnosis this document's §6(d) preset draws from.
- [Bulk Import Resilience](specs/bulk-import-resilience.md) — provider rate-limit classification matrix, stuck-job recovery runbook, CLI durable multipart resume.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | July 2026 | AI Assistant | Initial consolidated operator reference for the worker-container architecture: API-side env vars, worker-container env vars, CompreFace sizing, credentials, four recommended presets, and fleet-health verification steps. |
| 1.1 | July 2026 | AI Assistant | Documented worker-node memory/OOM hardening (`apps/cli/src/node/runtime-tuning.ts`): new §3.5, the three new env vars (`MEMORIAHUB_MAX_OLD_SPACE_MB`, `MEMORIAHUB_HEAP_SNAPSHOT`, `MEMORIAHUB_SHARP_CONCURRENCY`), and the core/RAM-aware `MEMORIAHUB_CONCURRENCY` default. |
| 1.2 | July 2026 | AI Assistant | Documented the memory watchdog (`MEMORIAHUB_MEMWATCH`), the pre-OOM drain-and-restart safety valve (`MEMORIAHUB_HEAP_RESTART_FRACTION`), the CLIP-path onnxruntime mitigation, and the heap-snapshot capture recipe in §3.5 + §3.3. Companion to the leak investigation (issue #156). |
