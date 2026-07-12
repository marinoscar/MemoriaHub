# Distributed Worker Nodes — Remote Enrichment Compute

| Field | Value |
|-------|-------|
| **Version** | 2.0 |
| **Last Updated** | July 2026 |
| **Status** | Implemented |

---

## Table of Contents

1. [Overview and Motivation](#1-overview-and-motivation)
2. [Security Model](#2-security-model)
3. [Data Model](#3-data-model)
4. [Multi-Process-Safe Claim](#4-multi-process-safe-claim)
5. [Node API — Control Plane and Data Plane](#5-node-api--control-plane-and-data-plane)
6. [Result Contract per Job Type](#6-result-contract-per-job-type)
   - [6.1 The Compute/Persist Split](#61-the-computepersist-split)
7. [Embedding / Model Parity](#7-embedding--model-parity)
8. [Node-Eligible Job Types](#8-node-eligible-job-types)
9. [CLI Control and Observability](#9-cli-control-and-observability)
   - [9.3 Worker Daemon, systemd Service, and TUI Attach](#93-worker-daemon-systemd-service-and-tui-attach)
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
| **Control plane** | Register, claim, submit result, report failure, heartbeat, lease renew, transient per-job provider credentials (§2.7) | Node ⟷ API, over HTTPS, PAT-authenticated (§2.4) |
| **Data plane** | Media bytes (the actual photo/video pixels a job needs to read), plus node-generated output bytes (e.g. a regenerated thumbnail) written back via a presigned PUT | Node ⟷ storage provider (S3/R2), directly, via a short-lived presigned URL issued by the API for that specific job |

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

Every presigned URL issued to a node (for reading source media bytes, or for uploading a generated thumbnail — §6) is scoped to **one specific job** and expires on a TTL far shorter than any long-lived storage credential. **As built**, both directions use the same 1-hour default: `NodesService.resolveInputUrl` calls `ObjectsService.getDownloadUrl` with no expiry override, so it falls through to that service's own default (the `storage.signedUrlExpiry` config value, 3600 seconds); `getJobUploadUrl` (the thumbnail-upload presigned PUT, §5.1/§5.3) hard-codes the same `expiresSeconds = 3600`. This is longer than the 15-minute figure the v1.0 draft proposed, but still comfortably shorter than `ENRICHMENT_LEASE_MS`'s 30-minute default lease and, more importantly, still bounded and job-scoped rather than a long-lived credential. This is a deliberate design simplification, stated explicitly:

> Because a presigned URL is self-expiring, there is **no long-lived credential of any kind stored on the laptop**, and therefore **nothing to revoke or delete** when a node goes offline, is decommissioned, or is simply never heard from again. The alternative design — issuing each node its own scoped, rotatable storage credential (e.g. an S3 IAM role or R2 API token per node) — would require a full credential lifecycle: issuance, rotation, and revocation-on-deregistration, plus a way to audit which node used which credential for which access. Presigned URLs sidestep all of that at the cost of a small, time-boxed exposure window (see [Risks §11](#11-risks-and-open-questions)) that is judged acceptable for a household deployment.

### 2.6 What a Node Can and Cannot Do — Summary Table

| Capability | Allowed? |
|------------|----------|
| Read Postgres directly | Never |
| Hold a storage provider access/secret key | Never |
| Read media bytes for a job it has claimed, via a job-scoped presigned URL | Yes, time-boxed |
| Write generated bytes (e.g. a regenerated thumbnail) for a job it has claimed, via a job-scoped presigned URL | Yes, time-boxed |
| Call an AI/geo provider directly (Anthropic or OpenAI vision, Nominatim, Google reverse-geocode) | Yes, for the one job it currently holds — using a **transient, per-job credential** fetched from `POST /api/nodes/:id/jobs/:jobId/credentials` and held in memory only, never persisted (§2.7) |
| Claim jobs registered to a different user's nodes | Never — every node call is scoped to `worker_nodes.createdById` |
| Write directly to `media_face_status`, `Face`, `media_visual_embedding`, or any other domain table | Never — only the API's result-submission endpoint invokes handler-side persistence (§6) |

### 2.7 Security Tradeoff: Transient Per-Job Credentials Instead of an AI-Proxy

An earlier revision of this spec (v1.0) proposed routing `auto_tagging` and `geocode` calls through server-side "AI-proxy" endpoints (`POST /nodes/jobs/:jobId/ai-proxy/tagging` / `/ai-proxy/geocode`): the node would send its prepared input to the API, and the API — holding the only copy of the provider key — would make the keyed call itself and return the raw result. **This was explicitly rejected during implementation** in favor of a different design, mandated as a product decision: a node fetches a **transient, per-job credential** via `POST /api/nodes/:id/jobs/:jobId/credentials` and calls the provider's HTTP API (Anthropic or OpenAI vision, Nominatim, or Google reverse-geocode) directly, exactly as the server's own in-process worker would.

Why the tradeoff was made deliberately, in the same spirit as §2.5's "deliberately ephemeral" framing for presigned URLs:

- **It avoids server-side call fan-out.** An AI-proxy design means every node-originated provider call still executes an outbound HTTP request *from the API process* — the API becomes a second hop for every single node job of these two types, with no bandwidth or latency benefit over just running the job in-process. A node making the call directly removes that hop entirely; the API's only remaining job is to hand over a short-lived credential.
- **The credential's blast radius is bounded and non-persistent.** `getJobCredentials` (`apps/api/src/nodes/nodes.service.ts`) resolves the plaintext key fresh on every call and returns it in the HTTP response body only — it is never written to `~/.memoriahub/config.json`, never logged (the CLI's `redactSensitive` helper in `apps/cli/src/node/logger.ts` scrubs any field matching `token`/`api[-_]?key`/`secret`/`credential`/`password` before anything is written to the JSONL log file, and no server-side interceptor logs response bodies), and exists in the node process's memory only for the duration of one compute call. The same guard that protects `/result` and `/failure` from a stale claim — `assertJobHeldByNode` (409 if the job is no longer claimed by this node, not running, or its lease has expired) — gates `/credentials` too, so a node past its lease window cannot mint a fresh credential for a job it no longer holds.
- **It is a narrower, well-understood exposure than a long-lived key.** Unlike `storage_provider_credentials` (§2.2, never handed to a node under any design), the credential handed out here is provider-specific, job-scoped, and disappears the moment the node process exits or the job's lease expires — the same "nothing to revoke, nothing long-lived to steal" property §2.5 argues for presigned URLs applies here too, just for a provider API key instead of a storage URL.
- **The cost:** every node running `auto_tagging` or `geocode` jobs necessarily sees a plaintext household provider key at least once per job, which an AI-proxy design would have avoided entirely. This is an accepted tradeoff, not an oversight — see the updated `auto_tagging`/`geocode` rows in §8.2.

`packages/enrichment-compute/src/ai/index.ts`'s `callAnthropicVision`/`callOpenAiVision` and `packages/enrichment-compute/src/geo/index.ts`'s `fetchNominatim`/`fetchGoogleReverse` are the shared, parity-guaranteeing functions both the server's in-process compute path and a node's compute module call with these credentials — see §6.1 and §7.

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

A node can go offline mid-job — the laptop is closed, loses Wi-Fi, or crashes — with no clean way to signal the API that its claimed jobs are now orphaned. The `leaseExpiresAt` column (§3.3) exists to bound this: a claim is only valid until its lease expires, and the node is responsible for renewing the lease (`POST /api/nodes/:id/jobs/:jobId/renew`, §5) periodically while a long-running job is still in progress.

The existing stuck-job-reset cron, `EnrichmentStuckResetTask` (see [enrichment-queue.md §11 — Stuck Threshold](enrichment-queue.md#stuck-threshold-settings-driven)), is augmented to additionally scan for `running` jobs whose `leaseExpiresAt` has passed:

- Such a job is **requeued**: `status` reset to `pending`, `claimedByNodeId` cleared, `leaseExpiresAt` cleared, so either the server's in-process worker or any other online node can pick it back up.
- This runs alongside, not instead of, the existing `startedAt`/threshold-based zombie-row detection already documented in enrichment-queue.md §11 — a lease-expired node job and a `startedAt IS NULL` zombie row from a dead server process are two different failure shapes converging on the same recovery cron.

**Budget-exhausted leases are failed, not requeued** — this exactly mirrors the existing stuck-job policy for the server-only case. Because `attempts` is charged at claim time (see [enrichment-queue.md §8 — Atomic Claim](enrichment-queue.md#atomic-claim)), a lease-expired job whose `attempts >= ENRICHMENT_MAX_ATTEMPTS` is marked `failed` directly by the reaper instead of being handed back to the pending queue for a fourth attempt — bounding a job that reliably kills every node/worker that touches it to the same `ENRICHMENT_MAX_ATTEMPTS` crash budget as any other job in the queue, node-originated or not.

### 4.4 Lease Renewal

```
POST /api/nodes/:id/jobs/:jobId/renew
```

`NodeEngine.processJob` (`apps/cli/src/node/node-engine.ts`) starts a renewal timer for every in-flight job at `leaseRenewIntervalMs` (default 30 seconds — comfortably short relative to `ENRICHMENT_LEASE_MS`'s 30-minute default lease), calling this endpoint with an optional `{ leaseMs }` override on each tick. The endpoint extends `leaseExpiresAt` to `now() + leaseDuration`, provided the caller's node is still the job's `claimedByNodeId` and the job is still `running`. A renewal failure is treated as non-fatal by the engine (logged, not thrown) — the assumption is that a transient network blip will resolve before the lease actually expires; if it doesn't, the server's lease-expiry reaper (§4.3) simply requeues the job as normal, and the node abandons local work on it once it observes that its next result/failure submission is rejected with 409 (§5.1, §6.1's `assertJobHeldByNode`).

---

## 5. Node API — Control Plane and Data Plane

All node-facing endpoints live under `/api/nodes/*`. Authentication is via Personal Access Token (§2.4); every call is implicitly scoped to `node.createdById` matching the authenticated PAT's owner — a PAT can only act on nodes it registered.

### 5.1 Node-Facing Endpoints

All node routes are mounted at `/api/nodes` and, per `NodesController`'s own convention, require the `jobs:write` permission on the caller's PAT (the model-manifest GET requires only `jobs:read`); owner-scoping (a caller may only touch nodes it registered) is enforced inside `NodesService`, not by a route-level guard.

| Endpoint | Description |
|----------|-------------|
| `POST /api/nodes/register` | Register a machine as a node; body includes `name`, `hostname`, `platform`, `cliVersion`, `eligibleTypes`, `concurrency`; returns the created `worker_nodes` row |
| `POST /api/nodes/:id/deregister` | Cleanly remove a node registration (operator-initiated, e.g. retiring a laptop) |
| `POST /api/nodes/:id/heartbeat` | Periodic liveness + capability payload; updates `lastHeartbeatAt`, and optionally `status`/`capabilities` (latest `node doctor` summary); this payload also feeds the Doctor `nodes` section (§10) |
| `POST /api/nodes/:id/claim` | Atomic claim per §4; body includes `max` (jobs to claim this round, capped at the node's `concurrency`) and an optional `types` filter (intersected with the node's registered `eligibleTypes`); returns `{ jobs: [{ job, inputUrl, params }] }` — `inputUrl` is a presigned GET for the source object bytes (`null` for a global job with no `mediaItemId`), `params` is the job's raw `payload` |
| `POST /api/nodes/:id/jobs/:jobId/renew` | Extend the lease on a job the caller currently holds (§4.4); optional body `{ leaseMs }` |
| `POST /api/nodes/:id/jobs/:jobId/upload-url` | Get a presigned PUT URL for a claimed job to upload output bytes to (currently the `thumbnail_regen`/`thumbnail_repair` compute path); returns `{ url, storageKey, expiresSeconds }`; the **server**, not the node, chooses `storageKey` (§6.1) |
| `POST /api/nodes/:id/jobs/:jobId/credentials` | Get a transient, per-job provider credential for `auto_tagging` or `geocode` (§2.7); response shape depends on job type — see §6 |
| `POST /api/nodes/:id/jobs/:jobId/result` | Submit the result-contract payload for a completed job (§6); validates against the handler's `nodeResultSchema`, dispatches to `persistNodeResult`, and completes the job as succeeded |
| `POST /api/nodes/:id/jobs/:jobId/failure` | Report a failed job; routes through the same normal-failure-vs-rate-limit backoff paths documented in [enrichment-queue.md §8 — Retry and Backoff](enrichment-queue.md#retry-and-backoff), via the shared `EnrichmentTerminalService` (§6.1) |
| `GET /api/nodes` | List worker nodes owned by the caller (`jobs:write`) — lets `node list`/`node status` work without an Admin permission |
| `GET /api/nodes/:id` | Get a single worker node owned by the caller (`jobs:write`) |
| `GET /api/nodes/models/manifest` | Return the sha256-pinned model manifest (§7.2, `jobs:read`) so a node can verify local model parity before advertising a job type as eligible |

Four of these — `upload-url`, `credentials`, `result`, `failure` — share one guard, `NodesService.assertJobHeldByNode`: the job must still have `claimedByNodeId === id`, `status === 'running'`, and a `leaseExpiresAt` in the future, or the call is rejected with 409. This is what makes a late submission from a reaped/re-claimed node harmless instead of a double-persist.

### 5.2 Admin-Facing Endpoints

| Endpoint | Permission | Description |
|----------|------------|-------------|
| `GET /api/admin/nodes` | `jobs:read` (Admin) | List all registered nodes across the deployment plus a health summary (status, last heartbeat age, eligible types, current claim count) |
| `DELETE /api/admin/nodes/:id` | `jobs:write` (Admin) | Force-deregister/remove a node record — e.g. a laptop that was lost or decommissioned without running `node deregister` first; any jobs it held are picked up by the lease-expiry reaper (§4.3) once the lease naturally expires |

**Correction from the v1.0 draft:** this feature does **not** introduce a new `nodes:read`/`nodes:write` permission pair. The admin endpoints above reuse the existing `jobs:read`/`jobs:write` permissions already granted to the Admin role for the enrichment job queue dashboard, and every node-facing endpoint in §5.1 is gated the same way (via the registering user's PAT, which must carry `jobs:write`).

### 5.3 Data-Plane Flow (Presigned URLs)

The claim response (`POST /api/nodes/:id/claim`) never includes raw media bytes. For a job that needs to read source pixels (e.g. `face_detection`), each claimed job entry includes a presigned GET URL scoped to that object, generated by the API's existing storage-provider abstraction (see [storage-providers.md](storage-providers.md)) at claim time. For a job that needs to write generated bytes back (currently `thumbnail_regen`/`thumbnail_repair` — §6, §6.1), the node first calls `POST /api/nodes/:id/jobs/:jobId/upload-url` to learn where to PUT the bytes — the server derives the storage key itself (`thumbnails/<storageObjectId>.jpg`, the same convention `ThumbnailProcessor.uploadThumbnail` uses in-process, so a node-produced thumbnail is indistinguishable in storage layout from a server-produced one) — uploads directly to the returned presigned URL, and only then calls the result endpoint with a reference to what it wrote (`{ storageKey, width, height, bytes }`, not the bytes themselves). Both directions keep the node talking directly to S3/R2, never streaming media bytes through the API process — see §2.3 for the full control-plane/data-plane rationale.

---

## 6. Result Contract per Job Type

The COMPUTE half of a job runs on the node; the **PERSIST half stays server-side**. [enrichment-queue.md §4](enrichment-queue.md#4-enrichmenthandler-interface) states that handlers own their domain-specific status tables (`MediaFaceStatus`, `MediaTagStatus`, etc.) and must not rely on the generic job record for domain status. That ownership does not move to the node: a node never writes to `media_face_status`, `Face`, `media_visual_embedding`, or any other domain table directly. Instead, `POST /api/nodes/:id/jobs/:jobId/result` is the single endpoint that **invokes the existing handler-side persistence logic** on the server, using the node-submitted payload as its input — the same handler code path that runs when the server's own in-process worker completes a job, just fed compute results from a node instead of from a local `process()` call. (Note the endpoint path: `/nodes/:id/jobs/:jobId/result`, not the bare `/nodes/jobs/:jobId/result` the v1.0 draft sketched — every node-facing route is nested under the node's own `:id`, matching the ownership-scoping model in §2.4.)

The **per-job-type result payload schemas are zod schemas, not hand-written TypeScript interfaces** — they live in the shared parity package (`packages/enrichment-compute/src/dto/index.ts`) and are re-exported from `apps/api/src/nodes/dto/compute-result.dto.ts` for API-layer convenience, so the CLI producer and the API consumer validate against the exact same runtime schema, not just the same TypeScript shape.

| Job type | Result payload shape | Notes |
|----------|----------------------|-------|
| `face_detection` / `video_face_detection` | `{ modelVersion, providerKey, imageWidth, imageHeight, faces: [{ boundingBox: {x,y,width,height}, confidence?, embedding: number[], landmarks?, externalFaceId? }] }` | `boundingBox` is a **pixel** box relative to `imageWidth`/`imageHeight` (not the 0–1 normalized convention the `faces` table stores) — normalization happens server-side in the persist half. `embedding` has no hard-pinned length in the schema (provider-dependent: 1024-d Human, 128-d CompreFace); the persist half validates against the active provider's expected dimensionality. `landmarks` and `externalFaceId` are new fields beyond the v1.0 draft — opaque passthrough for delegated-recognition providers; always absent for a node result today, since neither node-eligible face provider (the default keyless Human, or the opt-in keyless CompreFace sidecar — see [worker-node-setup.md §4](../worker-node-setup.md#4-matching-the-servers-face-detection-provider-compreface)) produces delegated-recognition landmarks or an external face ID |
| `duplicate_detection` | `{ model, embedding: number[512], dHash }` | Unchanged from the v1.0 draft; `dHash` is validated as a decimal-digit string (regex `^\d+$`) |
| `metadata_extraction` | `{ exif: Record<string, unknown>, probe: Record<string, unknown> \| null }` | Unchanged from the v1.0 draft |
| `social_media_detection` | `{ verdict: 'detected'\|'clean', score, ocrText, platform, detectionMethod, matchedRule, confidence }` | **Extended** beyond the v1.0 draft's `{ verdict, score, ocrText }` — `media_social_status` persists `platform`, `detectionMethod`, and `matchedRule` as first-class audit-trail columns, so the persist half needs them from the node directly rather than re-deriving them from `verdict`/`score` alone. `score` is kept for back-compat but downstream persistence reads `confidence` |
| `thumbnail_regen` / `thumbnail_repair` | `{ storageKey, width, height, bytes }` | Unchanged from the v1.0 draft: bytes are uploaded first via `POST /api/nodes/:id/jobs/:jobId/upload-url` + a presigned PUT (§5.3); this payload only references what was written |
| `auto_tagging` | `{ rawText: string }` submitted via the SAME `/result` endpoint as every other type | **Changed from the v1.0 draft**, which routed this through a separate AI-proxy submission path. The node calls the provider directly using a transient credential (§2.7) and submits the raw, unparsed vision-model response text; parsing against the enabled `TagLabel` vocabulary stays server-side in `AutoTaggingService.persistAutoTagging` (it needs a DB-loaded label set) |
| `geocode` | `{ country, countryCode, admin1, admin2, locality, placeName, source }` submitted via the SAME `/result` endpoint | **Changed from the v1.0 draft** for the same reason as `auto_tagging` — see §2.7 |

```typescript
// packages/enrichment-compute/src/dto/index.ts (actual, zod-backed — abbreviated)

export const faceDetectionResultSchema = z.object({
  modelVersion: z.string().min(1),
  providerKey: z.string().min(1),
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
  faces: z.array(z.object({
    boundingBox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    confidence: z.number().optional(),
    embedding: z.array(z.number()).min(1),
    landmarks: z.unknown().optional(),
    externalFaceId: z.string().optional(),
  })),
});

export const duplicateDetectionResultSchema = z.object({
  model: z.string().min(1),
  embedding: z.array(z.number()).length(512),
  dHash: z.string().regex(/^\d+$/),
});

export const metadataExtractionResultSchema = z.object({
  exif: z.record(z.string(), z.unknown()),
  probe: z.record(z.string(), z.unknown()).nullable(),
});

export const socialMediaDetectionResultSchema = z.object({
  verdict: z.enum(['detected', 'clean']),
  score: z.number(),
  ocrText: z.string().nullable(),
  platform: z.enum(['tiktok', 'instagram', 'facebook', 'other']).nullable(),
  detectionMethod: z.enum(['metadata', 'filename', 'ocr']).nullable(),
  matchedRule: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export const thumbnailResultSchema = z.object({
  storageKey: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
});

export const autoTaggingResultSchema = z.object({ rawText: z.string() });

export const geocodeResultSchema = z.object({
  country: z.string().nullable(),
  countryCode: z.string().nullable(),
  admin1: z.string().nullable(),
  admin2: z.string().nullable(),
  locality: z.string().nullable(),
  placeName: z.string().nullable(),
  source: z.string(),
});
```

`POST /api/nodes/:id/jobs/:jobId/result` (body `{ type, result }`) validates `type` against the job's own recorded type (defense against a node posting a payload against the wrong job), then validates `result` against the matching handler's `nodeResultSchema` before invoking `persistNodeResult` — the same validation rigor the handler would apply to its own locally-computed output (see [Risks §11](#11-risks-and-open-questions) for why this validation step is a new trust boundary that in-process handlers never needed).

**Failure contract:** `POST /api/nodes/:id/jobs/:jobId/failure` takes body `{ error: string; willRetry?: boolean; rateLimited?: boolean; retryAfterMs?: number | null }`. `rateLimited: true` routes the job through the exact same deferral/backoff path a server-side `RateLimitError` would (and trips the shared `ProviderThrottleService` gate, so a node-reported 429 backs off sibling server-side jobs of the same provider too); everything else takes the normal exponential-retry path. `willRetry` is advisory only — the server's `attempts` budget (§ enrichment-queue.md) is what actually decides whether the job is requeued or permanently failed, not anything the node reports. Both endpoints funnel through `EnrichmentTerminalService` (§6.1), the same shared terminal-state writer the in-process worker uses.

A node classifies a compute failure as rate-limited via the shared `ProviderRateLimitError` class (`packages/enrichment-compute/src/rate-limit/index.ts`) — every provider-calling subpath in the shared package (`/ai` → Anthropic/OpenAI, `/geo` → Nominatim/Google) throws or is classified into this one error type on a 429/529/quota-exhaustion response, so `apps/cli/src/node/node-engine.ts` has exactly one place (`err instanceof ProviderRateLimitError`) that detects a rate limit regardless of which compute module threw it, and forwards `{ rateLimited: true, retryAfterMs }` to the failure endpoint accordingly. Every other compute-module failure stays on the plain `{ willRetry: true }` path.

### 6.1 The Compute/Persist Split

Every node-eligible enrichment handler is split into two halves:

- **`compute*(buffer, params) → ResultDto`** — pure, takes downloaded bytes (or, for `geocode`, just stored coordinates) and returns a plain result object. Delegates to `packages/enrichment-compute` (§7) so the exact same compute code runs whether it's called in-process or wrapped by a node's CLI compute module.
- **`persist*(job, ResultDto)`** — Prisma writes only: upserts the domain status row, writes the domain table(s), never re-downloads or re-computes anything. Server-only.

For example, `apps/api/src/face/face-detection.service.ts` splits into `computeFaces` (download → `prepareImageForProcessing` → detect → normalize) and `persistFaces` (delete non-manual faces → `FaceDetectionCore.persistAndMatchFaces` → mark status); `apps/api/src/dedup/duplicate-detection.service.ts` splits into `computeDuplicate` and `persistDuplicate` the same way. The in-process path calls both halves back-to-back inside `process()`; a node calls the equivalent of `compute*` locally (via its own CLI compute module under `apps/cli/src/node/compute/`) and submits the resulting DTO, and the API's node-result endpoint calls only `persist*` — the exact same persist code path either way, so a face detected by a node and a face detected in-process are indistinguishable once persisted.

This split is expressed as an **optional extension** to the existing `EnrichmentHandler` interface (`apps/api/src/enrichment/enrichment-handler.interface.ts`), not a new interface or a parallel registration mechanism:

```typescript
export interface EnrichmentHandler {
  readonly type: string;
  process(job: EnrichmentJob): Promise<void>;

  // Present only on node-eligible handlers.
  readonly nodeResultSchema?: z.ZodType;
  persistNodeResult?(job: EnrichmentJob, result: unknown): Promise<void>;
}
```

`NodesService.submitJobResult` looks up the job's handler through the existing `EnrichmentHandlerRegistry` (no new module coupling — the same registry every handler already registers itself in), checks that both `nodeResultSchema` and `persistNodeResult` are present (a handler that hasn't opted in to node eligibility simply lacks them, and a node result for that job type is rejected with 400), parses `body.result` against the schema, and calls `persistNodeResult`.

**`EnrichmentTerminalService`** (`apps/api/src/enrichment/enrichment-terminal.service.ts`) was extracted, behavior-preserving, out of `EnrichmentJobWorker.processJob` specifically so both executors share identical terminal semantics: on success it decays the provider-throttle ramp and writes `succeeded` + releases the claim/lease; on failure it classifies rate-limit vs. normal error and routes through the same deferral/exponential-retry state machine the in-process worker has always used. `POST /api/nodes/:id/jobs/:jobId/result` and `/failure` both call into this one service — there is no separate, node-specific terminal-state code path to drift out of sync with the server worker's.

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

### 7.3 Four Mechanisms to Guarantee Parity — As Built

**1. A shared compute workspace package: `packages/enrichment-compute`.** Built as a real workspace package (added to the root `package.json`'s `"workspaces": ["apps/*", "packages/*"]`), containing the model-loading, preprocessing, and inference code for every node-eligible job type. Both `apps/api` and `apps/cli` import this package **identically** — not two independently-maintained reimplementations of "run Human on an image" that could quietly drift apart over time, but exactly one implementation.

- **Dual CJS + ESM build.** `apps/api` (NestJS, CommonJS) and `apps/cli` (ESM) need the SAME compiled output in two different module formats. The package's `build` script (`tsc -p tsconfig.cjs.json && tsc -p tsconfig.esm.json && node ./scripts/write-dist-stubs.mjs`) compiles both, and `package.json`'s `exports` map serves `require`/`import`/`types` conditions per subpath so each consumer's bundler picks the right artifact automatically.
- **Exact-pinned native dependencies, enforced at the root.** The package's own `dependencies`/`optionalDependencies` pin exact versions — `sharp@0.35.1`, `onnxruntime-node@1.27.0`, `@tensorflow/tfjs@4.22.0`, `@tensorflow/tfjs-backend-wasm@4.22.0`, `@vladmandic/human@3.3.6`, `tesseract.js@7.0.0` — and the **root** `package.json`'s `overrides` block repeats the exact same pins, so npm's workspace resolution cannot let `apps/api` or `apps/cli` end up with a different patch version of any of these than the shared package itself uses (a version-skew bug the parity guarantee in §7.1 depends on preventing). The heavy model libraries (`@tensorflow/tfjs*`, `@vladmandic/human`, `tesseract.js`) are declared as `optionalDependencies` so a lean CLI install doesn't force-download them — see §8 for the per-job-type degraded-mode behavior when they're absent.
- **Subpath exports, one per compute domain.** `package.json`'s `exports` map publishes twelve entry points, each independently buildable/importable: `.` (root), `/image` (`prepareImageForProcessing` + orientation), `/clip` (CLIP ONNX session + embedding), `/dhash` (perceptual hash), `/face` (Human face detector), `/ocr` (tesseract wrapper), `/metadata` (EXIF/ffprobe extraction), `/social` (social-media detection rule engine), `/video` (ffmpeg frame extraction), `/ai` (Anthropic/OpenAI vision calls), `/geo` (Nominatim/Google reverse-geocode calls), `/dto` (the zod result schemas — §6), `/rate-limit` (`ProviderRateLimitError`). A consumer imports only the subpath(s) it needs (`@memoriahub/enrichment-compute/clip`, etc.) rather than the whole package.

Any change to preprocessing or model version happens in one place (this package) and ships to both compute surfaces together.

**2. An API-served, sha256-pinned model manifest.**

```
GET /api/nodes/models/manifest
```

Returns a **bare array** (not `{ models: [...] }` — the CLI's `ApiClient.getModelManifest()` unwraps the standard `{ data }` response envelope and iterates the array directly):

```typescript
// actual response shape — apps/api/src/nodes/nodes.service.ts getModelManifest()
interface ModelManifestEntry {
  name: string;         // e.g. 'clip-vit-b32-vision-quantized.onnx'
  url: string;          // download URL (Hugging Face / vladmandic/human-models GitHub release)
  sha256: string;       // real, computed hash — no longer a null placeholder (see below)
  bytes: number;        // expected file size
  targetSubdir: string; // 'models' or 'human' — where under the node's model dir to place it
}
```

The manifest currently lists **five** files with real `sha256`/`bytes` values (§7.2 / §8): the CLIP ONNX vision model, and four Human face-recognition files — `blazeface-back.json` + **`blazeface-back.bin`** (the detector's weights) + `faceres.json` + `faceres.bin`. `blazeface-back.bin` did not exist in the early implementation pass — an earlier manifest was missing it entirely, which would have left the Human face detector unable to load its detector weights on any node that tried; it was added alongside the other four once the gap was found. A node fetches this manifest and compares it against the sha256 of its own local model files before advertising the corresponding job type in its `eligibleTypes` (§3.1). Byte-identical weights are the concrete, checkable proxy for "this node will produce embeddings comparable to the server's." (The CLIP entry's hash is documented as a point-in-time snapshot, not an eternal guarantee — Hugging Face may rebuild/re-quantize that file over time, so an unexpected hash-verification failure on that one entry should prompt a re-download-and-re-hash, not an assumption that the local file is corrupt.)

**3. A CLI startup model-hash self-check.** On `memoriahub node start` (§9), the CLI's model manager (`apps/cli/src/node/models.ts`, invoked as `ensureModels(manifest)`) downloads-and-verifies every manifest entry against its pinned sha256 before the node advertises the corresponding job type as eligible; `node doctor` runs the same check on demand (§10.1). A mismatch — a stale model file, a corrupted download, a version the operator never updated — keeps that job type out of `eligibleTypes` rather than letting the node claim jobs it cannot compute correctly.

**4. A golden-vector regression test.** `packages/enrichment-compute/test/golden.test.mjs` (run via `node --test`, the package's own `npm test`) is the actual regression guard: a committed fixture image (`test/fixtures/golden-fixture.jpg`) plus a committed golden 512-d CLIP vector (`test/fixtures/golden-clip-512.json`) and a pinned dHash value. The dHash assertion is bit-exact (no tolerance — dHash is resize + adjacent-pixel comparison, fully deterministic). The CLIP assertion uses a `1e-4` max-element-wise-diff tolerance rather than exact equality, specifically to absorb cross-platform floating-point reduction-order noise (a worker node without AVX2, or a future `onnxruntime-node` point release, can reorder matmul reductions and produce tiny non-zero diffs even for bit-identical model/input) while still catching a real regression (wrong preprocessing, wrong mean/std, wrong model, transposed tensor layout — all of which produce diffs many orders of magnitude larger than `1e-4`). The CLIP test **skips** (not fails) when the ~89 MB model file isn't present locally, so it degrades gracefully on CI/machines without the model downloaded — only the dHash/Hamming-distance assertions, which have no such dependency, always run.

---

## 8. Node-Eligible Job Types

Not every enrichment handler is a good candidate for remote execution. `apps/cli/src/node/capabilities.ts`'s `NODE_JOB_TYPES` constant is the authoritative list of types a node's compute dispatcher knows about at all; `JOB_TYPE_REQUIREMENTS` maps each to the native capabilities that gate it. Job types fall into three tiers:

### 8.1 High-Value, No Secrets Needed (Freely Node-Eligible) — Final Status

| Job type | Status | Notes |
|----------|--------|-------|
| `face_detection` | ✅ Implemented | Real compute via `@memoriahub/enrichment-compute/face` (Human, the node default) or, opt-in, `@memoriahub/enrichment-compute/face-compreface` (CompreFace, requires a local `compreface-core` sidecar the node itself runs) — the opt-in exists so a node's embedding space can match the server's active provider when the server is configured for `compreface` rather than `human`; see [worker-node-setup.md §4](../worker-node-setup.md#4-matching-the-servers-face-detection-provider-compreface) for setup and the `warnOnProviderMismatch` rationale for why matching matters |
| `duplicate_detection` | ✅ Implemented | Real compute via `@memoriahub/enrichment-compute/clip` + `/dhash`; degrades to dHash-only when `onnxruntime` is absent (not a hard requirement — see `JOB_TYPE_REQUIREMENTS`) |
| `metadata_extraction` | ✅ Implemented | **Note the type name:** the job type (and the `NODE_JOB_TYPES` entry) is `metadata_extraction`, not `metadata` |
| `thumbnail_regen` | ✅ Implemented, photos only | Shares one compute module with `thumbnail_repair` (`apps/cli/src/node/compute/thumbnail.ts`); uploads generated bytes via the new `POST /api/nodes/:id/jobs/:jobId/upload-url` presigned-PUT flow (§5.1, §5.3) instead of returning bytes inline. A video input surfaces as a sharp decode failure, mapped to `CapabilityUnavailableError` — video thumbnails still fall back to the server's existing in-process `StorageProcessingRecoveryService.reprocessObjectNow` path, nothing regresses |
| `thumbnail_repair` | ⚠️ Interface parity only, not end-to-end node-claimable | Listed in `NODE_JOB_TYPES` and shares the same compute module as `thumbnail_regen` for future-proofing, but `ThumbnailRepairTask` enqueues it as a single **global sweep job** (`mediaItemId: null`, `circleId: null`) that iterates many media items server-side in one job — a node claiming it gets no `inputUrl` (§5.1's `resolveInputUrl` returns `null` for any job with no `mediaItemId`) and has no way to iterate the underlying candidate set itself. Honest status: wired for the day this job type becomes per-item, not currently distributable |
| `social_media_detection` | ✅ Implemented, with a known gap | Real two-tier compute (ffprobe/filename Tier 1, on-device OCR Tier 2) via `@memoriahub/enrichment-compute/metadata` + `/social` + `/video` + `/ocr`. **Known gap:** `job.payload` is currently `null` server-side for this job type (`MediaEnrichmentService`'s enqueue call), so a node has no reliable original filename to feed Tier-1's filename rules — only the container-metadata rules (read from the downloaded bytes via ffprobe) are guaranteed to fire. The pre-flight caps, landscape-no-OCR gate, and feature flag remain entirely server-authoritative regardless |
| `video_face_detection` | ⚠️ **DEFERRED — scaffold only** | `apps/cli/src/node/compute/video-face-detection.ts` proves the required native libs (`sharp`, `human`) load, then unconditionally throws `CapabilityUnavailableError` — cross-frame embedding dedup and `frameThumbnailKey` upload were never wired. Frame extraction itself WAS extracted into the shared package (`/video`'s `extractFramesAt`, used by the social-media-detection compute module above), but the video-face compute module does not yet call it. This job type stays server-only in practice today, despite appearing in `NODE_JOB_TYPES` |
| `auto_tagging` | ✅ Implemented, via transient credentials | See §8.2 — moved out of the "AI-Proxy" tier this section originally proposed |
| `geocode` | ✅ Implemented, via transient credentials, with a provider gap | See §8.2. The `offline` reverse-geocode provider (server-side GeoNames dataset) has no node-side equivalent; `apps/cli/src/node/compute/geocode.ts` declines gracefully with `CapabilityUnavailableError` when the transient credential response reports `provider: 'offline'`, leaving that job server-only. Only `nominatim`/`google` are node-computable |

These remain the primary target of this feature — CPU/GPU-bound, per-item, secret-free work that scales cleanly across however many nodes a household has online.

### 8.2 Transient Credentials (Gated, Opt-In) — Formerly "AI-Proxy"

This section was originally titled "AI-Proxy" and described `auto_tagging`/`geocode` calls being routed through the server so the provider key never left it. That design was rejected — see §2.7 for the full rationale. As built:

| Job type | Why it needs a credential | How the node gets it |
|----------|---------------------------|------------------------|
| `auto_tagging` | Requires a keyed call to the configured AI provider. Both `anthropic` and `openai` are supported via `packages/enrichment-compute/src/ai/index.ts`'s `callAnthropicVision`/`callOpenAiVision` pair (§7.3) — a job configured for a hypothetical third/future tagging provider not yet ported to the shared package would decline with `CapabilityUnavailableError`, leaving that job server-only | `POST /api/nodes/:id/jobs/:jobId/credentials` returns `{ type: 'auto_tagging', provider, model, apiKey, baseUrl?, system, prompt, mimeTypeHint }`; the node dispatches on `provider` to call `callAnthropicVision` or `callOpenAiVision` directly with the returned key, held in memory only |
| `geocode` | Requires a keyed call to the active reverse-geocoding provider (`nominatim` or `google`; `offline` declines — §8.1) | `POST /api/nodes/:id/jobs/:jobId/credentials` returns `{ type: 'geocode', provider, apiKey?, baseUrl?, lat, lng }`; the node calls `fetchNominatim`/`fetchGoogleReverse` directly |

Every node-originated call of either type still competes for the exact same rate-limited provider budget as the server's own jobs — enabling these types on several nodes at once does not multiply available AI/geo throughput (see [Risks §11](#11-risks-and-open-questions)); a node's `ProviderRateLimitError` classification (§6) routes it through the identical deferral path a server-side rate limit would.

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

All node lifecycle actions are available as `apps/cli` subcommands (`apps/cli/src/commands/node.ts`):

| Command | Description |
|---------|-------------|
| `node register` | Register this machine as a node (§2.4, §5.1) |
| `node start [--daemon]` | Run the claim/compute loop; always hosts the IPC socket + file logging (§9.3); `--daemon` detaches into the background instead of running in the foreground |
| `node stop` | Stop a running node: tries the IPC socket first (graceful drain + server-side deregister), falls back to `SIGTERM` via the pidfile, falls back to a server-side deregister call if no local process is found at all |
| `node status` | Live snapshot via IPC when a daemon is running, else a local-only summary |
| `node logs [--follow] [-n <lines>]` | Print or tail the JSONL worker log (§9.3) |
| `node set-concurrency <n>` | Adjust concurrency live over IPC if a daemon is running, else persist to local config for the next `node start` |
| `node service install\|uninstall\|status` | Install/remove/inspect the systemd user unit that keeps the worker node always on (§9.3) |
| `node list` | List all nodes registered under the caller's PAT (backed by `GET /api/nodes`, §5.1) |
| `node doctor` | Run the node-scoped diagnostics sweep (§10.1) |

**Corrections from the v1.0 draft:** there is no standalone `node drain` subcommand — draining is reached via the daemon IPC (`{ cmd: 'drain' }`, sent internally by `node stop`'s graceful path) rather than a separate CLI verb. `node register` accepts `--types <csv>` to set the initial `eligibleTypes` explicitly (defaulting to every type the local capability probe supports).

### 9.1 Terminal UI Integration

This repo's CLI has an Ink-based Terminal UI (see the CLI TUI described in [job-insights.md](job-insights.md)). Node control is a real **"Worker Node"** entry under the TUI's tools menu (`apps/cli/src/tui/menu-config.ts`), with two screens:

- **`NodeDashboard`:** per-job state (active jobs with elapsed time, a scrolling history of recent completions/failures, aggregate counters) — the node-side analog of the admin web dashboard's job stats. See §9.3 for how it can attach to an already-running daemon instead of only reflecting an in-process engine.
- **`NodeConfig`:** concurrency (live-adjustable — §9.3), eligible job types as a checkbox list gated by capability/model-hash status, poll cadence, and lease-renew cadence.

### 9.2 Node Engine Events

The node engine is event-driven (`apps/cli/src/node/node-events.ts`'s `NODE_EV` map); the following events drive the TUI dashboard, structured file logs, and the daemon IPC socket alike:

```typescript
export const NODE_EV = {
  CLAIMED: 'claimed',
  JOB_START: 'job:start',
  JOB_PROGRESS: 'job:progress',
  JOB_DONE: 'job:done',
  JOB_ERROR: 'job:error',
  IDLE: 'idle',
  HEARTBEAT_OK: 'heartbeat:ok',
  HEARTBEAT_FAIL: 'heartbeat:fail',
  LEASE_RENEW: 'lease:renew',
  MODEL_LOADED: 'model:loaded',
  STOPPED: 'stopped',
} as const;
```

`JOB_DONE`'s payload carries a `submitted: boolean` flag (true once the result endpoint accepted the payload) and `JOB_ERROR`'s carries `willRetry: boolean` — both correct the v1.0 draft's simplified `{ durationMs }` / `{ error }` shapes.

### 9.3 Worker Daemon, systemd Service, and TUI Attach

This entire subsection is new relative to the v1.0 draft, which had no concept of a background/service mode — it was added mid-implementation as a product requirement: Oscar wanted a worker node to run as an always-on service on a household machine, not just as a foreground process tied to an open terminal.

**Daemon mode (`node start --daemon`).** `node start` always hosts two things alongside the `NodeEngine` itself: a pidfile at `~/.memoriahub/node.pid` and a Unix domain socket (named pipe on Windows) at `~/.memoriahub/node.sock`. Passing `--daemon` detaches the process into the background instead of blocking the foreground terminal; without it, `node start` runs the same engine + IPC host in the foreground (useful for watching logs directly, e.g. during first-time setup). A stale pidfile (dead PID) is removed automatically on the next start attempt; a live one refuses a second concurrent daemon.

**IPC protocol (`apps/cli/src/node/daemon.ts`, `apps/cli/src/node/ndjson.ts`).** The socket speaks one JSON object per line (NDJSON). Server → client frames: `{ kind: 'snapshot', ...EngineSnapshot }` (sent once on connect), `{ kind: 'log-tail', lines: string[] }` (recent log lines on connect), `{ kind: 'event', ev, payload, ts }` (every engine event, live), `{ kind: 'status', ...EngineSnapshot }` (reply to a status query), `{ kind: 'ack', cmd, ... }`, `{ kind: 'error', message }`. Client → server commands: `{ cmd: 'status' }`, `{ cmd: 'set-concurrency', value }`, `{ cmd: 'drain' }`, `{ cmd: 'stop' }`. This is how `node stop`, `node status`, `node set-concurrency`, and the TUI's attach mode (below) all talk to an already-running daemon without needing a second server-side round trip for every query.

**`node service install|uninstall|status`.** Writes/removes a systemd **user** unit (`~/.config/systemd/user/<unit>`, `ExecStart=<node> <cli-entry> node start`, `Restart=on-failure`, `RestartSec=5`) and drives it via `systemctl --user`. `install` also runs `daemon-reload` and `enable --now`, and reminds the operator that `loginctl enable-linger $USER` is needed to keep the service running after logout. On Windows, `service install` refuses immediately and points the operator at `node start --daemon` instead (systemd has no Windows equivalent). On WSL without a per-user systemd instance available (`systemctl --user show-environment` failing), it prints explicit guidance: enable systemd via `[boot]\nsystemd=true` in `/etc/wsl.conf` plus `wsl --shutdown` to restart the distro, or skip systemd entirely with `node start --daemon`.

**TUI attach mode (`apps/cli/src/tui/node-dashboard-source.ts`).** The `NodeDashboard` screen can render from two different sources, both feeding the same pure `reduceNodeEvent(state, ev, payload, now) → state` reducer over one `DashboardState` so the React component has exactly one update path regardless of where events originate:

- **Embedded:** no daemon is running; the dashboard owns an in-process `NodeEngine` directly (the original, pre-daemon behavior).
- **Attached:** a `node start --daemon` process is already running; a second CLI instance's TUI connects to its IPC socket, hydrates from the initial `snapshot` frame, and translates live `event` frames into the same state updates the embedded path would have produced.

This means an operator can leave a worker node running headless as a systemd service and still open the TUI at any time — from the same terminal or a fresh SSH session — to watch it live, without stopping or restarting the underlying engine.

**File logging and redaction (`apps/cli/src/node/logger.ts`).** JSONL logs are written to `~/.memoriahub/logs/node.log`, size-rotated at 5 MB (single-generation rollover to `node.log.1`), and readable via `node logs [-n <lines>] [--follow]`. Every log line is passed through `redactSensitive()` before being written: any field whose name matches `pat` (exact), or contains `token`/`api[-_]?key`/`secret`/`credential`/`password` (case-insensitive), is recursively replaced with `[REDACTED]` — so a PAT, a transient provider credential (§2.7), or a presigned URL query string can never land in a log file even by accident.

**Live-adjustable concurrency (`node set-concurrency <n>`).** When a daemon is running, this sends `{ cmd: 'set-concurrency', value: n }` over IPC and the engine's `setConcurrency()` applies the new cap starting with the next claim batch — no restart required. When no daemon is running, the value is persisted to local config for the next `node start`. The same control is exposed from the TUI's `NodeConfig` screen.

---

## 10. Doctor Coverage

This section extends both halves of the existing [Doctor Diagnostics](doctor.md) feature — the server-side admin sweep and a node-scoped CLI equivalent. The two halves ended up structurally different, and that difference is intentional (see the note at the end of §10.1): the server-side `nodes` section reuses `doctor.md`'s exact `DoctorReport` JSON shape (`key`/`label`/`status`/`message`/`actionItem?`/`durationMs`), because it is one more section folded into an existing structured report consumed by the admin web UI. `node doctor` is a CLI command whose audience is a human at a terminal, and it prints a plain-text report section by section rather than emitting that same JSON envelope.

### 10.1 CLI-Side: `node doctor`

`node doctor` (`apps/cli/src/commands/node.ts`'s `doctorCmd`) runs six sections in order, each backed by real code (not the "presence-only" checks originally proposed):

1. **API Access** (`apps/cli/src/node/doctor-checks.ts`'s `runApiAccessChecks`) — an actual `GET /api/auth/me` roundtrip (proves the PAT is valid and, since claim/renew/result/failure share the same `jobs:write` permission, implies those will authenticate too), whether the locally-configured node ID still resolves server-side (`nodeRegistrationOk`), and whether `GET /api/nodes/models/manifest` is reachable.
2. **Capabilities (installed)** — the existing presence-only probe from `apps/cli/src/node/capabilities.ts`'s `detectCapabilities()` (native module `require.resolve`, ffmpeg/ffprobe binary `-version` execution).
3. **Operational self-tests** (`apps/cli/src/node/self-test.ts`'s `runOperationalSelfTests`) — **new**, and the most significant upgrade from the original proposal: for every capability reported present in step 2, a REAL minimal operation is attempted, not just a presence check. `testSharp` decodes+encodes a tiny synthetic raw buffer; `testClip` loads the CLIP ONNX session and embeds a synthetic JPEG (only when the model file has already been downloaded — a missing model is reported as "not yet operational," not "broken," since models are fetched lazily); `testHuman` loads the face detector and runs detection on a synthetic JPEG (same lazy-model caveat); `testTesseract` inits and terminates an OCR worker (only when language data is present). ffmpeg/ffprobe are left as the existing binary-execution presence probe — generating a synthetic media asset to decode would add real complexity for a check that already executes the real binary, unlike a `require.resolve()` check. Every self-test has its own timeout and is wrapped in try/catch, so a broken native binary or a hung model load can never crash the doctor run. For a practical setup and troubleshooting walkthrough of each dependency, see [Worker Node Setup & Troubleshooting](../worker-node-setup.md).
4. **Job-type readiness** — for each of the node's configured (or, if unset, fully-supported) `eligibleTypes`, checks `missingRequirements(type, operationalCaps)` against the OPERATIONAL result from step 3, not mere presence from step 2 — so a node whose `sharp` binary resolves but crashes on first real use is correctly reported not-ready.
5. **Models** — downloads-and-verifies every entry in `GET /api/nodes/models/manifest` via `ensureModels()`, the same call `node start` makes.
6. **Daemon** (`apps/cli/src/node/doctor-checks.ts`'s `checkDaemonLiveness`) — **new**, and covers a health dimension the v1.0 draft had no concept of: is a `node start` process currently running on this machine (pidfile + a live IPC socket probe, with a quick snapshot if so), or is there a stale pidfile left behind by a crash. Informational only — a stopped daemon doesn't fail the overall doctor exit code, since "not currently running" isn't a problem with the machine's capabilities.

A failed check in steps 3–4 for a given job type keeps that type out of `eligibleTypes` — the same gating principle §7.3 describes, just implemented as a CLI text report (exit code 1 if any hard problem was found) rather than a `DoctorReport`-shaped JSON payload.

### 10.2 Server-Side: `nodes` Section on the Admin Doctor Sweep

`POST /api/admin/doctor/run` (see [doctor.md §7](doctor.md#7-api-endpoint-and-rbac)) has a `nodes` section (`apps/api/src/doctor/doctor.service.ts`), following the existing section/check shape used throughout the rest of the check catalog:

| Check key | Label | What it verifies | Failure → status + action item |
|-----------|-------|--------------------|----------------------------------|
| `nodes.registeredCount` | Registered nodes | Reports how many `worker_nodes` rows exist; `skipped` if zero (feature is simply unused, not misconfigured) | n/a — informational only |
| `nodes.heartbeatFreshness` | Heartbeat freshness | Any node with `status='online'` but `lastHeartbeatAt` older than the expected heartbeat interval | `warning` — one or more nodes have not reported in recently |
| `nodes.staleLeases` | Expired leases | Count of `enrichment_jobs` rows with `status='running'`, `executor='node'`, and `leaseExpiresAt` in the past, not yet reaped | `warning` — jobs will requeue automatically once the reaper runs |
| `nodes.capabilityHealth` | Node capability health | Aggregates each node's last-reported `capabilities`/`node doctor` summary into a per-node health signal | n/a / `warning` depending on findings |

**Correction from the v1.0 draft:** the fourth check's key is `nodes.capabilityHealth`, not `nodes.capabilitySummary`. This mirrors the existing `jobs.queueHealth` / `jobs.burstConfig` checks in doctor.md's Job Queue & Worker section in spirit — coarse, on-demand health signals rather than a full dashboard (this is not a replacement for a full per-node throughput dashboard).

---

## 11. Risks and Open Questions

This section is a candid accounting of what this design does not fully solve, in the same spirit as the "Operational Notes" and "Future Extension Ideas" sections of [enrichment-queue.md](enrichment-queue.md) and the "Gotchas and Implementation Notes" section of [doctor.md](doctor.md).

**A malicious or buggy node can submit a garbage result.** Nothing stops a compromised or simply buggy node from submitting a corrupted embedding, a nonsensical bounding box, or a broken thumbnail through `POST /api/nodes/:id/jobs/:jobId/result`. The zod `nodeResultSchema` validation described in §6/§6.1 is the concrete implementation of this defense — dimension checks on embeddings (where pinnable — see §6's note that face embedding length is intentionally NOT pinned, since it's provider-dependent), sane bounding-box ranges, decimal-string format on dHash — before persisting anything. This is a genuinely **new trust boundary**: an in-process handler's output was implicitly trusted because it ran inside the API's own process under the API's own code; a node's output is, by construction, produced by code and hardware the API does not control. Validation that used to be "defense against a bug" becomes "defense against a bug *or* a hostile actor," and should be reviewed with that shift in mind.

**Presigned URL exposure window.** A presigned GET or PUT URL is, by design, usable by anyone who has it — including someone who intercepts it in transit — for as long as it remains valid. HTTPS protects the URL in transit under normal circumstances, and the short TTL proposed in §2.5 bounds the exposure window, but this is worth stating plainly rather than glossing over: a presigned URL is a bearer credential for the duration of its validity, just a very short-lived one. This is the accepted tradeoff described in §2.5 in exchange for never issuing nodes a long-lived storage credential.

**Version skew between a node and the server.** A node running an older `cliVersion` — and therefore an older bundled model set — after the server-side model has been upgraded is the expected, not exceptional, case in a fleet where laptops update on their own schedule. The manifest-plus-hash-check mechanism (§7.3) prevents this from silently producing wrong embeddings: a stale node simply fails its local model-hash check and stops advertising the affected job type as eligible until the operator updates it. This is graceful degradation — reduced fleet capacity for that job type — not a hard failure, and it requires no manual intervention to detect, only to fix.

**Household network reliability.** Unlike the server, a laptop node has no uptime guarantee — it depends on being both physically awake and network-reachable. This means jobs claimed by nodes are structurally at higher risk of lease expiry and requeue churn than jobs the server's own in-process worker claims. Operators should expect some baseline rate of "job A got half-processed on a laptop that then went to sleep, and was requeued and finished by someone else" as a normal, not exceptional, occurrence of this feature — not a bug to chase.

**Shared provider quota (renamed from "AI-proxy quota sharing").** A node calling `auto_tagging` or `geocode` directly with its transient credential (§2.7, §8.2) burns the exact same rate-limited provider quota as the server's own jobs of those types — no separate quota is created or allocated per node. Nodes and the server worker are, from the provider's point of view, indistinguishable competitors for the same budget, and both are subject to the same rate-limit deferral path via the shared `ProviderRateLimitError` classification and `EnrichmentTerminalService` (§6, §6.1). Enabling these two job types on several nodes at once does not multiply available AI/geo throughput; it only changes which machine happens to be waiting on the shared quota at any given moment. Moving from an AI-proxy design to transient credentials (§2.7) does not change this risk at all — it was never about which side makes the HTTP call, only about how many concurrent callers share one provider-side budget.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | July 2026 | AI Assistant | Initial specification (proposal, pre-implementation) |
| 2.0 | July 2026 | AI Assistant | Brought current with the completed implementation on `feat/finish-nodes`: replaced the AI-proxy design with transient per-job credentials (§2.7, §8.2); corrected all endpoint paths to include `:id` and added `credentials`/`upload-url`/owner-list endpoints (§5); documented the actual zod-schema result contract, its extended fields, and the compute/persist handler split (§6, §6.1); documented the real `packages/enrichment-compute` shared package, its dual-build/pinned-deps/subpath-export structure, and the golden-vector test (§7.3); updated per-job-type status including the `video_face_detection`/`thumbnail_repair` gaps (§8); documented the worker daemon, systemd service mode, and TUI attach mode added mid-implementation as a product requirement (§9.3); corrected the CLI/server Doctor coverage to the actual six-section report and `nodes.capabilityHealth` key (§10) |
