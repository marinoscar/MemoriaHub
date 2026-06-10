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

---

## 3. What We Reuse

Every item in this phase reuses one or more of these established extension points:

| Extension Point | Reused By |
|-----------------|-----------|
| `ObjectProcessor` interface (`apps/api/src/storage/processing/object-processor.interface.ts`) | Face recognition, object detection, video thumbnail, location enrichment, duplicate detection |
| `StorageProvider` interface (`apps/api/src/storage/providers/storage-provider.interface.ts`) | Azure provider, additional cloud providers |
| Phase 05 CLI resumable upload + manifest | Google Photos Takeout import, OneDrive/Dropbox import |
| Phase 02 `contentHash` on `MediaItem` | Duplicate detection grouping |
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

**Note:** Exact-duplicate detection (same SHA-256 `contentHash`) already works from Phase 02 / Phase 05. This phase adds near-duplicate detection via perceptual hashing.

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

### 4.7 Location Enrichment

**New `ObjectProcessor`:** `LocationEnrichmentProcessor`
- Reverse-geocodes `takenLat` / `takenLng` (from Phase 02 EXIF) using a self-hosted Nominatim instance or a configured third-party geocoding API
- Writes `MediaItem.metadata.location`: `{ city, country, region, displayName }`

**API enhancement:** `GET /api/media?country=Costa Rica` filter against enriched location

---

### 4.8 Timeline and Event Grouping

**New service:** `EventGroupingService`
- Cron task: clusters `MediaItem` records by `capturedAt` proximity (gap > 48 hours = new event) and `takenLat`/`takenLng` proximity
- Creates `Album` records automatically (labeled by date range + location if available)
- Albums created by the service are flagged as `auto_generated`; users can rename, merge, or delete them

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
| Location enrichment | Add `LocationEnrichmentProcessor`; configure geocoding service | `backend-dev`, `testing-dev` |
| Event grouping | Add `EventGroupingService` cron task | `backend-dev`, `frontend-dev`, `testing-dev` |

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
