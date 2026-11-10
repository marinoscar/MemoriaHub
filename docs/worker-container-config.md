# Worker Container Configuration Reference

| Field | Value |
|-------|-------|
| **Version** | 2.0 |
| **Last Updated** | November 2026 |
| **Status** | Implemented (RETRO-C10 #616, RETRO-C11 #620) |

The single page for every setting that shapes MemoriaHub's worker fleet: the API's queue variables (`JOBS_*`, `NODE_*`), the worker container's variables (`MEMORIAHUB_*`) and the CompreFace sidecar. The queue and the node engine are the EnterpriseAppBase (EAB) platform's; for design and the full platform variable list read the EAB documents `docs/specs/job-queue.md`, `docs/specs/worker-nodes.md` and `docs/runbooks/run-worker-nodes.md` and the generated [`infra/compose/.env.example`](../infra/compose/.env.example), which is the reference for every `JOBS_*` and `NODE_*` default. This page does not copy them; it says what is MemoriaHub-specific.

Companions: [setup and troubleshooting](worker-node-setup.md), [fleet runbook](runbooks/worker-fleet.md), [what runs on a node](specs/distributed-nodes.md).

## Table of Contents

1. [Architecture at a glance](#1-architecture-at-a-glance)
2. [API-side settings](#2-api-side-settings)
3. [Worker-container settings](#3-worker-container-settings)
4. [Legacy names (one release)](#4-legacy-names-one-release)
5. [CompreFace](#5-compreface)
6. [Credentials](#6-credentials)
7. [Recommended presets](#7-recommended-presets)
8. [Verifying it works](#8-verifying-it-works)

## 1. Architecture at a glance

```
 API (control plane)  <--- HTTPS, nod_ credential --->  worker container(s)
  sole Postgres writer     register / claim / renew /      claims eligible jobs
  holds storage + AI keys  result / failure / heartbeat    presigned GET/PUT for media
  runs server-only jobs    (/api/nodes/*)                  runs compute locally
  (and, if mode=all, all)                                        | localhost:3000
                                                                 v
                                                      CompreFace core sidecar
```

Invariants:

1. **A node never touches the database.** Everything flows over authenticated HTTPS to `/api/nodes/*`.
2. **A `nod_` credential reaches only `/api/nodes/*`.** Never media, settings or admin routes, even for an administrator's credential.
3. **No provider API key reaches a node.** Tagging, enhancement and every other AI call run on the API host. The single exception is the Google geocode key through the platform per-job secret (`POST /api/nodes/:id/jobs/:jobId/secret`): per job, in node memory only, lease-bound, and only when `nodes.jobSecretBrokerEnabled` is on (default off), Google is the active provider and a key is stored. A Google key cannot be revoked per job: restrict and rotate it ([runbook](runbooks/geocoding-key.md)).
4. **Media bytes go straight between the node and storage** through short-lived presigned URLs, never through the API; no storage credential is on a node.

| Setting class | Where | Restart |
|---|---|---|
| Queue and fleet variables (`JOBS_*`, `NODE_*`), storage recovery, thumbnail repair | API `.env` (`infra/compose/.env`) | API |
| Worker identity, tuning, image | the worker bundle's `.env` (`infra/compose/.env.worker.example`) | worker container |
| Feature toggles and tuning (`features.*`, `nodes.*`, `burst.*`, `dedup.*`, `face.*`), run and job retention | Admin UI, `system_settings` | none (read live) |
| Node credential (`nod_` token) | `/admin/settings/workers` (Node credentials) or `memoriahub node enroll` | none until rotated |

## 2. API-side settings

All variables below are documented, with defaults, in the generated `.env.example` (queue section and Worker Node Fleet section).

| Variable | Meaning | MemoriaHub note |
|---|---|---|
| `JOBS_WORKER_MODE` | `all` / `system` / `off`: what the API's own worker claims | `all` (default) runs everything on the API. `system` runs only what a node may not run right now; use it once a fleet exists. **Never `off`**: the AI types and every other server-only type would never run. |
| `JOBS_WORKER_CONCURRENCY` | job slots in the API process | The effective default is **1** (the platform's is 2), kept from the old queue because each slot buffers a decoded image. Raise it deliberately. |
| `JOBS_POLL_MS` | idle poll interval | |
| `JOBS_MAX_ATTEMPTS`, `JOBS_RETRY_BASE_MS`, `JOBS_RETRY_MAX_MS` | default retry budget and backoff | A job type's own `profile` (`maxRuntimeMs`, `maxAttempts`) overrides the attempts default; the table is in [enrichment-queue.md](specs/enrichment-queue.md#memoriahub-job-types). Attempts are charged at claim, so a job that kills its worker is bounded. |
| `JOBS_RATELIMIT_*` | rate-limit deferral budget | A provider throttle (429, 503, 529) defers the job without consuming an attempt. |
| `JOBS_JOB_TIMEOUT_MS` | execution ceiling for types without a profile | The video types (`video_face_detection`, `social_media_detection`, `video_auto_tagging`) carry a 20 minute profile. |
| `JOBS_REAPER_ENABLED` | the lease reaper | Always run it. Independent of the worker mode. Lease and patience derive from each type's `maxRuntimeMs`. |
| `JOBS_SYSTEM_MODE_EXTRA_TYPES` | extra types the `system` mode claims on the server | `workflow_execute_batch` is always added, so workflows run with no fleet. |
| `NODE_STALE_OFFLINE_ENABLED`, `NODE_OFFLINE_PRUNE_ENABLED`, `NODE_SECRET_SWEEP_ENABLED` | the fleet sweep, offline pruning and per-job secret sweep kill-switches | default on |

The stale-heartbeat window, the offline multiplier and offline retention are the `nodes` settings namespace (`/admin/settings/workers`), not variables; the old `NODE_HEARTBEAT_STALE_SECONDS`, `NODE_OFFLINE_STALE_MULTIPLIER` and `NODE_OFFLINE_RETENTION_DAYS` only seed its defaults. Stuck-job thresholds are no longer a setting: lease and reaper patience derive from the job profile (`jobs.stuckThresholdMinutes` remains for the dashboard's "stuck" count). Storage recovery (`STORAGE_PROCESSING_*`, `THUMBNAIL_REPAIR_*`) is documented in [CLAUDE.md](../CLAUDE.md) and the storage runbooks; it is unrelated to the queue's variables.

## 3. Worker-container settings

### 3.1 Platform variables

Declared once by the platform (`workerEnv()`), read by every platform worker. `MEMORIAHUB_URL` is accepted for `MEMORIAHUB_SERVER_URL`.

| Variable | Default | Meaning |
|---|---|---|
| `MEMORIAHUB_SERVER_URL` | required | API base URL (no trailing path) |
| `MEMORIAHUB_TOKEN` | required | a `nod_` credential (a PAT also works, a `nod_` token is preferred) |
| `MEMORIAHUB_NODE_ID` | | node row to resume, so a restart is not a new node |
| `MEMORIAHUB_NODE_NAME` | hostname | display name; re-attach keys on it. **Unique per replica.** |
| `MEMORIAHUB_CONCURRENCY` | core/RAM aware (2 to 4); overlay sets 2 | jobs at once, 1 to 64 |
| `MEMORIAHUB_ELIGIBLE_TYPES` | all it can run | CSV of job types to claim |
| `MEMORIAHUB_POLL_INTERVAL_MS` | | idle poll interval |
| `MEMORIAHUB_HEADLESS` | `true` in the container | no TTY; registers itself; drains on SIGTERM without deregistering |
| `MEMORIAHUB_STATE_DIR` | `~/.memoriahub/node` (`/var/lib/worker` in the container) | pidfile, socket, logs, heap snapshots, tmp, models. Does **not** relocate `config.json`. |
| `MEMORIAHUB_HEAP_LIMIT_MB` | computed from RAM; `0` disables re-tuning | V8 old-space ceiling |
| `MEMORIAHUB_HEAP_TUNED` | | re-exec latch; not an operator knob |
| `MEMORIAHUB_MEMORY_WATCHDOG` | on | `false` disables the watchdog and the valve |
| `MEMORIAHUB_MEMORY_THRESHOLD` | `0.90` (0.5 to 0.99) | heapUsed/heapLimit fraction that fires the valve |
| `MEMORIAHUB_HEAP_SNAPSHOTS` | on | `false` disables heap-snapshot writing |
| `MEMORIAHUB_NATIVE_THREADS` | half the cores, 1 to 4 | libvips thread cap per pipeline |
| `MEMORIAHUB_MODELS_DIR` | `<state dir>/models` (`/app/models` in the image) | where model files live |

### 3.2 MemoriaHub variables

| Variable | Default | Meaning |
|---|---|---|
| `MEMORIAHUB_COMPREFACE_URL` | `http://localhost:3000` (compose: `http://compreface-core:3000`) | the CompreFace sidecar |
| `MEMORIAHUB_FACE_PROVIDER` | `compreface` | only `compreface` is accepted; anything else is a warning |
| `MEMORIAHUB_CLIP_RECYCLE_AFTER` | `1000`; `0` disables | embeds before the CLIP onnxruntime session is recycled, bounding native memory growth (`duplicate_detection` is the only onnxruntime path). The API's counterpart is `CLIP_SESSION_RECYCLE_AFTER`. |

### 3.3 Bundle knobs

`infra/compose/worker.compose.yml` is generated; MemoriaHub adds three overlays. `WORKER_IMAGE` (full image reference) or `WORKER_VERSION` (tag of `ghcr.io/marinoscar/memoriahub-worker`, default `latest`), `WORKER_STOP_GRACE` (default `180s`: how long SIGTERM may drain before a kill), `COMPREFACE_PROCESSES` (uwsgi processes in the sidecar, default 2). Scale with `--scale worker=N`.

### 3.4 Per-replica rules

The most common fleet mistake: replicas sharing an identity. Leave `MEMORIAHUB_NODE_NAME` empty or distinct per replica and never share `MEMORIAHUB_NODE_ID`. Each replica needs its own CompreFace capacity (the bundle gives one sidecar per stack; `--scale` replicas share it, so raise `COMPREFACE_PROCESSES` with the replica count). Give each replica a volume for `/var/lib/worker`.

### 3.5 Memory & OOM hardening

The worker is a long-running process that decodes images and spawns ffmpeg, so off-heap memory (libvips, ONNX, child processes) grows outside V8's limit. The platform handles this in three layers:

1. **Heap ceiling.** At start the CLI re-execs itself with `--max-old-space-size` computed from RAM (a 16 GB, 8-core host is the baseline); `MEMORIAHUB_HEAP_LIMIT_MB` overrides, `0` disables.
2. **Watchdog.** Every 30 s it samples rss, heapUsed, heapTotal, external and arrayBuffers, and the heap growth rate once the samples span 30 minutes.
3. **Exit-75 valve.** When heapUsed/heapLimit passes `MEMORIAHUB_MEMORY_THRESHOLD` (0.90) the worker stops claiming, drains for up to 60 s, writes a heap snapshot and exits with code **75**. A supervisor (compose `restart: unless-stopped`, systemd) restarts it, so a bulk import self-recovers instead of being killed by the kernel. Without a supervisor the exit leaves the worker down.

Tuning: lower `MEMORIAHUB_CONCURRENCY` first (each job buffers a decoded image or a video temp file), then `MEMORIAHUB_NATIVE_THREADS`, then raise the heap limit. The libvips operation cache is disabled (a bulk import never repeats an operation). Inside a memory-limited container, set `MEMORIAHUB_HEAP_LIMIT_MB` well below the container limit, leaving headroom for the off-heap memory. A recurring exit 75 soon after start means a leak: take `memoriahub node heap-snapshot` ([runbook](runbooks/worker-fleet.md#7-heap-snapshot-over-ipc)). Sizing for a small VPS: [Bulk Uploads on a Cheap VPS](specs/bulk-upload-vps-tuning.md).

## 4. Legacy names (one release)

The 1.3 worker variables keep working for one release and print a deprecation line; the next release removes them.

| 1.3 name | Current name | How |
|---|---|---|
| `MEMORIAHUB_URL` | `MEMORIAHUB_SERVER_URL` | mirrored when the new one is unset |
| `MEMORIAHUB_MAX_OLD_SPACE_MB` | `MEMORIAHUB_HEAP_LIMIT_MB` | platform alias |
| `MEMORIAHUB_HEAP_SNAPSHOT` | `MEMORIAHUB_HEAP_SNAPSHOTS` | platform alias |
| `MEMORIAHUB_MEMWATCH` | `MEMORIAHUB_MEMORY_WATCHDOG` | platform alias |
| `MEMORIAHUB_HEAP_RESTART_FRACTION` | `MEMORIAHUB_MEMORY_THRESHOLD` | platform alias |
| `MEMORIAHUB_SHARP_CONCURRENCY` | `MEMORIAHUB_NATIVE_THREADS` | mirrored |
| `MODELS_DIR`, the 1.3 `~/.memoriahub/models` folder | `MEMORIAHUB_MODELS_DIR` | mirrored |
| `MEMORIAHUB_STARTUP_SELFTEST` | (none) | ignored: the worker self-tests at start in headless mode |

The root `docker-compose.worker*.yml` files keep working through these aliases. On the API side the old `ENRICHMENT_*` queue variables are likewise read for one release by a translation layer (`apps/api/src/platform/jobs/legacy-env.ts`) with a deprecation warning at boot, a `JOBS_*` value always winning; `ENRICHMENT_VIDEO_JOB_TIMEOUT_MS` still sets the 20-minute profile of the three video types, and `ENRICHMENT_LEASE_MS` and `ENRICHMENT_STUCK_MINUTES` are no longer read. Rename them to the `JOBS_*` names in section 2 before the translation layer is removed.

## 5. CompreFace

Face detection (`face_detection`, `video_face_detection`) calls a CompreFace core sidecar (`exadel/compreface-core:1.2.0-mobilenet`, keyless, 128-d embeddings), on the server and on a node alike. In the worker bundle it is the `app.worker.compreface.compose.yml` overlay, and the worker waits for its `/status` health check. Natively, `memoriahub node install-deps` starts a `memoriahub-compreface-core` container. Size it with `COMPREFACE_PROCESSES` (uwsgi processes; cores minus two between 1 and 6 is the native default) and, if needed, a Docker memory cap. The server uses `FACE_COMPREFACE_URL`; a node uses `MEMORIAHUB_COMPREFACE_URL`.

## 6. Credentials

- **`nod_` node credential**: durable, accepted only on `/api/nodes/*`, owner-scoped, nullable expiry, individually revocable; created at `/admin/settings/workers` (shown once) or by `node enroll`. Held in `MEMORIAHUB_TOKEN` or `~/.memoriahub/config.json`; treat it as a secret and keep it out of images and logs.
- **PAT**: still accepted on `/api/nodes/*` for back-compat.
- **Per-job secret**: the geocode Google key only (section 1, invariant 3). Never persisted on the node; revoked or swept when the job settles.

## 7. Recommended presets

- **Single box (default).** Change nothing: `JOBS_WORKER_MODE=all`, no fleet.
- **VPS plus a home worker.** API stays `all`. On the home machine: `memoriahub node enroll`, `node register --concurrency 2`, `node service install`.
- **Control-plane VPS plus a fleet.** API `.env`: `JOBS_WORKER_MODE=system`. Workers: the compose bundle, `--scale worker=N`, `MEMORIAHUB_CONCURRENCY=2`.
- **Bulk-import survival.** API: `JOBS_WORKER_MODE=system`, `JOBS_WORKER_CONCURRENCY=1`. Workers: concurrency 1 or 2, memory limit set, `restart: unless-stopped`, `WORKER_STOP_GRACE=300s`. See [bulk-upload-vps-tuning.md](specs/bulk-upload-vps-tuning.md).

## 8. Verifying it works

1. `/admin/settings/workers` lists each node `online` with a fresh heartbeat and the offered types.
2. `memoriahub node doctor` is green for the types you expect; `node status` shows the node's configuration and state.
3. Enqueue work (a rerun on a photo) and watch `/admin/settings/jobs`: the job is claimed by a node and succeeds; its row shows executor `node`.
4. The server Doctor's `nodes` category passes.
