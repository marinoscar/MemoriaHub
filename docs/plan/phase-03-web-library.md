# Phase 03 — Web Media Library

**Roadmap:** [ROADMAP.md](ROADMAP.md)
**Previous Phase:** [Phase 02 — Metadata Extraction](phase-02-metadata-extraction.md)
**Next Phase:** [Phase 07 — Memory Prioritization](phase-07-memory-prioritization.md)
**Status:** Done

---

## 1. Goal

Build the web application layer for MemoriaHub: a media library page with responsive grid and timeline-by-date browsing, a detail drawer for viewing metadata, a multi-file resumable upload dialog, and thumbnail generation so images load fast. All new frontend code reuses the existing MUI theme, `ProtectedRoute`, API client, and hook patterns already established in `apps/web/`. A new `media.ts` API client and `useMedia` hook wrap the resumable upload flow end-to-end.

---

## 2. Vision Mapping

| Vision Item | Relevant Section in VISION.MD |
|-------------|-------------------------------|
| #1 — Upload and store photos and videos | "Web Application" — "Upload new media files" |
| #6 — Web application for browsing, uploading, managing | "Web Application" — full MVP capability section |
| #10 — Metadata export | "Export Capabilities" — Export button wired in this phase; export stream implemented in Phase 04 |

From the vision: _"The web app should be clean, simple, and focused on control rather than social sharing."_ Every component in this phase is scoped to ownership and browsing, not sharing features.

---

## 3. What We Reuse

| Existing File | How It Is Reused |
|---------------|-----------------|
| `apps/web/src/services/api.ts` | Built-in token refresh; `media.ts` client calls the same base client |
| `apps/web/src/components/settings/ImageUpload.tsx` | Resumable upload validation patterns (file type checking, size limits, error states) |
| `apps/web/src/hooks/useUsers.ts`, `useAllowlist.ts` | Hook pattern (load, pagination, mutation, error state) mirrored by `useMedia` and `useAlbums` |
| MUI theme (`apps/web/src/theme/`) | All new components use `useTheme`, `sx` props, and theme breakpoints |
| `apps/web/src/components/common/ProtectedRoute.tsx` | Media library page is wrapped in `ProtectedRoute` (any authenticated user) |
| Phase 01 API: `GET /api/media`, `POST /api/media`, `GET /api/media/:id` | Consumed by `useMedia` |
| Phase 02 `ImageDimensionsProcessor` and `ExifProcessor` | Metadata displayed in `MediaDetailDrawer` |
| Phase 02 `ReverseGeocodeProcessor` | `geoCountry`, `geoAdmin1`, `geoLocality` displayed in drawer and used as facet values in the location filter sidebar |
| `apps/api/src/storage/processing/object-processor.interface.ts` | `ThumbnailProcessor` is a new `ObjectProcessor` (backend side of this phase) |

---

## 4. Scope / Deliverables

**Backend additions (thumbnail processor):**
- `ThumbnailProcessor`: a new `ObjectProcessor` (priority 30) that uses `sharp` to generate a JPEG thumbnail (max 400 px on the long edge) for every image. The thumbnail is stored as a new `StorageObject` owned by the same user, with `metadata.thumbnailOf` referencing the original object ID. The signed download URL for the thumbnail is written to `MediaItem.metadata.thumbnailUrl`.

**Frontend additions:**
- `apps/web/src/services/media.ts` — API client with typed methods for the Phase 01/02 media endpoints and the resumable upload flow (init → upload parts → complete)
- `apps/web/src/hooks/useMedia.ts` — pagination hook; `apps/web/src/hooks/useAlbums.ts`
- `MediaLibraryPage` (`apps/web/src/pages/MediaLibrary/`) — responsive MUI `ImageList` grid; timeline grouping by `capturedAt` year/month; filter controls (type, date range, classification, album, favorite toggle, tag chips, location); infinite scroll or page controls
- `MediaDetailDrawer` (`apps/web/src/components/media/`) — slide-in drawer showing full-resolution download link, all typed metadata fields from `MediaItem` (including `geoCountry`, `geoAdmin1`, `geoLocality`, `geoPlaceName` if present), the ability to edit `capturedAt`, `classification`, `title`, `caption`, `description`, and a favorite star toggle
- **Location filter / facet** — a sidebar or collapsible filter panel in `MediaLibraryPage` that lets users drill down by country → region (state/province) → city, populated from the `geoCountry`, `geoAdmin1`, and `geoLocality` values present in the caller's media. A free-text **place search box** passes the typed value to the `?location=` query param, enabling searches like "California", "Costa Rica", or "Yosemite". Selecting a facet value applies the corresponding `country`, `region`, or `locality` filter param. An optional map view is explicitly deferred; no map dependency is introduced in this phase.
- **Favorite toggle** — a star icon overlay on each grid thumbnail and in the drawer; clicking toggles `MediaItem.favorite` via `PATCH /api/media/:id`; a "Favorites only" filter chip in the toolbar passes `?favorite=true`.
- **Tag filter chips** — a horizontal chip row below the filter toolbar showing the caller's tags (from `GET /api/media/tags`); clicking a chip appends `?tag=<name>` to the list query; multiple chips may be active simultaneously.
- `MediaUploadDialog` (`apps/web/src/components/media/`) — multi-file picker, per-file progress bars, retry on failure, calls the resumable upload API (init → upload chunks → complete → `POST /api/media`)
- Route `/media` added to the React Router config and to the sidebar navigation
- Export button in the library toolbar (links to Phase 04 endpoint; visible but grayed-out if Phase 04 is not yet deployed)

---

## 5. Data Model Changes

No new Prisma models. The `ThumbnailProcessor` writes to `MediaItem.metadata` (JSONB) using a new key:

```json
{
  "thumbnailUrl": "https://signed-url.example.com/thumb-abc123.jpg",
  "thumbnailObjectId": "uuid-of-thumbnail-storage-object"
}
```

---

## 6. API Endpoints

No new API endpoints beyond Phase 01 and Phase 02. The thumbnail signed URL is returned as part of `GET /api/media/:id` via `MediaItem.metadata.thumbnailUrl`.

**Note (as built):**

- **Thumbnail and download URL handling.** The stable references `thumbnailObjectId` and `thumbnailStorageKey` are persisted in `MediaItem.metadata`; `thumbnailUrl` (thumbnail) and `downloadUrl` (full resolution, returned on `GET /api/media/:id`) are signed fresh on each read inside `MediaService` rather than stored. This avoids serving expired signed URLs that were written at processor time.

- **Scoped limitations.** The list endpoint (`GET /api/media`) filters by a single `?tag=` value; when multiple tag chips are active the UI sends only the first. The `MediaUploadDialog` handles files within the first presigned-URL batch (up to 10 parts, roughly 100 MB); files exceeding that limit surface a clear error rather than silently failing. Both limitations are candidates for a follow-up.

---

## 7. Implementation Steps

| Step | Description | Subagent |
|------|-------------|----------|
| 1 | Implement `ThumbnailProcessor` in `apps/api/src/storage/processing/processors/thumbnail.processor.ts`; use `sharp` (already added in Phase 02) to resize the image to max 400 px; upload the thumbnail as a new `StorageObject` via `ObjectsService`; write `metadata.thumbnailUrl` and `metadata.thumbnailObjectId` onto the original `MediaItem` | `backend-dev` |
| 2 | Register `ThumbnailProcessor` in `storage.module.ts` | `backend-dev` |
| 3 | Create `apps/web/src/services/media.ts` with typed functions: `listMedia(params)`, `getMedia(id)`, `patchMedia(id, dto)`, `deleteMedia(id)`, `initUpload(dto)`, `uploadPart(uploadId, partNumber, chunk)`, `completeUpload(id, parts)`, `createAlbum(dto)`, `listAlbums()`, `getAlbum(id)` | `frontend-dev` |
| 4 | Create `apps/web/src/hooks/useMedia.ts` (paginated list with filter state) and `useAlbums.ts`; mirror the `useAllowlist` hook pattern | `frontend-dev` |
| 5 | Implement `MediaUploadDialog`: multi-file `<input>`, per-file progress state, calls `initUpload` → chunk loop → `completeUpload` → `POST /api/media`; handle retry for failed parts | `frontend-dev` |
| 6 | Implement `MediaDetailDrawer`: MUI `Drawer` with image preview (via `thumbnailUrl` or full download URL), all `MediaItem` fields including geo location display, inline edit for `capturedAt`, `classification`, `title`, `caption`, `description`, and favorite star toggle (all call `PATCH /api/media/:id`) | `frontend-dev` |
| 7 | Implement `MediaLibraryPage`: MUI `ImageList` (Masonry variant on desktop, single-column on mobile), group items by `capturedAt` month/year, filter sidebar with location facet (country → region → city drill-down and free-text place search box), favorite toggle on thumbnails, tag filter chip row, open `MediaDetailDrawer` on click, upload FAB that opens `MediaUploadDialog` | `frontend-dev` |
| 8 | Add `/media` route to React Router and sidebar navigation link (visible to all authenticated users) | `frontend-dev` |
| 9 | Add Export button to library toolbar; button calls `GET /api/media/export?format=json` (Phase 04 endpoint) — render as disabled with tooltip "Export available in next release" until Phase 04 is deployed | `frontend-dev` |
| 10 | Write Vitest + RTL tests for `MediaUploadDialog` (file selection, progress, success/error states), `MediaDetailDrawer` (renders metadata, edit flow), and `MediaLibraryPage` (renders grid, filter triggers API call) using MSW handlers | `testing-dev` |
| 11 | Write unit test for `ThumbnailProcessor` (mock `sharp` and `ObjectsService`) | `testing-dev` |
| 12 | Update `docs/plan/ROADMAP.md` status for Phase 03 | `docs-dev` |

---

## 8. Acceptance Criteria

- Uploading a JPEG via `MediaUploadDialog` creates a `MediaItem` and the thumbnail appears in the grid within the next page load (thumbnail signed URL populated by `ThumbnailProcessor`).
- `MediaLibraryPage` renders a responsive grid: 4-column on desktop (≥1200 px), 2-column on tablet, 1-column on mobile.
- Items are grouped by `capturedAt` year/month header; items with no `capturedAt` are grouped under "Unknown Date".
- `MediaDetailDrawer` shows all typed metadata fields from `MediaItem` (type, capturedAt, dimensions, duration, GPS, camera, source, classification, title, caption, description, and location geo fields when present).
- Inline edit of `capturedAt`, `classification`, `title`, `caption`, `description`, and favorite toggle in the drawer call `PATCH /api/media/:id` and reflect the update without a full page reload.
- The location filter facet drills down correctly: selecting a country limits the region list to regions within that country; selecting a region limits the city list accordingly; the free-text place search box sends `?location=<query>` to the API.
- The favorite toggle on a thumbnail and in the drawer updates `MediaItem.favorite` immediately; the "Favorites only" chip correctly filters the grid to `?favorite=true`.
- Tag filter chips appear for all of the caller's tags; selecting one or more filters the grid; deselecting restores all results.
- Resumable upload handles a file > 50 MB without a timeout; individual part failures are retried automatically up to 3 times.
- `ThumbnailProcessor.canProcess()` returns `false` for video files.
- Export button is visible and labeled; clicking it before Phase 04 is deployed shows an informative message (not a 404).
- Frontend test coverage meets the 70% threshold (enforced by `vitest.config.ts`).
- `npm run typecheck` passes for both `apps/api` and `apps/web`.

---

## 9. Out of Scope / Deferred

- Video thumbnail extraction (requires `ffmpeg` frame extraction; deferred to Phase 09)
- In-browser video playback UI (deferred)
- Album management UI (creating and editing albums via the web — deferred to a follow-up in Phase 03 or Phase 07)
- Classification review UI (Phase 07)
- Search by person, object, or scene (Phase 09)
- Social sharing or public album links (explicitly out of scope per VISION.MD)
