# Phase 06 — Storage Providers and Replication

**Roadmap:** [ROADMAP.md](ROADMAP.md)
**Previous Phase:** [Phase 01 — Media Domain Foundation](phase-01-media-domain.md)
**Next Phase:** (no single next; feeds into Phase 09 for multi-cloud)
**Status:** Not Started

---

## 1. Goal

Extend the pluggable storage system with a `LocalStorageProvider` (disk-based storage for home servers and NAS devices) and introduce a `StorageLocation` registry plus a `ReplicationService` that copies blobs across locations on a cron schedule. This phase makes the "Provider Independence" and "Local and Cloud Flexibility" principles concrete: users are never locked into a single storage backend.

---

## 2. Vision Mapping

| Vision Item | Relevant Section in VISION.MD |
|-------------|-------------------------------|
| #3 — AWS storage (already done) | "Storage Support" — backbone; noted in ROADMAP.md as pre-existing |
| #4 — Future Azure and other providers | "Storage Support" — `LocalStorageProvider` proves the pattern; Azure follows the same interface |
| #5 — Sync with local hard drives or network storage | "Local Hard Drive and Network Sync" |

From the vision: _"Storage should be flexible because long-term ownership requires options."_ This phase turns the theoretical extensibility of `StorageProvider` into a real, working second provider and adds the replication layer that lets users keep copies in multiple places.

---

## 3. What We Reuse

| Existing File | How It Is Reused |
|---------------|-----------------|
| `apps/api/src/storage/providers/storage-provider.interface.ts` | `LocalStorageProvider` implements `StorageProvider` identically to `S3StorageProvider` |
| `apps/api/src/storage/providers/s3-storage.provider.ts` | Reference implementation; `LocalStorageProvider` mirrors its method signatures |
| `apps/api/src/storage/tasks/storage-cleanup.task.ts` | `ReplicationService` is a new `@nestjs/schedule` cron task following the exact same pattern |
| `apps/api/src/storage/objects/objects.service.ts` | `getStream()` used by `ReplicationService` to read blobs from the source provider |
| `apps/api/prisma/schema.prisma` | New `StorageLocation` and `StorageObjectLocation` models added |
| `apps/api/src/common/constants/roles.constants.ts` | `storage:read_any` used by `ReplicationService` to read any user's objects |

---

## 4. Scope / Deliverables

- `LocalStorageProvider`: implements `StorageProvider` for local disk; uses Node.js `fs` streams and `path`; supports configurable `LOCAL_STORAGE_ROOT` env var; generates signed URLs as temporary file-serve tokens via the API (not direct filesystem exposure)
- Provider selection via environment: `STORAGE_PROVIDER=s3|local` env var; `StorageProvidersModule` wires the correct provider at startup (currently hardcoded to S3)
- `StorageLocation` model: registry of named storage locations with provider type and connection config
- `StorageObjectLocation` join model: tracks replication state (pending/copying/done/failed) per object per location
- `ReplicationService`: `@nestjs/schedule` cron task (configurable interval, default: every 15 minutes); reads `StorageObjectLocation` records with `status: pending`; streams blobs from source provider and writes to target provider; updates status on completion or failure
- Admin API endpoints for managing storage locations
- **Note on Azure**: `AzureStorageProvider` is not implemented in this phase. The `LocalStorageProvider` proves the interface is fully workable; Azure is documented as a follow-on task requiring only a new provider class.

---

## 5. Data Model Changes

Add to `apps/api/prisma/schema.prisma`:

```prisma
enum StorageProviderType {
  s3
  local
  azure
}

enum ReplicationStatus {
  pending
  copying
  done
  failed
}

model StorageLocation {
  id              String                 @id @default(uuid())
  name            String                 @unique
  providerType    StorageProviderType
  config          Json
  isDefault       Boolean                @default(false)
  createdAt       DateTime               @default(now())
  objectLocations StorageObjectLocation[]

  @@map("storage_locations")
}

model StorageObjectLocation {
  id                String            @id @default(uuid())
  storageObjectId   String
  storageObject     StorageObject     @relation(fields: [storageObjectId], references: [id], onDelete: Cascade)
  locationId        String
  location          StorageLocation   @relation(fields: [locationId], references: [id])
  storageKey        String
  replicationStatus ReplicationStatus @default(pending)
  startedAt         DateTime?
  completedAt       DateTime?
  errorMessage      String?
  createdAt         DateTime          @default(now())

  @@unique([storageObjectId, locationId])
  @@index([replicationStatus])
  @@map("storage_object_locations")
}
```

---

## 6. API Endpoints

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/api/storage/locations` | `storage:read_any` (Admin) | List configured storage locations |
| `POST` | `/api/storage/locations` | `storage:write_any` (Admin) | Add a new storage location |
| `DELETE` | `/api/storage/locations/:id` | `storage:delete_any` (Admin) | Remove a storage location (only if no pending replications) |
| `GET` | `/api/storage/objects/:id/locations` | `storage:read` | List replication status for a specific object |

---

## 7. Implementation Steps

| Step | Description | Subagent |
|------|-------------|----------|
| 1 | Add `StorageLocation` and `StorageObjectLocation` models to `schema.prisma`; generate migration `add_storage_locations` | `database-dev` |
| 2 | Implement `LocalStorageProvider` in `apps/api/src/storage/providers/local-storage.provider.ts`; implement all `StorageProvider` methods using `fs.createReadStream`, `fs.createWriteStream`, `path.join(LOCAL_STORAGE_ROOT, key)` | `backend-dev` |
| 3 | Implement signed-URL generation for `LocalStorageProvider`: issue a short-lived JWT (or HMAC token) that the API validates on `GET /api/storage/objects/:id/download`, serving the file from disk | `backend-dev` |
| 4 | Update `apps/api/src/storage/storage-providers.module.ts` (or equivalent wiring module): read `STORAGE_PROVIDER` env var and conditionally provide `S3StorageProvider` or `LocalStorageProvider`; register `STORAGE_PROVIDER` token for injection | `backend-dev` |
| 5 | Add `LOCAL_STORAGE_ROOT` env var to `infra/compose/.env.example` and document it | `backend-dev` |
| 6 | Implement `StorageLocationsService` and `StorageLocationsController` (admin-only CRUD for `StorageLocation`); wire into `storage.module.ts` | `backend-dev` |
| 7 | Implement `ReplicationService` as `@nestjs/schedule` `@Cron` task (interval from `REPLICATION_CRON_SCHEDULE` env, default `*/15 * * * *`): query `StorageObjectLocation` where `replicationStatus = pending`; batch process up to 10 at a time; stream via `getStream` from source provider, write to target provider, update status | `backend-dev` |
| 8 | When a new `StorageObject` is created and a second location exists, automatically insert a `StorageObjectLocation` record with `status: pending` so replication is queued | `backend-dev` |
| 9 | Write unit tests for `LocalStorageProvider` (mock `fs` module) and `ReplicationService` (mock both providers) | `testing-dev` |
| 10 | Write integration test: configure two `StorageLocation` records; upload an object to location A; verify `ReplicationService.runReplication()` copies the blob to location B and updates `replicationStatus` to `done` | `testing-dev` |
| 11 | Update `docs/plan/ROADMAP.md` status for Phase 06 | `docs-dev` |

---

## 8. Acceptance Criteria

- Setting `STORAGE_PROVIDER=local` and `LOCAL_STORAGE_ROOT=/data/media` causes all uploads to write to the local filesystem; existing S3 behavior is unchanged when `STORAGE_PROVIDER=s3`.
- `LocalStorageProvider.getSignedDownloadUrl()` returns a time-limited URL that serves the file from disk via the API (not a direct file path).
- `ReplicationService` copies blobs from source to target location; `StorageObjectLocation.replicationStatus` transitions from `pending` → `copying` → `done`.
- A replication failure sets `replicationStatus = failed` and records `errorMessage`; the task retries on the next cron run.
- Admin can list, add, and remove storage locations via the API endpoints.
- `GET /api/storage/objects/:id/locations` returns replication status for each location.
- `LocalStorageProvider` unit tests run without a real filesystem (mocked `fs`).
- `npm run typecheck` passes with zero errors.
- Removing `STORAGE_PROVIDER` from the env (or setting it to `s3`) causes no behavioral change to existing upload flows.

---

## 9. Out of Scope / Deferred

- `AzureStorageProvider` implementation (the interface is ready; Azure requires Azure SDK dependency and config — deferred to Phase 09 or a standalone task)
- Multi-cloud replication across more than two locations (supported by the data model but not tested in this phase)
- Replication scheduling per-location (all pending objects are replicated on each cron run; per-location scheduling is deferred)
- Automatic failover to a secondary location if the primary is unreachable (deferred)
- Replication progress UI in the web app (deferred; visible via `GET /api/storage/objects/:id/locations`)
