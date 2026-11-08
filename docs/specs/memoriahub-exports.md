# Data export ("Download your data")

RETRO-H2 ([#596](https://github.com/marinoscar/MemoriaHub/issues/596), epic [#584](https://github.com/marinoscar/MemoriaHub/issues/584)). MemoriaHub mounts the platform exports slice (`@marinoscar/platform-api/exports`, platform `0.1.0-next.27`) and registers four sources of its own next to the platform's `user-data` and `org-data`. The platform's design (sources and writers, the `export.run` / `export.purge` jobs, signed downloads, expiry, the redaction rule, the secret-egress conformance case) is the EnterpriseAppBase spec `docs/specs/data-export.md` and the slice README; this page documents only what MemoriaHub adds and where it deviates.

**The original photo and video files are never exported.** An export is a list of what MemoriaHub knows about your library (file names, capture dates, places, tags, people, albums, memories). To keep a copy of the files themselves, use [Local Media Backup](../local-backup.md) (`memoriahub backup`), which mirrors the original bytes to a worker node's disk.

## 1. Where it is

| Surface | Path | Permission |
|---|---|---|
| User page "Download your data" (packaged `DataExportPage`) | `/settings/data-export`, card in the **Your data** group of `/settings` (before the pinned-last Danger Zone) | none on the card; each source is checked by the API |
| Admin card "Organization data export" (same packaged page) | `/admin/settings/data-export`, Console Operations group | `org_members:read` (the string the exports service checks for `org-data`) |
| API | `GET /api/exports/sources`, `POST /api/exports`, `GET /api/exports`, `GET /api/exports/:id` (tag `Exports`) | every route `@Auth()`; the permission is the source's |
| Jobs | `export.run` (one per export, server-only), `export.purge` (daily expiry, enqueued by the slice's cron) | permanent type strings |
| Notifications | `export.ready`, `export.failed` (bell and Web Push, no email; link to `/settings/data-export`) | sent to the requester after the file is committed |

Binding: `apps/api/src/platform/exports/` (`exports.config.ts`, `exports-host.module.ts`), registrations `apps/api/src/app-registrations/exports.ts`, events `apps/api/src/notifications-registry/exports.notifications.ts`.

Options: `retentionDays: 7`, `downloadUrlTtlSeconds: 300`, `maxInFlightPerSubject: 3`, `pageSize: 500`, `appSlug` from `packages/shared/identity.json`. Formats: JSON, CSV (one file per dataset in a zip, formula-neutralised by the platform writer) and XLSX (one sheet per dataset).

Another user's export id answers **404**, never 403 (platform behaviour, asserted by `test/exports/exports-mount.integration.spec.ts` and `exports-run.db.spec.ts`).

## 2. Sources

All four are `scope: 'user'`, permission `media:read` (the string `GET /api/media` enforces, held by every role), no request options, formats JSON / CSV / XLSX only (`acceptsAttachedWriters: false`). Ids use `-` because the platform's `EXPORT_ID_PATTERN` is `^[a-z][a-z0-9-]{0,47}$` (the issue's `memoriahub.media` does not match it); they are permanent.

### What "my content" means

Open decision 1 of #596, the recommended answer: **everything in the user's personal circle**, plus **what the user added** (`added_by_id`) in a shared circle, but never inside another user's personal circle (`export-scope.ts`, `ownedCircleContentWhere`). Circle-wide exports for circle administrators wait for Epic I (circles become groups).

### `memoriahub-media`: dataset `media_item`

| Column | From |
|---|---|
| `id`, `circleId`, `circleName` | the item and its circle |
| `mediaType`, `originalFilename`, `mimeType`, `fileSize` | the item; size and type from its storage object (`fileSize` is text, exact past 2^53) |
| `capturedAt` | **civil timestamp**: the stored UTC wall clock without a zone (`2026-06-20T20:16:07`), the same day and time the gallery shows ([date model](date-model.md)) |
| `width`, `height`, `durationMs`, `cameraMake`, `cameraModel` | the item |
| `takenLat`, `takenLng`, `coordSource` | the item |
| `geoCountry`, `geoCountryCode`, `geoRegion`, `geoLocality`, `geoPlaceName` | the raw geocoder values |
| `geoCanonicalCountry`, `geoCanonicalRegion`, `geoCanonicalLocality` | the [location group](location-grouping.md) names |
| `description`, `favorite` | the item |
| `tags`, `people`, `albums` | names joined with `; ` (tags, the named people of the item's faces, the albums holding it) |
| `uploadedAt`, `archivedAt`, `deletedAt` | instants, ISO 8601 UTC |

Trashed and archived items are included (with their timestamps).

### `memoriahub-albums`: datasets `album`, `album_item`

`album`: `id`, `circleId`, `circleName`, `name`, `description`, `itemCount`, `dateRangeStart` / `dateRangeEnd` (civil, over live members, as the album list shows it), `coverMediaItemId`, `createdAt`, `updatedAt`. `album_item`: `id`, `albumId`, `mediaItemId`, `addedAt`. Albums of the personal circle and the ones the user created in a shared circle.

### `memoriahub-memories`: datasets `memory`, `memory_item`

Live memories (tombstoned ones, `deleted_at` set, are excluded) of every circle the user is a member of. `memory`: `id`, `circleId`, `circleName`, `type`, `title`, `subtitle`, `narrative`, `titleSource`, `titleModel`, `periodStart` / `periodEnd` (civil), `itemCount`, `coverMediaItemId`, `generatedAt`, and the user's OWN `seenAt`, `hiddenAt`, `favoritedAt` (another member's marks are never read). `memory_item`: `id`, `memoryId`, `mediaItemId`, `position`.

### `memoriahub-people`: dataset `person`

`id`, `circleId`, `circleName`, `name`, `faceCount`, `coverFaceId`, `favorite`, `hiddenAt`, `mergedIntoId`, `deletedAt`, `createdAt`. The face count is a SQL count; no face row is ever read.

## 3. What never leaves the server

| Never exported | How |
|---|---|
| `content_hash`, `perceptual_hash`, sharpness and burst scores, `source_path` | not selected, not a column |
| storage keys of originals, thumbnails, face frames and avatars; buckets; upload ids; signed URLs | not selected; `storage_object` columns removed from `user-data` / `org-data` (section 4); `UserProfile.avatarStorageKey` is an `exportOmit` |
| `media_item_embedding`, `media_visual_embedding`, `faces.embedding`, `faces.embedding_vec` (biometric) | never read; the embedding tables and `Face` have no user key, so they are not in the user-owned registry and `user-data` never sees them; `Unsupported` vector columns are absent from the runtime datamodel |
| credentials, tokens | the platform's default redaction and the registry's `exclude` / `exportOmit` (`MediaShare.token`, `MhLegacyNodeCredential.tokenHash`) |

Each MemoriaHub dataset declares its columns and builds every row from them alone, so a column not listed cannot reach a file even if a client returned it. Proof: `test/exports/memoriahub-export.sources.spec.ts` runs every source through every writer over a client that ignores `select` and returns sentinel hashes, keys, URLs and embeddings, and asserts none appears; `exports-run.db.spec.ts` repeats it end to end on PostgreSQL; the conformance `exports` suite covers the platform sources.

## 4. Deviations (see [local-exceptions.md](../platform-adoption/local-exceptions.md))

1. **`user-data` and `org-data` are re-registered** (`memoriahub-platform-sources.ts`, `PLATFORM-ADOPTION-SHIM(#596)`). The platform registers `StorageObject` in the user-owned registry with no `exportOmit`, so its two sources wrote each object's `storageKey`, `bucket`, `s3UploadId` and `metadata` (MemoriaHub's holds thumbnail keys). An app cannot extend the redaction of a platform-registered model, so `platformSources` is off and both sources are registered again under their permanent ids, with the platform's `collect`, label, permissions and writers, minus those columns. The file manifest keeps name, size, type, status and dates.
2. **Export files are written through MemoriaHub's own storage providers** (`exports-storage.adapter.ts`, `PLATFORM-ADOPTION-SHIM(RETRO-D1)`). The platform `STORAGE_PROVIDER` reads the platform `storage` settings, which MemoriaHub does not run yet. `ExportsHostModule` provides the platform token itself (the slice imports it first, ahead of its own `StorageProvidersModule`). Writes stream to the active provider; downloads, purges and cleanups resolve the provider and bucket **recorded on the `storage_objects` row**.
3. **`EXPORTS_SYSTEM_DATA` is `forSystem(PrismaService)`** (no `PrismaSystemService` until RETRO-D1), like the AI and user-data host modules.

Export files are `storage_objects` rows under `exports/users/...` / `exports/orgs/...` (the slice's registered key prefixes) with `metadata.source = 'export'`; MemoriaHub's own storage surfaces (storage insights, the objects list of the uploader) may count or list them like any upload until `export.purge` deletes them.

## 5. Operator notes

- No migration, no environment variable, no new permission.
- A storage provider must be configured (`/admin/settings/storage/providers`); without one `export.run` fails and the requester gets `export.failed`.
- Rollback: revert; pending exports finish or are purged by `export.purge`.
