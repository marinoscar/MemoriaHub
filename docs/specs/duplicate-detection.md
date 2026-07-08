# Near-Duplicate Detection — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.1 |
| **Last Updated** | July 2026 |
| **Status** | Specification (backend complete; UI not yet implemented) |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Detection Engine](#2-detection-engine)
3. [Grouping, Burst Overlap, and Read-Time Classification](#3-grouping-burst-overlap-and-read-time-classification)
4. [Visual Embedding Model Lifecycle](#4-visual-embedding-model-lifecycle)
5. [Data Model](#5-data-model)
6. [Processing and Enrichment Flow](#6-processing-and-enrichment-flow)
7. [Database Footprint and Data Lifecycle](#7-database-footprint-and-data-lifecycle)
8. [Configuration](#8-configuration)
9. [API Endpoints](#9-api-endpoints)
10. [RBAC](#10-rbac)
11. [UI](#11-ui)
12. [Security and Privacy](#12-security-and-privacy)
13. [Testing Notes](#13-testing-notes)
14. [Future Work](#14-future-work)

---

## 1. Overview and Goals

### The problem: WhatsApp re-shares and other lossy re-uploads

A common way photos re-enter a family circle is a re-share: someone forwards a photo through WhatsApp, Telegram, or a similar app, then uploads the resulting file to their circle. The re-shared copy is **not byte-identical** to the original:

- It has been **recompressed** at a lower JPEG quality by the messaging app.
- It is often **resized** to a smaller resolution.
- It may have a **different filename** and little or no surviving EXIF (messaging apps routinely strip metadata).
- It may have a **filter or crop** applied before forwarding.

Two mechanisms already in MemoriaHub cannot catch this class of duplicate:

- **`contentHash` exact-match dedup** (enforced at upload via the `(circle_id, content_hash)` unique index) only blocks byte-for-byte identical files. A recompressed copy has a completely different SHA-256 hash and sails through.
- **Burst detection** (`docs/specs/burst-detection.md`) links photos by *same-device temporal proximity* (default ≤10 s) plus a tight perceptual-hash distance. A WhatsApp re-share was captured on a different device (or at a completely different time — it might be re-shared years later) and carries no usable capture-time relationship to the original. Burst detection's window-based matching structurally cannot find it.

Near-duplicate detection closes this gap: it compares photos **purely on visual content**, independent of device, capture time, filename, or EXIF survival, and surfaces clusters of visually-identical photos in a review queue so a human can pick the keeper and archive or trash the rest. Like burst detection, it is **non-destructive by design** — nothing is deleted until a human confirms.

### Goals

- Detect near-duplicate photos regardless of device, capture time, compression, or resolution differences.
- Operate as a global feature toggle (`features.duplicateDetection`, default off), consistent with face recognition, auto-tagging, and burst detection.
- Run entirely on-server: the visual-similarity model is a local ONNX inference session, not a cloud API call.
- Run as an enrichment job on the existing `enrichment_jobs` queue to inherit retries, observability, and the admin jobs dashboard.
- Scale to backfilling a library of several thousand existing photos without exceeding the enrichment worker's stuck-job reset threshold.
- Degrade gracefully: if the visual-embedding model cannot be loaded (missing file, corrupt download, unsupported platform), the feature keeps working using perceptual hash alone rather than failing jobs.

### Non-Goals

- **Auto-deletion.** The system suggests groups; a human confirms which items to keep before anything is archived or trashed.
- **Cross-photo semantic similarity** (e.g. "two different photos of the same person"). This is a *visual near-duplicate* detector, not a content-understanding one — the existing 1536-d text embedding (description + tags + people names, `media_item_embedding`) is the wrong tool here for the same reason it is wrong for burst detection: it is semantic, not visual.
- **Video duplicate detection.** Only `MediaType.photo` items are processed.
- **Cross-circle detection.** Groups are strictly circle-scoped, matching every other review-queue feature in the app.
- **Overlap with burst detection's job.** Burst detection stays responsible for same-device rapid-fire sequences; duplicate detection is responsible for everything else. Section 3.2 documents the explicit hand-off rules between the two features so a photo is never fought over by both review queues at once.

---

## 2. Detection Engine

Two independent signals are combined with an **OR** link rule — either signal alone is sufficient to link two photos as duplicates.

### 2.1 Tier 1 — CLIP Visual Embedding (Cosine Similarity)

Each photo is encoded into a 512-dimensional vector using the vision tower of **CLIP ViT-B/32** (`Xenova/clip-vit-base-patch32`), int8-quantized to an ONNX file, run in-process via `onnxruntime-node`. This is the same architectural pattern already used for the `human` WASM face-recognition provider: an ML model runs inside the API process, no bytes leave the server, no per-call cloud cost.

Two photos are linked by this tier when the cosine similarity of their embeddings is **≥ `dedup.similarityThreshold`** (default `0.96`). CLIP embeddings are semantically/visually robust to JPEG recompression, resizing, and moderate color/filter adjustments — exactly the transformations a WhatsApp re-share applies — which is why this tier catches duplicates that hash-based matching alone would miss.

Candidates for this tier are found via a **pgvector HNSW cosine KNN query** scoped to the circle (`ORDER BY embedding <=> subject_embedding LIMIT dedup.knnCandidates`, default 20 candidates), not a full circle scan — this keeps per-item matching cost bounded regardless of library size.

### 2.2 Tier 2 — dHash Hamming Distance

Every photo already carries a 64-bit perceptual hash (`MediaItem.perceptualHash`, computed by the `visual-hash` storage processor introduced for burst detection — see `docs/specs/burst-detection.md` §4.2/§5.1). Duplicate detection reuses this hash rather than computing a second one.

Two photos are linked by this tier when their Hamming distance is **≤ `dedup.hashMaxDistance`** (default `6` of 64 bits — noticeably stricter than burst detection's default of 10, because duplicate detection has no temporal-proximity signal to lean on and must rely on the hash alone being highly discriminating). Candidates for this tier are found via a circle-scoped table scan using the `(circle_id, perceptual_hash)` index, computed in application code with the same `hammingDistance` helper burst detection uses (re-exported from `BurstDetectionService` so both features share one implementation, never two hand-written copies that could drift).

### 2.3 Why Two Tiers, Not One

- The CLIP tier is the primary signal: it is robust to recompression/resize/filter and catches the WhatsApp scenario directly.
- The dHash tier is the **degraded-mode fallback**: if the CLIP model cannot be loaded (see §4), the CLIP KNN query naturally returns zero candidates (its inner join against the subject's own — nonexistent — embedding row yields nothing), and hash-only matching keeps the feature functional, just less resilient to heavy recompression.
- Neither tier is throttled by the enrichment queue's per-provider rate-limit gate — both run entirely local, in-process compute with no external API quota to respect.

### 2.4 What Is Deliberately Not Used

- **`contentHash`** — already enforced as a hard uniqueness constraint at upload time; a photo with a duplicate `contentHash` in the same circle is rejected before it is even created, so there is nothing left for this feature to catch at that level.
- **The 1536-d text embedding** (`media_item_embedding`) — semantic (description/tags/people), not visual; two photos with a similar caption but completely different pixels would incorrectly match if this were used.

---

## 3. Grouping, Burst Overlap, and Read-Time Classification

### 3.1 Union-Find Grouping

Group membership is resolved with the same **greedy union-find create/join/merge-into-oldest** approach as `BurstDetectionService` (`apps/api/src/burst/burst-detection.service.ts`), implemented in `DuplicateDetectionService.processMediaItem` (`apps/api/src/dedup/duplicate-detection.service.ts`):

1. Run both tiers to build a candidate ID set (Tier 1 KNN rows above `similarityThreshold`, unioned with Tier 2 hash matches within `hashMaxDistance`).
2. Load each candidate's current `duplicateGroupId`.
3. **No existing group among candidates:** create a new `DuplicateGroup` (`status = pending`), assign the subject and all candidates to it, set `mediaCount`.
4. **Candidates belong to exactly one existing group:** assign the subject to that group.
5. **Candidates span multiple existing groups:** merge all of them into the oldest (by `createdAt`), reassigning every member and deleting the now-empty groups.
6. Recompute the group's `mediaCount` and its `capturedAt` (earliest active member's capture time, used for chronological queue ordering — mirrors `burst_groups.capturedAt`).

If no candidates are found for an item, nothing is created or modified — `duplicateGroupId` stays null.

**Idempotency:** re-running `processMediaItem` for an already-grouped item is a no-op beyond recomputing `mediaCount`/`capturedAt` — this is what makes the chunked batch handler's retry-the-whole-chunk-on-partial-failure strategy safe (§6.2).

### 3.2 Burst-Overlap Exclusion Rules

Burst detection and duplicate detection both operate on photos, both maintain a review-queue group, and both can in principle claim the same pair of photos. To keep the two features from fighting over the same items, three explicit rules are enforced in `DuplicateDetectionService.processMediaItem`:

1. **An item currently in a *pending* burst group is skipped entirely.** `processMediaItem` returns immediately without running either matching tier for that item. Burst review may soft-delete or reshuffle that group's members at any time; running dedup concurrently against a still-mutable burst group would produce matches that are invalidated moments later.
2. **Candidates that belong to any *pending* burst group are excluded** from both the KNN and hash candidate queries (`NOT EXISTS (SELECT 1 FROM burst_groups bg WHERE bg.id = m.burst_group_id AND bg.status = 'pending')`), even when the *subject* itself isn't in a burst group. A photo can't be pulled into a duplicate group while it is still an unreviewed burst candidate.
3. **Two items that share the same `burstGroupId` are never linked to each other**, regardless of that burst group's status. This matters after a burst group is *resolved*: `BurstService.resolveBurstGroup` soft-deletes the non-kept members but does **not** clear `burstGroupId` on the kept ones, so surviving siblings from the same burst still share a `burstGroupId`. They are assumed to already be a deliberate, reviewed keep-set from the same shooting moment and are not re-litigated by the duplicate-detection queue.

When a burst group transitions out of `pending` (resolved or dismissed), its members become eligible for duplicate matching again. `BurstService` re-enqueues a `duplicate_detection` job (priority 10, reason `rerun`) for the affected items immediately after the transition:

- **On resolve:** for the `keepIds` (survivors) — they were excluded from dedup matching while the group was pending review.
- **On dismiss:** for *all* members — `dismissBurstGroup` clears `burstGroupId` to null on every member, so all of them become eligible.

**Closing the ordering race — eviction ("burst wins").** The three rules above only prevent overlap when burst detection groups an item *before* duplicate detection runs against it. Both `burst_detection` and `duplicate_detection` are enqueued together at upload time (`MediaEnrichmentService.enqueueUploadEnrichment`), so the enrichment worker can just as easily process them in the opposite order: `duplicate_detection` runs first while the item has no `burstGroupId` yet, links it into a `DuplicateGroup`, and only afterward does `burst_detection` group the same item into a `BurstGroup` — leaving the photo visible in both review queues at once.

This ordering race is closed by making burst detection **actively evict** its own group's members from any duplicate group, rather than relying solely on the candidate-exclusion rules above:

- **`DuplicateDetectionService.evictFromDuplicateGroups(itemIds: string[])`** — for the given items, clears `duplicateGroupId` to null and recomputes/cleans every duplicate group that lost a member. Idempotent: items with a null `duplicateGroupId` are no-ops.
- **`recomputeGroupMeta`** (the same private helper used after every membership change in §3.1) now also deletes a duplicate group when eviction shrinks it below the `mediaCount >= 2` invariant — including the single-remaining-member case, which additionally clears that member's `duplicateGroupId` before the group row is deleted (a 1-member duplicate group is meaningless).
- **`BurstDetectionService.processMediaItem`**, after assigning an item to a burst group and recomputing burst scores (§5, Step 6 in [burst-detection.md](burst-detection.md)), loads every current member of that burst group and calls `evictFromDuplicateGroups` on all of them — covering both the item just processed and any pre-existing group members that were dedup'd before this item arrived to trigger the burst grouping. This runs uniformly across the create/join/merge branches. **Best-effort:** the call is wrapped in try/catch; a failure is logged as a warning but never fails the burst job.
- **`DuplicateDetectionService.evictExistingBurstOverlaps(circleId?: string)`** — one-time remediation for photos that were already double-listed in both queues before this fix existed (uploads processed during the old ordering-race window). Finds every media item that is simultaneously in a *pending* burst group and in a duplicate group (optionally scoped to one circle), evicts them via `evictFromDuplicateGroups`, and returns `{ evicted: number }`.

`POST /api/admin/bursts/backfill` (see [burst-detection.md §7.3](burst-detection.md#73-global-backfill-admin)) now runs `evictExistingBurstOverlaps()` app-wide as a post-step after enqueueing backfill jobs, so a single admin-triggered scan both catches up any un-fingerprinted legacy photos and heals existing overlap. Its response gained a new field: `{ "data": { "enqueued": 312, "circles": 4, "evictedDuplicateOverlaps": 5 } }`.

Net effect: burst membership always wins. An item that lands in a burst group — whether it got there before or after duplicate detection ran — is guaranteed not to remain in a duplicate group at the same time.

### 3.3 Best-Copy Scoring (Read-Time)

Unlike burst detection, where `burstScore` is written to the `media_items` row when a group is updated, duplicate-group scoring is **computed at read time** by `DuplicateService` (`apps/api/src/dedup/duplicate.service.ts`) whenever a group is listed or fetched, and never persisted to a column. Only `suggestedBestItemId` on `DuplicateGroup` is opportunistically written back as a best-effort cache when it changes.

```
qualityScore = 0.35 · normalize(width × height)
             + 0.30 · (exifRichness / 3)
             + 0.20 · normalize(sharpnessScore)
             + 0.15 · normalize(fileSizeBytes)
```

- `normalize(x)` maps each member's value to `[0, 1]` within the group (min–max scaling); when every member has an equal value, all receive `0.5` (same convention as `BurstDetectionService.normalize`).
- `exifRichness` (0–3) counts: has `capturedAt`, has GPS (`takenLat`/`takenLng` both non-null), has camera info (`cameraMake` or `cameraModel` non-null). Original photos with intact EXIF outscore recompressed re-shares whose EXIF was stripped — exactly the WhatsApp scenario this feature targets.
- `sharpnessScore` reuses the Laplacian-variance value already computed by the `visual-hash` processor for burst detection — no additional computation.
- `fileSizeBytes` comes from the linked `StorageObject.size`; a recompressed copy is typically smaller than the original at equal or lower resolution.

The member with the highest `qualityScore` becomes `suggestedBestItemId` and is pre-selected as the keep candidate in the group detail response.

### 3.4 Kind Classification

Also computed at read time (never persisted), `DuplicateService.computeGroupKind` assigns one of three labels to each group:

| Kind | Rule | Meaning |
|------|------|---------|
| `exact_variant` | max pairwise CLIP cosine similarity across all members ≥ `0.99` **AND** min pairwise Hamming distance ≤ `2` | Resize/recompress of the exact same shot — no meaningful visual change |
| `edited` | matched the group (met the linking threshold) but members diverge — different pixel dimensions across members, **or** min Hamming distance > `2` | A real edit occurred between otherwise-matching photos: crop, filter, or heavier recompression |
| `similar` | everything else that met the matching threshold | Catch-all for groups that linked but don't cleanly fit either bucket above |

This classification, along with the `similarityToBest` value returned per member in the group-detail response (cosine similarity of each member's embedding against the suggested-best member's), was informed directly by user feedback on **immich Discussion #25831** — the most-requested improvements to immich's own duplicate-detection UX were (a) not mixing exact recompressed copies together with loosely-related "similar" photos in one undifferentiated list, and (b) showing *why* a group was linked instead of hiding the similarity score from the reviewer. `kind` badges (queryable via `GET /api/media/duplicates?kind=`) and the exposed `similarityToBest` field address both points directly.

---

## 4. Visual Embedding Model Lifecycle

`VisualEmbeddingService` (`apps/api/src/dedup/visual-embedding.service.ts`) owns the CLIP model file and the ONNX inference session end-to-end.

### 4.1 Model Distribution

The model is **never bundled in the Docker image**. It is downloaded on first use from the Hugging Face CDN:

```
https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx
```

- **`MODELS_DIR`** (default `./data/models`) is the persistent-volume directory the model is written to; mount it as a Docker volume so the ~87 MB download survives container restarts and redeploys.
- `ensureModel()` first checks whether the file already exists at `MODELS_DIR/clip-vit-b32-vision-quantized.onnx`; if so, it is used as-is with no re-download or re-verification.
- On first download, the response is size-checked (must exceed 50 MB — the quantized vision tower is ~87 MB; a truncated download or an HTML error page would be far smaller) and sanity-checked against ONNX's protobuf leading-byte convention (`buffer[0] === 0x08`, see `looksLikeOnnxModel`). This is a heuristic, not a cryptographic checksum — a pinned SHA-256 was deliberately rejected because Hugging Face may re-quantize the file over time and a hardcoded hash would silently break air-gapped deployments that can't refresh it. Combined with the size check and the fact that `InferenceSession.create()` itself throws on a genuinely corrupt file, this is judged sufficient.
- The download is written to a temp file in the **same directory** (`.{filename}.{uuid}.tmp`) and atomically renamed into place, so a crash mid-download never leaves a partially-written file at the real path.

**Air-gapped / offline installs:** place the model file manually at `MODELS_DIR/clip-vit-b32-vision-quantized.onnx` before starting the API (matching the exact filename `ensureModel()` checks for). No network access is required at runtime once the file is present — `ensureModel()` short-circuits to the existing file.

### 4.2 Lazy Load and Idle Release

The ONNX `InferenceSession` is not created at application startup. It is lazily constructed on the **first** call to `embedImage`/`ensureEmbedding` (`intraOpNumThreads: 2`), then kept warm for subsequent calls. A **5-minute idle timer** releases the session (`session.release()`) after the last call, freeing the ~250–350 MB of resident memory the loaded session holds. During a backfill run, consecutive batch jobs arrive well within the 5-minute window, so the session stays warm for the duration of the run rather than reloading per job.

### 4.3 Degraded Mode

Any failure while downloading, verifying, or loading the model (network failure, disk full, corrupt file, unsupported platform for the `onnxruntime-node` native binary) sets an internal `degraded` flag. Once degraded:

- `isAvailable()` returns `false`.
- `embedImage()` / `ensureEmbedding()` return `null` / `'unavailable'` instead of throwing.
- A warning is logged exactly **once** (`degradedWarned` guard) rather than spamming logs on every subsequent call.
- Enrichment jobs **never fail** because of a missing/broken model — `DuplicateDetectionService.processMediaItem` treats an `'unavailable'` embedding result as "no Tier 1 candidates" and proceeds with Tier 2 (dHash) matching only.

Admins can check current model health via `GET /api/admin/duplicates/status` (§9.7), which surfaces `modelAvailable`, `degraded`, `modelPath`, and the model tag (`clip-vit-b32-q8`) — useful both for confirming a successful first download and for diagnosing why a deployment is silently running hash-only.

### 4.4 Preprocessing

`preprocessImageForClip` (a pure, dependency-injection-free function, independently testable): runs the buffer through `prepareImageForProcessing` (mandatory EXIF-orientation entry point, per repo convention — see CLAUDE.md "Writing an Image Enrichment Handler"), resizes to 224×224 with `fit: 'fill'` (matching CLIP's own preprocessor), normalizes each channel with CLIP's published mean/std (`[0.4815, 0.4578, 0.4082]` / `[0.2686, 0.2613, 0.2758]`), and lays the result out as a CHW `Float32Array` tensor. The raw 512-d model output is L2-normalized (`l2Normalize`) before storage so that cosine similarity reduces to a plain dot product for every downstream query.

---

## 5. Data Model

### 5.1 New Table: `duplicate_groups`

One row per detected near-duplicate cluster, circle-scoped, mirroring `burst_groups` closely enough that the two features share the same mental model for reviewers.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `circleId` | UUID | FK → `circles` (cascade delete) |
| `status` | `DuplicateGroupStatus` | `pending` \| `resolved` \| `dismissed`; default `pending` |
| `suggestedBestItemId` | UUID? | FK → `media_items` (SetNull on delete); opportunistically refreshed at read time, see §3.3 |
| `mediaCount` | Int | Denormalized member count; default `0`, maintained on every membership change |
| `capturedAt` | DateTime? | Earliest active member's `capturedAt`; added in a follow-up migration (`20260702010000_duplicate_groups_captured_at`) for chronological queue ordering, same pattern as `burst_groups.capturedAt` |
| `resolvedById` | UUID? | FK → `users` (SetNull on delete) |
| `resolvedAt` | DateTime? | |
| `createdAt` / `updatedAt` | DateTime | |

Index: `@@index([circleId, status])`.

**`DuplicateGroupStatus` enum:** `pending` (awaiting review), `resolved` (reviewer picked a keep set; non-kept members archived or trashed), `dismissed` (reviewer indicated this is not actually a duplicate set; members ungrouped).

Unlike `burst_groups`, there is **no minimum-size gate**. A duplicate group is only ever created when the union-find step links 2+ items, so `mediaCount` is always ≥ 2 by construction — there is no `dedup.minGroupSize` setting and no "provisional, not yet surfaced" state the way undersized burst groups have.

### 5.2 New Column on `media_items`

| Column | Type | Notes |
|--------|------|-------|
| `duplicateGroupId` | UUID? | FK → `duplicate_groups` (SetNull on delete) |

Index: `media_items_duplicate_group_id_idx` on `duplicate_group_id`.

A second index, `media_items_circle_id_perceptual_hash_idx` on `(circle_id, perceptual_hash)`, was added in the same migration specifically to serve Tier 2's circle-scoped hash-candidate scan.

### 5.3 New Table: `media_visual_embedding`

Raw-SQL table (not modeled in Prisma — the same reason `media_item_embedding` is raw SQL: Prisma cannot read/write `Unsupported` pgvector column types). One row per media item with a computed embedding; **row existence doubles as the "already processed" marker** for backfill eligibility (§6.2) — there is no separate status side-table for duplicate detection, unlike tagging/geocode/metadata.

| Column | Type | Notes |
|--------|------|-------|
| `media_item_id` | UUID PK | FK → `media_items` (cascade delete) |
| `circle_id` | UUID | Denormalized, no FK — matches `media_item_embedding`'s pattern; enables circle-scoped KNN without a join |
| `embedding` | `vector(512)` | L2-normalized CLIP output |
| `model` | text | Model tag, currently always `clip-vit-b32-q8` (`VISUAL_EMBEDDING_MODEL_TAG`) — future model swaps stay traceable per row |
| `created_at` | timestamptz | |

Indexes: plain B-tree on `circle_id`; **HNSW** on `embedding` (`vector_cosine_ops`, `m = 16, ef_construction = 64`) — same tuning as `media_item_embedding`'s HNSW index. Requires the `vector` Postgres extension (already enabled by an earlier migration for semantic search) and the `pgvector/pgvector:pg16` database image.

`ensureEmbedding(mediaItemId)` is the single write path: it checks row existence first (idempotent, resumable — safe to call from every retry of a batch job), then downloads the object bytes, embeds, and `INSERT ... ON CONFLICT (media_item_id) DO UPDATE`. If the model is degraded or the download/embed fails, it returns `'unavailable'` without writing a row — a later retry (or a future backfill with `force: true` after the model becomes available) will attempt again.

### 5.4 Global Feature Setting

`features.duplicateDetection` (Boolean, default `false`) in the `system_settings` JSONB, same pattern as `features.autoTagging` / `features.faceRecognition` / `features.burstDetection`. Read via `SystemSettingsService.isFeatureEnabled(FEATURE_KEYS.DUPLICATE_DETECTION)`.

---

## 6. Processing and Enrichment Flow

### 6.1 Two Job Types

| Job type | Trigger | `reason` | `priority` | Payload |
|----------|---------|----------|------------|---------|
| `duplicate_detection` | Upload (photo, feature on) | `upload` | 10 | none — `mediaItemId` on the job row |
| `duplicate_detection` | Per-item rerun (`POST /api/media/:id/duplicates/rerun`) | `rerun` | 0 (highest) | none |
| `duplicate_detection` | Burst group resolve (survivors) / dismiss (all members) | `rerun` | 10 | none — one job per affected item |
| `duplicate_detection_batch` | Admin backfill | `backfill` | 100 (lowest) | `{ mediaItemIds: string[] }`, 100 IDs per job |

Both job types are handled by thin handlers (`DuplicateDetectionHandler`, `DuplicateDetectionBatchHandler`) that delegate all matching logic to the shared `DuplicateDetectionService.processMediaItem` — the batch handler simply loops over its chunk, calling the exact same per-item function used by the single-item path, sequentially, with per-item try/catch.

Upload-time enqueue lives in `MediaEnrichmentService.enqueueUploadEnrichment` (`apps/api/src/media/enrichment/media-enrichment.service.ts`) alongside `auto_tagging`, `face_detection`, and `burst_detection` — called synchronously before `createMedia` returns, so the job row exists before any client (web, CLI, Android) receives its 201 response. Gated by `features.duplicateDetection` **and** the `DUPLICATE_DETECTION_ENABLED` environment kill-switch, exactly like the other three enrichment types.

### 6.2 Why Backfill Is Chunked, Not One-Job-Per-Item

This is a scale-critical design decision, not an arbitrary choice. Two verified facts about the shared enrichment worker constrain backfill design for *any* feature:

- The worker claims at most `ENRICHMENT_WORKER_CONCURRENCY` jobs (default `1`) per `ENRICHMENT_JOB_POLL_MS` tick (default 5 s) — a naive one-job-per-item backfill is **poll-floor-bound** at roughly 720 jobs/hour *regardless of how fast the handler itself runs*. A 10 000-photo library would take upward of 14 hours of pure poll pacing before compute time is even considered.
- `EnrichmentStuckResetTask` resets any job stuck in `running` for longer than `ENRICHMENT_STUCK_MINUTES` (default 15 minutes) back to `pending`, so a single job may never legitimately run longer than roughly 10–12 minutes without risking a false "stuck" reset and duplicate processing.

Duplicate-detection backfill is **compute-bound** (CLIP embedding is ~150–400 ms/image on 2 vCPU, plus image download/decode — call it ~1–2 s/photo end-to-end), which makes it the worst case of any backfill in the app for the poll-floor problem. `DuplicateBackfillService` (`apps/api/src/dedup/duplicate-backfill.service.ts`) resolves this by chunking: eligible item IDs are paginated with a keyset (id-cursor) scan, 5 000 per page, then sliced into **100-ID chunks**, each enqueued as one `duplicate_detection_batch` job (`skipDedup: true` so the standard `(type, mediaItemId IS NULL)` global-job dedup doesn't collapse every chunk into a single job row — each chunk gets its own row keyed only by its unique payload). At a worst-case ~3 s/item, 100 items ≈ 5 minutes/job — comfortably under the 15-minute stuck-reset ceiling, and for a 10 000-photo library this reduces the job count from 10 000 rows down to 100, making poll-floor pacing negligible.

Chunking never spans circle boundaries — `backfillCircle` runs its full keyset scan per circle before moving to the next, so every `duplicate_detection_batch` job's `circleId` is unambiguous.

**Partial-failure handling:** `DuplicateDetectionBatchHandler` processes its 100 IDs sequentially, collecting per-item failures into an array rather than aborting on the first error. If any items failed, the handler throws at the very end so the enrichment worker's standard retry logic re-attempts the **whole chunk** — this is safe specifically because `processMediaItem` is idempotent (§3.1) and `ensureEmbedding` checks row existence first (§5.3), so re-processing the already-succeeded 99 items in a retried chunk costs a handful of no-op existence checks, not 99 re-embeddings.

### 6.3 Idempotency and Backfill Eligibility

Duplicate detection has no dedicated per-item status table (unlike tagging, geocode, or metadata extraction). Instead, **the existence of a `media_visual_embedding` row is the "already processed" signal** used by `force: false` (default) backfill eligibility:

```sql
NOT EXISTS (SELECT 1 FROM media_visual_embedding mve WHERE mve.media_item_id = media_items.id)
```

`force: true` disables this check and re-enqueues every eligible photo regardless of existing embedding — useful after changing `dedup.similarityThreshold` / `dedup.hashMaxDistance` (the embedding itself doesn't need recomputing for a threshold change, but forcing a full re-run is the simplest way to re-evaluate every pairing under the new threshold) or after the model transitions out of degraded mode and hash-only-matched items should get a real CLIP embedding.

Eligibility filters applied by `fetchEligibleIdsPage`: `circle_id`, `type = 'photo'`, `deleted_at IS NULL`, `archived_at IS NULL`, optional `captured_at` range (`from`/`to`, both inclusive).

### 6.4 Progress Visibility

There is no dedicated dedup progress endpoint. Progress is read from the existing admin jobs dashboard (`/admin/settings/jobs`, `GET /api/admin/jobs/stats`) filtering `byType` for `duplicate_detection_batch` — the count of `succeeded` jobs against the `enqueued` total returned by the backfill call is the progress signal, exactly as documented for burst detection's backfill.

### 6.5 Throughput Expectations

Defaults assumed: `ENRICHMENT_JOB_POLL_MS=5000`, `ENRICHMENT_WORKER_CONCURRENCY=1`, 2 vCPU host.

| Library size | Jobs enqueued (100/chunk) | Approximate wall-clock time |
|---|---|---|
| 1 000 photos | 10 | ~25–50 minutes |
| 10 000 photos | 100 | ~4.5–9 hours |
| 50 000 photos | 500 | ~1–2 days |

This is compute-bound (CLIP inference + image download/decode), one-time per photo (subsequent backfills with `force: false` skip already-embedded items in milliseconds), fully background, and naturally pre-empted by priority-10 upload jobs and priority-0 reruns since the enrichment worker always claims the lowest `priority` value first. Setting `ENRICHMENT_WORKER_CONCURRENCY=2` roughly halves wall-clock time on a 4 vCPU host — see the "Bulk Import Tuning" guidance in CLAUDE.md for the RAM tradeoff of raising worker concurrency for AI/CLIP-bound work.

---

## 7. Database Footprint and Data Lifecycle

### 7.1 Storage Cost Per Photo

One `media_visual_embedding` row costs **512 × 4 bytes ≈ 2.1 KB** for the vector itself, plus roughly **2.3 KB** in the HNSW index — **~4.5 KB/photo total**. For comparison, the existing semantic-search table (`media_item_embedding`, `vector(1536)`, used for AI auto-tagging descriptions) already costs about 3× that per photo — duplicate detection adds roughly a third of what auto-tagging already stores per item.

| Library size | `media_visual_embedding` table | HNSW index | Dedup total | (existing 1536-d `media_item_embedding`, for comparison) |
|---|---|---|---|---|
| 1 000 photos | ~2 MB | ~3 MB | **~5 MB** | ~15 MB |
| 10 000 photos | ~21 MB | ~25 MB | **~46 MB** | ~140 MB |
| 50 000 photos | ~105 MB | ~125 MB | **~230 MB** | ~700 MB |

`duplicate_groups` rows (~200 bytes each, one per cluster — not one per photo) and `duplicate_detection_batch` job rows (100 per 10 000 photos, auto-purged by the nightly `job_history_purge` job per `jobs.history.retentionDays`) are noise by comparison. Query load during backfill is one HNSW KNN lookup (single-digit milliseconds) plus a couple of inserts per photo, at worker concurrency 1 by default — no load spikes to plan around.

**Verdict:** not a capacity concern on a typical 4–8 GB self-hosted VPS at these scales. If a deployment ever grows past roughly 200 000 photos, the escape hatch is migrating the `embedding` column type to `halfvec(512)` (pgvector ≥ 0.7, supported by the same `pgvector/pgvector:pg16` image already in use), which halves both the raw vector size and the HNSW index size. This is **not built today** — it is a documented future migration path, not a current limitation.

### 7.2 What Happens to Embeddings When a Duplicate Group Is Resolved

`POST /api/media/duplicates/:id/resolve` takes an `action` of `'archive'` or `'trash'` for the non-kept members (see §9.3):

- **Archive** (`archivedAt` set): the media row, its storage blob, and its `media_visual_embedding` row **all remain in place** — archive is reversible, and at ~2 KB/item the embedding cost of keeping every archived duplicate around is deliberately not worth optimizing away.
- **Trash** (`deletedAt` set): the item enters the existing Trash lifecycle (`docs/specs/archive-trash.md`). After `storage.trash.retentionDays` (default 30) elapses, the existing hourly `trash_purge` enrichment job hard-deletes the row via `MediaService.purgeMediaItems` — this removes the **storage blob** (the real space cost, typically 2–8 MB/photo), the `StorageObject` row, and the `media_items` row itself. The `media_visual_embedding` row is removed automatically via its `ON DELETE CASCADE` FK to `media_items` — no separate cleanup step is needed. **Trashing 1 000 duplicates eventually reclaims gigabytes of object storage against roughly 4.5 MB of Postgres bookkeeping** — the database cost of running duplicate detection is trivially repaid by the storage it lets an admin reclaim.
- `DuplicateGroup` rows themselves are **not deleted** on resolve or dismiss — they persist as audit history (~200 bytes each) with `status = resolved`/`dismissed` and `resolvedById`/`resolvedAt` populated. If every member of an already-`pending` group is independently archived or trashed via some other path (e.g. bulk operations), `recomputeGroupMeta` deletes the now-empty group defensively — this is the one case a `DuplicateGroup` row is actually removed.

---

## 8. Configuration

### 8.1 System Settings (Admin-Editable)

| Setting key | Type | Range | Default | Description |
|-------------|------|-------|---------|-------------|
| `features.duplicateDetection` | boolean | — | `false` | Global on/off for the entire feature (upload-time enqueue + admin backfill both gated on this) |
| `dedup.similarityThreshold` | number | 0.80–0.995 | `0.96` | Minimum CLIP cosine similarity (Tier 1) for two photos to be linked |
| `dedup.hashMaxDistance` | integer | 0–16 | `6` | Maximum dHash Hamming distance (Tier 2, out of 64 bits) for two photos to be linked |
| `dedup.knnCandidates` | integer | 5–50 | `20` | Number of nearest-neighbor candidates fetched per item from the pgvector HNSW index before threshold filtering |

All three `dedup.*` values are validated by the same Zod schema used for every other system-settings write path (`apps/api/src/settings/dto/update-system-settings.dto.ts`), round-tripped through `PATCH /api/system-settings` / `PUT /api/system-settings` like every other setting group.

### 8.2 Environment Variables

| Variable | Default | Description |
|----------|---------|--------------|
| `DUPLICATE_DETECTION_ENABLED` | `true` | Environment kill-switch. Set to `false` to disable upload-time `duplicate_detection` enqueue regardless of `features.duplicateDetection`. The system setting is the runtime toggle; this env var is a hard override for CI/test environments — same pattern as `BURST_DETECTION_ENABLED`, `AUTO_TAG_ENABLED`, `FACE_AUTO_DETECT`. |
| `MODELS_DIR` | `./data/models` | Persistent-volume directory the CLIP ONNX model file is downloaded to and loaded from (§4.1). Mount as a Docker volume in production so the model survives container recreation. |

The shared enrichment worker variables (`ENRICHMENT_WORKER_ENABLED`, `ENRICHMENT_JOB_POLL_MS`, `ENRICHMENT_WORKER_CONCURRENCY`) govern the queue that runs both `duplicate_detection` and `duplicate_detection_batch` jobs alongside every other enrichment type — see [enrichment-queue.md](enrichment-queue.md).

---

## 9. API Endpoints

All endpoints require JWT Bearer authentication. No new system-level RBAC permissions were introduced for the review-queue endpoints — they reuse `media:read`, `media:write`, and `media:delete`, exactly like burst detection. Admin endpoints reuse `system_settings:read`/`system_settings:write`.

### 9.1 `GET /api/media/duplicates`

List duplicate groups for a circle.

- **Auth:** `media:read` + per-circle `viewer` role.
- **Query params:** `circleId` (required), `status` (`pending`\|`resolved`\|`dismissed`, default `pending`), `kind` (`exact_variant`\|`edited`\|`similar`, optional filter), `page` (default 1), `pageSize` (default 20, max 100).
- **Response `200`:**
  ```json
  {
    "items": [
      {
        "id": "uuid",
        "status": "pending",
        "kind": "exact_variant",
        "mediaCount": 3,
        "capturedAt": "2026-06-15T14:32:01.234Z",
        "suggestedBestItemId": "uuid",
        "coverThumbnailUrls": ["https://...", "https://..."]
      }
    ],
    "meta": { "total": 8, "page": 1, "pageSize": 20 }
  }
  ```
  Ordered by `capturedAt ASC, createdAt ASC` (chronological — see §3.4's discussion of immich Discussion #25831). `coverThumbnailUrls` contains up to 4 signed thumbnail URLs for the first 4 active members. `kind` filtering is applied in application code after read-time classification (§3.4), so `meta.total` reflects the post-filter count.

### 9.2 `GET /api/media/duplicates/:id`

Full detail for a single group.

- **Auth:** `media:read` + per-circle `viewer` role.
- **Response `200`:** `{ "data": { id, circleId, status, kind, mediaCount, capturedAt, suggestedBestItemId, resolvedById, resolvedAt, members: [...] } }`. Each member: `{ id, thumbnailUrl, previewUrl, width, height, fileSize, capturedAt, cameraMake, cameraModel, hasGps, contentHash (first 12 chars), sharpnessScore, qualityScore, similarityToBest, isSuggestedBest }`. `previewUrl` is a signed URL to the full original (not just the thumbnail) so the reviewer can compare at full resolution. `similarityToBest` is the member's CLIP cosine similarity against `suggestedBestItemId`'s embedding, or `null` if either side lacks an embedding (degraded mode / hash-only match).
- **Response `404`:** group not found.

### 9.3 `POST /api/media/duplicates/:id/resolve`

Keep selected members; archive or trash the rest.

- **Auth:** `media:write` + per-circle `collaborator` role. If `action: 'trash'`, the caller must **additionally** hold `media:delete` (checked in the service, not the route decorator) — a collaborator without delete rights can archive but not trash.
- **Request body:** `{ "keepIds": ["uuid", ...], "action": "archive" | "trash" }`. `keepIds` must be non-empty and every ID must belong to the group.
- **Response `200`:** `{ "data": { "removed": 2, "kept": 1, "action": "trash", "groupStatus": "resolved" } }`.
- **Response `400`:** empty/invalid `keepIds`, missing `media:delete` for a trash action, or the group is not currently `pending`.
- **Response `404`:** group not found.
- Runs in a single `$transaction`: bulk `archivedAt`/`deletedAt` update on the removed members plus the group's `status = resolved` update succeed or fail together. Writes an `audit_events` row (`duplicate_group:resolved`).

### 9.4 `POST /api/media/duplicates/:id/dismiss`

Mark a group as not actually duplicates; ungroups all members (`duplicateGroupId = null`) without deleting anything.

- **Auth:** `media:write` + per-circle `collaborator` role.
- **Response `200`:** `{ "data": { "groupStatus": "dismissed", "ungrouped": 3 } }`.
- **Response `400`:** group is not currently `pending`.
- Writes an `audit_events` row (`duplicate_group:dismissed`).

### 9.5 `POST /api/media/:id/duplicates/rerun`

Re-enqueue duplicate detection for a single media item at priority 0 (highest).

- **Auth:** `media:write` + per-circle `collaborator` role (`CircleMembershipService.assertCircleAccess`), consistent with the geocode and metadata-extraction rerun endpoints.
- **Response `201`:** `{ "data": { "jobId": "uuid", "status": "pending" } }`.
- **Response `400`:** item is not a photo.
- **Response `404`:** item not found or soft-deleted.

### 9.6 `POST /api/admin/duplicates/backfill`

Bulk-enqueue `duplicate_detection_batch` jobs across **all circles**.

- **Auth:** Admin role + `system_settings:write`.
- **Requirement:** `features.duplicateDetection` must be `true`; otherwise `400`.
- **Request body:** `{ "from": "ISO-8601"?, "to": "ISO-8601"?, "force": false }`. `from`/`to` bound `capturedAt` (both inclusive, independent). `force: true` re-embeds every eligible photo regardless of existing embedding.
- **Response `201`:** `{ "data": { "enqueued": 87, "circles": 4, "estimatedItems": 8412 } }` — `enqueued` is the number of `duplicate_detection_batch` job rows created (matches the admin jobs dashboard's `byType` count exactly), `estimatedItems` is the number of individual photos those jobs cover.

### 9.7 `GET /api/admin/duplicates/status`

Visual-embedding model availability.

- **Auth:** Admin role + `system_settings:read`.
- **Response `200`:** `{ "data": { "modelAvailable": true, "modelPath": "./data/models/clip-vit-b32-vision-quantized.onnx", "degraded": false, "model": "clip-vit-b32-q8" } }`. When `degraded: true`, the deployment is running Tier 2 (dHash) matching only (§4.3).

### 9.8 Circle Dashboard

`GET /api/media/dashboard?circleId=` returns a `pendingDuplicateGroups` count (`DuplicateGroupStatus.pending`, circle-scoped). Unlike `pendingBurstGroups`, there is **no minimum-size filter applied** — every `pending` duplicate group qualifies, since a group is never created below `mediaCount = 2` in the first place (§5.1).

---

## 10. RBAC

| Endpoint | Permission | Per-circle role | Notes |
|---|---|---|---|
| `GET /api/media/duplicates` | `media:read` | `viewer` | |
| `GET /api/media/duplicates/:id` | `media:read` | `viewer` | |
| `POST /api/media/duplicates/:id/resolve` | `media:write` (+ `media:delete` if `action: 'trash'`) | `collaborator` | |
| `POST /api/media/duplicates/:id/dismiss` | `media:write` | `collaborator` | |
| `POST /api/media/:id/duplicates/rerun` | `media:write` | `collaborator` | |
| `POST /api/admin/duplicates/backfill` | `system_settings:write` | — (Admin, app-wide) | 400 if feature disabled |
| `GET /api/admin/duplicates/status` | `system_settings:read` | — (Admin) | |

No new permission scopes were introduced. All endpoints reuse `media:read`/`media:write`/`media:delete`/`system_settings:read`/`system_settings:write`, consistent with burst detection and the metadata/geocode rerun endpoints.

---

## 11. UI

**Not yet implemented as of this specification's version.** The backend (matching engine, both enrichment handlers, chunked backfill service, review API, admin status endpoint, settings, dashboard count) is complete and independently usable via the API documented above. A frontend review-queue page (`/duplicates`, `/duplicates/:id`), an admin settings sub-page (`/admin/settings/duplicates` with the global toggle, threshold sliders, and a backfill panel mirroring `TaggingSettingsPage`), and a `pendingDuplicateGroups` dashboard banner are planned as the immediate next phase of this feature and will follow the same `services/<domain>.ts` + `hooks/use<Domain>.ts` pattern used by `pages/Bursts/*`.

---

## 12. Security and Privacy

### All Processing Is On-Server

The CLIP inference session runs entirely in-process via `onnxruntime-node`. No pixel data or embedding vector is ever sent to a third-party service — this mirrors the `human` WASM face-recognition provider's privacy posture. The perceptual hash (Tier 2) was already computed on-server for burst detection.

### Non-Destructive by Design

No deletion or archival happens without an authenticated, authorized call to `POST /api/media/duplicates/:id/resolve` with an explicit `keepIds` list. Both `archive` and `trash` outcomes are reversible (unarchive; restore from Trash within the retention window).

### Global Feature Toggle

`features.duplicateDetection` defaults to `false`. Both the upload-time enqueue path and the admin backfill endpoint refuse to run while the setting is off (backfill returns `400`; upload enqueue silently skips and logs the skip reason).

### Model Download Provenance

The CLIP model is fetched from Hugging Face's CDN over HTTPS at a fixed URL. See §4.1 for the size/magic-byte verification applied to the download and the rationale for not pinning a cryptographic checksum.

### Audit Trail

`duplicate_group:resolved` and `duplicate_group:dismissed` audit events are written on every resolve/dismiss action, recording the actor, the `keepIds`/`action` (resolve) or ungrouped count (dismiss).

---

## 13. Testing Notes

**Current state:** `apps/api/src/dedup/duplicate-detection.service.spec.ts` provides unit coverage for `DuplicateDetectionService` — guards (non-photo/deleted/archived items skipped; items in a pending burst group skipped entirely), the link-rule matrix (embedding-only, hash-only, both, neither), degraded mode (embedding unavailable falls back to hash-only linking), union-find grouping (create / join / merge-into-oldest), burst-overlap candidate exclusions, and on-demand perceptual-hash backfill for legacy items. Additionally, `apps/api/src/burst/burst.service.spec.ts` was updated with a `SystemSettingsService` mock provider so the pre-existing burst tests keep passing now that `BurstService` depends on it for the dedup re-enqueue interop (§3.2).

**Known gaps:** as of this version there is no dedicated test coverage for `VisualEmbeddingService` (preprocessing, model lifecycle, degraded-mode transition), `DuplicateService` (best-copy scoring, kind classification, resolve/dismiss/rerun business logic), `DuplicateBackfillService` (chunking, `force` semantics, keyset pagination), `DuplicateDetectionBatchHandler` (partial-failure retry behavior), or the two controllers (RBAC branches, request validation). These should be treated as follow-up work — see §14.

The scenarios below describe the full coverage this module should have; items already covered by `duplicate-detection.service.spec.ts` are marked accordingly, following the same shape as the equivalent burst-detection test plan (`docs/specs/burst-detection.md` §10):

### Unit Tests

- **Preprocessing** *(gap)*: `preprocessImageForClip` against known fixture images (golden tensor values or shape assertions); `l2Normalize` correctness; `looksLikeOnnxModel` heuristic against real/corrupt byte sequences.
- **Link-rule matrix** *(covered)*: embedding-only match, hash-only match, both, neither — verifies the OR combination.
- **Union-find grouping** *(covered)*: create / join-existing / merge-multiple-into-oldest, mirroring `BurstDetectionService.processMediaItem`'s existing test shape.
- **Burst-overlap exclusion** *(covered)*: pending-burst-group subject skip; pending-burst-group / same-`burstGroupId` candidate exclusion.
- **On-demand hash backfill** *(covered)*: legacy items lacking `perceptualHash` get one computed and persisted before matching runs.
- **Best-copy scoring** *(gap)*: `computeBestCopyScores` with representative fixture sets (original vs. recompressed-and-resized copy); verify normalization and weight application.
- **Kind classification** *(gap)*: fixtures for each of `exact_variant` / `edited` / `similar` at the exact threshold boundaries (sim `0.99`, hamming `2`).
- **Degraded mode** *(partially covered)*: `duplicate-detection.service.spec.ts` covers the consuming side (embedding unavailable → hash-only fallback); the `VisualEmbeddingService` side — a mocked failing `InferenceSession.create`, `isAvailable()` flipping, the one-time warning log — is still a gap.
- **Chunker** *(gap)*: `DuplicateBackfillService`'s keyset pagination correctness, `NOT EXISTS` eligibility SQL, `skipDedup` usage, and the never-spans-circles invariant.
- **Batch handler** *(gap)*: idempotent resume on retry (re-processing already-embedded items is a fast no-op) and partial-failure-throws-whole-chunk behavior.

### Integration Tests

- **Full pipeline:** upload two photos with intentionally similar mocked embeddings/hashes in the same circle; verify a `DuplicateGroup` row is created once both `duplicate_detection` jobs complete.
- **Resolve — archive vs. trash:** verify the correct column (`archivedAt` vs. `deletedAt`) is set on non-kept members and that `media:delete` is required for the trash path.
- **Dismiss:** verify `duplicateGroupId` is cleared on all members and no items are deleted.
- **Burst hand-off:** seed an item in a pending burst group; verify it's excluded from dedup matching; resolve/dismiss the burst group; verify a `duplicate_detection` rerun job is enqueued for the appropriate members afterward.
- **Backfill — force semantics:** seed items with and without existing `media_visual_embedding` rows; verify `force: false` only enqueues the missing ones and `force: true` enqueues all.
- **Backfill — 400 when disabled:** verify `POST /api/admin/duplicates/backfill` returns `400` when `features.duplicateDetection` is `false`.
- **Cascade on hard-delete:** hard-delete a `media_items` row with an embedding; verify the `media_visual_embedding` row is removed via `ON DELETE CASCADE`.

### RBAC Tests

- Verify a `viewer` can call the two `GET` endpoints but receives `403` on resolve/dismiss.
- Verify a `collaborator` without `media:delete` can resolve with `action: 'archive'` but receives `400` (not `403`) attempting `action: 'trash'`.
- Verify `POST /api/admin/duplicates/backfill` and `GET /api/admin/duplicates/status` return `403` for a non-admin.
- The per-circle collaborator check on the rerun endpoint (§9.5) is now covered: `apps/api/src/dedup/duplicate.service.spec.ts`'s `rerunDuplicateDetection` describe block asserts `assertCircleAccess` is called with the correct arguments, and that a rejection from the membership check propagates without enqueueing a job.

---

## 14. Future Work

| Capability | Notes |
|------------|-------|
| Remaining test coverage | See §13 — `DuplicateDetectionService` has unit coverage; `VisualEmbeddingService`, `DuplicateService`, `DuplicateBackfillService`, the batch handler, and the controllers do not yet |
| Frontend review queue and admin settings page | See §11 |
| `halfvec(512)` migration | Escape hatch for libraries beyond ~200 000 photos (§7.1); not needed at current scale |
| Configurable scoring weights | Expose the `0.35/0.30/0.20/0.15` best-copy weights as admin-editable settings rather than code constants, mirroring the equivalent Future Work item in `docs/specs/burst-detection.md` |
| Cross-circle detection | Explicitly out of scope today; would require rethinking the circle-scoped HNSW index and RBAC model |
| Video near-duplicate detection | Out of scope today; photos only |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | July 2026 | AI Assistant | Initial specification, documenting the Phase 1 (backend) implementation: CLIP ViT-B/32 + dHash two-tier matching engine, union-find grouping with burst-overlap exclusion rules, read-time best-copy scoring and kind classification, model lifecycle and degraded mode, chunked backfill architecture, and the full review/admin API surface |
| 1.1 | July 2026 | AI Assistant | Document §3.2 eviction ("burst wins") fix closing the upload-time ordering race: `DuplicateDetectionService.evictFromDuplicateGroups`, the `recomputeGroupMeta` shrink-below-2 cleanup, `evictExistingBurstOverlaps` one-time remediation, and the `evictedDuplicateOverlaps` field on `POST /api/admin/bursts/backfill` |
