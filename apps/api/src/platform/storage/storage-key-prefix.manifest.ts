// =============================================================================
// Object-storage key prefixes (RETRO-D1, #563)
// =============================================================================
//
// Every key prefix this deployment writes under, registered before the registry
// freezes at bootstrap. A destructive path (the storage purge, org offboarding,
// the factory reset) may enumerate only this list, so a prefix that is not here
// is a prefix a purge silently leaves behind. The `storage` conformance suite
// fails on a malformed or overlapping prefix and on a missing required id.
//
// PLATFORM prefixes first, in the platform's purge order: the storage slice's
// four (`uploads/`, `avatars/`, `node-outputs/`, `storage-config-test/`), then the
// db-backup slice's `database-backups/`. `StorageModule.forRoot()` and
// `DbBackupModule` register them too; a registration identical to an existing
// one is skipped, which is what lets this manifest fix the ORDER.
//
// MEMORIAHUB prefixes are `deployment` scope (except `avatars/`, which is the
// platform's user-scoped entry: MemoriaHub's avatars are `avatars/<userId>/<uuid>.jpg`,
// the same layout). MemoriaHub keeps its own key builders and its stored keys:
// no object is ever moved to a `<prefix><orgId>/` layout.
//
//   uploads/            platform; MemoriaHub's legacy `uploads/<timestamp>/<uuid><ext>` keys live here
//   thumbnails/         content-addressed `thumbnails/<objectId>-<hash16>.jpg` (#434)
//   video-faces/        representative video face frames, `video-faces/<mediaItemId>/<uuid>.jpg`
//   enhancements/       AI enhancer staging, `enhancements/<id>/result.jpg` and `thumb.jpg`
//   db-backups/         database archives written before the db-backup slice (RETRO-D4); never moved
//   android-releases/   hosted APKs, `android-releases/<releaseId>.apk` (the android-app slice's
//                       definition, registered here until RETRO-D5 mounts that slice)
//
// Not registrable: `__memoriahub_conn_test__/`, the old connection-test sentinel
// (an underscore is outside the prefix pattern). Nothing writes it since RETRO-D1:
// the platform's connection test uses `storage-config-test/`. A probe object a
// failed test left there is listed in docs/runbooks/storage-configuration.md.
// =============================================================================

import { DB_BACKUP_KEY_PREFIX } from '@marinoscar/platform-api/db-backup';
import {
  STORAGE_SLICE_KEY_PREFIXES,
  registerStorageKeyPrefixes,
  storageKeyPrefixRegistry,
  type StorageKeyPrefixDef,
} from '@marinoscar/platform-api/storage';

/** Where MemoriaHub wrote database archives before the platform slice (`db-backups/<stamp>-<runId>.dump`). */
export const LEGACY_DB_BACKUP_KEY_PREFIX: StorageKeyPrefixDef = Object.freeze({
  id: 'legacy-db-backups',
  prefix: 'db-backups/',
  owner: 'db-backup',
  scope: 'deployment' as const,
  description: 'Database backup archives written before the platform slice (RETRO-D4); never moved.',
  survivesFactoryReset: true,
});

/** The hosted APKs: the android-app slice's own definition (`ANDROID_RELEASES_KEY_PREFIX_DEF`). */
export const ANDROID_RELEASES_KEY_PREFIX: StorageKeyPrefixDef = Object.freeze({
  id: 'android-releases',
  prefix: 'android-releases/',
  owner: 'android-app',
  scope: 'deployment' as const,
  description: 'Android APK releases the deployment hosts, android-releases/<releaseId>.apk (kept by the factory reset).',
  survivesFactoryReset: true,
});

/** MemoriaHub's own prefixes, appended after the platform's. */
export const MEMORIAHUB_KEY_PREFIXES: readonly StorageKeyPrefixDef[] = [
  {
    id: 'thumbnails',
    prefix: 'thumbnails/',
    owner: 'media',
    scope: 'deployment',
    description: 'Content-addressed media thumbnails, thumbnails/<objectId>-<hash16>.jpg (#434).',
  },
  {
    id: 'video-faces',
    prefix: 'video-faces/',
    owner: 'face',
    scope: 'deployment',
    description: 'Representative frames of faces detected in videos, video-faces/<mediaItemId>/<uuid>.jpg.',
  },
  {
    id: 'enhancements',
    prefix: 'enhancements/',
    owner: 'enhancement',
    scope: 'deployment',
    description: 'AI Picture Enhancer staging objects, enhancements/<enhancementId>/result.jpg and thumb.jpg.',
  },
  LEGACY_DB_BACKUP_KEY_PREFIX,
  ANDROID_RELEASES_KEY_PREFIX,
];

/** Every prefix this deployment registers, in purge order. */
export const ALL_KEY_PREFIXES: readonly StorageKeyPrefixDef[] = [
  ...STORAGE_SLICE_KEY_PREFIXES,
  DB_BACKUP_KEY_PREFIX,
  ...MEMORIAHUB_KEY_PREFIXES,
];

/** The ids the `storage` conformance suite requires (every MemoriaHub writer's prefix). */
export const MEMORIAHUB_REQUIRED_KEY_PREFIX_IDS = [
  DB_BACKUP_KEY_PREFIX.id,
  ...MEMORIAHUB_KEY_PREFIXES.map((def) => def.id),
] as const;

let registered = false;

/** Registers {@link ALL_KEY_PREFIXES} (skipping an id a slice already registered). Idempotent per process. */
export function registerMemoriaHubStorageKeyPrefixes(): void {
  if (registered) return;
  registered = true;
  const missing = ALL_KEY_PREFIXES.filter((def) => !storageKeyPrefixRegistry.has(def.id));
  if (missing.length > 0 && !storageKeyPrefixRegistry.frozen) registerStorageKeyPrefixes(missing);
}

registerMemoriaHubStorageKeyPrefixes();
