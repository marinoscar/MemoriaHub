# Phase 09 — Long-Term Enrichment

**Roadmap:** [ROADMAP.md](ROADMAP.md)
**Previous Phase:** [Phase 05 — CLI Importer](phase-05-cli-importer.md) · [Phase 08 — Android Sync](phase-08-android-sync.md)
**Next Phase:** (long-term horizon; no single next phase)
**Status:** Not Started

---

## 1. Goal

Extend MemoriaHub with the intelligence and platform integrations described in the "Future Search and Enrichment Capabilities" and "Long-Term Vision" sections of VISION.MD. Every capability outlined here is a new `ObjectProcessor`, a new `StorageProvider`, or a new import-path module — all reusing the established extension points from earlier phases. Nothing in this phase requires changing the processing orchestrator, storage interface, or upload pipeline.

**IMPORTANT:** This phase is a planning sketch. Each bullet below represents a distinct sub-project that should be planned, estimated, and committed to a worktree independently when prioritized. The items are grouped here for reference only.

---

## 2. Vision Mapping

| Vision Item | Relevant Section in VISION.MD |
|-------------|-------------------------------|
| #11 — Extensible enrichment processors | "Future Search and Enrichment Capabilities" |
| #13 — Long-term import from Google Photos, OneDrive, Apple, Dropbox | "Importing From Existing Platforms", "Long-Term Vision" |

All items in this phase map to the "Long-Term Vision" section: _"Over time, MemoriaHub can become a complete personal memory platform."_

**Note:** Basic reverse geocoding (country / state-region / city) was moved to Phase 02 because location-based search is a first-class user capability, not a long-term enhancement. What remains in Phase 09 is (a) fine-grained POI/landmark naming beyond the default offline geocoder, and (b) trip/event grouping — auto-clustering a date range and place into a named trip. These are distinct from, and complementary to, the location filtering that Phase 01/02 deliver.

---

## 3. What We Reuse

Every item in this phase reuses one or more of these established extension points:

| Extension Point | Reused By |
|-----------------|-----------|
| `ObjectProcessor` interface (`apps/api/src/storage/processing/object-processor.interface.ts`) | Face recognition, object detection, video thumbnail, landmark refinement, duplicate detection |
| `GeoLocationProvider` interface (Phase 02, `apps/api/src/media/geo/`) | Landmark/POI refinement processor — swaps in a finer provider or re-geocodes with POI resolution |
| `StorageProvider` interface (`apps/api/src/storage/providers/storage-provider.interface.ts`) | Azure provider, additional cloud providers |
| Phase 05 CLI resumable upload + manifest | Google Photos Takeout import, OneDrive/Dropbox import |
| Phase 02 `contentHash` on `MediaItem` | Duplicate detection grouping |
| Phase 02 `geoCountry` / `geoAdmin1` / `geoLocality` on `MediaItem` | Trip/event grouping — location is already populated; this phase clusters by date + place into named trips |
| Phase 01 `MediaItem.metadata` JSONB | All processors write their results here |

---

## 4. Scope / Deliverables

### 4.1 Face Recognition — Search by Person

**New `ObjectProcessor`:** `FaceRecognitionProcessor`
- Runs an embedded face detection model (e.g., `face-api.js` backed by TensorFlow.js, or a sidecar Python service) against each uploaded image
- Writes detected face embeddings and bounding boxes to `MediaItem.metadata.faces`

**New Prisma models:**

```prisma
model Person {
  id          String        @id @default(uuid())
  ownerId     String
  owner       User          @relation(fields: [ownerId], references: [id])
  name        String
  createdAt   DateTime      @default(now())
  mediaFaces  MediaPerson[]

  @@index([ownerId])
  @@map("persons")
}

model MediaPerson {
  id          String    @id @default(uuid())
  mediaItemId String
  mediaItem   MediaItem @relation(fields: [mediaItemId], references: [id], onDelete: Cascade)
  personId    String
  person      Person    @relation(fields: [personId], references: [id])
  confidence  Float
  boundingBox Json

  @@unique([mediaItemId, personId])
  @@map("media_persons")
}
```

**New API endpoint:** `GET /api/media?personId=<uuid>` — filters `MediaItem` by linked `Person`.

**Deferred note:** `Person` and `MediaPerson` models were explicitly excluded from Phase 01. They are created here.

---

### 4.2 Object and Scene Detection

**New `ObjectProcessor`:** `ObjectDetectionProcessor`
- Uses a pre-trained COCO-SSD or similar model via TensorFlow.js or a sidecar service
- Writes detected labels and confidence scores to `MediaItem.metadata.detectedObjects`

**API enhancement:** `GET /api/media?tag=beach` — full-text or exact match against `metadata.detectedObjects`

---

### 4.3 Duplicate Detection and Cleanup

**New `ObjectProcessor`:** `PerceptualHashProcessor`
- Computes a perceptual hash (pHash) of each image using `sharp` + a pHash library
- Writes `MediaItem.metadata.pHash`

**New service:** `DuplicateDetectionService`
- Cron task: queries `MediaItem` records and groups items with a Hamming distance ≤ 5 between pHash values
- Writes `MediaItem.metadata.duplicateGroupId`

**Web review UI:** new `DuplicateReviewPage` showing side-by-side groups; user picks which copy to keep; deletes the rest via `POST /api/media/review`

**Note:** Exact-duplicate detection (same SHA-256 `contentHash`) already works from Phase 02 / Phase 05. **Tier-1 exact/byte-identical deduplication shipped** on branch `feat/reliable-dedup` (migration `20260612000000_add_media_content_hash_unique`, `POST /api/media` idempotent registration, web pre-check, CLI hash cache + `contentHash` registration, and P2002 race handling). This phase adds **tier-2 near-duplicate detection** via perceptual hashing — visually similar but not byte-identical files.

---

### 4.4 Platform Import Paths

Each import path is a new CLI subcommand (`memoriaHub import-google`, etc.) or a standalone import service, reusing the Phase 05 upload helpers and manifest tracking:

| Import Source | Approach |
|--------------|---------|
| **Google Photos Takeout** | Parse the Takeout ZIP structure; read `*.json` sidecar files for metadata (date, location, description); map to `MediaItem` fields; upload via resumable API |
| **OneDrive** | OAuth2 + Microsoft Graph API; enumerate `Photos` drive items; download and upload via resumable API |
| **Apple Photos (iCloud)** | Export via `osxphotos` CLI on macOS; MemoriaHub CLI reads the export folder; maps `.AAE` sidecar metadata |
| **Dropbox** | Dropbox API v2; enumerate media files; download and upload |
| **Local folder (already done)** | Phase 05 |

---

### 4.5 Azure Storage Provider

**New `StorageProvider`:** `AzureStorageProvider`
- Implements `StorageProvider` using `@azure/storage-blob` SDK
- Configured via `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_KEY`, `AZURE_CONTAINER_NAME` env vars
- Selected via `STORAGE_PROVIDER=azure`

---

### 4.6 Video Thumbnail Generation

**New `ObjectProcessor`:** `VideoThumbnailProcessor`
- Uses `fluent-ffmpeg` (already in the API image from Phase 02) to extract a frame at the 10% mark of the video duration
- Uploads the frame as a thumbnail `StorageObject` (same pattern as `ThumbnailProcessor` from Phase 03)
- Writes `MediaItem.metadata.thumbnailUrl` for video items

---

### 4.7 Landmark/POI Refinement

**Context:** Basic reverse geocoding (country → state/region → city) already lands in Phase 02 via `ReverseGeocodeProcessor` and `OfflineGeoLocationProvider`. This sub-project addresses the one gap in offline geocoding: fine-grained point-of-interest and landmark naming (e.g., resolving "37.865°N, 119.538°W" to "Yosemite National Park" rather than just "Mariposa County, California").

**New `ObjectProcessor`:** `LandmarkRefinementProcessor`
- Runs only for items where `geoPlaceName` is null and `takenLat`/`takenLng` are present (i.e., items that were geocoded offline but did not receive a landmark name)
- Calls `GeoLocationProvider.reverseGeocode()` with a more capable provider (external Nominatim, Mapbox, or Google Places) that returns POI/landmark data
- Updates `MediaItem.geoPlaceName`, `geoSource`, and `geocodedAt` only if a landmark name is resolved; leaves other geo columns unchanged

**IMPORTANT:** This processor contacts an external service and sends GPS coordinates over the network. It must only be enabled when the operator has explicitly opted in via `GEO_PROVIDER=nominatim` (or equivalent). Privacy tradeoff must be documented in the configuration guide.

**API:** no new endpoint required — `geoPlaceName` is already a first-class column and is included in the existing `?place=` and `?location=` filter params from Phase 01.

---

### 4.8 Trip and Event Grouping

**Context:** Location-based search ("all photos from Costa Rica") is available from Phase 01/02. This sub-project adds a higher-level concept: automatically recognising that a cluster of photos taken in the same place over a multi-day window represents a named trip or event (e.g., "Trip to Costa Rica, March 2025"), and surfacing it as a browseable unit.

**New service:** `TripGroupingService`
- Cron task: clusters `MediaItem` records by `capturedAt` proximity (gap > 48 hours = new event boundary) and `geoAdmin1` / `geoLocality` proximity
- Creates `Album` records automatically labeled by date range + location (e.g., "La Fortuna · March 14–18 2025")
- Albums created by the service carry a flag `autoGenerated = true`; users can rename, merge, or delete them; auto-generated albums are not re-created if deleted

**Distinction from location filtering:** `?location=Costa Rica` returns individual items. A trip album groups those items into a named, browseable collection with a date-range label. These are complementary, not overlapping.

---

## 5. Data Model Changes

See Section 4.1 for `Person` and `MediaPerson` models. Other items in this phase extend `MediaItem.metadata` JSONB only — no additional migrations beyond `Person`/`MediaPerson`.

---

## 6. API Endpoints

| New Endpoint | Phase-09 Feature |
|-------------|-----------------|
| `GET /api/media?personId=<uuid>` | Face recognition search |
| `GET /api/media?tag=<label>` | Object/scene tag search |
| `GET /api/persons` | List known persons |
| `POST /api/persons` | Create a named person |
| `PATCH /api/persons/:id` | Rename a person |
| `GET /api/media/duplicates` | List duplicate groups |

---

## 7. Implementation Steps

Because each sub-project in this phase is a standalone workstream, implementation steps are listed per sub-project. Each should be executed as a separate worktree branch when prioritized.

| Sub-Project | First Steps | Subagents |
|-------------|-------------|-----------|
| Face recognition | Evaluate TF.js vs. sidecar; add `Person`/`MediaPerson` migration; implement `FaceRecognitionProcessor`; add search endpoint | `database-dev`, `backend-dev`, `frontend-dev`, `testing-dev` |
| Object detection | Add `ObjectDetectionProcessor`; add tag-search filter to `GET /api/media` | `backend-dev`, `testing-dev` |
| Duplicate detection | Add `PerceptualHashProcessor`; implement `DuplicateDetectionService`; build `DuplicateReviewPage` | `backend-dev`, `frontend-dev`, `testing-dev` |
| Platform imports | One sub-project per platform; each extends Phase 05 CLI | `backend-dev`, `testing-dev` |
| Azure provider | Add `AzureStorageProvider`; update provider module wiring | `backend-dev`, `testing-dev` |
| Video thumbnails | Add `VideoThumbnailProcessor` | `backend-dev`, `testing-dev` |
| Landmark/POI refinement | Add `LandmarkRefinementProcessor` (opt-in, external provider only); document privacy tradeoff in configuration guide | `backend-dev`, `testing-dev` |
| Trip grouping | Add `TripGroupingService` cron task; add `autoGenerated` flag to `Album` model; build trip browsing UI | `database-dev`, `backend-dev`, `frontend-dev`, `testing-dev` |

---

## 8. Acceptance Criteria

Each sub-project defines its own acceptance criteria when planned. The shared acceptance bar for any Phase 09 sub-project:

- Implemented as an `ObjectProcessor` (for enrichment) or a `StorageProvider` (for storage) — no changes to the orchestrator or upload pipeline
- Unit tests for the new processor/provider
- Integration test for the end-to-end path (upload → enrich → query)
- `MediaItem.metadata` JSONB shape documented in a comment or schema note
- `npm run typecheck` passes
- `docs/plan/ROADMAP.md` status updated

---

## 9. Out of Scope / Deferred

- Real-time AI inference in the request path (all AI enrichment is async post-upload)
- Collaborative family accounts or shared albums (out of scope per VISION.MD)
- Advanced photo editing (out of scope per VISION.MD)
- Social sharing / public albums (out of scope per VISION.MD)
- Printed photo products (out of scope per VISION.MD)
