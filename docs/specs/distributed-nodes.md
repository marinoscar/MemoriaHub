# Distributed Worker Nodes — Remote Enrichment Compute

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | July 2026 |
| **Status** | Proposed |

---

## Table of Contents

1. [Overview and Motivation](#1-overview-and-motivation)
2. [Security Model](#2-security-model)
3. [Data Model](#3-data-model)
4. [Multi-Process-Safe Claim](#4-multi-process-safe-claim)
5. [Node API — Control Plane and Data Plane](#5-node-api--control-plane-and-data-plane)
6. [Result Contract per Job Type](#6-result-contract-per-job-type)
7. [Embedding / Model Parity](#7-embedding--model-parity)
8. [Node-Eligible Job Types](#8-node-eligible-job-types)
9. [CLI Control and Observability](#9-cli-control-and-observability)
10. [Doctor Coverage](#10-doctor-coverage)
11. [Risks and Open Questions](#11-risks-and-open-questions)

---

## 1. Overview and Motivation

The enrichment queue (see [enrichment-queue.md](enrichment-queue.md)) currently runs a single **in-process worker pool** inside the API process — `ENRICHMENT_WORKER_CONCURRENCY` long-lived loops, each independently claiming and processing one job at a time (see [enrichment-queue.md §8 EnrichmentJobWorker](enrichment-queue.md#8-enrichmentjobworker)). All compute — face detection, auto-tagging, near-duplicate embedding, metadata extraction, thumbnail generation — runs on whatever host the API happens to be deployed on. For a household running MemoriaHub on a modest VPS (see [bulk-upload-vps-tuning.md](bulk-upload-vps-tuning.md)), this means the queue is bottlenecked by a single, often memory- and CPU-constrained machine, even though household members frequently own laptops and desktops with spare CPU, GPU, and RAM sitting idle.

**Distributed Worker Nodes** let `apps/cli` register a machine — a laptop, desktop, or spare mini-PC — as a **node**: a remote compute client that authenticates to the API, claims eligible enrichment jobs, runs the compute locally, and submits results back for the API to persist. This turns the queue from "one worker inside the API container" into a **fleet**, e.g.:

```
Server (VPS)         : 1 in-process worker loop  (always on, low concurrency)
Laptop "office-mbp"   : 4 node workers             (opt-in, only while awake/plugged in)
Laptop "kitchen-imac" : 2 node workers             (opt-in)
```

The server remains the sole source of truth for the queue and the sole writer to Postgres and object storage credentials. Nodes are purely **compute contributors** — they claim work, do CPU/GPU-bound inference, and hand results back over HTTPS. This is a deliberate asymmetry: it lets a household throw spare hardware at a slow backfill (e.g. re-running face detection against 20,000 legacy photos, or a duplicate-detection sweep) without exposing the database or storage credentials to a laptop that might be lost, stolen, or simply asleep half the time.

This spec assumes the reader is already familiar with the enrichment queue's data model, claim/retry/backoff machinery, and handler pattern — see [enrichment-queue.md](enrichment-queue.md) throughout. It also reuses the Doctor diagnostics report shape and conventions described in [doctor.md](doctor.md) for both the node-side and server-side health checks introduced here (§10).

### Why Not Just Raise `ENRICHMENT_WORKER_CONCURRENCY`?

Raising in-process concurrency scales compute *on the server*, which is exactly the resource this feature is designed to relieve pressure on — see the VPS memory-sizing guidance in [bulk-upload-vps-tuning.md](bulk-upload-vps-tuning.md) for why a memory-constrained host cannot simply crank concurrency without OOM risk. Distributed nodes scale compute **off** the server entirely, onto hardware the household already owns and is not paying cloud CPU-hour pricing for.

---

## 2. Security Model

This is the most important section of this specification. The design goal is: **a laptop node must never become a new way to steal the family's photo library or its cloud storage credentials.** Every design decision below follows from that goal.

### 2.1 No Direct Database Access

Nodes never connect to Postgres, directly or indirectly. All queue state — claims, leases, results — flows through authenticated HTTPS calls to the API (§5). The API remains, as it is today, the **sole DB writer**. A compromised or malicious node can at worst submit a bad *result payload* for a job it was assigned (see [Risks §11](#11-risks-and-open-questions)); it cannot run arbitrary SQL, read other circles' data, or touch tables it has no job-scoped reason to touch.

### 2.2 No Storage Provider Credentials on a Laptop

Nodes never hold an S3/R2 access key, secret key, or any other long-lived storage credential. This is non-negotiable: `storage_provider_credentials` (see the main `CLAUDE.md` database reference) already stores these encrypted at rest specifically because they grant broad bucket access — handing a copy to every laptop that opts into node duty would multiply the blast radius of a single stolen or compromised device by the number of registered nodes.

### 2.3 Control Plane vs. Data Plane

The feature splits cleanly into two planes, mirroring (but not identical to) the byte-proxy-vs-metadata split already used by [public-sharing.md](public-sharing.md):

| Plane | Carries | Path |
|-------|---------|------|
| **Control plane** | Register, claim, submit result, heartbeat, lease renew, AI-proxy calls | Node ⟷ API, over HTTPS, PAT-authenticated (§2.4) |
| **Data plane** | Media bytes (the actual photo/video pixels a job needs to read) | Node ⟷ storage provider (S3/R2), directly, via a short-lived presigned URL issued by the API for that specific job |

Media bytes are **never proxied through the API** for node jobs — the presigned URL points the node straight at the storage provider's object endpoint, and the node streams bytes to/from S3 or R2 itself.

**Contrast with public sharing:** [public-sharing.md](public-sharing.md) deliberately does the *opposite* — it proxies bytes through the API (`GET /api/public/shares/:token/media/:idx`) so that the storage URL is never exposed to an anonymous, unauthenticated public visitor, and so the response can carry security headers (`X-Content-Type-Options`, `Referrer-Policy`) and strip metadata from the JSON envelope around the file. A node, by contrast, is an authenticated, *trusted-for-this-job* compute peer of the household's own API — proxying gigabytes of photo/video bytes back and forth through the API server for every job would recreate exactly the bandwidth-and-memory bottleneck this feature exists to relieve. The two designs optimize for different threat models: public sharing optimizes for "never reveal the storage URL to an anonymous stranger"; node data-plane access optimizes for "let an authenticated household device fetch bytes as cheaply and directly as possible."

### 2.4 Authentication: Personal Access Tokens

Nodes authenticate to the API using the existing **Personal Access Token** system (`POST /api/pat`, `personal_access_tokens` table — see the main API reference). There is no new node-specific credential type. A household member runs `memoriahub node register` on a laptop, which:

1. Prompts for (or accepts via flag) a PAT — created ahead of time via `POST /api/pat` or the web UI.
2. Calls `POST /api/nodes/register` with that PAT as the bearer credential.
3. The API records the new `worker_nodes` row with `createdById` set to the PAT owner's user ID.

Every subsequent node → API call is scoped by `createdById`: a PAT can only claim jobs, renew leases, and submit results for nodes **it itself registered**. This means a PAT scoped to one user cannot see or interfere with another user's registered nodes, even within the same household/circle — node ownership follows the same "resource belongs to the user who created it" convention used elsewhere in this codebase (e.g. `personal_access_tokens`, `storage_objects`).

Because a node is "just" a PAT holder making authenticated API calls, all existing PAT lifecycle behavior applies unmodified: revoking the PAT (`DELETE /api/pat/{id}`) immediately cuts off every node registered with it, with no separate node-credential revocation path to build or maintain.

### 2.5 Presigned URLs: Deliberately Ephemeral, Deliberately Unrevocable

Every presigned URL issued to a node (for reading source media bytes, or for uploading a generated thumbnail — §6) is scoped to **one specific job** and expires on a short TTL (proposed default: 15 minutes, comfortably longer than any single-item compute step but far shorter than a job's overall lease). This is a deliberate design simplification, stated explicitly:

> Because a presigned URL is self-expiring, there is **no long-lived credential of any kind stored on the laptop**, and therefore **nothing to revoke or delete** when a node goes offline, is decommissioned, or is simply never heard from again. The alternative design — issuing each node its own scoped, rotatable storage credential (e.g. an S3 IAM role or R2 API token per node) — would require a full credential lifecycle: issuance, rotation, and revocation-on-deregistration, plus a way to audit which node used which credential for which access. Presigned URLs sidestep all of that at the cost of a small, time-boxed exposure window (see [Risks §11](#11-risks-and-open-questions)) that is judged acceptable for a household deployment.

### 2.6 What a Node Can and Cannot Do — Summary Table

| Capability | Allowed? |
|------------|----------|
| Read Postgres directly | Never |
| Hold a storage provider access/secret key | Never |
| Read media bytes for a job it has claimed, via a job-scoped presigned URL | Yes, time-boxed |
| Write generated bytes (e.g. a regenerated thumbnail) for a job it has claimed, via a job-scoped presigned URL | Yes, time-boxed |
| Call an AI provider directly with the household's API key | Never — routed through the AI-proxy endpoints (§5, §8) so the key never leaves the server |
| Claim jobs registered to a different user's nodes | Never — every node call is scoped to `worker_nodes.createdById` |
| Write directly to `media_face_status`, `Face`, `media_visual_embedding`, or any other domain table | Never — only the API's result-submission endpoint invokes handler-side persistence (§6) |

---

## 3. Data Model

### 3.1 `worker_nodes` table (new)

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `name` | String | Human-assigned display name (e.g. `"office-mbp"`); set at registration, editable later |
| `hostname` | String | Machine hostname reported at registration, for operator identification |
| `platform` | String | `os.platform()` / `os.arch()` summary reported at registration (e.g. `"darwin-arm64"`) |
| `cliVersion` | String | `apps/cli` package version running on the node; used by the model-parity self-check (§7) and version-skew handling (§11) |
| `eligibleTypes` | String[] | Job types this node currently advertises as eligible to claim (§8); recomputed on each heartbeat from the node's local capability/model-hash self-check |
| `concurrency` | Int | Number of local worker slots the node is configured to run, mirroring `ENRICHMENT_WORKER_CONCURRENCY` for the in-process pool |
| `status` | `NodeStatus` enum | `online` \| `draining` \| `offline` \| `disabled` (§3.2) |
| `registeredAt` | DateTime | When `POST /api/nodes/register` first created this row |
| `lastHeartbeatAt` | DateTime? | Timestamp of the most recently accepted `POST /api/nodes/:id/heartbeat` call; null if the node has never heartbeated |
| `createdById` | UUID | FK → `users`; the PAT owner who registered this node (§2.4); all node-facing endpoints scope by this column |

### 3.2 `NodeStatus` Enum

| Value | Meaning |
|-------|---------|
| `online` | Node has heartbeated within the expected interval and is actively claiming jobs |
| `draining` | Operator has requested the node stop claiming new work (`node drain` — §9); in-flight jobs are allowed to finish |
| `offline` | Node has missed its expected heartbeat window; inferred by the server, not set directly by the node |
| `disabled` | Admin- or owner-disabled; the node cannot claim jobs until re-enabled, independent of heartbeat freshness |

### 3.3 New Columns on `enrichment_jobs`

These extend the table already documented in [enrichment-queue.md §2](enrichment-queue.md#2-data-model):

| Column | Type | Description |
|--------|------|-------------|
| `claimedByNodeId` | UUID? | FK → `worker_nodes`, `ON DELETE SET NULL`; null when the job was claimed by the server's own in-process worker, or when it has not yet been claimed |
| `leaseExpiresAt` | DateTime? | When the current claim's lease expires; null when the job is not currently `running`. Set on every claim (§4) and extended by lease-renew calls (§5) |
| `executor` | String (or enum) | `'server'` \| `'node'` — which compute plane actually ran (or is running) this job; recorded for observability/audit even after the job completes, distinct from `claimedByNodeId` which is nulled on node deletion |

### 3.4 New Index

```
[status, lease_expires_at]   — serves the lease-expiry reaper's scan for expired running jobs (§4)
```

This complements, rather than replaces, the existing `[status, scheduledFor, priority, createdAt]` primary claim index documented in [enrichment-queue.md §2](enrichment-queue.md#2-data-model).

---

## 4. Multi-Process-Safe Claim

### 4.1 The Problem

[enrichment-queue.md §8](enrichment-queue.md#serialized-claims-in-process-mutex) documents, in its own words, that the current claim mechanism is explicitly **not** safe across multiple processes:

> **LIMITATION — single-process only.** This in-process mutex makes claims safe **within one API process**. It does **not** coordinate across processes: running MULTIPLE API replicas against the same database could still double-claim, because each replica has its own independent `claimLock`. Cross-process safety would require a database-level claim — e.g. `SELECT … FOR UPDATE SKIP LOCKED` or a conditional `UPDATE … WHERE status = 'pending'` that returns the affected row — so that the database, not an in-memory promise chain, arbitrates the race.

Distributed nodes make this limitation immediately load-bearing rather than theoretical: every registered node is, from the claim mechanism's point of view, exactly the "another process racing the same database" scenario the limitation note warns about — multiplied by however many nodes and however many worker slots per node are online at once. The existing promise-chain mutex (`claimOne()` in `EnrichmentJobWorker`) only serializes claims made by loops *inside the same Node.js process*; it has no visibility into a claim request arriving over HTTP from a laptop across the network.

### 4.2 The Fix: `FOR UPDATE SKIP LOCKED`

This feature requires replacing the promise-chain mutex's role — for the shared claim query only — with a **database-atomic claim** usable by both the server's in-process worker loops and every remote node's claim requests, coordinated purely through row-level locking rather than any application-level mutex:

```sql
UPDATE enrichment_jobs
SET status = 'running',
    started_at = now(),
    scheduled_for = null,
    attempts = attempts + 1,
    claimed_by_node_id = $nodeId,      -- null for the server's own in-process worker
    lease_expires_at = now() + $leaseDuration,
    executor = $executor               -- 'server' | 'node'
WHERE id IN (
  SELECT id
  FROM enrichment_jobs
  WHERE status = 'pending'
    AND type = ANY($eligibleTypes)
    AND (scheduled_for IS NULL OR scheduled_for <= now())
  ORDER BY priority ASC, created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $n
)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` is the key primitive: it lets Postgres itself arbitrate an arbitrary number of concurrent claimants — the server's own worker loops **and** every node's claim request, from any number of laptops, all racing the same `pending` row set — without any of them needing to coordinate with each other first. A transaction that would otherwise block waiting for a row another transaction has already locked instead **skips** that row and moves on to the next eligible candidate, so no claimant ever waits on, or double-claims, a row another claimant is mid-transaction on.

This query subsumes and generalizes the existing [Atomic Claim](enrichment-queue.md#atomic-claim) transaction documented in enrichment-queue.md §8 — that transaction's `findFirst` + `update` pair is read-committed-safe only because of the in-process mutex wrapped around it; the `FOR UPDATE SKIP LOCKED` form is safe with **no** wrapping mutex, in-process or otherwise, which is exactly the property needed once claimants can originate from outside the API process. Adopting it is the structural prerequisite for this whole feature, and — as a side effect — also closes the pre-existing multi-API-replica limitation the enrichment-queue spec already flagged as a documented follow-up.

`$eligibleTypes` for a server in-process worker loop is simply "every registered handler type" (unchanged from today); for a node claim request it is the node's own advertised `eligibleTypes` list (§3.1, §7), so a node only ever claims job types it has already self-verified it can compute correctly.

### 4.3 Lease-Expiry Reaper

A node can go offline mid-job — the laptop is closed, loses Wi-Fi, or crashes — with no clean way to signal the API that its claimed jobs are now orphaned. The `leaseExpiresAt` column (§3.3) exists to bound this: a claim is only valid until its lease expires, and the node is responsible for renewing the lease (`POST /api/nodes/jobs/:jobId/renew`, §5) periodically while a long-running job is still in progress.

The existing stuck-job-reset cron, `EnrichmentStuckResetTask` (see [enrichment-queue.md §11 — Stuck Threshold](enrichment-queue.md#stuck-threshold-settings-driven)), is augmented to additionally scan for `running` jobs whose `leaseExpiresAt` has passed:

- Such a job is **requeued**: `status` reset to `pending`, `claimedByNodeId` cleared, `leaseExpiresAt` cleared, so either the server's in-process worker or any other online node can pick it back up.
- This runs alongside, not instead of, the existing `startedAt`/threshold-based zombie-row detection already documented in enrichment-queue.md §11 — a lease-expired node job and a `startedAt IS NULL` zombie row from a dead server process are two different failure shapes converging on the same recovery cron.

**Budget-exhausted leases are failed, not requeued** — this exactly mirrors the existing stuck-job policy for the server-only case. Because `attempts` is charged at claim time (see [enrichment-queue.md §8 — Atomic Claim](enrichment-queue.md#atomic-claim)), a lease-expired job whose `attempts >= ENRICHMENT_MAX_ATTEMPTS` is marked `failed` directly by the reaper instead of being handed back to the pending queue for a fourth attempt — bounding a job that reliably kills every node/worker that touches it to the same `ENRICHMENT_MAX_ATTEMPTS` crash budget as any other job in the queue, node-originated or not.

### 4.4 Lease Renewal

```
POST /api/nodes/jobs/:jobId/renew
```

A node calls this periodically (proposed cadence: at roughly half the lease duration, e.g. every 3–4 minutes for a 7–8 minute lease) while a job it holds is still actively being processed. The endpoint extends `leaseExpiresAt` to `now() + leaseDuration`, provided the caller's node is still the job's `claimedByNodeId` and the job is still `running` — a renewal request for a job the caller no longer owns (already reaped and reclaimed elsewhere) is rejected, and the node should abandon local work on that job rather than continue computing toward a result no endpoint will accept.

---

## 5. Node API — Control Plane and Data Plane

All node-facing endpoints live under `/api/nodes/*`. Authentication is via Personal Access Token (§2.4); every call is implicitly scoped to `node.createdById` matching the authenticated PAT's owner — a PAT can only act on nodes it registered.

### 5.1 Node-Facing Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /api/nodes/register` | Register a machine as a node; body includes `name`, `hostname`, `platform`, `cliVersion`, `concurrency`; returns the created `worker_nodes` row |
| `POST /api/nodes/:id/deregister` | Cleanly remove a node registration (operator-initiated, e.g. retiring a laptop) |
| `POST /api/nodes/:id/heartbeat` | Periodic liveness + capability payload; updates `lastHeartbeatAt`, `eligibleTypes`, `status`; this payload also feeds the Doctor `nodes` section (§10) |
| `POST /api/nodes/:id/claim` | Atomic claim per §4; body includes `n` (max jobs to claim this round) and the node's current `eligibleTypes`; returns claimed jobs, each with a presigned GET URL for its source object bytes and any job-specific params from `payload` |
| `POST /api/nodes/jobs/:jobId/renew` | Extend the lease on a job the caller currently holds (§4.4) |
| `POST /api/nodes/jobs/:jobId/result` | Submit the result-contract payload for a completed job (§6); triggers server-side handler persistence |
| `POST /api/nodes/jobs/:jobId/failure` | Report a failed job; routes through the same normal-failure-vs-rate-limit backoff paths documented in [enrichment-queue.md §8 — Retry and Backoff](enrichment-queue.md#retry-and-backoff) |
| `GET /api/nodes/models/manifest` | Return the sha256-pinned model manifest (§7.2) so a node can verify local model parity before advertising a job type as eligible |
| `POST /api/nodes/jobs/:jobId/ai-proxy/tagging` | AI-proxy call for `auto_tagging`; the API holds the provider key and makes the keyed call server-side (§8) |
| `POST /api/nodes/jobs/:jobId/ai-proxy/geocode` | AI-proxy call for `geocode`; same pattern as tagging |

### 5.2 Admin-Facing Endpoints

| Endpoint | Permission | Description |
|----------|------------|-------------|
| `GET /api/admin/nodes` | `nodes:read` (Admin) | List all registered nodes across the deployment plus a health summary (status, last heartbeat age, eligible types, current claim count) |
| `DELETE /api/admin/nodes/:id` | `nodes:write` (Admin) | Force-deregister/remove a node record — e.g. a laptop that was lost or decommissioned without running `node deregister` first; any jobs it held are picked up by the lease-expiry reaper (§4.3) once the lease naturally expires |

Following this repo's existing `<domain>:read` / `<domain>:write` RBAC convention (see the Key Permissions table in the main API reference), this introduces a new permission pair, `nodes:read` / `nodes:write`, granted to the Admin role only — the same pattern used by `jobs:read`/`jobs:write` for the enrichment job queue dashboard.

### 5.3 Data-Plane Flow (Presigned URLs)

The claim response (`POST /api/nodes/:id/claim`) never includes raw media bytes. For a job that needs to read source pixels (e.g. `face_detection`), each claimed job entry includes a presigned GET URL scoped to that object, generated by the API's existing storage-provider abstraction (see [storage-providers.md](storage-providers.md)) at claim time. For a job that needs to write generated bytes back (e.g. `thumbnail_regen` — §6), the result-submission flow instead begins with the node requesting a presigned PUT URL, uploads directly to the storage provider, and only then calls the result endpoint with a reference to what it wrote (not the bytes themselves). Both directions keep the node talking directly to S3/R2, never streaming media bytes through the API process — see §2.3 for the full control-plane/data-plane rationale.

---

## 6. Result Contract per Job Type

The COMPUTE half of a job runs on the node; the **PERSIST half stays server-side**. [enrichment-queue.md §4](enrichment-queue.md#4-enrichmenthandler-interface) states that handlers own their domain-specific status tables (`MediaFaceStatus`, `MediaTagStatus`, etc.) and must not rely on the generic job record for domain status. That ownership does not move to the node: a node never writes to `media_face_status`, `Face`, `media_visual_embedding`, or any other domain table directly. Instead, `POST /api/nodes/jobs/:jobId/result` is the single endpoint that **invokes the existing handler-side persistence logic** on the server, using the node-submitted payload as its input — the same handler code path that runs when the server's own in-process worker completes a job, just fed compute results from a node instead of from a local `process()` call.

| Job type | Result payload shape |
|----------|----------------------|
| `face_detection` / `video_face_detection` | `{ modelVersion, providerKey, imageWidth, imageHeight, faces: [{ boundingBox, confidence?, embedding: number[1024] }] }` |
| `duplicate_detection` | `{ model, embedding: number[512], dHash }` |
| `metadata_extraction` | `{ exif, probe }` |
| `social_media_detection` | `{ verdict, score, ocrText }` |
| `thumbnail_regen` / `thumbnail_repair` | `{ storageKey, width, height, bytes }` — thumbnail bytes themselves are uploaded first via a presigned PUT (mirroring this repo's existing storage upload flow, see [storage-providers.md](storage-providers.md)); the result payload references what was written, it does not carry the bytes inline |
| `auto_tagging`, `geocode` | Not submitted via this endpoint at all — routed through the AI-proxy endpoints (§5.1, §8) instead, since the API must make the keyed provider call itself |

```typescript
// apps/api/src/nodes/dto/submit-job-result.dto.ts (proposed)

export interface FaceDetectionResult {
  modelVersion: string;
  providerKey: string;
  imageWidth: number;
  imageHeight: number;
  faces: Array<{
    boundingBox: { x: number; y: number; width: number; height: number };
    confidence?: number;
    embedding: number[]; // 1024-d, Human provider convention — see §7
  }>;
}

export interface DuplicateDetectionResult {
  model: string;        // e.g. 'clip-vit-b32-q8'
  embedding: number[];  // 512-d
  dHash: string;        // unsigned 64-bit dHash, decimal string — see the perceptual_hash storage
                         // rationale in the main API reference ("Why TEXT and not bigint")
}

export interface MetadataExtractionResult {
  exif: Record<string, unknown>;
  probe: Record<string, unknown> | null; // video-probe output; null for photos
}

export interface SocialMediaDetectionResult {
  verdict: 'detected' | 'clean';
  score: number;
  ocrText: string | null;
}

export interface ThumbnailResult {
  storageKey: string;
  width: number;
  height: number;
  bytes: number; // byte length, for server-side sanity validation against the actual uploaded object
}
```

`POST /api/nodes/jobs/:jobId/result` validates the submitted payload against the shape expected for that job's `type` before invoking the corresponding handler's persistence logic — the same validation rigor the handler would apply to its own locally-computed output (see [Risks §11](#11-risks-and-open-questions) for why this validation step is a new trust boundary that in-process handlers never needed).

---

## 7. Embedding / Model Parity

This is **the load-bearing constraint of the whole feature**. If it is not held, the feature is actively harmful rather than merely unhelpful.

### 7.1 The Problem

A face embedding or a CLIP visual embedding computed on a laptop must be **numerically comparable** — same model, same preprocessing pipeline, same dimensionality — to one computed on the server. If it is not:

- A face detected on a laptop node, embedded with a slightly different model version or preprocessing step than the server uses, will silently fail to match against `Person` clusters built from server-computed embeddings — either producing false negatives (the same person's face never matches) or, worse, false positives if the embedding spaces are similar-but-not-identical enough to produce spurious close matches.
- A CLIP embedding used for near-duplicate detection ([duplicate-detection.md](duplicate-detection.md)) computed with a different quantization or preprocessing than the server's `clip-vit-b32-q8` model would corrupt the pgvector HNSW index's cosine-similarity assumptions the moment node-computed and server-computed vectors are compared against each other.

This class of bug is especially dangerous because it fails **silently** — nothing throws, nothing errors, the job "succeeds," and the corruption only surfaces later as inexplicably-wrong face matches or duplicate groups that don't make sense, long after the offending job has scrolled out of the admin dashboard.

### 7.2 Current Server Stack (Baseline for Parity)

Per this repo's existing conventions (see the main CLAUDE.md reference and [face-recognition.md](face-recognition.md)):

- **Faces:** Human (`@vladmandic/human`, tfjs-wasm backend), 1024-dimensional embeddings.
- **Near-duplicate visual embedding:** CLIP ViT-B/32 (`onnxruntime-node`, int8-quantized), 512-dimensional embeddings.
- **Preprocessing:** both are preceded by the shared `prepareImageForProcessing` (sharp) EXIF-orientation step documented in [enrichment-queue.md §4 — Image Rule](enrichment-queue.md#4-enrichmenthandler-interface) and [enrichment-queue.md §12 Step 5](enrichment-queue.md#step-5-use-prepareimageforprocessing-for-image-based-handlers).

Any node-side implementation of face or CLIP compute must reproduce this exact stack — same model weights, same quantization, same orientation-correction step — bit-for-bit where possible, or the parity guarantee in §7.1 does not hold.

### 7.3 Four Mechanisms to Guarantee Parity

**1. A shared compute workspace package.** Proposed as a new workspace package, `packages/enrichment-compute`, containing the model-loading, preprocessing, and inference code for every node-eligible job type. Both `apps/api` and `apps/cli` import this package **identically** — not two independently-maintained reimplementations of "run Human on an image" that could quietly drift apart over time, but exactly one implementation with exactly one set of pinned native dependency versions (exact `onnxruntime-node`, `@vladmandic/human`/tfjs-wasm, and `sharp` versions, locked identically in both `apps/api/package.json` and `apps/cli/package.json`, or hoisted to the shared package's own lockfile). Any change to preprocessing or model version happens in one place and ships to both compute surfaces together.

**2. An API-served, sha256-pinned model manifest.**

```
GET /api/nodes/models/manifest
```

```typescript
// proposed response shape
interface ModelManifest {
  models: Array<{
    key: string;         // e.g. 'human-face-1024', 'clip-vit-b32-q8'
    jobTypes: string[];  // job types this model backs, e.g. ['face_detection', 'video_face_detection']
    sha256: string;      // hash of the model weight file the server is currently running
    version: string;     // human-readable model version tag
  }>;
}
```

A node fetches this manifest and compares it against the sha256 of its own local model files before advertising the corresponding job type in its `eligibleTypes` (§3.1). Byte-identical weights are the concrete, checkable proxy for "this node will produce embeddings comparable to the server's."

**3. A CLI startup model-hash self-check.** On `memoriahub node start` (§9), the CLI hashes every local model file it has and diffs the result against the current manifest from mechanism 2. Any mismatch — a stale model file, a corrupted download, a version the operator never updated — means that job type is **not advertised as eligible** for this run; the node simply omits it from `eligibleTypes` on its next heartbeat rather than claiming jobs it cannot compute correctly. This ties directly into the node-side Doctor checks in §10.

**4. A golden-vector regression test.** A fixed set of test images with known-good embedding vectors (or an accepted cosine-similarity tolerance band around them) is checked into the repo and run in CI against **both** the API's compute path and the CLI's compute path (via `packages/enrichment-compute`, mechanism 1). This is the automated backstop that catches silent drift — e.g. a routine `onnxruntime-node` version bump that quietly changes numerical output — *before* it ships, rather than relying solely on mechanisms 2 and 3 to catch it at runtime after the fact.

---

## 8. Node-Eligible Job Types

Not every enrichment handler is a good candidate for remote execution. Job types fall into three tiers:

### 8.1 High-Value, No Secrets Needed (Freely Node-Eligible)

| Job type | Why it fits |
|----------|-------------|
| `face_detection` | Pure per-item CPU/GPU compute, no provider secret required for the `human` provider path (§7.2) |
| `video_face_detection` | Same as above, plus ffmpeg frame extraction — CPU-heavy, a good fit for a spare laptop |
| `duplicate_detection` | CLIP embedding compute, no provider secret required |
| `metadata_extraction` | EXIF/dimensions/video-probe extraction, no provider secret required |
| `social_media_detection` | ffprobe + on-server OCR, no provider secret required |
| `thumbnail_regen` | Image resize/encode via sharp, no provider secret required |
| `thumbnail_repair` | Same underlying compute as `thumbnail_regen` |

These are the primary target of this feature — CPU/GPU-bound, per-item, secret-free work that scales cleanly across however many nodes a household has online.

### 8.2 AI-Proxy (Gated, Opt-In)

| Job type | Why it's gated |
|----------|-----------------|
| `auto_tagging` | Requires a keyed call to the configured AI provider (Anthropic/OpenAI/etc.) — routed through `POST /api/nodes/jobs/:jobId/ai-proxy/tagging` so the provider key never leaves the server, but the call still burns the household's shared provider quota |
| `geocode` | Requires a keyed call to the active reverse-geocoding provider (when `google` is active) — routed through `POST /api/nodes/jobs/:jobId/ai-proxy/geocode`, same quota-sharing caveat |

A node must explicitly opt in to claiming these two types (a per-node config flag, distinct from the model-hash-driven `eligibleTypes` gating in §7 — this is a policy choice, not a capability check), because every AI-proxy call a node makes competes for the exact same rate-limited provider budget as the server's own jobs (see [Risks §11](#11-risks-and-open-questions)).

### 8.3 Server-Only (Never Node-Eligible)

| Job type | Why it stays server-only |
|----------|---------------------------|
| `storage_insights` | Global aggregate computed directly from Postgres — not a per-item compute task, nothing to distribute |
| `trash_purge` | Direct DB deletes plus storage-blob deletes — inherently a server-side, credentialed operation |
| `job_history_purge` | Direct batch DB deletes — same reasoning as `trash_purge` |
| `location_inference` | Reads and reasons over an entire circle's timeline in a single in-memory pass (see [location-inference.md](location-inference.md)) — tightly coupled to a live, consistent view of circle-wide DB state, not a per-item unit of compute that benefits from being handed to a remote peer |
| `storage_migration` | Directly manipulates storage-provider credentials and copies bytes provider-to-provider — inherently a server-held-credential operation, the opposite of what a node is allowed to touch (§2.2) |
| `burst_detection` | Cheap, fast, DB-and-in-memory-hash-comparison work even at scale — distributing it would add coordination overhead without a meaningful compute win |

---

## 9. CLI Control and Observability

All node lifecycle actions are available as `apps/cli` subcommands:

| Command | Description |
|---------|-------------|
| `node register` | Register this machine as a node (§2.4, §5.1) |
| `node start` | Start local worker loops; runs the model-hash self-check (§7.3) before advertising any job type as eligible |
| `node stop` | Stop local worker loops immediately; in-flight jobs are abandoned (their leases expire naturally and are reaped per §4.3) |
| `node drain` | Set `status = draining` (§3.2); stop claiming new jobs but let in-flight jobs finish before exiting |
| `node status` | Show this node's current registration, status, eligible types, and active job count |
| `node list` | List all nodes registered under the caller's PAT |
| `node doctor` | Run the node-scoped diagnostics sweep (§10) |

### 9.1 Terminal UI Integration

This repo's CLI already has an Ink-based Terminal UI, referenced elsewhere in this documentation set (see the CLI TUI described in [job-insights.md](job-insights.md)). Node control is proposed as a new **"Worker Node"** entry under the TUI's tools menu, with two screens:

- **Live dashboard:** per-slot state (running / waiting / idle), per-job progress, aggregate throughput, and a scrolling error log — the node-side analog of the admin web dashboard's job stats.
- **Config screen:** concurrency, eligible job types presented as a checkbox list gated by the model-hash self-check from §7 (a job type whose model hash doesn't match the manifest is shown but disabled, with the mismatch reason inline), poll cadence, and lease-renew cadence.

### 9.2 Node Engine Events

The node engine is event-driven; the following events drive both the TUI dashboard and structured CLI logs:

```typescript
type NodeEngineEvent =
  | { type: 'job:start'; jobId: string; jobType: string }
  | { type: 'job:progress'; jobId: string; progress: number /* 0..1 */ }
  | { type: 'job:done'; jobId: string; durationMs: number }
  | { type: 'job:error'; jobId: string; error: string }
  | { type: 'idle'; slot: number }
  | { type: 'heartbeat'; eligibleTypes: string[] }
  | { type: 'lease:renew'; jobId: string; newExpiresAt: string }
  | { type: 'model:loaded'; modelKey: string; sha256: string };
```

---

## 10. Doctor Coverage

This section extends both halves of the existing [Doctor Diagnostics](doctor.md) feature — the server-side admin sweep and, newly, a node-scoped CLI equivalent — following doctor.md's own conventions exactly: sections → checks, each check carrying `key`, `label`, `status` (`ok` \| `warning` \| `error` \| `skipped`), `message`, an optional `actionItem`, and `durationMs` (see [doctor.md §2 — Response Shape](doctor.md#2-response-shape)).

### 10.1 CLI-Side: `node doctor`

`node doctor` runs a local, node-scoped version of the same idea Doctor already applies server-side: a set of checks verifying every capability the node might advertise, reusing the same status/action-item shape:

| Check key (proposed) | Label | What it verifies |
|-----------------------|-------|--------------------|
| `node.faceModel` | Face model presence + hash match | Local Human model files exist and their sha256 matches the manifest (§7.2) |
| `node.clipModel` | CLIP model presence + hash match | Local CLIP ONNX weights exist and match the manifest |
| `node.ocr` | OCR / tesseract availability | tesseract binary and language data are present and loadable, for `social_media_detection` eligibility |
| `node.ffmpeg` | ffmpeg / ffprobe presence | Both binaries are on `PATH` and respond to a version probe, for video job types |
| `node.sharpDecode` | sharp / libvips decode capability | `sharp` can decode a bundled test image, for the EXIF-orientation preprocessing step shared with the server (§7.2) |
| `node.apiConnectivity` | API connectivity | The node's PAT can reach `GET /api/nodes/models/manifest` |
| `node.storageReachability` | Storage reachability | A throwaway presigned GET round-trip against the configured storage provider — analogous to the write→read→delete round-trip `StorageSettingsService.testConnection()` performs server-side (see [doctor.md §6](doctor.md#6-reuse-of-existing-services)) |
| `node.tempDisk` | Temp-disk space/health | Sufficient free space and write access on the local temp directory the node uses for downloaded media and intermediate output |

A **failed check for a given capability stops the node from advertising the corresponding job type as eligible** — the check result feeds directly back into the `eligibleTypes` list reported on the next heartbeat, exactly as described in §7.3.

### 10.2 Server-Side: New `nodes` Section on the Admin Doctor Sweep

`POST /api/admin/doctor/run` (see [doctor.md §7](doctor.md#7-api-endpoint-and-rbac)) gains a new `nodes` section, following the existing section/check shape used throughout the current twenty-one-check catalog (see [doctor.md §4](doctor.md#4-check-catalog)):

| Check key (proposed) | Label | What it verifies | Failure → status + action item |
|-----------------------|-------|--------------------|----------------------------------|
| `nodes.registeredCount` | Registered nodes | Reports how many `worker_nodes` rows exist; `skipped` if zero (feature is simply unused, not misconfigured) | n/a — informational only |
| `nodes.heartbeatFreshness` | Node heartbeat freshness | Any node with `status='online'` but `lastHeartbeatAt` older than the expected heartbeat interval | `warning` — "One or more nodes have not reported in recently; check the laptop is still awake and networked." |
| `nodes.staleLeases` | Stuck/expired leases | Count of `enrichment_jobs` rows with `status='running'`, `executor='node'`, and `leaseExpiresAt` in the past, not yet reaped | `warning` — "Run the lease-expiry reaper manually or wait for the next scheduled pass; jobs will requeue automatically." |
| `nodes.capabilitySummary` | Per-node capability summary | Aggregates each node's last-reported `eligibleTypes` from its heartbeat payload into a human-readable summary (e.g. which job types have zero node coverage) | n/a — informational only, never `error`/`warning` |

This mirrors the existing `jobs.queueHealth` / `jobs.burstConfig` checks in doctor.md's Job Queue & Worker section in spirit — coarse, on-demand health signals rather than a full dashboard (Doctor's Job Queue Insights non-goal, see [doctor.md §1](doctor.md#non-goals), applies equally here: this is not a replacement for a full per-node throughput dashboard).

---

## 11. Risks and Open Questions

This section is a candid accounting of what this design does not fully solve, in the same spirit as the "Operational Notes" and "Future Extension Ideas" sections of [enrichment-queue.md](enrichment-queue.md) and the "Gotchas and Implementation Notes" section of [doctor.md](doctor.md).

**A malicious or buggy node can submit a garbage result.** Nothing stops a compromised or simply buggy node from submitting a corrupted embedding, a nonsensical bounding box, or a broken thumbnail through `POST /api/nodes/jobs/:jobId/result`. The API must apply exactly the same validation to a node-submitted result that it would apply to its own in-process handler's output — dimension checks on embeddings, sane bounding-box ranges, image-decodability checks on thumbnail bytes — before persisting anything. This is a genuinely **new trust boundary**: an in-process handler's output was implicitly trusted because it ran inside the API's own process under the API's own code; a node's output is, by construction, produced by code and hardware the API does not control. Validation that used to be "defense against a bug" becomes "defense against a bug *or* a hostile actor," and should be reviewed with that shift in mind.

**Presigned URL exposure window.** A presigned GET or PUT URL is, by design, usable by anyone who has it — including someone who intercepts it in transit — for as long as it remains valid. HTTPS protects the URL in transit under normal circumstances, and the short TTL proposed in §2.5 bounds the exposure window, but this is worth stating plainly rather than glossing over: a presigned URL is a bearer credential for the duration of its validity, just a very short-lived one. This is the accepted tradeoff described in §2.5 in exchange for never issuing nodes a long-lived storage credential.

**Version skew between a node and the server.** A node running an older `cliVersion` — and therefore an older bundled model set — after the server-side model has been upgraded is the expected, not exceptional, case in a fleet where laptops update on their own schedule. The manifest-plus-hash-check mechanism (§7.3) prevents this from silently producing wrong embeddings: a stale node simply fails its local model-hash check and stops advertising the affected job type as eligible until the operator updates it. This is graceful degradation — reduced fleet capacity for that job type — not a hard failure, and it requires no manual intervention to detect, only to fix.

**Household network reliability.** Unlike the server, a laptop node has no uptime guarantee — it depends on being both physically awake and network-reachable. This means jobs claimed by nodes are structurally at higher risk of lease expiry and requeue churn than jobs the server's own in-process worker claims. Operators should expect some baseline rate of "job A got half-processed on a laptop that then went to sleep, and was requeued and finished by someone else" as a normal, not exceptional, occurrence of this feature — not a bug to chase.

**AI-proxy quota sharing.** A node proxying `auto_tagging` or `geocode` calls (§8.2) burns the exact same rate-limited provider quota as the server's own jobs of those types — no separate quota is created or allocated per node. Nodes and the server worker are, from the provider's point of view, indistinguishable competitors for the same budget, and both are subject to the same rate-limit deferral path described in [enrichment-queue.md §8 — Rate-limit deferral path](enrichment-queue.md#retry-and-backoff). Enabling AI-proxy on several nodes at once does not multiply available AI throughput; it only changes which machine happens to be waiting on the shared quota at any given moment.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | July 2026 | AI Assistant | Initial specification |
