# dedup

The near-duplicate detection slice of the MemoriaHub domain (RETRO-J10, #624), detection part.

## Purpose and scope

`VisualEmbeddingService` lazily loads the CLIP ViT-B/32 vision model (downloaded to `MODELS_DIR` on first use, recycled every N embeds, degraded to hash-only matching when it cannot load) and stores 512-d pgvector embeddings. `DuplicateDetectionService` matches in two tiers, OR-combined: CLIP cosine similarity over a pgvector KNN (`dedup.similarityThreshold`) or dHash Hamming distance (`dedup.hashMaxDistance`), then groups with union-find into review groups; a row lock re-checks the burst group before writing `duplicate_group_id` so burst membership wins (the write-time guard), and the group's `confidence` (tightest-pair similarity) is persisted. The compute half (embed plus dHash) is separate from the persist half, which is what a worker node uses. Jobs (type strings and profiles permanent): `duplicate_detection` (node-eligible, 5 minutes, three attempts), `duplicate_detection_batch` (100 ids per job, server-only), `duplicate_confidence_backfill` (server-only). `DuplicateBackfillService` queues the chunks, `DedupUploadEnrichment` registers the photo fan-out with the media slice (priority 10), and `ReviewInsightsService` answers the burst and duplicate review counters. The review service (resolve, dismiss, thresholds, best-copy scoring), its review-run strategy and the controllers stay in the web app until the review-run engine moves. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-api/dedup` (and `@marinoscar/memoriahub-api/dedup/testing`). It imports the `ports`, `core` and `media` slices through their `index.ts` and nothing else of the package.

## Peer dependencies

`@nestjs/common`, `@marinoscar/memoriahub-compute` (`dhash`, `clip`, `dto`) and `onnxruntime-node` (the native runtime probe at boot).

## Configuration

`DedupModule.forRoot()`; the options object is reserved and empty. Import it once in the host. Settings: `features.duplicateDetection` (kill switch `DUPLICATE_DETECTION_ENABLED`) and the `dedup` namespace (`similarityThreshold`, `hashMaxDistance`, `knnCandidates`); the model directory is `MODELS_DIR` and `CLIP_SESSION_RECYCLE_AFTER` tunes the session recycling.

## Extension-point catalog

None. The slice registers three job handlers through `MEMORIAHUB_JOBS` and one fan-out with the media slice's `UploadEnrichmentRegistry`. `describeDedupSliceConformance` (`./dedup/testing`) proves the registration: photos only, priority 10, gated by the feature flag.
