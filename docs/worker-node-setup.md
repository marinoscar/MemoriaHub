# Worker Node Setup & Troubleshooting

| Field | Value |
|-------|-------|
| **Version** | 2.0 |
| **Last Updated** | November 2026 |
| **Status** | Implemented (RETRO-C10 #616, RETRO-C11 #620) |

A MemoriaHub worker node is the EnterpriseAppBase (EAB) platform's node engine (`@marinoscar/platform-cli`, `memoriahub node ...`) running MemoriaHub's eight executors. This page is the practical "what do I install, and what do I do when `node doctor` complains" companion. The architecture, the control plane, leases and claim tokens are the platform's: see the EAB documents `docs/specs/worker-nodes.md` and `docs/runbooks/run-worker-nodes.md` (in the EnterpriseAppBase repository). What is MemoriaHub-specific (which job types run on a node and why) is in [the Distributed Nodes spec](specs/distributed-nodes.md); day-two operations are in [the worker fleet runbook](runbooks/worker-fleet.md); every variable is in [the container configuration reference](worker-container-config.md).

## Table of Contents

1. [Which path to take](#1-which-path-to-take)
2. [Containers (recommended)](#2-containers-recommended)
3. [Native install](#3-native-install)
4. [Enroll, register, start](#4-enroll-register-start)
5. [What a node needs, per job type](#5-what-a-node-needs-per-job-type)
6. [Reading `node doctor`](#6-reading-node-doctor)
7. [Models](#7-models)
8. [Troubleshooting](#8-troubleshooting)
9. [Upgrading from CLI 1.3](#9-upgrading-from-cli-13)

## 1. Which path to take

Use the container bundle for a production fleet: the image carries ffmpeg, the native libraries, the CLIP model and the Tesseract language data, and the bundle adds a CompreFace sidecar. Use a native install for a workstation you already own or to try a node out. Either way a node needs the API's `JOBS_WORKER_MODE` to be `all` (default) or `system`; the AI types and everything else outside the eight node-eligible types keep running on the API host.

## 2. Containers (recommended)

The bundle is generated from the platform (`infra/compose/worker.compose.yml`, never hand-edited) plus MemoriaHub overlays: `app.worker.memoriahub.compose.yml` (image `ghcr.io/marinoscar/memoriahub-worker`, tag `WORKER_VERSION`), `app.worker.compreface.compose.yml` (a `compreface-core` sidecar the worker waits for) and, to build locally, `app.worker.build.compose.yml` (`apps/cli/Dockerfile`, target `worker`).

```bash
cd infra/compose
cp .env.worker.example .env       # set MEMORIAHUB_SERVER_URL and MEMORIAHUB_TOKEN (a nod_ credential)
docker compose -f worker.compose.yml -f app.worker.memoriahub.compose.yml \
  -f app.worker.compreface.compose.yml up -d --scale worker=2
```

Mint the `nod_` token at `/admin/settings/workers` (Node credentials, shown once) or with `memoriahub node enroll` on any machine. The root `docker-compose.worker.yml` bundle of earlier releases still works because the old variable names are aliased for one release (section 9). Scaling, upgrades and recovery: [the fleet runbook](runbooks/worker-fleet.md).

## 3. Native install

Prerequisites: the `memoriahub` CLI (see [the CLI README](../apps/cli/README.md)). Then:

```bash
memoriahub node install-deps
```

`install-deps` is idempotent. Beyond the platform's own steps it does, for MemoriaHub:

| Step | What it does | Where |
|---|---|---|
| ffmpeg | `apt` installs `ffmpeg` (ffprobe ships with it) | Debian family, needs `sudo` |
| native libraries | checks that `sharp` and `onnxruntime-node` resolve (npm optional dependencies) | detect only |
| tesseract | downloads the OCR language data for `social_media_detection` Tier 2 | best effort |
| compreface | starts the `compreface-core` sidecar container (`exadel/compreface-core:1.2.0-mobilenet`, name `memoriahub-compreface-core`) | only where Docker exists |

Docker itself is not installed by the command: install it first if you want the sidecar. Flags: `--skip-compreface`, `--compreface-port <port>` (default 3000), `--compreface-processes <n>`, `--compreface-memory <size>`, `--compreface-cpus <n>`, `--compreface-recreate`. On macOS or Windows install ffmpeg yourself and run CompreFace in Docker Desktop; `node doctor` tells you what is still missing. Windows needs WSL for the daemon and the systemd service.

## 4. Enroll, register, start

```bash
memoriahub node enroll        # device-flow login, then mints and stores a nod_ credential
memoriahub node register      # registers (or re-attaches by name) and stores the node id
memoriahub node start         # foreground; watch it work
memoriahub node start --daemon          # detached
memoriahub node service install         # systemd user unit, always on
```

Other commands: `node status`, `node logs`, `node stop` (drains, then exits), `node set-concurrency <n>`, `node list` (MemoriaHub extra), `node doctor`, `node models status|pull`, `node heap-snapshot`, `node service uninstall|status`. Flags on `register` / `start`: `--name`, `--concurrency`, `--types <csv>`, `--poll <ms>`, `--compreface-url <url>`. State lives in `~/.memoriahub/node/` (pidfile, `node.sock`, logs, models, heap snapshots); `MEMORIAHUB_STATE_DIR` points at that directory only. `config.json` stays in `~/.memoriahub/`. A headless worker (`MEMORIAHUB_HEADLESS=1`, always the case in the container) registers itself at start when it has no node id, and drains on SIGTERM without deregistering.

## 5. What a node needs, per job type

A type is advertised only when its requirements hold; otherwise the platform withholds it and says why in `node doctor`. Required capability ids are `binary:<name>`, `module:<npm name>` and `service:<id>`.

| Job type | Required | Degrades without |
|---|---|---|
| `face_detection` | `module:sharp`, `service:compreface` | |
| `video_face_detection` | `module:sharp`, `service:compreface`, `binary:ffmpeg`, `binary:ffprobe` | |
| `duplicate_detection` | `module:sharp`, `module:onnxruntime-node`, the CLIP model file | |
| `metadata_extraction` | `module:sharp`, `binary:ffprobe` | |
| `social_media_detection` | `binary:ffprobe`, `binary:ffmpeg` | `module:tesseract.js` (Tier 2 OCR off, Tier 1 only) |
| `thumbnail_regen` | `module:sharp`, `binary:ffmpeg` | |
| `geocode` | none | runs only with the broker switch on, Google active and a key stored; otherwise the server runs it |
| `workflow_execute_batch` | none | |

`auto_tagging`, `video_auto_tagging` and `picture_enhancement` are not listed because a node never runs them: the API resolves the provider key, and no key reaches a node.

## 6. Reading `node doctor`

`memoriahub node doctor` checks the server (reachable, token authenticates, `nodes:read`/`nodes:write` held), each capability (`installed`, `not operational`, `missing`), each model file, and prints which types would be withheld. A capability can be installed yet not operational (the module loads but its native binary does not). The result is also sent with the heartbeat and shows in the Doctor `nodes` category on the server (`/admin/settings/doctor`).

## 7. Models

Only `duplicate_detection` needs a model file: the CLIP ViT-B/32 vision model (`clip-vit-b32`, about 85 MB, `vision_model_quantized.onnx`). Container images bake it in (`MEMORIAHUB_MODELS_DIR=/app/models`). Natively: `memoriahub node models pull` downloads and verifies it (sha256), `node models status` shows the verdict. A missing or corrupt file withholds `duplicate_detection` only. The server's manifest route `GET /api/nodes/models/manifest` lists the artifacts for a node's types. Air-gapped hosts: place the file in the models directory by hand; the sha256 must match.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot run job type "video_face_detection": required capability "binary:ffmpeg" is missing` | ffmpeg or ffprobe not on `PATH` | `node install-deps`, or install ffmpeg; restart the worker |
| `required capability "module:sharp" is installed but not operational` | the native binary did not load (wrong platform build, missing libvips) | reinstall the CLI with scripts enabled; in a container use the published image |
| `required capability "service:compreface" is missing` | the sidecar does not answer `/status` | start it (`node install-deps` or the compose overlay); check `MEMORIAHUB_COMPREFACE_URL`; `docker logs memoriahub-compreface-core` |
| `duplicate_detection` not offered, doctor says a model is withheld | CLIP file missing or sha mismatch | `node models pull`, then restart |
| `--face-provider ... is not supported` / `MEMORIAHUB_FACE_PROVIDER` warning | only `compreface` exists | remove the setting |
| `403` ... "missing `nodes:read`/`nodes:write`" | the token's owner is not an administrator | mint the credential as an administrator |
| `401` on every call | credential revoked or expired | mint a new one at `/admin/settings/workers`, `node enroll` |
| node never claims anything | no pending job of an offered type; API `JOBS_WORKER_MODE`; the broker switch off for `geocode` | check `/admin/settings/jobs` and the Workers page; the type list in `node status` |
| node shows `offline` after the 1.3 upgrade | the migration marked every node offline | `node register` once (section 9) |
| a worker restarts every few hours, exit code 75 | the memory valve drained it before an out-of-memory kill | normal; a supervisor restarts it. Lower concurrency or raise the heap limit ([config reference](worker-container-config.md#35-memory--oom-hardening)); take a `heap-snapshot` if it recurs soon after start |
| `node stop` says another daemon is running | a 1.3 daemon is still up | the CLI names its pid; `kill <pid>` |
| jobs fail with a rate-limit then retry | provider quota (geocode) | automatic deferral; no action unless it persists |

## 9. Upgrading from CLI 1.3

Existing nodes must run `memoriahub node register` once (the C2 migration marked them offline); `nod_` tokens stay valid. State moved to `~/.memoriahub/node/`. The 1.3 variables keep working for one release with a deprecation line: `MEMORIAHUB_URL` (for `MEMORIAHUB_SERVER_URL`), `MEMORIAHUB_MAX_OLD_SPACE_MB`, `_HEAP_SNAPSHOT`, `_MEMWATCH`, `_HEAP_RESTART_FRACTION`, `_SHARP_CONCURRENCY`, `MODELS_DIR` and the 1.3 models folder; `MEMORIAHUB_STARTUP_SELFTEST` is ignored. Mapping table: [container configuration reference](worker-container-config.md#4-legacy-names-one-release).

Known gaps: the social-media and video-face settings are not in the job payload, so nodes use the old defaults (5 s, 60 frames, 0.8 confidence); the staging end-to-end test has not been run. See [the fleet runbook](runbooks/worker-fleet.md#known-gaps).
