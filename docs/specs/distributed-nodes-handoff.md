# Distributed Worker Nodes — Implementation Handoff & Continuation Plan

> **Purpose of this document.** The coordination, control-plane, UI, Doctor, and CLI
> surfaces of the distributed worker-nodes feature are **built, typecheck-verified, and
> pushed** on branch `claude/distributed-queue-cli-nodes-kudzja`. The remaining work — the
> **actual local model compute**, the **server result-ingestion + persist path**, the
> **shared parity package**, and **tests** — could NOT be built in the cloud session because
> that container cannot install the native model libraries (`onnxruntime-node`, `sharp`,
> `@tensorflow/tfjs`, `@vladmandic/human`, `tesseract.js` all network-fail on their binary
> downloads), has no Postgres, and no model files. This document is the complete recipe to
> finish and TEST the feature on a laptop that CAN run all of that.
>
> Read the full design first: [`docs/specs/distributed-nodes.md`](distributed-nodes.md).

---

## 0. TL;DR — the current end-to-end state

A node can **register, heartbeat, be seen in the web UI + Doctor, and safely claim/lease/
download jobs**. It CANNOT yet **complete** a job, because (a) the 8 CLI compute modules are
scaffolds that throw `CapabilityUnavailable`, and (b) the server has no result-ingestion
endpoint to persist a node's output. Closing those two gaps (plus the shared parity package
they both depend on) is the remaining core.

```
[✓] register → [✓] heartbeat → [✓] claim (atomic, leased) → [✓] presigned download
     → [✗] compute (SCAFFOLD)  → [✗] submit result (ENDPOINT NOT BUILT) → [✗] API persists
```

---

## 1. Laptop environment setup (do this first)

```bash
# 1. Clone + switch to the feature branch
git clone https://github.com/marinoscar/MemoriaHub.git
cd MemoriaHub
git checkout claude/distributed-queue-cli-nodes-kudzja

# 2. Install ALL deps WITH build scripts (this is the step the cloud container could not do)
npm install            # NOT --ignore-scripts — we WANT sharp/onnxruntime/tfjs to build

# 3. Bring up Postgres (pgvector image required) + apply the new migration
cp infra/compose/.env.example infra/compose/.env   # if not already present
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml up -d db
cd ../../apps/api
npm run prisma:migrate:dev        # applies 20260710000000_distributed_worker_nodes
npm run prisma:generate
npm run seed                      # or the repo's seed script, for an admin user

# 4. Required env (apps/api / infra/compose/.env)
#    - SECRETS_ENCRYPTION_KEY  (openssl rand -base64 32)
#    - JWT_SECRET, GOOGLE_CLIENT_ID/SECRET, INITIAL_ADMIN_EMAIL
#    - ENRICHMENT_LEASE_MS=1800000 (optional; default 30 min)
#    - MODELS_DIR=./data/models    (server-side model dir; nodes use ~/.memoriahub/models)

# 5. Start the API (server worker enabled by default)
npm run start:dev
```

**Verify the baseline before writing code:**
```bash
cd apps/api && npx tsc --noEmit    # ignore the single @types/jest error if present
cd apps/cli && npm run typecheck   # should be 0
cd apps/cli && npm run build && node dist/index.js node doctor   # after `memoriahub login`
```

> **Note on `@types/jest`:** the cloud container had a corrupted `@types/jest` producing one
> unrelated `'*/' expected` error. A clean `npm install` on your laptop should not have it. If
> it appears, `npm i -D @types/jest@latest -w apps/api`.

---

## 2. What is DONE (verified, on the branch)

All 9 commits after `357497a`. Each was typecheck-gated.

| Commit | What it delivers | Key files |
|--------|------------------|-----------|
| `docs(docs)` spec | Full design contract | `docs/specs/distributed-nodes.md` |
| `feat(db)` | `worker_nodes` table, `enrichment_jobs.claimed_by_node_id/lease_expires_at/executor`, migration | `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260710000000_distributed_worker_nodes/` |
| `fix(enrichment)` | **DB-atomic `FOR UPDATE SKIP LOCKED` claim** + lease reaper (also fixes a latent double-claim bug) | `apps/api/src/enrichment/enrichment-claim.service.ts`, `enrichment-job.worker.ts`, `enrichment-admin.service.ts` |
| `feat(api)` control | Node data-plane: register/deregister/heartbeat/claim/renew + model manifest; admin list/delete; jobs list now returns `executor`+`claimedByNode` | `apps/api/src/nodes/` (`nodes.service.ts`, `nodes.controller.ts`, `nodes-admin.controller.ts`, `node-ownership.guard.ts`, `nodes.module.ts`) |
| `feat(web)` | Workers-health page `/admin/settings/nodes` + "Node" column on the Job Queue | `apps/web/src/pages/Admin/WorkersPage.tsx`, `services/workers.ts`, `hooks/useWorkers.ts`, `pages/Admin/JobsPage.tsx`, `services/jobs.ts`, `App.tsx`, `SettingsHubPage.tsx`, `Sidebar.tsx` |
| `feat(api)` doctor | Doctor "Worker Nodes" section: registered nodes, heartbeat freshness, expired leases, per-node capability health | `apps/api/src/.../doctor.service.ts` (search `nodes` section) |
| `feat(cli)` engine | `node register/start/stop/status/list/doctor`; event-driven claim→download→compute→submit engine; capability detection; model manager; config | `apps/cli/src/commands/node.ts`, `apps/cli/src/node/*` (`node-engine.ts`, `node-events.ts`, `capabilities.ts`, `models.ts`, `download.ts`, `compute/*`), `api.ts`, `config.ts`, `paths.ts` |
| `feat(cli)` TUI | Tools ▸ Worker Node: live `NodeDashboard` + `NodeConfig` | `apps/cli/src/tui/NodeDashboard.tsx`, `NodeConfig.tsx`, `menu-config.ts`, `app.tsx` |
| `docs` | CLAUDE.md updated | `CLAUDE.md` |

**Contracts already frozen** (do not change without updating both sides):
- Claim: `EnrichmentClaimService.claim({ nodeId, executor, eligibleTypes, limit, leaseMs }) → EnrichmentJob[]` (aliased `$queryRaw` RETURNING).
- Node claim response: `{ jobs: [{ job, inputUrl, params }] }` — `inputUrl` is a presigned GET for the ORIGINAL bytes (null when `mediaItemId` is null).
- Model manifest: `GET /api/nodes/models/manifest → [{ name, url, sha256, bytes, targetSubdir }]` (sha256/bytes currently `null` — TODO, see §4.G).
- CLI engine events: `claimed, job:start, job:progress, job:done, job:error, idle, heartbeat:ok, heartbeat:fail, lease:renew, model:loaded, stopped`.

---

## 3. The parity constraint (read before writing ANY compute)

A face/CLIP embedding computed on the laptop MUST be numerically comparable to one from the
server, or faces won't cluster and duplicates won't match. The server's exact pipelines:

**Face — `apps/api/src/face/providers/human.provider.ts`:**
- Libs: `@tensorflow/tfjs` + `@tensorflow/tfjs-backend-wasm` + `@vladmandic/human` (WASM, NOT onnx).
- Models: `blazeface-back.json` (detector) + `faceres.json` (description) under
  `FACE_HUMAN_MODEL_PATH` (default `/app/models/human`).
- Pipeline: `prepareImageForProcessing(buffer, {maxDim: FACE_MAX_IMAGE_DIM=2000})` (sharp,
  applies EXIF orientation, JPEG q90) → `bufferToTensor` (sharp ensureAlpha → raw RGBA →
  `tf.tensor3d`) → `human.detect` → box normalized `/width,/height` → **L2-normalized 1024-d**
  faceres descriptor. Two load-bearing hacks: the **fs-backed IOHandler** and
  **`patchFaceresEmbeddingOutput`** (faceres.json's graph doesn't declare the embedding as an
  output; the patch exposes it). `providerKey='human'`, `modelVersion='human-faceres-1024'`.

**CLIP dedup — `apps/api/src/dedup/visual-embedding.service.ts`:**
- Lib: `onnxruntime-node`. Model `clip-vit-b32-vision-quantized.onnx` (~87 MB) from
  `https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx`.
- Pipeline: `preprocessImageForClip(buffer)` (`prepareImageForProcessing` → sharp resize 224
  `fit:fill` removeAlpha raw → CHW normalize with CLIP mean/std) → `session.run` → **L2-normalized
  512-d**. Tag `VISUAL_EMBEDDING_MODEL_TAG='clip-vit-b32-q8'`.

**Both** start with `prepareImageForProcessing`
(`apps/api/src/storage/processing/image-orientation.util.ts`) — the single most important
shared primitive. **Pin the same `sharp`/libvips version in the shared package**: a different
libvips build re-encodes JPEG bytes differently → different tensors → different vectors.

---

## 4. What REMAINS — ordered, concrete tasks

Do them in this order; each has an acceptance check. Respect the mandatory-subagent rules
(`database-dev`/`backend-dev`/`frontend-dev`/`testing-dev`/`docs-dev`) and Conventional Commits.

### A. Shared parity package `packages/enrichment-compute` (backend-dev)
The linchpin. One package, imported IDENTICALLY by API and CLI, with **pinned** native deps.
1. `git mv`/create `packages/enrichment-compute/` and add `"packages/*"` to root
   `package.json` `workspaces`. Use NodeNext + a `package.json` with pinned
   `sharp`, `onnxruntime-node`, `@tensorflow/tfjs`, `@tensorflow/tfjs-backend-wasm`,
   `@vladmandic/human`, `tesseract.js`.
2. Move the PURE compute out of the API services into the package and re-export from the API so
   existing imports keep working (behavior-preserving — API tests must stay green):
   - `prepareImageForProcessing` + orientation utils (`image-orientation.util.ts`).
   - CLIP: `preprocessImageForClip`, `l2Normalize`, `VISUAL_EMBEDDING_MODEL_TAG`, the ONNX
     `embedImage(buffer): Promise<number[512]>` (split it out of `ensureEmbedding`'s persist).
   - Human: `humanConfig`, the fs IOHandler, `patchFaceresEmbeddingOutput`, `bufferToTensor`,
     `l2Normalize`, `detectFaces(buffer): Promise<{box, confidence, embedding[1024]}[]>`.
   - dHash, OCR (tesseract) core, ffprobe/metadata helpers.
3. **Acceptance:** `cd apps/api && npx tsc --noEmit` clean; `npm test` in apps/api green;
   `node -e "require('@memoriahub/enrichment-compute')"` loads.

### B. Compute/persist split in API handlers (backend-dev)
For each node-eligible type, split the service into `compute*(buffer, params) → ResultDto`
(pure, delegates to the package) and `persist*(job, ResultDto)` (Prisma writes, server-only).
Canonical reference is already shaped this way:
`apps/api/src/face/face-detection.service.ts` — steps 4–6+normalize (`download → prepare →
detect → normalize`) become `computeFaces`; steps 7–10 (`deleteMany` non-manual →
`core.persistAndMatchFaces` → `core.markStatus`) become `persistFaces`. Repeat for
`dedup/visual-embedding.service.ts`, `metadata/metadata.service.ts`,
`social-media/social-media-ocr.service.ts`, `media/thumbnail-regen.handler.ts` /
`thumbnail-repair.handler.ts`.
- **Acceptance:** server-executed jobs still work end-to-end (upload a photo, face/dedup/tag
  run as before); tests green.

### C. Server result-ingestion + fail + AI-proxy endpoints (backend-dev)
Add to `apps/api/src/nodes/` (currently omitted — the CLI already calls them optimistically):
- `POST /nodes/:id/jobs/:jobId/result` body `{ type, result }` — guard
  `claimedByNodeId===id && status==='running' && lease not expired` (reject a late result from
  a reaped node → prevents double-persist), dispatch to the type's `persist*`, then write
  terminal `succeeded` (reuse the worker's `safeTerminalUpdate` + JobStatsRollup fold).
- `POST /nodes/:id/jobs/:jobId/fail` body `{ message, rateLimited?, retryAfterMs? }` — run the
  SAME failure branch as `EnrichmentJobWorker.processJob` (normal retry vs rate-limit deferral
  via `computeQueueBackoffMs`), clearing claim fields.
- `POST /nodes/:id/proxy/auto-tagging` and `/proxy/geocode` — node sends prepared input; API
  calls the keyed provider (reuse `AutoTaggingService`/`GeocodeService` + `ProviderThrottleService`)
  and returns the raw provider result for the node to normalize + submit via `/result`.
- **Result contract DTOs** (zod) in `apps/api/src/nodes/dto/compute-result.dto.ts`, mirrored in
  the shared package. See [`distributed-nodes.md` §6](distributed-nodes.md) for the per-type shapes:
  face `{modelVersion,providerKey,imageW,imageH,faces:[{boundingBox,confidence?,embedding[1024]}]}`;
  dedup `{model,embedding[512],dHash}`; metadata `{exif,probe}`; social `{verdict,score,ocrText}`;
  thumbnails → node uploads bytes via the EXISTING `storage/objects/:id/upload/*` presigned PUT,
  then submits `{storageKey,width,height,bytes}`; auto_tagging/geocode via proxy.
- **Acceptance:** integration test posts a canned ResultDto → row goes `succeeded`, DB reflects it.

### D. Implement the 8 CLI compute modules (CLI)
Replace the scaffolds in `apps/cli/src/node/compute/*` with real calls into
`@memoriahub/enrichment-compute` (add it as a CLI dependency). Each module:
download already done by the engine → run the shared compute → return the ResultDto the engine
submits. **Must process ORIGINAL bytes and run the identical `prepareImageForProcessing` first.**
Thumbnails: generate bytes, upload via the existing presigned-PUT flow (`ApiClient.putRaw` +
`storage/objects/:id/upload/*`), submit the storage key.
- **Acceptance:** `memoriahub node doctor` reports all capabilities OK; a claimed
  `duplicate_detection` job produces a 512-d vector; a `face_detection` job produces 1024-d faces.

### E. `GET /api/nodes` + `GET /api/nodes/:id` owner self-list (backend-dev)
The CLI `node list`/`status` call these optimistically and currently fall back to local config
on 403/404. Add owner-scoped read endpoints so they work without admin.

### F. Model manifest real hashes (backend-dev)
`nodes.service.ts getModelManifest()` returns `sha256:null, bytes:null`. Fill real values so the
CLI `models.ts` verification + `node doctor` hash self-check are meaningful (download each model
once, `sha256sum`, record). This is the anti-drift guard for parity.

### G. Tests (testing-dev)
- **Claim concurrency:** two concurrent `EnrichmentClaimService.claim` callers on one pending
  row → exactly one wins (needs a real/test Postgres; `FOR UPDATE SKIP LOCKED` can't be unit-mocked).
- **Lease reaper:** expired-lease running job → requeued (or failed if attempts exhausted).
- **Golden-vector parity:** a fixed fixture image through the shared package → stored golden
  512-d / 1024-d vectors within float tolerance. **This is the regression guard for the whole feature.**
- **Node engine loop:** mocked `ApiClient` → claim→compute→submit happy path + failure path.
- Node-auth ownership guard; each `persist*` given a canned ResultDto.

---

## 5. End-to-end test plan (two machines, or two terminals)

1. **Server:** `apps/api` running against Postgres, an admin user seeded, storage provider
   configured (local disk is fine for testing), and the relevant feature flags ON in Admin
   Settings (`features.faceRecognition`, `features.duplicateDetection`, etc.).
2. **Node:** `cd apps/cli && npm run build`, then:
   ```bash
   node dist/index.js login                 # device flow → PAT
   node dist/index.js node doctor           # all capabilities OK, models present
   node dist/index.js node register --name laptop-A --concurrency 2 \
        --types face_detection,duplicate_detection,thumbnail_regen,metadata
   node dist/index.js node start --concurrency 2
   #   ...or launch the TUI: node dist/index.js  → Tools ▸ Worker Node ▸ Node dashboard → press s
   ```
3. **Drive work:** upload a batch of photos (via web or `memoriahub import`). With
   `ENRICHMENT_WORKER_CONCURRENCY=1` on the server, most jobs should be claimed by the node
   (watch `executor='node'`).
4. **Verify in the web UI:** `/admin/settings/jobs` → the **Node** column shows `laptop-A` for
   node-run jobs and "server" for the one the server ran. `/admin/settings/nodes` shows laptop-A
   **online** with a fresh heartbeat and rising succeeded counts.
5. **Parity check:** confirm a face detected on the node assigns to the SAME Person as one the
   server detected (cluster them); confirm a duplicate pair the node embedded is grouped.
6. **Resilience:** `kill -9` the node mid-job → its lease expires → the reaper (or
   `POST /api/admin/jobs/reset-stuck`) requeues the job → the server or another node finishes it
   → the node flips to **offline/stale** in the UI and Doctor.
7. **Doctor:** `POST /api/admin/doctor/run` → the **Worker Nodes** section reports registered
   count, heartbeat freshness, 0 expired leases, and each node's capability health.

**Topology you wanted:** `ENRICHMENT_WORKER_CONCURRENCY=1` on the server, `--concurrency 2` on
each laptop → 1 server + 2 + 2 = 5 concurrent workers, all coordinated safely by the atomic claim.

---

## 6. Gotchas & risks (learned / by design)

- **Parity is the #1 risk.** Pin `sharp`/libvips + `onnxruntime-node` + `tfjs*` + `human` to ONE
  version in the shared package. Use the API-served manifest sha256 + the CLI startup hash
  self-check + the golden-vector test as the safety net. Every row records
  `modelVersion`/`providerKey` so a mismatch is traceable and re-runnable.
- **`attempts` is charged at CLAIM time** — the reaper must FAIL (not requeue) a lease-expired
  job once `attempts >= ENRICHMENT_MAX_ATTEMPTS`, else a poison job crash-loops. (Already handled
  in `resetStuck`; preserve it.)
- **Late result after reap** — the `/result` endpoint MUST reject when the job is no longer
  claimed by that node / lease expired, or you double-persist.
- **`ENRICHMENT_LEASE_MS` (30 min)** must stay comfortably above the longest job (video: 20 min
  timeout). The node renews the lease during long jobs via `POST /nodes/:id/jobs/:jobId/renew`.
- **No storage creds on the node** — keep all byte transfer on presigned URLs (download GET,
  thumbnail upload PUT). Never add an S3 client to the CLI.
- **AI-proxy types (auto_tagging/geocode)** offload little server CPU (the cost is the external
  provider call the API still makes). Treat them as server-preferred / opt-in.
- **pgvector required** — the DB must be the `pgvector/pgvector:pg16` image for the 512-d/1024-d
  embedding columns and KNN.

---

## 7. Quick file map

| Role | Path |
|------|------|
| Design spec | `docs/specs/distributed-nodes.md` |
| Schema + migration | `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260710000000_distributed_worker_nodes/` |
| Atomic claim (shared) | `apps/api/src/enrichment/enrichment-claim.service.ts` |
| Worker (uses claim) | `apps/api/src/enrichment/enrichment-job.worker.ts` |
| Lease reaper | `apps/api/src/enrichment/enrichment-admin.service.ts` (`resetStuck`/`stuckRunningWhere`) |
| Node API | `apps/api/src/nodes/` |
| Doctor nodes section | `apps/api/src/.../doctor.service.ts` |
| Parity sources to extract | `apps/api/src/face/providers/human.provider.ts`, `apps/api/src/dedup/visual-embedding.service.ts`, `apps/api/src/storage/processing/image-orientation.util.ts` |
| Compute/persist split ref | `apps/api/src/face/face-detection.service.ts` |
| Web UI | `apps/web/src/pages/Admin/WorkersPage.tsx`, `apps/web/src/pages/Admin/JobsPage.tsx` |
| CLI node engine | `apps/cli/src/node/node-engine.ts` |
| CLI compute scaffolds (implement) | `apps/cli/src/node/compute/*` |
| CLI TUI | `apps/cli/src/tui/NodeDashboard.tsx`, `NodeConfig.tsx` |

---

## 8. Remaining-work checklist

- [ ] A. `packages/enrichment-compute` shared package (pinned native deps) + API re-exports
- [ ] B. compute/persist split of the eligible API handlers
- [ ] C. `POST /nodes/:id/jobs/:jobId/result` + `/fail` + `/proxy/*` + result DTOs
- [ ] D. implement the 8 CLI compute modules against the shared package
- [ ] E. `GET /api/nodes` + `GET /api/nodes/:id` owner self-list
- [ ] F. real sha256/bytes in the model manifest
- [ ] G. tests: claim concurrency, lease reaper, golden-vector parity, node loop
- [ ] End-to-end run per §5 (server + 2 laptop nodes), verify parity + resilience
- [ ] Bump `apps/cli/package.json` patch version per feature + `npm install --package-lock-only`
