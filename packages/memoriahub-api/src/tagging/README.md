# tagging

Photo and video auto-tagging, the transcript, the admin tag vocabulary and the tagging backfill of the MemoriaHub domain, written against the host ports (RETRO-J7, #618). Every model call goes through `MEMORIAHUB_AI`; the slice imports no provider SDK, no `@marinoscar/platform-*` package and no generated database client.

## Purpose and scope

Owns: `AutoTaggingService` (one vision call over an image of at most `TAG_MAX_IMAGE_DIM` pixels, and `persistAutoTagging`, the single vocabulary validator both job types share: only labels of the admin's vocabulary become tags, case is normalised, a re-run replaces the AI tags and never touches or downgrades a manual one, the description is written only for an answer that parses, then a best-effort 1536-d embedding into `media_item_embedding`), `VideoAutoTaggingService` (frame sampling, optional first-N-seconds transcription into `media_transcripts`, ONE multi-image vision call; `VideoInputResolver` streams the video from a presigned URL when the provider honours Range and falls back to a temp file in every other case), the two job handlers (`auto_tagging`, `video_auto_tagging`), `TagLabelsService` and its CSV import/export, `TaggingBackfillService` (photos by default, videos opt in), `TaggingUploadEnrichment` (the photo fan-out registered with the media slice's registry) and the four controllers (`TaggingController`, `TagLabelsController`, `AdminTaggingController`). Does not own: the provider adapters and keys (the host), the video fan-out after social-media detection (the host's media enrichment service), the web UI. Status: experimental until the first published release.

Both job types are SERVER-ONLY, permanently: they declare `usesAi` and no node result pair, because a provider key is never brokered to a worker node. Job type strings (`auto_tagging`, `video_auto_tagging`), profiles (3 minutes and 20 minutes, 3 attempts) and the shared `tagging` throttle bucket never change.

## Entry point

`@marinoscar/memoriahub-api/tagging` (and `./tagging/testing` for the conformance kit and the in-memory store). It imports the `ports`, `core` and `media` slices through their `index.ts`.

## Peer dependencies

`@nestjs/common`, `@nestjs/swagger`, `nestjs-zod`, `zod`, `csv-parse` and `csv-stringify` (the vocabulary CSV), `@marinoscar/memoriahub-contract` (the vocabulary and backfill schemas) and `@marinoscar/memoriahub-compute` (the image preparation, frame and audio extraction, and the result schema). The CSV import reads the upload with `request.file()`: the host registers `@fastify/multipart` (`$hostPlugins`).

## Configuration

`TaggingModule.forRoot(options)`; the options object is reserved and empty today. The knobs are the ones a deployment already has: `features.autoTagging` and `autoTagging.video.*` system settings (read through the settings port), the `ai.features.tagging`, `ai.features.transcription` and `ai.features.embedding` model selections, and the environment variables `AUTO_TAG_ENABLED`, `TAG_MAX_IMAGE_DIM`, `VIDEO_ENRICHMENT_MAX_BYTES` and `OPENAI_REASONING_EFFORT`. The host registers the four AI features (`media_tagging`, `video_tagging`, `video_transcription`, `semantic_embedding`), mounts the controllers in its own module and, for a run on a worker with no platform, binds the ports.

## Extension-point catalog

None: the slice has no registry of its own. It is a client of one, the media slice's `UploadEnrichmentRegistry` (it registers `auto_tagging` at order 100, priority 20).
