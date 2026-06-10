# Phase 02 — Metadata Extraction (Enrichment v1)

**Roadmap:** [ROADMAP.md](ROADMAP.md)
**Previous Phase:** [Phase 01 — Media Domain Foundation](phase-01-media-domain.md)
**Next Phase:** [Phase 03 — Web Media Library](phase-03-web-library.md) · [Phase 04 — Metadata Export](phase-04-metadata-export.md) · [Phase 05 — CLI Importer](phase-05-cli-importer.md)
**Status:** Not Started

---

## 1. Goal

Implement the first wave of post-upload enrichment processors to automatically extract EXIF data, image dimensions, video properties, and content hashes from every uploaded photo and video. Each extractor is a new implementation of the existing `ObjectProcessor` interface and is registered via NestJS dependency injection — no changes to the processing orchestrator are required. Extracted values are written into `StorageObject.metadata` (JSONB) and then synced into the typed `MediaItem` columns defined in Phase 01.

---

## 2. Vision Mapping

| Vision Item | Relevant Section in VISION.MD |
|-------------|-------------------------------|
| #2 — Extract and store key media metadata | "Metadata Management", "Media Processing and Enrichment" |
| #11 — Allow future processors to enrich photos and videos | "Extensible Enrichment" — this phase proves the processor model with real extractors |

From the vision: _"MemoriaHub should store metadata in a structured way so the application can organize, search, process, and export media information."_ The typed columns added in Phase 01 are populated here for the first time. Vision item #11 is fulfilled at the architectural level in Phase 01 (the `ObjectProcessor` interface exists); this phase delivers the first concrete processors.

---

## 3. What We Reuse

| Existing File | How It Is Reused |
|---------------|-----------------|
| `apps/api/src/storage/processing/object-processor.interface.ts` | Each new extractor implements `ObjectProcessor` (`name`, `priority`, `canProcess`, `process`) |
| `apps/api/src/storage/processing/object-processing.service.ts` | Orchestrator unchanged; new processors registered via NestJS DI are picked up automatically |
| `apps/api/src/storage/processing/processors/example-metadata.processor.ts` | Reference implementation; new processors follow identical structure |
| `apps/api/src/storage/objects/objects.service.ts` | `getStream()` callback passed to each processor to stream bytes from the storage provider |
| `apps/api/src/media/media.service.ts` (Phase 01) | `syncMetadataToMediaItem()` method called after processors write to `StorageObject.metadata` |
| `apps/api/prisma/schema.prisma` | `MediaItem` typed columns (`capturedAt`, `width`, `height`, `durationMs`, `takenLat`, `takenLng`, `cameraMake`, `cameraModel`, `contentHash`) populated by the sync step |

---

## 4. Scope / Deliverables

- Four new `ObjectProcessor` implementations, each in `apps/api/src/storage/processing/processors/`:
  1. `ContentHashProcessor` — SHA-256 over the raw byte stream (priority: highest, runs first)
  2. `ExifProcessor` — extracts `capturedAt`, GPS coordinates, `cameraMake`, `cameraModel` from image files
  3. `ImageDimensionsProcessor` — extracts `width` and `height` from image files
  4. `VideoProbeProcessor` — extracts `durationMs`, `width`, `height`, codec from video files
- A `MediaMetadataSyncService` (or a hook in `MediaService`) that reads the populated `StorageObject.metadata` after all processors complete and writes the typed values into the corresponding `MediaItem` columns
- New npm dependencies in `apps/api/package.json`: `exifr`, `sharp`, `fluent-ffmpeg` (+ `@types/fluent-ffmpeg`)
- `ffmpeg` binary added to `apps/api/Dockerfile`
- Unit tests for each processor
- Integration test verifying the full enrichment-to-MediaItem-sync cycle

---

## 5. Data Model Changes

No new Prisma models are introduced. The existing `StorageObject.metadata` JSONB field stores intermediate processor results. The Phase 01 `MediaItem` typed columns are the final destination. No migration is required.

The metadata JSONB shape written by each processor:

```json
{
  "contentHash": {
    "sha256": "e3b0c44298fc1c149afb..."
  },
  "exif": {
    "capturedAt": "2024-06-15T10:30:00Z",
    "latitude": 9.9281,
    "longitude": -84.0907,
    "cameraMake": "Apple",
    "cameraModel": "iPhone 15 Pro"
  },
  "dimensions": {
    "width": 4032,
    "height": 3024
  },
  "videoProbe": {
    "durationMs": 12400,
    "width": 1920,
    "height": 1080,
    "codec": "h264"
  }
}
```

---

## 6. API Endpoints

No new endpoints are introduced in this phase. Processor results are visible through the existing `GET /api/media/:id` endpoint (Phase 01) — the typed columns on `MediaItem` are populated asynchronously after upload completes.

**Note:** Clients should poll `GET /api/media/:id` and check that `classification !== 'unreviewed'` or that `capturedAt` is populated to know that enrichment has finished. A future phase may add a WebSocket or SSE status push.

---

## 7. Implementation Steps

| Step | Description | Subagent |
|------|-------------|----------|
| 1 | Add `exifr`, `sharp`, `fluent-ffmpeg`, `@types/fluent-ffmpeg` to `apps/api/package.json`; add `RUN apt-get install -y ffmpeg` to `apps/api/Dockerfile` | `backend-dev` |
| 2 | Implement `ContentHashProcessor` (priority 10): stream bytes, compute SHA-256 with Node `crypto`, write `metadata.contentHash.sha256`; register in `storage.module.ts` | `backend-dev` |
| 3 | Implement `ExifProcessor` (priority 20): call `exifr.parse()` on the stream, extract `DateTimeOriginal`, `GPSLatitude`, `GPSLongitude`, `Make`, `Model`; write to `metadata.exif`; `canProcess` returns true for `image/*` mime types | `backend-dev` |
| 4 | Implement `ImageDimensionsProcessor` (priority 25): use `sharp(buffer).metadata()` to get width/height; write to `metadata.dimensions`; `canProcess` returns true for `image/*` | `backend-dev` |
| 5 | Implement `VideoProbeProcessor` (priority 20): use `fluent-ffmpeg.ffprobe()` to get duration, video stream width/height, codec; write to `metadata.videoProbe`; `canProcess` returns true for `video/*` | `backend-dev` |
| 6 | Implement `MediaMetadataSyncService.sync(storageObjectId)` that reads `StorageObject.metadata` and upserts typed columns on the linked `MediaItem`; call this from `ObjectProcessingService` after all processors have run (hook into the post-processing completion event) | `backend-dev` |
| 7 | Register all four processors as providers in `storage.module.ts` (follow the pattern used for `ExampleMetadataProcessor`) | `backend-dev` |
| 8 | Write unit tests for each processor; mock the `getStream` callback to return a fixture byte buffer | `testing-dev` |
| 9 | Write integration test: upload a test image → verify `MediaItem.capturedAt`, `width`, `height`, `contentHash` are populated after event processing; upload a test video → verify `durationMs` populated | `testing-dev` |
| 10 | Update `docs/plan/ROADMAP.md` status for Phase 02 | `docs-dev` |

---

## 8. Acceptance Criteria

- Uploading a JPEG with valid EXIF populates `MediaItem.capturedAt`, `takenLat`, `takenLng`, `cameraMake`, `cameraModel` within the processing cycle.
- Uploading any image populates `MediaItem.width` and `MediaItem.height`.
- Uploading any file populates `MediaItem.contentHash` (SHA-256 hex string).
- Uploading an MP4 populates `MediaItem.durationMs`, `width`, `height`.
- A file without EXIF data (e.g., a screenshot) does not cause the processor to throw; `capturedAt` remains `null`.
- `VideoProbeProcessor.canProcess()` returns `false` for image files; `ExifProcessor.canProcess()` returns `false` for video files.
- The orchestrator is not modified; only new processors are added.
- `npm run typecheck` passes with zero new errors.
- All four processor unit tests pass in isolation without a running storage backend.
- Integration test confirms the sync step writes to `MediaItem` typed columns, not only to `StorageObject.metadata`.

---

## 9. Out of Scope / Deferred

- Thumbnail generation (Phase 03 — uses `sharp` but as a separate processor/service)
- Location reverse-geocoding (Phase 09)
- Low-value media heuristics (Phase 07 — uses dimension data from this phase as input)
- Face recognition (Phase 09)
- Duplicate detection UI (Phase 09 — `contentHash` is the foundation, computed here)
- Processing status push notifications to clients (future WebSocket/SSE work)
