# media

The media core of the MemoriaHub domain, moved onto the host ports slice by slice (RETRO-J5, #613). This first cut carries the upload enrichment fan-out registry, the sidecar touch service, the `upload_completed` producer and the Android Media Sync device service.

## Purpose and scope

Everything a media item needs that does not depend on another slice, written against `@marinoscar/memoriahub-api/ports` only (no platform import, no generated database client). The upload fan-out is a registry: tagging, face detection, burst, duplicate, location-inference and social-media slices register their enqueue and its gate with `UploadEnrichmentRegistry.register(type, gate)` instead of `media` importing them, which keeps the dependency one way. `MediaTouchService` bumps `media_items.updated_at` after a related-table write so the node backup change feed sees it. `UploadNotificationService` raises `media.upload_completed` as one rolling 15-minute row per recipient however many files an import registers. `MediaSyncService` is the Android Media Sync device API (register, versioned desired config, commands, check-in, runs, diagnostics) with owner-scoped 404s and PAT scoping. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-api/media`. It imports the `ports` and `core` slices through their `index.ts` and nothing else of the package.

## Peer dependencies

`@nestjs/common`, `zod` and `@marinoscar/memoriahub-contract` (the Media Sync wire schemas and refusal reasons).

## Configuration

`MediaModule.forRoot(options)`; the options object is reserved and empty today. Import it once in the host and re-export it from the host's media module (the registry is a singleton). The slice reads no environment variable: a gate that honours a kill switch (`AUTO_TAG_ENABLED`) lives in the registration of the slice that owns the feature.

## Extension-point catalog

`UploadEnrichmentRegistry` is the extension point: a slice calls `register(type, { mediaTypes, order, skipReason, enqueue, onSkipped })` when it starts. `skipReason` answers `null` to enqueue or the logged reason to skip; `onSkipped` is the fallback of a skipped job (video: no social-media detection means face detection runs directly). The registrations run in ascending `order`; the priority of the job each enqueues is the registration's own.
