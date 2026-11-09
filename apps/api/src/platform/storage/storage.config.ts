// =============================================================================
// The storage slice's composition (RETRO-D1, #563)
// =============================================================================
//
// `StorageModule.forRoot` serves `/api/storage/objects` (the objects API, at the
// paths MemoriaHub always had, INCLUDING `POST :id/upload/part-urls`,
// `PUT :id/upload/parts/:partNumber` for a driver without presigned URLs and
// `GET :id/upload/status` with `uploadedParts`; `upload/init` answers
// `partUploadAuth`), `GET /api/storage/status`, the `storage.cleanup.stale-uploads`
// and `storage.object.process` job types and the stale-upload cron (which only
// enqueues). `StorageConfigModule` serves `/api/admin/storage-config` (read, save,
// connection test, bucket provisioning), the copy-only provider migration
// (`/api/admin/storage/migrations`, jobs `storage.migrate_plan` /
// `storage.migrate_object`) and the `storage.config` / `storage.bucket` Doctor
// checks. They replace MemoriaHub's own `storage/` and `storage-settings/`.
//
// THE OBJECT STORE IS RUNTIME-CONFIGURED: the active driver and its non-secret
// settings are the `storage` system-settings namespace, a driver's secrets are in
// the credential store (`storage/default` for the S3 family). The deployment's
// `STORAGE_PROVIDER`, `S3_*`, `AWS_*` and `BACKUP_LOCAL_PATH` environment
// variables are no longer read; `scripts/migrate-storage-settings.ts` copies them
// (and the legacy `storage_provider_credentials` rows) once. Runbook:
// docs/runbooks/storage-configuration.md.
//
// PER-ROW ROUTING is the platform's `StorageProviderRouter`: a download, delete,
// processing read or in-flight upload resolves the driver recorded on the row
// (`storage_provider`, `bucket`), so objects written to `s3`, `r2` or `local`
// before a switch keep working.
//
// NOT MOUNTED: `ProfileImageModule` (MemoriaHub's avatar is its own,
// `profile/user-avatar.service.ts`, under the same `avatars/` prefix).
//
// ORDER: the key-prefix manifest registers before the registry freezes, and the
// `local` driver before the `storage` namespace is composed.
//
// THE CONSTANT BELOW IS A SINGLETON: a module that needs `ObjectsService`
// imports `storageModule` (the same dynamic-module object), never a second
// `StorageModule.forRoot()`.
// =============================================================================

import { StorageConfigModule, StorageModule } from '@marinoscar/platform-api/storage';

import '../../app-registrations/storage';
import './storage-key-prefix.manifest';
import { StorageHostModule } from './storage-host.module';

/** How long an unfinished upload is left before the cleanup job reclaims it (the old cron's 24 hours). */
export const STALE_UPLOAD_HOURS = 24;

export const storageModule = StorageModule.forRoot({
  imports: [StorageHostModule],
  staleUploadHours: STALE_UPLOAD_HOURS,
});

export { StorageConfigModule };
