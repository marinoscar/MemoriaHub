# Phase 01 — Media Domain Foundation

**Roadmap:** [ROADMAP.md](ROADMAP.md)
**Previous Phase:** — (first phase; builds on existing storage backbone)
**Next Phase:** [Phase 02 — Metadata Extraction](phase-02-metadata-extraction.md)
**Status:** Not Started

---

## 1. Goal

Introduce the `media` domain as a first-class module that wraps the existing `StorageObject` upload flow. Every uploaded photo or video becomes a `MediaItem` record with typed columns for ownership, type, source, classification, and core media attributes. This phase establishes the data model, API surface, and RBAC permissions that all subsequent phases depend on — without touching the existing storage, auth, or processing infrastructure.

---

## 2. Vision Mapping

| Vision Item | Relevant Section in VISION.MD |
|-------------|-------------------------------|
| #1 — Upload and store photos and videos | "MVP Focus", "Web Application", "Storage Support" |
| #2 — Extract and store key media metadata | "Metadata Management" — foundational model created here, populated in Phase 02 |
| #6 — Web application for browsing and managing media | "Web Application" — API surface consumed by Phase 03 |
| #9 — API support for external tools and automations | "API Support" — full CRUD + album endpoints |

The vision states: _"Uploading a file should be only the beginning."_ This phase creates the `MediaItem` record that all future enrichment processors write into.

---

## 3. What We Reuse

| Existing File | How It Is Reused |
|---------------|-----------------|
| `apps/api/src/storage/objects/objects.controller.ts` | Upload flow unchanged; `POST /api/media` calls objects.service then creates a MediaItem |
| `apps/api/src/storage/objects/objects.service.ts` | `StorageObject` creation logic reused verbatim |
| `apps/api/src/storage/providers/storage-provider.interface.ts` | No change; storage provider wiring untouched |
| `apps/api/src/storage/processing/object-processor.interface.ts` | Phase 02 processors write back to `MediaItem`; interface unchanged |
| `apps/api/src/allowlist/allowlist.module.ts` (and siblings) | Module layout mirrored exactly: `media.module.ts`, `media.controller.ts`, `media.service.ts`, `dto/` |
| `apps/api/src/common/constants/roles.constants.ts` | Extended with `media:*` permission constants |
| `apps/api/src/pat/` | PAT auth reused for API clients (Phase 05, 08) |
| `apps/api/prisma/schema.prisma` | `MediaItem`, `Album`, `AlbumItem` models added in new migration |
| `apps/api/test/storage/storage.integration.spec.ts` | Pattern mirrored for `media.integration.spec.ts` |

---

## 4. Scope / Deliverables

- Prisma migration adding `MediaItem`, `Album`, and `AlbumItem` models
- `media` NestJS module with controller, service, and DTOs
- `media:read`, `media:write`, `media:delete`, `media:read_any`, `media:write_any`, `media:delete_any` permissions seeded into the database
- RBAC wiring: Contributor and Viewer receive `media:read`/`media:write`/`media:delete` (own); Admin receives the `_any` variants
- Full CRUD for `MediaItem`: create, list (paginated + filtered), get, patch, delete
- Album CRUD: create album, add/remove items, list albums
- OpenAPI annotations on all endpoints
- Unit tests for `MediaService` and `MediaController`
- Integration tests covering RBAC and ownership checks

---

## 5. Data Model Changes

Add to `apps/api/prisma/schema.prisma`:

```prisma
enum MediaType {
  photo
  video
}

enum MediaSource {
  web
  cli
  android
  import
  sync
}

enum MediaClassification {
  memory
  low_value
  unreviewed
}

model MediaItem {
  id               String              @id @default(uuid())
  storageObjectId  String              @unique
  storageObject    StorageObject       @relation(fields: [storageObjectId], references: [id])
  ownerId          String
  owner            User                @relation(fields: [ownerId], references: [id])
  type             MediaType
  capturedAt       DateTime?
  importedAt       DateTime            @default(now())
  source           MediaSource
  contentHash      String?
  classification   MediaClassification @default(unreviewed)
  width            Int?
  height           Int?
  durationMs       Int?
  takenLat         Float?
  takenLng         Float?
  cameraMake       String?
  cameraModel      String?
  originalFilename String
  metadata         Json?
  albumItems       AlbumItem[]

  @@index([ownerId])
  @@index([capturedAt])
  @@index([contentHash])
  @@index([classification])
  @@index([type])
  @@map("media_items")
}

model Album {
  id          String      @id @default(uuid())
  ownerId     String
  owner       User        @relation(fields: [ownerId], references: [id])
  name        String
  description String?
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt
  items       AlbumItem[]

  @@index([ownerId])
  @@map("albums")
}

model AlbumItem {
  id          String    @id @default(uuid())
  albumId     String
  album       Album     @relation(fields: [albumId], references: [id], onDelete: Cascade)
  mediaItemId String
  mediaItem   MediaItem @relation(fields: [mediaItemId], references: [id], onDelete: Cascade)
  addedAt     DateTime  @default(now())

  @@unique([albumId, mediaItemId])
  @@index([albumId])
  @@map("album_items")
}
```

**Note:** A future `Person` and `MediaPerson` model for face-recognition search is explicitly deferred to Phase 09. Do not add these models now.

---

## 6. API Endpoints

All endpoints require JWT or PAT authentication unless noted. Ownership checks apply: a user may only access their own `MediaItem` unless they hold a `media:*_any` permission.

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `POST` | `/api/media` | `media:write` | Register an uploaded StorageObject as a MediaItem |
| `GET` | `/api/media` | `media:read` | List caller's media (paginated; filter: type, capturedAt range, classification, albumId) |
| `GET` | `/api/media/:id` | `media:read` | Get a single MediaItem |
| `PATCH` | `/api/media/:id` | `media:write` | Update mutable fields (capturedAt, classification, metadata) |
| `DELETE` | `/api/media/:id` | `media:delete` | Delete MediaItem (and underlying StorageObject) |
| `POST` | `/api/media/albums` | `media:write` | Create album |
| `GET` | `/api/media/albums` | `media:read` | List caller's albums (paginated) |
| `GET` | `/api/media/albums/:id` | `media:read` | Get album with item list |
| `PATCH` | `/api/media/albums/:id` | `media:write` | Rename / update album |
| `DELETE` | `/api/media/albums/:id` | `media:delete` | Delete album (does not delete MediaItems) |
| `POST` | `/api/media/albums/:id/items` | `media:write` | Add MediaItem(s) to album |
| `DELETE` | `/api/media/albums/:id/items/:itemId` | `media:write` | Remove MediaItem from album |

---

## 7. Implementation Steps

| Step | Description | Subagent |
|------|-------------|----------|
| 1 | Add `MediaItem`, `Album`, `AlbumItem` models and enums to `schema.prisma`; generate migration `add_media_domain` | `database-dev` |
| 2 | Add `media:read`, `media:write`, `media:delete`, `media:read_any`, `media:write_any`, `media:delete_any` to `roles.constants.ts`; update `seed.ts` to assign permissions to roles | `database-dev` |
| 3 | Scaffold `apps/api/src/media/media.module.ts`, `media.controller.ts`, `media.service.ts`, `dto/` mirroring `apps/api/src/allowlist/` structure | `backend-dev` |
| 4 | Implement `POST /api/media` — accept a `storageObjectId`, validate ownership of the `StorageObject`, create the `MediaItem`; wire `@Auth({ permissions: ['media:write'] })` | `backend-dev` |
| 5 | Implement `GET /api/media` with pagination and filters; `GET /api/media/:id`; ownership guard mirrors storage pattern | `backend-dev` |
| 6 | Implement `PATCH /api/media/:id` and `DELETE /api/media/:id`; cascade delete the `StorageObject` on media delete | `backend-dev` |
| 7 | Implement album CRUD endpoints and `AlbumItem` add/remove | `backend-dev` |
| 8 | Add OpenAPI `@ApiTags`, `@ApiOperation`, `@ApiResponse` decorators to all endpoints | `backend-dev` |
| 9 | Write unit tests for `MediaService` (mock `PrismaService`) and `MediaController` | `testing-dev` |
| 10 | Write integration tests in `apps/api/test/media/media.integration.spec.ts` covering RBAC, ownership, and album flows (mirror `storage.integration.spec.ts`) | `testing-dev` |
| 11 | Update `docs/plan/ROADMAP.md` status for Phase 01 | `docs-dev` |

---

## 8. Acceptance Criteria

- `POST /api/media` returns a `MediaItem` with all typed fields populated; the referenced `StorageObject` must be owned by the caller.
- `GET /api/media` returns paginated results filtered by `type`, `capturedAt` range, `classification`, and `albumId`.
- A Contributor cannot read or modify another user's `MediaItem` (403 returned); an Admin with `media:read_any` can.
- Album operations correctly create, populate, and remove album–item associations without deleting the underlying `MediaItem`.
- `DELETE /api/media/:id` removes both the `MediaItem` and its associated `StorageObject` (and the blob via the storage provider).
- All new permissions are seeded and assignable; existing permission tests remain green.
- Unit test coverage for `MediaService` and `MediaController` meets the project 70% threshold.
- Integration tests cover: create, list-with-filter, ownership-denied, album-CRUD, and delete.
- `npm run typecheck` passes with zero errors.

---

## 9. Out of Scope / Deferred

- Thumbnail generation (Phase 03)
- Metadata extraction from EXIF, dimensions, or video probes (Phase 02)
- Content hash / deduplication (Phase 02)
- Web UI components for the media library (Phase 03)
- CLI import commands (Phase 05)
- Android sync client (Phase 08)
- `Person` and face-recognition models (Phase 09)
- Low-value media heuristic processors (Phase 07)
- Storage replication tracking (Phase 06)
