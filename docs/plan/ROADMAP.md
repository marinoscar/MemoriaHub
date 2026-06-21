# MemoriaHub Implementation Roadmap

**Version:** 1.1
**Last Updated:** June 2026

MemoriaHub is a personal media ownership platform that gives families full control over their photos and videos — independent of any single cloud provider. The product vision (see [`../../VISION.MD`](../../VISION.MD)) defines fourteen MVP capabilities spanning upload, metadata extraction, web browsing, CLI import, Android sync, multi-provider storage, replication, export, and long-term enrichment. This roadmap translates that vision into sequenced phases built on top of the already-implemented resumable-upload and event-driven processing backbone, so that every phase adds media-domain value rather than rebuilding infrastructure.

**Phase 01 (Media Domain Foundation) is implemented and deployed at https://memoriahub.dev.marin.cr.**

**Family Circles (Collaboration Foundation) is implemented on branch `feat/family-circles`.** This is a cross-cutting feature that touches the data model, API, web, CLI, and admin backup — it is tracked separately from the numbered phases because it is an architectural foundation rather than an enrichment layer.

**Several enrichment capabilities have since shipped as cross-cutting features ahead of the numbered Phase 09 sequence:** the generic enrichment queue, face recognition and people management, and AI auto-tagging are all deployed. Agentic search (conversational AI with tool-calling) is also live. These realize the core of Phase 09 §4.1 and §4.2. See the Status Tracking table and the Phase 09 Sub-Project Status breakdown below.

**Backbone already in place (satisfies vision item #3 — AWS storage):**
The `S3StorageProvider`, resumable multipart upload flow (`StorageObject` / `StorageObjectChunk`), JSONB `metadata` field, `ObjectProcessor` plugin interface, and `OBJECT_UPLOADED_EVENT` pipeline all exist today. Every enrichment processor described in phases 02 through 09 is a new implementation of that existing interface — no pipeline changes are needed.

---

## Phase Table

| Phase | Title | Primary Surfaces | Key Vision Items | Depends On |
|-------|-------|-----------------|-----------------|------------|
| [01](phase-01-media-domain.md) | Media Domain Foundation | API, DB | #1, #2, #6, #9 | — (backbone) |
| [02](phase-02-metadata-extraction.md) | Metadata Extraction + Reverse Geocoding (Enrichment v1) | API, DB | #2, #11 | 01 |
| [03](phase-03-web-library.md) | Web Media Library | Web, API | #1, #6, #10 | 02 |
| [04](phase-04-metadata-export.md) | Metadata Export | API, Web | #10 | 02 |
| [05](phase-05-cli-importer.md) | CLI Importer | CLI, API | #8, #12 | 02 |
| [06](phase-06-storage-replication.md) | Storage Providers and Replication | API, Infra | #3, #4, #5 | 01 |
| FC | **Family Circles** (collaboration foundation) | API, Web, CLI, DB | #6, #7, #8, #9 | 01–05 |
| [07](phase-07-memory-prioritization.md) | Memory Prioritization | API, Web | #14, #11 | FC, 02, 03 |
| [08](phase-08-android-sync.md) | Android Sync | Android, API | #7 | FC, 02, 03 |
| [09](phase-09-longterm-enrichment.md) | Long-Term Enrichment | API, Web, Infra | #11, #13 | 05, 08 |

> Several cross-cutting enrichment features (Enrichment Queue, Face Recognition, AI Auto-Tagging) have shipped independently of the numbered sequence. See the [Status Tracking](#status-tracking) table and [Phase 09 Sub-Project Status](#phase-09-sub-project-status) below for the per-sub-project breakdown.

---

## Dependency Graph

```
01 (Media Domain)
 |
 +──────────────────────────+
 |                          |
 02 (Metadata Extraction)   06 (Storage Replication)
 |
 +──────────┬──────────────+
 |           |              |
 03 (Web)   04 (Export)   05 (CLI)
 |
 FC (Family Circles — collaboration foundation)
 |
 +──────────────────────────+
 |                          |
 07 (Memory Prioritization)  08 (Android Sync)
                             |
                             09 (Long-Term Enrichment)
```

Full notation:
- 01 is the root; nothing depends on the backbone infrastructure layer
- 06 runs in parallel after 01 (no dependency on 02)
- FC (Family Circles) is implemented after 01–05; it adds circle-scoped data model, per-circle authorization, shared media library, invite flow, web UI, CLI circle commands, and local-drive backup
- 07 depends on FC (review actions are per-circle), 02 (processor infrastructure), and 03 (web review UI)
- 08 depends on FC (Android uploads target a circle), 02 (enrichment pipeline), and 03 (upload client patterns)
- 09 depends on 05 and 08 (ingestion paths mature)

---

## Guiding Principles

The following principles are restated directly from [`../../VISION.MD`](../../VISION.MD) and govern every phase decision:

| Principle | What It Means for the Roadmap |
|-----------|-------------------------------|
| **Ownership First** | No phase introduces lock-in; media and metadata remain exportable at every stage |
| **Family Memories First** | Phase 07 (prioritization) is mandatory MVP, not a future nicety |
| **Provider Independence** | Phase 06 adds local storage and replication so AWS is never the only option |
| **Open Metadata** | Phase 02 extracts into typed columns + JSONB (including location reverse-geocoding for country/region/city); Phase 04 exports in JSON and CSV |
| **Extensible Enrichment** | Every processor is a new `ObjectProcessor` — the orchestrator never changes |
| **Simple Export and Exit** | Phase 04 export is a first-class deliverable, not an afterthought |

---

## Status Tracking

| Phase | Title | Status |
|-------|-------|--------|
| 01 | Media Domain Foundation | Done |
| 02 | Metadata Extraction | Done |
| 03 | Web Media Library | Done |
| 04 | Metadata Export | Done |
| 05 | CLI Importer | Done — upgraded in 05.1 with SQLite-backed multi-folder sync and interactive Ink TUI |
| 06 | Storage Providers and Replication | Partial — `LocalDiskStorageProvider` shipped (`apps/api/src/storage/providers/local/`) with runtime `STORAGE_PROVIDER=s3\|local` selection; S3 was already done. The `StorageLocation`/`StorageObjectLocation` registry models, `ReplicationService` cron, admin `/api/storage/locations` endpoints, and `AzureStorageProvider` are not started. |
| FC | Family Circles | Done — circle data model, per-circle RBAC, shared library, invite flow, web CircleSwitcher + admin pages, CLI circles/backup commands, LocalDiskStorageProvider, admin backup job |
| EQ | **Enrichment Queue** (cross-cutting) | Done — generic `enrichment_jobs` table + `EnrichmentJobWorker` + handler registry (`apps/api/src/enrichment/`); admin job-queue dashboard at `/admin/jobs` with stats, list, retry, reset-stuck, and delete. Shared infrastructure for all future Phase 09 processors. See [docs/specs/enrichment-queue.md](../specs/enrichment-queue.md). |
| FR | **Face Recognition & People** (cross-cutting — realizes Phase 09 §4.1) | Done — `Person`/`Face`/`MediaFaceStatus` models, three providers (human WASM 1024-d, CompreFace 128-d, Rekognition), face detection handler in enrichment queue, clustering/merge, `/api/people` + `/api/media/:id/faces` endpoints, PeoplePage + UnknownFacesReview web UI, per-circle opt-in. See [docs/specs/face-recognition.md](../specs/face-recognition.md). |
| AT | **AI Auto-Tagging** (cross-cutting — realizes Phase 09 §4.2) | Done — vocabulary-driven vision-model tagging: `TagLabel` global vocabulary + `MediaTagStatus`, `source` column (manual\|ai) on media_tags, auto-tagging handler in enrichment queue, `/api/tag-labels` CRUD + `/api/tagging/backfill`, per-circle opt-in, admin TagsPage UI. See [docs/specs/auto-tagging.md](../specs/auto-tagging.md). |
| AI | **Agentic Search + AI Settings** (cross-cutting) | Done — deterministic `POST /api/search`, conversational SSE search with tool-calling loop, AI provider registry (Anthropic / OpenAI), admin credential management with AES-256-GCM encryption at rest, conversation lifecycle cron. See [docs/specs/agentic-search.md](../specs/agentic-search.md). |
| 07 | Memory Prioritization | Removed — `MediaClassification` enum and `media_items.classification` column were added in Phase 01 and partially surfaced in bulk editing and the review-queue UI, but the full automatic heuristic processors and dedicated review mode were never completed. The classification feature has since been removed entirely (schema column dropped, enum deleted, API filter and UI removed). |
| 08 | Android Sync | Not Started — server-side `MediaSource` enum reserves the `android` value; no `apps/android/` client exists. |
| 09 | Long-Term Enrichment | Partial — §4.1 (Face Recognition) and §4.2 (AI Auto-Tagging) are done as cross-cutting features; §4.3 Tier-1 (exact dedup) is done; §4.6 (video thumbnails) is done. §4.3 Tier-2, §4.4, §4.5, §4.7, and §4.8 are not started. See Phase 09 Sub-Project Status below. |

### Phase 09 Sub-Project Status

Phase 09 (Long-Term Enrichment) is a collection of independent sub-projects. Several have shipped ahead of schedule as cross-cutting features.

| Sub-Project | Vision / Spec | Status | Notes |
|-------------|---------------|--------|-------|
| §4.1 Face Recognition | [docs/specs/face-recognition.md](../specs/face-recognition.md) | Done | Three providers (human WASM, CompreFace, Rekognition); circle-scoped; people clustering/merge; full web UI. Implemented beyond the original sketch — circle-scoped, real provider integrations (not face-api.js). |
| §4.2 Object & Scene Detection | [docs/specs/auto-tagging.md](../specs/auto-tagging.md) | Done (reframed as AI Auto-Tagging) | Vocabulary-driven vision-model tagging replaces the original object/scene detection sketch; per-circle opt-in; admin tag vocabulary management. |
| §4.3 Duplicate Detection | — | Partial | Tier-1 exact/byte-identical dedup done (content_hash unique constraint, idempotent upload, CLI hash cache, web pre-check). Tier-2 perceptual-hash processor + `DuplicateReviewPage` not started. |
| §4.4 Platform Import Paths | — | Not Started | Google Photos Takeout, OneDrive, Dropbox, Apple Photos imports not started. Generic local-folder CLI sync exists (Phase 05). |
| §4.5 Azure Storage Provider | — | Not Started | S3 and LocalDisk only; Azure provider not started. |
| §4.6 Video Thumbnail Generation | — | Done | `ThumbnailProcessor` extracts poster frame via fluent-ffmpeg for video MIME types; `video-probe.processor.ts` reads ffprobe metadata. |
| §4.7 Landmark / POI Refinement | — | Not Started | Reverse geocoding to country/region/city/place exists (Phase 02); no dedicated POI-refinement processor. |
| §4.8 Trip & Event Grouping | — | Not Started | No `TripGroupingService`, no `autoGenerated` Album flag. |

---

## Vision Item Traceability

| Vision Item | Description (abbreviated) | Phase(s) |
|-------------|--------------------------|---------|
| #1 | Upload and store photos and videos | 01, 03 |
| #2 | Extract and store key media metadata (incl. location reverse-geocoding for country/region/city search) | 01, 02 |
| #3 | AWS storage as first cloud option | Already done (backbone) |
| #4 | Future Azure and other provider support | 06 |
| #5 | Sync with local hard drives or network storage | 06, FC (LocalDiskStorageProvider + backup job) |
| #6 | Web application for browsing, uploading, managing | 01, 03, FC (circle-scoped library) |
| #7 | Android app for mobile sync | 08 (circle-scoped from day one) |
| #8 | CLI for importing and syncing from a computer | 05, FC (circle commands + backup) |
| #9 | API support for external tools and automations | 01, FC (circles + backup API) |
| #10 | Metadata export in JSON and CSV | 03, 04 |
| #11 | Future processor extensibility | 02, 07, 09 |
| #12 | Import from local folders and exported libraries | 05 |
| #13 | Long-term import from Google Photos, OneDrive, etc. | 09 |
| #14 | Distinguish meaningful memories from low-value media | 07 |

---

## Related Documents

| Document | Purpose |
|----------|---------|
| [`../../VISION.MD`](../../VISION.MD) | Full product vision and MVP definition |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | System architecture — storage subsystem, module patterns |
| [`../API.md`](../API.md) | Existing API endpoint reference |
| [`../DEVELOPMENT.md`](../DEVELOPMENT.md) | Development setup and conventions |
| [`../TESTING.md`](../TESTING.md) | Testing patterns and frameworks |
