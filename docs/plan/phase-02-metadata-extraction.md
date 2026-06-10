# Phase 02 — Metadata Extraction (Enrichment v1)

**Roadmap:** [ROADMAP.md](ROADMAP.md)
**Previous Phase:** [Phase 01 — Media Domain Foundation](phase-01-media-domain.md)
**Next Phase:** [Phase 03 — Web Media Library](phase-03-web-library.md) · [Phase 04 — Metadata Export](phase-04-metadata-export.md) · [Phase 05 — CLI Importer](phase-05-cli-importer.md)
**Status:** Done

---

## 1. Goal

Implement the first wave of post-upload enrichment processors to automatically extract EXIF data, image dimensions, video properties, and content hashes from every uploaded photo and video. Each extractor is a new implementation of the existing `ObjectProcessor` interface and is registered via NestJS dependency injection — no changes to the processing orchestrator are required. Extracted values are written into `StorageObject.metadata` (JSONB) and then synced into the typed `MediaItem` columns defined in Phase 01.

---

## 2. Vision Mapping

| Vision Item | Relevant Section in VISION.MD |
|-------------|-------------------------------|
| #2 — Extract and store key media metadata | "Metadata Management", "Media Processing and Enrichment" |
| #2 — Open Metadata (Location) | "Open Metadata" — location data extracted and stored in first-class typed columns, enabling location-based search |
| #11 — Allow future processors to enrich photos and videos | "Extensible Enrichment" — this phase proves the processor model with real extractors |

From the vision: _"MemoriaHub should store metadata in a structured way so the application can organize, search, process, and export media information."_ The typed columns added in Phase 01 are populated here for the first time. Vision item #11 is fulfilled at the architectural level in Phase 01 (the `ObjectProcessor` interface exists); this phase delivers the first concrete processors. Location reverse-geocoding lands here — not in Phase 09 — because location-based search ("pics in California", "pics in Costa Rica") is a first-class user capability, not a long-term enhancement.

---

## 3. What We Reuse

| Existing File | How It Is Reused |
|---------------|-----------------|
| `apps/api/src/storage/processing/object-processor.interface.ts` | Each new extractor implements `ObjectProcessor` (`name`, `priority`, `canProcess`, `process`) |
| `apps/api/src/storage/processing/object-processing.service.ts` | Orchestrator unchanged; new processors registered via NestJS DI are picked up automatically |
| `apps/api/src/storage/processing/processors/example-metadata.processor.ts` | Reference implementation; new processors follow identical structure |
| `apps/api/src/storage/objects/objects.service.ts` | `getStream()` callback passed to each processor to stream bytes from the storage provider |
| `apps/api/src/storage/providers/storage-provider.interface.ts` | Pluggable provider pattern mirrored by the new `GeoLocationProvider` interface (see Section 4) |
| `apps/api/src/media/media.service.ts` (Phase 01) | `syncMetadataToMediaItem()` method called after processors write to `StorageObject.metadata` |
| `apps/api/prisma/schema.prisma` | `MediaItem` typed columns (`capturedAt`, `width`, `height`, `durationMs`, `takenLat`, `takenLng`, `cameraMake`, `cameraModel`, `contentHash`, and all `geo*` columns) populated by the sync step |

---

## 4. Scope / Deliverables

- A pluggable **`GeoLocationProvider` interface** (`apps/api/src/media/geo/geo-location-provider.interface.ts`), mirroring the existing `StorageProvider` pattern:

```typescript
export interface GeoLocationProvider {
  reverseGeocode(lat: number, lng: number): Promise<{
    country?: string;
    countryCode?: string;   // ISO 3166-1 alpha-2
    admin1?: string;        // state / province
    admin2?: string;        // county / canton
    locality?: string;      // city / town
    placeName?: string;     // POI / landmark / display label
  } | null>;
}
```

- Two provider implementations:
  - **`OfflineGeoLocationProvider` (default)** — uses the `local-reverse-geocoder` npm package (GeoNames dataset, loaded at startup). No network calls, no per-request cost, no rate limits, and GPS coordinates never leave the server — aligned with MemoriaHub's ownership/privacy ethos. Resolves country → state/region → city reliably. **Note:** landmark/POI naming (e.g., "Yosemite National Park") is limited offline; fine-grained POI resolution is a Phase 09 enhancement.
  - **`NominatimGeoLocationProvider` (optional, env-selectable)** — calls an external geocoding service (OSM Nominatim, Mapbox, or Google) for finer POI/landmark resolution. **IMPORTANT:** enabling this provider sends photo GPS coordinates to a third-party service; document the privacy tradeoff prominently in configuration. Provider chosen by `GEO_PROVIDER` env var (default: `offline`), mirroring how the storage provider is wired in `storage-providers.module.ts`.

- Five new `ObjectProcessor` implementations, each in `apps/api/src/storage/processing/processors/`:
  1. `ContentHashProcessor` — SHA-256 over the raw byte stream (priority 10, runs first)
  2. `ExifProcessor` — extracts `capturedAt`, GPS coordinates, `cameraMake`, `cameraModel`, EXIF orientation, `capturedAtOffset` from image files (priority 20)
  3. `ImageDimensionsProcessor` — extracts `width` and `height` from image files (priority 25)
  4. `VideoProbeProcessor` — extracts `durationMs`, `width`, `height`, codec from video files (priority 20)
  5. `ReverseGeocodeProcessor` — reads `takenLat`/`takenLng` from the just-extracted EXIF data, calls the configured `GeoLocationProvider`, and writes `geoCountry`, `geoCountryCode`, `geoAdmin1`, `geoAdmin2`, `geoLocality`, `geoPlaceName`, `geoSource`, `geocodedAt` onto the `MediaItem` via the metadata-sync step (priority 30, runs after `ExifProcessor`; no-ops if no GPS present)

- A `MediaMetadataSyncService` (or a hook in `MediaService`) that reads the populated `StorageObject.metadata` after all processors complete and writes the typed values into the corresponding `MediaItem` columns (including all `geo*` columns)
- New npm dependencies in `apps/api/package.json`: `exifr`, `sharp`, `fluent-ffmpeg` (+ `@types/fluent-ffmpeg`), `local-reverse-geocoder`
- `ffmpeg` binary added to `apps/api/Dockerfile`
- Unit tests for each processor
- Integration test verifying the full enrichment-to-MediaItem-sync cycle, including geo column population

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
    "capturedAtOffset": -360,
    "latitude": 9.9281,
    "longitude": -84.0907,
    "altitude": 1247.5,
    "cameraMake": "Apple",
    "cameraModel": "iPhone 15 Pro",
    "orientation": 6
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
  },
  "geocode": {
    "country": "Costa Rica",
    "countryCode": "CR",
    "admin1": "Alajuela",
    "admin2": null,
    "locality": "La Fortuna",
    "placeName": null,
    "source": "geonames-offline",
    "geocodedAt": "2024-06-15T10:35:00Z"
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
| 1 | Add `exifr`, `sharp`, `fluent-ffmpeg`, `@types/fluent-ffmpeg`, `local-reverse-geocoder` to `apps/api/package.json`; add `RUN apt-get install -y ffmpeg` to `apps/api/Dockerfile` | `backend-dev` |
| 2 | Define `GeoLocationProvider` interface in `apps/api/src/media/geo/geo-location-provider.interface.ts`; implement `OfflineGeoLocationProvider` using `local-reverse-geocoder` (GeoNames dataset, loads at startup); implement optional `NominatimGeoLocationProvider` for external geocoding; wire provider selection via `GEO_PROVIDER` env var in a `GeoLocationModule` (mirror `storage-providers.module.ts` pattern) | `backend-dev` |
| 3 | Implement `ContentHashProcessor` (priority 10): stream bytes, compute SHA-256 with Node `crypto`, write `metadata.contentHash.sha256`; register in `storage.module.ts` | `backend-dev` |
| 4 | Implement `ExifProcessor` (priority 20): call `exifr.parse()` on the stream, extract `DateTimeOriginal`, `GPSLatitude`, `GPSLongitude`, `GPSAltitude`, `Make`, `Model`, orientation tag, UTC offset; write to `metadata.exif`; `canProcess` returns true for `image/*` mime types | `backend-dev` |
| 5 | Implement `ImageDimensionsProcessor` (priority 25): use `sharp(buffer).metadata()` to get width/height; write to `metadata.dimensions`; `canProcess` returns true for `image/*` | `backend-dev` |
| 6 | Implement `VideoProbeProcessor` (priority 20): use `fluent-ffmpeg.ffprobe()` to get duration, video stream width/height, codec; write to `metadata.videoProbe`; `canProcess` returns true for `video/*` | `backend-dev` |
| 7 | Implement `ReverseGeocodeProcessor` (priority 30, after `ExifProcessor`): read `takenLat`/`takenLng` from `StorageObject.metadata.exif`; call `GeoLocationProvider.reverseGeocode()`; write results to `metadata.geocode` including `source` and `geocodedAt`; no-op if GPS absent; `canProcess` returns true for `image/*` | `backend-dev` |
| 8 | Implement `MediaMetadataSyncService.sync(storageObjectId)` that reads `StorageObject.metadata` and upserts all typed columns on the linked `MediaItem`, including `geoCountry`, `geoCountryCode`, `geoAdmin1`, `geoAdmin2`, `geoLocality`, `geoPlaceName`, `geoSource`, `geocodedAt`, `orientation`, and `capturedAtOffset`; call this from `ObjectProcessingService` after all processors have run. **Note (as built):** the sync is triggered via an `OBJECT_PROCESSED_EVENT` listener inside `MediaMetadataSyncService` rather than a direct call from the orchestrator, to avoid a circular dependency. | `backend-dev` |
| 9 | Register all five processors as providers in `storage.module.ts` (follow the pattern used for `ExampleMetadataProcessor`) | `backend-dev` |
| 10 | Write unit tests for each processor; mock the `getStream` callback to return a fixture byte buffer; mock `GeoLocationProvider` in `ReverseGeocodeProcessor` tests | `testing-dev` |
| 11 | Write integration test: upload a test image with GPS EXIF → verify `MediaItem.capturedAt`, `width`, `height`, `contentHash`, `geoCountry`, `geoAdmin1`, `geoLocality` are populated after event processing; upload a test video → verify `durationMs` populated; upload a GPS-free image → verify `geocodedAt` remains null | `testing-dev` |
| 12 | Update `docs/plan/ROADMAP.md` status for Phase 02 | `docs-dev` |

---

## 8. Acceptance Criteria

- Uploading a JPEG with valid EXIF populates `MediaItem.capturedAt`, `takenLat`, `takenLng`, `cameraMake`, `cameraModel`, `orientation`, `capturedAtOffset` within the processing cycle.
- Uploading a JPEG with GPS EXIF populates `MediaItem.geoCountry`, `geoCountryCode`, `geoAdmin1`, `geoLocality`, and `geocodedAt` using the default offline provider; GPS coordinates do not leave the server when the offline provider is active.
- Uploading a JPEG without GPS data leaves all `geo*` columns null; `ReverseGeocodeProcessor` completes without error.
- Uploading any image populates `MediaItem.width` and `MediaItem.height`.
- Uploading any file populates `MediaItem.contentHash` (SHA-256 hex string).
- Uploading an MP4 populates `MediaItem.durationMs`, `width`, `height`.
- A file without EXIF data (e.g., a screenshot) does not cause any processor to throw; `capturedAt` remains `null`.
- `VideoProbeProcessor.canProcess()` returns `false` for image files; `ExifProcessor.canProcess()` returns `false` for video files; `ReverseGeocodeProcessor.canProcess()` returns `false` for video files.
- The orchestrator is not modified; only new processors are added.
- `npm run typecheck` passes with zero new errors.
- All five processor unit tests pass in isolation without a running storage backend or network connection.
- Integration test confirms the sync step writes to `MediaItem` typed columns (including `geo*`), not only to `StorageObject.metadata`.

---

## 9. Out of Scope / Deferred

- Thumbnail generation (Phase 03 — uses `sharp` but as a separate processor/service)
- Fine-grained POI/landmark enrichment beyond the default offline geocoder (Phase 09 — the offline provider resolves country/region/city well; specific landmark naming such as "Yosemite National Park" may require the optional external provider or a Phase 09 refinement pass)
- Trip/event grouping — auto-clustering a date-range and location into a named trip (Phase 09 — distinct from location filtering, which is covered here)
- Low-value media heuristics (Phase 07 — uses dimension data from this phase as input)
- Face recognition (Phase 09)
- Duplicate detection UI (Phase 09 — `contentHash` is the foundation, computed here)
- Processing status push notifications to clients (future WebSocket/SSE work)
