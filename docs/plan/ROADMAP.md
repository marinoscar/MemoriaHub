# MemoriaHub Implementation Roadmap

**Version:** 1.0
**Last Updated:** June 2026

MemoriaHub is a personal media ownership platform that gives families full control over their photos and videos — independent of any single cloud provider. The product vision (see [`../../VISION.MD`](../../VISION.MD)) defines fourteen MVP capabilities spanning upload, metadata extraction, web browsing, CLI import, Android sync, multi-provider storage, replication, export, and long-term enrichment. This roadmap translates that vision into nine sequenced phases built on top of the already-implemented resumable-upload and event-driven processing backbone, so that every phase adds media-domain value rather than rebuilding infrastructure.

**Backbone already in place (satisfies vision item #3 — AWS storage):**
The `S3StorageProvider`, resumable multipart upload flow (`StorageObject` / `StorageObjectChunk`), JSONB `metadata` field, `ObjectProcessor` plugin interface, and `OBJECT_UPLOADED_EVENT` pipeline all exist today. Every enrichment processor described in phases 02 through 09 is a new implementation of that existing interface — no pipeline changes are needed.

---

## Phase Table

| Phase | Title | Primary Surfaces | Key Vision Items | Depends On |
|-------|-------|-----------------|-----------------|------------|
| [01](phase-01-media-domain.md) | Media Domain Foundation | API, DB | #1, #2, #6, #9 | — (backbone) |
| [02](phase-02-metadata-extraction.md) | Metadata Extraction (Enrichment v1) | API, DB | #2, #11 | 01 |
| [03](phase-03-web-library.md) | Web Media Library | Web, API | #1, #6, #10 | 02 |
| [04](phase-04-metadata-export.md) | Metadata Export | API, Web | #10 | 02 |
| [05](phase-05-cli-importer.md) | CLI Importer | CLI, API | #8, #12 | 02 |
| [06](phase-06-storage-replication.md) | Storage Providers and Replication | API, Infra | #3, #4, #5 | 01 |
| [07](phase-07-memory-prioritization.md) | Memory Prioritization | API, Web | #14, #11 | 02, 03 |
| [08](phase-08-android-sync.md) | Android Sync | Android, API | #7 | 02, 03 |
| [09](phase-09-longterm-enrichment.md) | Long-Term Enrichment | API, Web, Infra | #11, #13 | 05, 08 |

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
 07 (Memory Prioritization)
 |
 08 (Android Sync)
 |
 09 (Long-Term Enrichment)
```

Full notation:
- 01 is the root; nothing depends on the backbone infrastructure layer
- 06 runs in parallel after 01 (no dependency on 02)
- 07 depends on both 02 (processor infrastructure) and 03 (web review UI)
- 08 depends on 02 (enrichment pipeline) and 03 (upload client patterns)
- 09 depends on 05 and 08 (ingestion paths mature)

---

## Guiding Principles

The following principles are restated directly from [`../../VISION.MD`](../../VISION.MD) and govern every phase decision:

| Principle | What It Means for the Roadmap |
|-----------|-------------------------------|
| **Ownership First** | No phase introduces lock-in; media and metadata remain exportable at every stage |
| **Family Memories First** | Phase 07 (prioritization) is mandatory MVP, not a future nicety |
| **Provider Independence** | Phase 06 adds local storage and replication so AWS is never the only option |
| **Open Metadata** | Phase 02 extracts into typed columns + JSONB; Phase 04 exports in JSON and CSV |
| **Extensible Enrichment** | Every processor is a new `ObjectProcessor` — the orchestrator never changes |
| **Simple Export and Exit** | Phase 04 export is a first-class deliverable, not an afterthought |

---

## Status Tracking

| Phase | Title | Status |
|-------|-------|--------|
| 01 | Media Domain Foundation | Not Started |
| 02 | Metadata Extraction | Not Started |
| 03 | Web Media Library | Not Started |
| 04 | Metadata Export | Not Started |
| 05 | CLI Importer | Not Started |
| 06 | Storage Providers and Replication | Not Started |
| 07 | Memory Prioritization | Not Started |
| 08 | Android Sync | Not Started |
| 09 | Long-Term Enrichment | Not Started |

---

## Vision Item Traceability

| Vision Item | Description (abbreviated) | Phase(s) |
|-------------|--------------------------|---------|
| #1 | Upload and store photos and videos | 01, 03 |
| #2 | Extract and store key media metadata | 01, 02 |
| #3 | AWS storage as first cloud option | Already done (backbone) |
| #4 | Future Azure and other provider support | 06 |
| #5 | Sync with local hard drives or network storage | 06 |
| #6 | Web application for browsing, uploading, managing | 01, 03 |
| #7 | Android app for mobile sync | 08 |
| #8 | CLI for importing and syncing from a computer | 05 |
| #9 | API support for external tools and automations | 01 |
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
