# Phase 04 — Metadata Export

**Roadmap:** [ROADMAP.md](ROADMAP.md)
**Previous Phase:** [Phase 02 — Metadata Extraction](phase-02-metadata-extraction.md)
**Next Phase:** [Phase 07 — Memory Prioritization](phase-07-memory-prioritization.md)
**Status:** Done

---

## 1. Goal

Give users the ability to export all of their media metadata in JSON or CSV format with a single API call. This fulfils the vision principle of "Simple Export and Exit" — a user must be able to take their metadata and leave at any time. The implementation is a single streaming endpoint on the API and a one-click Export button in the web library toolbar (wired but visible from Phase 03).

---

## 2. Vision Mapping

| Vision Item | Relevant Section in VISION.MD |
|-------------|-------------------------------|
| #10 — Metadata export in JSON and CSV | "Export Capabilities" |

From the vision: _"A user should be able to leave MemoriaHub without losing access to their memories... MemoriaHub should earn trust by not trapping the user."_ Metadata export is a trust-building feature that must be reliable and complete.

The full list of exported fields mirrors the "Open Metadata" principle from VISION.MD:
- Date and time (`capturedAt`, `importedAt`)
- Location (`takenLat`, `takenLng`)
- Camera information (`cameraMake`, `cameraModel`)
- File name (`originalFilename`), type (`type`), size (`StorageObject.size`)
- Device information (`source`)
- Storage location (`StorageObject.storageKey`, `StorageObject.storageProvider`)
- User-added metadata (`MediaItem.metadata` JSONB)
- Processing metadata from enrichment processors

---

## 3. What We Reuse

| Existing File | How It Is Reused |
|---------------|-----------------|
| `apps/api/src/media/media.service.ts` (Phase 01) | New `streamExport()` method queries `MediaItem` with `include: { storageObject: true }` |
| `apps/api/src/media/media.controller.ts` (Phase 01) | New `GET /api/media/export` action added to the existing controller |
| `apps/web/src/services/media.ts` (Phase 03) | `exportMedia(format)` function added; triggers browser download |
| Phase 03 Export button | Enabled by wiring the Phase 04 endpoint URL |
| `apps/api/src/common/constants/roles.constants.ts` | `media:read` permission (already seeded in Phase 01) gates the export endpoint |

---

## 4. Scope / Deliverables

- `GET /api/media/export` endpoint with `?format=json|csv` query parameter
- Response is a streaming download (no pagination, no size limit for the caller's own data)
- JSON format: newline-delimited JSON objects (one per line) for streaming parsability
- CSV format: RFC 4180 compliant, with a header row; all JSONB metadata fields serialized as a single JSON-encoded column
- Export includes only the authenticated caller's own `MediaItem` records (RBAC: `media:read`)
- Admin with `media:read_any` can export all users' records by specifying `?ownerId=<userId>`
- `Content-Disposition: attachment` header with a timestamped filename
- Web "Export" button in `MediaLibraryPage` toolbar sends the request and triggers a browser file download

**Note (as built):** The endpoint streams via Fastify `@Res()` writing directly to `res.raw`. JSON output is newline-delimited. CSV uses `csv-stringify` with 19 columns (all typed `MediaItem` fields plus `storage_provider`, `storage_key`, `storage_size`, and a JSON-encoded `metadata` column). The web Export button opens a JSON/CSV menu and forwards only `type`, `from`, and `to` filters (no `ownerId` from the UI).

---

## 5. Data Model Changes

No data model changes. The export reads `media_items` joined to `storage_objects` using existing fields.

---

## 6. API Endpoints

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/api/media/export` | `media:read` | Stream metadata export for the caller |

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `format` | `json` \| `csv` | `json` | Export file format |
| `ownerId` | UUID | (caller) | Admin only: export a specific user's media |
| `type` | `photo` \| `video` | (all) | Filter by media type |
| `from` | ISO 8601 date | (all) | Filter `capturedAt >= from` |
| `to` | ISO 8601 date | (all) | Filter `capturedAt <= to` |

**Response headers:**

```
Content-Type: application/json          (or text/csv)
Content-Disposition: attachment; filename="memoriaHub-export-2026-06-10.json"
Transfer-Encoding: chunked
```

**JSON record shape:**

```json
{
  "id": "uuid",
  "originalFilename": "IMG_1234.jpg",
  "type": "photo",
  "capturedAt": "2024-06-15T10:30:00Z",
  "importedAt": "2026-06-10T08:00:00Z",
  "source": "web",
  "width": 4032,
  "height": 3024,
  "durationMs": null,
  "takenLat": 9.9281,
  "takenLng": -84.0907,
  "cameraMake": "Apple",
  "cameraModel": "iPhone 15 Pro",
  "contentHash": "e3b0c44298fc1c149afb...",
  "metadata": {},
  "storage": {
    "provider": "s3",
    "key": "user-abc/2024/06/IMG_1234.jpg",
    "size": 4194304
  }
}
```

---

## 7. Implementation Steps

| Step | Description | Subagent |
|------|-------------|----------|
| 1 | Add `GET /api/media/export` action to `media.controller.ts`; parse `format`, `ownerId`, `type`, `from`, `to` query params; set response headers for streaming download | `backend-dev` |
| 2 | Implement `MediaService.streamExport(options, res)`: use Prisma cursor-based iteration (`findMany` with `cursor` + `take: 100` in a loop) to stream records; write JSON lines or CSV rows directly to the Fastify response stream | `backend-dev` |
| 3 | For CSV: use the `csv-stringify` npm package (streaming API) to convert records to RFC 4180 format; serialize `metadata` JSONB column as `JSON.stringify()` | `backend-dev` |
| 4 | Add `ownerId` admin override with `media:read_any` permission check mirroring storage ownership pattern | `backend-dev` |
| 5 | Add `exportMedia(format: 'json' | 'csv', filters?)` to `apps/web/src/services/media.ts`; use `fetch` with `Blob` + `URL.createObjectURL` to trigger browser download | `frontend-dev` |
| 6 | Enable the Export button in `MediaLibraryPage` toolbar (Phase 03); add a format selector dropdown (JSON / CSV) | `frontend-dev` |
| 7 | Write integration test: authenticated user calls `GET /api/media/export?format=json` → receives streaming newline-delimited JSON; verify record shape matches schema | `testing-dev` |
| 8 | Write integration test: `GET /api/media/export?format=csv` → verify header row and one data row; verify JSONB metadata column is JSON-encoded | `testing-dev` |
| 9 | Write test: non-admin caller cannot specify `?ownerId=<other>` (403 returned) | `testing-dev` |
| 10 | Update `docs/plan/ROADMAP.md` status for Phase 04 | `docs-dev` |

---

## 8. Acceptance Criteria

- `GET /api/media/export?format=json` returns a streaming response with `Content-Disposition: attachment` and newline-delimited JSON objects, one per `MediaItem`.
- `GET /api/media/export?format=csv` returns a valid CSV file with a header row; all typed fields are columns; `metadata` is a single JSON-encoded column.
- A library of 10,000 `MediaItem` records exports without loading all rows into memory (cursor-based streaming confirmed by heap profiling or log output showing batched DB queries).
- Response includes `storage.provider`, `storage.key`, and `storage.size` so the user knows where each file physically lives.
- A non-admin user requesting `?ownerId=<other-user-id>` receives `403 Forbidden`.
- An admin user requesting `?ownerId=<other-user-id>` receives that user's records.
- The web Export button triggers a file download with a timestamped filename.
- `npm run typecheck` passes with zero errors.

---

## 9. Out of Scope / Deferred

- Export of the actual media files (binary blobs) — users download files individually via signed URLs
- ZIP archive export of media + metadata together (deferred to Phase 09 or later)
- Scheduled/automated exports (deferred)
- Export filtering beyond type and date range (tags, albums — deferred)
