# Storage Provider Configuration — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | June 2026 |
| **Status** | Specification |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Provider Model](#2-provider-model)
3. [Resolver Architecture](#3-resolver-architecture)
4. [Active Provider Selection](#4-active-provider-selection)
5. [Connectivity Test](#5-connectivity-test)
6. [Copy-Only Migration Model](#6-copy-only-migration-model)
7. [Per-Object Routing](#7-per-object-routing)
8. [Correctness Notes and Gotchas](#8-correctness-notes-and-gotchas)
9. [RBAC](#9-rbac)
10. [API Endpoints Reference](#10-api-endpoints-reference)
11. [System Setting](#11-system-setting)
12. [Database Tables](#12-database-tables)

---

## 1. Overview and Goals

Storage Provider Configuration lets administrators manage multiple object-storage backends — AWS S3, Cloudflare R2, and local disk — through the Admin UI rather than through environment variables alone. A single active provider is selected for new uploads; existing objects are routed to the provider they were written to at upload time, so objects on different providers are served simultaneously without disruption. When the active provider changes, a copy-only migration tool can move objects to the new provider at a configurable background pace while the source files are left in place as a fallback.

### Goals

- Give admins visibility into which storage providers are configured and which is active for new uploads.
- Allow credentials to be upserted or removed without a deployment restart.
- Provide a safe connectivity test (write→read→delete round-trip on a sentinel key) before credentials are saved.
- Support copy-only provider-to-provider migration via the enrichment queue with per-object progress tracking.
- Route existing objects to their original provider seamlessly, even after the active provider is changed.
- Reuse the existing `SECRETS_ENCRYPTION_KEY` and the same AES-256-GCM encryption pattern used by AI and Face provider credentials.

### Non-Goals

- Automatic migration on active-provider switch: switching the active provider never migrates existing objects.
- Destructive migration: the source file is never deleted. Cleanup is a manual admin operation after verifying the migration succeeded.
- Per-circle provider selection: provider configuration is global (admin-only).
- Multi-region or multi-bucket sharding: one active provider at a time.

---

## 2. Provider Model

### Known Provider Types

| Key | Label | Requires Credentials | Endpoint Required |
|-----|-------|---------------------|-------------------|
| `s3` | AWS S3 | Yes | No (uses AWS default endpoint) |
| `r2` | Cloudflare R2 | Yes | Yes (account-scoped R2 endpoint URL) |
| `local` | Local Disk | No | No |

`requiresCredentials` controls whether the Admin UI prompts for `accessKeyId` / `secretAccessKey` fields. For `local`, no credentials are stored.

### Credential Storage

Credentials are stored in the `storage_provider_credentials` table:

- `secretAccessKey` — encrypted at rest using AES-256-GCM via `SECRETS_ENCRYPTION_KEY` (the same 32-byte key used by AI and Face provider credentials). The plaintext secret is never persisted or returned by any API response.
- `accessKeyId`, `region`, `bucket`, `endpoint` — stored plaintext; returned in `GET /api/storage-settings` responses.
- `last4` — the last four characters of the secret access key, stored at upsert time and exposed for display (analogous to the pattern used by `ai_provider_credentials` and `face_provider_credentials`).
- `enabled` — boolean flag; a disabled provider is excluded from active-provider selection but its credential row is preserved.
- `updatedAt` — timestamp for auditing when credentials were last changed.

### `GET /api/storage-settings` Response Shape

```json
{
  "providers": [
    {
      "provider": "s3",
      "label": "AWS S3",
      "configured": true,
      "enabled": true,
      "requiresCredentials": true,
      "accessKeyId": "AKIA...",
      "region": "us-east-1",
      "bucket": "my-media-bucket",
      "endpoint": null,
      "last4": "XY7Z",
      "updatedAt": "2026-06-01T12:00:00.000Z"
    },
    {
      "provider": "r2",
      "label": "Cloudflare R2",
      "configured": false,
      "enabled": false,
      "requiresCredentials": true,
      "accessKeyId": null,
      "region": null,
      "bucket": null,
      "endpoint": null,
      "last4": null,
      "updatedAt": null
    }
  ],
  "knownProviders": [
    { "key": "s3", "label": "AWS S3", "requiresCredentials": true, "fields": ["accessKeyId", "secretAccessKey", "bucket", "region"], "endpointRequired": false },
    { "key": "r2", "label": "Cloudflare R2", "requiresCredentials": true, "fields": ["accessKeyId", "secretAccessKey", "bucket", "region", "endpoint"], "endpointRequired": true },
    { "key": "local", "label": "Local Disk", "requiresCredentials": false, "fields": [], "endpointRequired": false }
  ],
  "activeProvider": "s3"
}
```

`secretAccessKey` and `encryptedKey` are NEVER included in any response.

---

## 3. Resolver Architecture

**File:** `apps/api/src/storage/providers/storage-provider.resolver.ts`

`StorageProviderResolver` is a singleton NestJS service responsible for constructing and caching provider client instances. All storage operations (upload, download, delete, head, signed URL generation) go through the resolver rather than directly instantiating S3 clients.

### `getActiveProvider()`

Returns the client for the currently configured active provider (read from the `storage.activeProvider` system setting). Used by:

- Upload initiation (`POST /api/storage/objects/upload/init`)
- Simple upload (`POST /api/storage/objects`)
- Any new write operation

### `getProviderFor(providerId, bucket?)`

Returns the client for a specific provider ID. Used for:

- Download (`GET /api/storage/objects/:id/download`) — reads `StorageObject.storageProvider` to determine which provider holds the file
- Delete (`DELETE /api/storage/objects/:id`) — deletes from the provider that holds the object
- Head / verify operations during migration

The optional `bucket` parameter handles cases where an object was stored in a non-default bucket. If the bucket recorded on the `StorageObject` row differs from the currently configured credential row, `getProviderFor` uses the stored bucket rather than the credential's current bucket, so existing objects are always reachable.

### Provider Instance Cache

Provider clients are cached in-process after first construction. Cache entries are invalidated when credentials are upserted or deleted via the API, ensuring that configuration changes take effect without a restart.

### Legacy / Environment Fallback

`StorageObject` rows created before Admin UI configuration carry `storageProvider='s3'` (or whatever `STORAGE_PROVIDER` env var was set). When no credential row exists for a given `storageProvider` key, the resolver falls back to constructing a client from the environment variables (`S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, etc.). This guarantees that objects uploaded before Admin UI configuration remain accessible without a data migration.

---

## 4. Active Provider Selection

The active provider is controlled by the `storage.activeProvider` system setting (see [§11](#11-system-setting)). Its value is a provider key string (`'s3'`, `'r2'`, or `'local'`).

**Switching the active provider:**

- Call `PUT /api/storage-settings/active` with `{ provider: 'r2' }`.
- The system setting is updated immediately.
- All NEW uploads after this call go to `r2`.
- Existing objects remain on their original provider and continue to be served correctly via per-object routing.
- Existing objects are NOT migrated automatically. Use the migration endpoint to copy them if desired.

**Constraint:** The active provider must have a configured, enabled credential row (or be `local`, which requires no credentials).

---

## 5. Connectivity Test

`POST /api/storage-settings/test` performs a live round-trip to verify that credentials work before they are saved. This mirrors the pattern used by `POST /api/ai/test` and `POST /api/face/test`.

### Test Flow

1. Construct a temporary provider client from the request body fields (does not require an existing credential row — supports testing before first save).
2. Generate a unique sentinel key: `__memoriahub_conn_test__/<uuid>`.
3. **Write** a small test payload to the sentinel key.
4. **Read** the sentinel key back and verify the content matches.
5. **Delete** the sentinel key.
6. Return `{ ok: true, bucket, region, endpoint }` on success, or `{ ok: false, error: "<message>" }` on any failure.

The test request body accepts override fields (`accessKeyId`, `secretAccessKey`, `bucket`, `region`, `endpoint`) alongside the `provider` discriminator, so an admin can test new credentials before committing them.

---

## 6. Copy-Only Migration Model

### Overview

A migration run copies objects from a source provider to a target provider at background priority. It is strictly additive: the source file is NEVER deleted. After migration, the `StorageObject` row is repointed to the target provider. Both providers serve requests simultaneously during and after the migration.

### Run / Item Tables

| Table | Purpose |
|-------|---------|
| `storage_migration_runs` | One row per migration run; tracks overall status and counts |
| `storage_migration_items` | One row per object in the run; `@@unique([runId, objectId])` provides idempotency |

Run statuses: `pending` → `running` → `completed` | `failed` | `cancelled`

Item-level status is tracked on the `storage_migration_items` row. Counts (`migratedCount`, `failedCount`, `skippedCount`) on the run row are recomputed from item rows on each `GET /api/storage-settings/migrate/:runId` request rather than maintained with counters, avoiding race conditions.

### Enrichment Job Type: `storage_migration`

Migration work runs through the shared `enrichment_jobs` queue. One `storage_migration` enrichment job is enqueued per object when `POST /api/storage-settings/migrate` is called.

**Priority conventions:**

| Trigger | `reason` | `priority` |
|---------|----------|------------|
| Admin-initiated migration | `backfill` | 100 (low / background) |

The `skipDedup` option is set on each job to prevent the standard `(type, mediaItemId IS NULL)` global-job deduplication from collapsing all per-object jobs into one. Each object has its own job row keyed by `(type='storage_migration', mediaItemId=<objectId>)`.

### Handler Flow

For each `storage_migration` job, `StorageMigrationHandler.process()` executes:

1. **Guard: run cancelled?** Load the `storage_migration_runs` row. If status is `cancelled`, mark the item `skipped` and return (no error, no retry).
2. **Guard: already done?** If the `storage_migration_items` row is already `completed`, return immediately (idempotent no-op).
3. **Download** the object from the source provider using `getProviderFor(sourceProvider, storedBucket)`.
4. **Upload** the bytes to the target provider under the same `storageKey`. The key path is identical so that signed URLs constructed from the key remain consistent.
5. **Verify** the object exists on the target provider (HEAD request).
6. **Repoint** the `StorageObject` row in a database transaction: update `storageProvider` and `bucket` to the target values.
7. **SOURCE IS NOT DELETED.** The source file is left in place as a fallback. Cleanup is a manual operation.
8. Mark the `storage_migration_items` row `completed`.

On any error, the handler re-throws so the enrichment worker applies standard retry / backoff logic (up to `ENRICHMENT_MAX_ATTEMPTS`, default 3).

### Cancel Semantics

`POST /api/storage-settings/migrate/:runId/cancel` sets the run status to `cancelled`. In-flight jobs that are already claimed by the worker detect the cancelled status at step 1 of the handler flow and skip gracefully without error. Jobs still in the queue (`pending`) are not deleted from `enrichment_jobs`; they are skipped when the worker eventually picks them up.

### Retry and Backoff

Migration jobs inherit the shared enrichment worker retry configuration:

- `ENRICHMENT_MAX_ATTEMPTS` (default 3) — max attempts before permanent failure.
- `ENRICHMENT_RETRY_BASE_MS` / `ENRICHMENT_RETRY_MAX_MS` — equal-jitter exponential backoff for transient errors.
- Failed migration jobs appear in the `/admin/jobs` dashboard under `type='storage_migration'` and can be retried individually via `POST /api/admin/jobs/:id/retry`.

---

## 7. Per-Object Routing

Every `StorageObject` row carries a `storageProvider` column (and `bucket`) that records where the file lives. When serving a file (download, thumbnail, signed URL), the API calls `getProviderFor(storageObject.storageProvider, storageObject.bucket)` to obtain the correct client, then generates the appropriate signed URL or streams the content.

This means:

- Objects uploaded before the active provider was switched are served from their original provider.
- Objects successfully migrated have their `storageProvider` updated to the target; subsequent requests are served from the target.
- Objects that were not migrated (e.g. because the migration was cancelled, or migration has not been run) continue to be served from the source provider.
- There is no disruption during a migration run: objects are served from the source until their item row is repointed, then from the target.

---

## 8. Correctness Notes and Gotchas

### Multipart Upload Lifecycle Stability

A multipart upload that is in progress when the active provider is switched will complete on the original provider because the upload initiation stamped a specific `storageProvider` value onto the `StorageObject` row. The complete-multipart call resolves the provider from the `StorageObject` row, not from the current active provider setting. Do not delete a provider's credentials while a multipart upload is in progress for that provider.

### Presigned URL Endpoint Correctness for R2

Cloudflare R2 requires an explicit `endpoint` to be set (e.g. `https://<account_id>.r2.cloudflarestorage.com`). When constructing the S3-compatible client for R2, the resolver passes this endpoint to the AWS SDK v3 `S3Client`. Presigned URLs generated for R2 objects will include the R2 endpoint hostname. If the `endpoint` value in the credential row is wrong, presigned URLs will be malformed and downloads will fail. Always use `POST /api/storage-settings/test` to verify R2 connectivity before saving credentials.

### Migration Idempotency

The `@@unique([runId, objectId])` constraint on `storage_migration_items` ensures that re-enqueueing migration jobs (e.g. after a cancel-and-restart) does not create duplicate item rows. The handler checks the item status at the start and returns immediately if the item is already `completed`.

### Repoint Transaction

The `StorageObject` row is updated (`storageProvider`, `bucket`) only after the verify step (HEAD request) confirms the file exists on the target provider. If the upload succeeds but the verify fails (e.g. eventual-consistency delay on some S3-compatible stores), the repoint does not happen and the job is retried. This ensures the source is never "lost" — if the row is not repointed, requests continue to be served from the source.

### Credential Deletion Guard

`DELETE /api/storage-settings/credentials/:provider` returns `400` if the provider being deleted is currently the active provider. The admin must switch the active provider to a different one before removing credentials, preventing a state where the active provider has no valid credentials.

---

## 9. RBAC

Storage provider configuration is Admin-only. Two new permission scopes are introduced:

| Permission | Granted To | Allows |
|------------|------------|--------|
| `storage_settings:read` | Admin | View configured providers, test connectivity, list migration runs |
| `storage_settings:write` | Admin | Upsert/delete credentials, set active provider, start/cancel migration runs |

No per-circle roles are involved. The feature is entirely global.

---

## 10. API Endpoints Reference

All endpoints are mounted under `/api/storage-settings` and require JWT Bearer authentication with the Admin system role.

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/api/storage-settings` | `storage_settings:read` | Return configured providers, known provider types, and active provider |
| `GET` | `/api/storage-settings/providers` | `storage_settings:read` | List registry descriptors for all known provider types |
| `PUT` | `/api/storage-settings/credentials/:provider` | `storage_settings:write` | Upsert provider credentials; omitting `secretAccessKey` preserves stored secret |
| `DELETE` | `/api/storage-settings/credentials/:provider` | `storage_settings:write` | Remove provider credentials; 400 if provider is currently active |
| `POST` | `/api/storage-settings/test` | `storage_settings:read` | Test connectivity with a write→read→delete sentinel round-trip |
| `PUT` | `/api/storage-settings/active` | `storage_settings:write` | Set the active provider for new uploads |
| `POST` | `/api/storage-settings/migrate` | `storage_settings:write` | Start a copy-only migration run; returns `{ runId, totalCount }` |
| `GET` | `/api/storage-settings/migrate` | `storage_settings:read` | List recent migration runs |
| `GET` | `/api/storage-settings/migrate/:runId` | `storage_settings:read` | Get migration run detail including per-status counts |
| `POST` | `/api/storage-settings/migrate/:runId/cancel` | `storage_settings:write` | Cancel a pending or running migration run |

---

## 11. System Setting

**Key:** `storage.activeProvider`

| Property | Value |
|----------|-------|
| Type | string |
| Default | env `STORAGE_PROVIDER` if set, otherwise `'s3'` |
| Storage | `system_settings` JSONB, nested under `storage.activeProvider` |
| Admin UI | Storage Providers admin page — active-provider selector |

This setting controls which provider receives NEW uploads. Changing it does not migrate existing objects. The `S3_*` environment variables and `STORAGE_PROVIDER` env var serve as bootstrap defaults and as the fallback for objects created before a credential row existed in `storage_provider_credentials`.

---

## 12. Database Tables

### `storage_provider_credentials`

One row per configured provider key. Stores encrypted credentials and connection parameters.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `provider` | String (unique) | Provider key: `s3`, `r2`, or `local` |
| `accessKeyId` | String? | Plaintext; null for keyless providers |
| `encryptedKey` | String? | AES-256-GCM ciphertext of `secretAccessKey`; never returned by API |
| `last4` | String? | Last 4 chars of secret; exposed for display |
| `region` | String? | AWS region or R2 region string |
| `bucket` | String? | Default bucket name |
| `endpoint` | String? | Custom endpoint URL (required for R2) |
| `enabled` | Boolean | Default `true`; disabled providers are excluded from active selection |
| `updatedAt` | DateTime | Auto-updated on any credential change |

### `storage_migration_runs`

One row per migration run initiated by an admin.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | Returned as `runId` in API responses |
| `sourceProvider` | String | Provider key of the source |
| `targetProvider` | String | Provider key of the target |
| `status` | Enum | `pending` \| `running` \| `completed` \| `failed` \| `cancelled` |
| `totalCount` | Int | Number of objects enqueued at run creation |
| `startedAt` | DateTime? | Set when first item job is claimed |
| `finishedAt` | DateTime? | Set when all items are terminal |
| `lastError` | String? | Error message from the last failed item |

### `storage_migration_items`

One row per object in a migration run. Provides per-object progress and idempotency.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `runId` | UUID | FK → `storage_migration_runs` (cascade delete) |
| `objectId` | UUID | FK → `storage_objects` (cascade delete) |
| `status` | Enum | `pending` \| `running` \| `completed` \| `failed` \| `skipped` |
| `lastError` | String? | Error message if status is `failed` |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |

`@@unique([runId, objectId])` prevents duplicate item rows if migration is re-initiated.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 2026 | AI Assistant | Initial specification |
