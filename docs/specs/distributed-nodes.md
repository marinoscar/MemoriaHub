# Distributed Worker Nodes: What MemoriaHub Runs on a Node

| Field | Value |
|-------|-------|
| **Version** | 3.0 |
| **Last Updated** | November 2026 |
| **Status** | Implemented (RETRO-C2 #581, C3 #585, C4 #590, C5 #594, C6 #600, C10 #616, C11 #620) |

A MemoriaHub worker node is a machine, usually a container, that claims background jobs from the API, runs the compute locally and submits results over HTTPS. The mechanism is the EnterpriseAppBase (EAB) platform's: the control plane (`@marinoscar/platform-api/nodes`), the queue (`@marinoscar/platform-api/jobs`) and the node engine (`@marinoscar/platform-cli`, the `memoriahub node` group). **This spec keeps only what is MemoriaHub-specific.** For registration, heartbeat, claim tokens, leases and renewal, the claim algorithm (`FOR UPDATE SKIP LOCKED`), per-job secrets, the fleet sweeps and the full route list, read the EAB documents `docs/specs/worker-nodes.md` and `docs/specs/job-queue.md` (EnterpriseAppBase repository) and the package READMEs `packages/platform-api/src/nodes/README.md`, `packages/platform-api/src/jobs/README.md` and `packages/platform-cli/src/node/README.md`.

Operator pages: [setup and troubleshooting](../worker-node-setup.md), [configuration reference](../worker-container-config.md), [fleet runbook](../runbooks/worker-fleet.md). Job type inventory: [enrichment-queue.md](enrichment-queue.md#memoriahub-job-types). Local Media Backup: [local-backup.md](local-backup.md).

## Table of Contents

1. [Security model](#1-security-model)
2. [Which job types run on a node, and why](#2-which-job-types-run-on-a-node-and-why)
3. [AI types are server-only](#3-ai-types-are-server-only)
4. [Geocode and the per-job secret](#4-geocode-and-the-per-job-secret)
5. [Presigned I/O and node output](#5-presigned-io-and-node-output)
6. [The compute/persist split and parity](#6-the-computepersist-split-and-parity)
7. [Models manifest](#7-models-manifest)
8. [Local Media Backup on a node](#8-local-media-backup-on-a-node)
9. [Permissions and routes](#9-permissions-and-routes)
10. [Known gaps and seam requests](#10-known-gaps-and-seam-requests)
11. [Document history](#11-document-history)

## 1. Security model

1. **No database access.** A node talks to `/api/nodes/*` only; it holds no SQL credential.
2. **No storage credentials.** Media bytes move through short-lived presigned URLs the API hands out per job (`POST /api/nodes/:id/jobs/:jobId/download-url` and `upload-url`). They are not revocable, so they are short and per object.
3. **`nod_` is confined.** A node credential is accepted on `/api/nodes/*` only, even if its owner is an administrator (proof: `apps/api/test/nodes/nodes-mount.spec.ts`). It is hashed at rest, shown once, individually revocable, with an optional expiry.
4. **No provider API key reaches a node**, with one exception (section 4). AI keys never leave the server (EAB AI rule 2 and 3).
5. **A late result is harmless.** Every job-scoped call carries the claim token; a node whose lease was reaped and re-claimed is refused.
6. **Another user's node is a 404** on the app routes (backup, models), 403 on platform routes.

## 2. Which job types run on a node, and why

Eligibility is derived, not flagged: a handler is node-eligible when it carries both `nodeResultSchema` and `persistNodeResult`. The snapshot spec `apps/api/test/jobs/job-type-snapshot.spec.ts` pins the set. Eight types:

| Type | Runs on a node because | Node needs |
|---|---|---|
| `face_detection` | CPU-bound detection against a local CompreFace sidecar; the result is faces and 128-d embeddings | sharp, CompreFace |
| `video_face_detection` | ffmpeg frame extraction plus per-frame detection and cross-frame de-duplication; the heaviest per-item type | sharp, CompreFace, ffmpeg, ffprobe |
| `duplicate_detection` | CLIP ViT-B/32 embedding (onnxruntime) and dHash | sharp, onnxruntime-node, CLIP model |
| `metadata_extraction` | EXIF, dimensions and ffprobe | sharp, ffprobe |
| `social_media_detection` | ffprobe rules plus optional Tesseract OCR of first and last frames | ffprobe, ffmpeg; OCR degrades |
| `thumbnail_regen` | image and video thumbnail rendering | sharp, ffmpeg |
| `geocode` | a network round trip per item; see section 4 | the broker switch |
| `workflow_execute_batch` | a declared-intent pass; the server re-derives and applies it | none |

Everything else is server-only: the work reads several tables while it runs, writes as it goes, needs a server-held secret, or is a sweep with no per-item unit (`burst_detection`, `duplicate_detection_batch`, `duplicate_confidence_backfill`, `face_auto_archive_sweep`, `location_inference`, `location_group_rebuild`, `thumbnail_repair`, `storage_insights`, `trash_purge`, the run-engine jobs, the memories jobs, the housekeeping crons, and the storage and database-backup jobs). `workflow_execute_batch` is also in the `system` worker mode's claim set (`JOBS_SYSTEM_MODE_EXTRA_TYPES`), so workflows run on the API when no fleet exists. A deployment declines offload for a type with the platform's setting, read at claim time, never by editing a handler.

The platform decides what a node is offered from its registered capabilities: a node that lacks a type's required capability does not advertise it (a missing CLIP model withholds `duplicate_detection` only).

## 3. AI types are server-only

`auto_tagging`, `video_auto_tagging`, `picture_enhancement` and `picture_enhancement_purge` implement neither `nodeResultSchema` nor `persistNodeResult` (conformance: `apps/api/test/jobs/ai-bound.conformance.spec.ts`). The API resolves the provider key (user, organization or deployment) for each call and holds it only between resolution and the adapter call. The old transient credentials endpoint (`POST /api/nodes/:id/jobs/:jobId/credentials`) is deleted; a node that still calls it gets 404. Provider throttles reach the queue as the platform's rate-limit error and defer the job without consuming an attempt. Consequence for operators: `JOBS_WORKER_MODE` must be `all` or `system`, never `off`.

## 4. Geocode and the per-job secret

`geocode` is node-eligible, and the one place a secret reaches a node. Its handler declares a `nodeSecretBroker` (`GoogleGeocodeKeyBroker`, kind `geo.google`, `apps/api/src/geo/google-geocode-key.broker.ts`). The node asks `POST /api/nodes/:id/jobs/:jobId/secret` with the claim token and receives the Google key valid until the job's lease ends (plus a one-minute skew allowance); it keeps it in memory for that job and never writes it to disk, environment or argv. The server stores a handle in `job_node_secrets`, never the material, and sweeps grants whose job is no longer held (`NODE_SECRET_SWEEP_ENABLED`).

It is **off by default**: the platform withholds `geocode` from nodes unless `nodes.jobSecretBrokerEnabled` is on, the active reverse provider is Google, the provider is switched on and a key is stored. Otherwise the API's own worker runs the job and nothing fails for want of a secret. Residual risk: a Google key cannot be revoked per job, so a compromised node holds a usable key until it is rotated. Restrict the key to the Geocoding API and to your egress addresses, and rotate after a compromise ([runbook](../runbooks/geocoding-key.md)). The platform's optional persistent node-side credential cache is not implemented in MemoriaHub, and the geocode payload carries the coordinates (the node has no database): `geocodeCoordinates` in `apps/api/src/platform/jobs/enrichment-job.facade.ts`.

## 5. Presigned I/O and node output

The API never proxies media. A node downloads the original from a presigned GET (`download-url`, issued per job against the job's media item through `NodeJobInputsAdapter`) and, for types that produce bytes, uploads to a presigned PUT at a key the **server** chooses:

- `thumbnail_regen` implements `deriveOutputKey`: the content-addressed `thumbnails/<sourceObjectId>-<version>.jpg` namespace, the version derived from the job id so the answer is stable per job. `persistNodeResult` verifies the bytes landed, records the rows, syncs the media item and then prunes the superseded thumbnail (sync before prune, issue #434).
- `video_face_detection` does not implement it: a video has one frame thumbnail per face cluster and the platform allows one key per job, so the frames land under the platform default `node-outputs/<jobId>/<uuid>` and the cluster carries the key back.

A job whose subject is not a media item, or whose item is gone, fails the input step with a 422 rather than crash-looping.

## 6. The compute/persist split and parity

Each node-eligible handler has a pure compute half and a persist half. The compute half lives in the shared workspace package `packages/memoriahub-compute` (`@marinoscar/memoriahub-compute`, the first package of the packages-first rule in [ADR-0001](../decisions/0001-packages-first.md) and [PACKAGES.md](../PACKAGES.md); dual CJS and ESM build, exact-pinned native dependencies repeated in the root `overrides`; no AI subpath, because AI jobs are server-only) and is imported identically by `apps/api` and by the node's executors (`apps/cli/src/executors/`); the persist half (`persistNodeResult`) is server-only Prisma writes that re-validate the result against the handler's `nodeResultSchema` and re-derive anything authoritative from the trusted job payload. The node result is therefore never a source of truth for what to write, only for what was computed.

**Parity is the load-bearing constraint.** A face or CLIP embedding computed on a node must be numerically comparable to a server one: a mismatch fails silently (no error, wrong matches later). Four guards hold it: one shared compute package; the sha256-pinned model manifest (section 7); the node's startup model check (a mismatching or missing model withholds the type rather than computing it); and a golden-vector regression test (`packages/memoriahub-compute/test/golden.test.mjs`: a bit-exact dHash and a CLIP vector within 1e-4, plus a committed HEIC fixture, with `REQUIRE_HEIC_DECODE=1` enforced in the worker and API images in CI). The API and worker images both compile libvips 8.18.3 with libheif and the libde265 plugin from one script (`scripts/docker/build-libvips.sh`) and build sharp's addon against it, so HEIC decodes natively and identically on both (Debian trixie ships libvips 8.16, below sharp 0.35's minimum, and sharp's bundled libvips has no HEVC decoder). Both Dockerfiles fail the build if the source-built addon cannot load, because sharp otherwise falls back silently to the bundled one. Known caveat: the quantized CLIP model gives slightly different vectors on CPUs with AVX-512 VNNI (observed 0.0153 max diff on an AMD EPYC 9V45 runner, pixel input identical), so the CLIP golden check depends on the runner CPU, not on libvips.

## 7. Models manifest

`GET /api/nodes/models/manifest` (`nodes:read`, `apps/api/src/node-models/`) returns a bare array of `{ name, url, sha256, bytes, targetSubdir }` for the model files a node's types need. It lists one file, the CLIP ONNX vision model (face detection is a sidecar call, not a model file). The node verifies the file against the pinned sha256 before advertising `duplicate_detection` (`memoriahub node models pull|status`, and `node doctor`).

## 8. Local Media Backup on a node

The pull mirror of original media onto a node's disk (epic #308) is MemoriaHub's, not the platform's: routes `/api/nodes/:id/backup/*` (`apps/api/src/node-backup/`), gated by `nodes:write` and the node's owner, unchanged in shape. The CLI hosts the backup engine in the worker daemon through a runtime hook (`apps/cli/src/backup/daemon-part.ts`), reachable over its own socket (`backup.sock`); it shares no queue slot or cooldown gate with job compute. `memoriahub backup init` suggests `memoriahub node enroll` when no node credential is present. Protocol and on-disk format: [local-backup.md](local-backup.md).

## 9. Permissions and routes

Permissions are `nodes:read` and `nodes:write` (system scope, administrators); they replaced `jobs:read` and `jobs:write` on these routes, which still gate the job queue pages. The platform serves `/api/nodes` (register, job-types, heartbeat, claim, renew, download-url, upload-url, secret, result, failure, telemetry, events), `/api/admin/nodes` and `/api/node-credentials`; the app adds `GET /api/nodes/models/manifest` and the backup routes under the same prefix. Admin page: `/admin/settings/workers` (the old `/admin/settings/nodes` redirects). Tables are the platform's `worker_nodes`, `node_credentials`, `worker_node_events` and `job_node_secrets`; `node_backup_configs` and `node_backup_runs` stay MemoriaHub's and reference `worker_nodes` ids. The operator view of the migration: [worker-nodes-cutover.md](../runbooks/worker-nodes-cutover.md).

## 10. Known gaps and seam requests

- The staging end-to-end test on the platform engine (a 2,000-item import, HEIC photos, a 2 GB video, API replica restarts) has not been run.
- `socialMedia.*` and `face.video.*` settings are not in the job payload: a node uses the old defaults (5 s sampling, 60 frames, 0.8 confidence) whatever an administrator saved. The API host honours the settings.
- EAB seam requests: #1143 (`WorkerNode` extensible so `node_backup_*` can relate to it; 404 for a foreign node; a `models/*` route), #1144 (export `ProviderRateLimitError`; the CLI shim loads it by file URL), #1145 (daemon channel commands, which retire the `backup.sock` shim). Each local deviation has a row in [local-exceptions.md](../platform-adoption/local-exceptions.md).

## 11. Document history

| Version | Date | Changes |
|---|---|---|
| 1.0 to 2.3 | July 2026 | The hand-written node plane: transient per-job provider credentials, `ENRICHMENT_WORKER_MODE`, the 1.3 daemon, the first container bundle. Superseded; recover from git history. |
| 3.0 | November 2026 | Rewritten for the platform engine (RETRO-C2, C3, C4, C5, C6, C10, C11): only the MemoriaHub-specific rules remain; the control plane, claim, lease and queue mechanics are linked, not copied. |
