# dedup

The near-duplicate detection and review slice of the MemoriaHub domain (RETRO-J10, #624).

## Purpose and scope

`VisualEmbeddingService` lazily loads the CLIP ViT-B/32 vision model (downloaded to `MODELS_DIR` on first use, recycled every N embeds, degraded to hash-only matching when it cannot load) and stores 512-d pgvector embeddings. `DuplicateDetectionService` matches in two tiers, OR-combined: CLIP cosine similarity over a pgvector KNN (`dedup.similarityThreshold`) or dHash Hamming distance (`dedup.hashMaxDistance`), then groups with union-find into review groups; a row lock re-checks the burst group before writing `duplicate_group_id` so burst membership wins (the write-time guard), and the group's `confidence` (tightest-pair similarity) is persisted. The compute half (embed plus dHash) is separate from the persist half, which is what a worker node uses. Jobs (type strings and profiles permanent): `duplicate_detection` (node-eligible, 5 minutes, three attempts), `duplicate_detection_batch` (100 ids per job, server-only), `duplicate_confidence_backfill` (server-only). `DuplicateBackfillService` queues the chunks, `DedupUploadEnrichment` registers the photo fan-out with the media slice (priority 10), and `ReviewInsightsService` answers the burst and duplicate review counters. `DuplicateService` is the review queue: list with the read-time `kind` (`exact_variant`, `edited`, `similar`) and best-copy scoring, detail with quality and similarity scores, resolve, dismiss, bulk resolve, the two threshold runs and the per-item rerun; its resolve and dismiss primitives are public because `DuplicateGroupReviewStrategy` wraps them and registers with the review-run engine's `ReviewRunSubjectRegistry`. `DuplicateController`, `AdminDuplicateController` and `ReviewInsightsController` are exported classes over `@MemoriahubAuth` that the host mounts in the module where its routes belong. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-api/dedup` (and `@marinoscar/memoriahub-api/dedup/testing`). It imports the `ports`, `core`, `media` and `review-runs` slices through their `index.ts` and nothing else of the package.

## Peer dependencies

`@nestjs/common`, `@nestjs/swagger`, `nestjs-zod`, `@marinoscar/memoriahub-compute` (`dhash`, `clip`, `dto`), `@marinoscar/memoriahub-contract` (`dedup`) and `onnxruntime-node` (the native runtime probe at boot).

## Configuration

`DedupModule.forRoot()`; the options object is reserved and empty. Import it once in the host. Settings: `features.duplicateDetection` (kill switch `DUPLICATE_DETECTION_ENABLED`) and the `dedup` namespace (`similarityThreshold`, `hashMaxDistance`, `knnCandidates`); the model directory is `MODELS_DIR` and `CLIP_SESSION_RECYCLE_AFTER` tunes the session recycling.

## Extension-point catalog

| Symbol | Kind | What the host does |
|---|---|---|
| `DUPLICATE_OBSERVER`, `DuplicateObserver` | token, interface | optional: what happens after a resolve with `trash` commits (the `media.item.trashed` webhook); never throws; bind it from a global module |

The slice registers three job handlers through `MEMORIAHUB_JOBS`, one fan-out with the media slice's `UploadEnrichmentRegistry` and one strategy with the review-run engine. `describeDedupSliceConformance` (`./dedup/testing`) proves the registration: photos only, priority 10, gated by the feature flag.

**Diagnostics (RETRO-J10, #624).** The slice registers the `memoriahub.ai.duplicate-detection` check (`DuplicateDetectionDoctorCheck`: skipped when the feature is off, a warning when the CLIP model is unavailable and dedup runs dHash-only) through the `MEMORIAHUB_DOCTOR` port from `forRoot()`. Read-only; the id and the statuses are the ones the app declared before the move.
