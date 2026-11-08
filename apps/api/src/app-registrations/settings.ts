// =============================================================================
// MemoriaHub's settings namespaces (RETRO-B3, #614)
// =============================================================================
//
// What this app adds to the platform's settings registries, and the type
// augmentation that types `AppSystemSettingsService.getSettings()`,
// `getNamespace('workflows')` and the user-settings responses.
//
//   system (app list): ui, features, ai, autoTagging, face, storage, burst, dedup,
//                      locationInference, locationGrouping, socialMedia, geo, email,
//                      reviewRuns, notifications, pictureEnhancement, backup, workflows,
//                      memories
//   system (platform): maintenance (registered by the host core), jobs and retention (the jobs slice, RETRO-C1),
//                      databaseBackup (the db-backup slice, RETRO-D4)
//   user   (app list): search, notifications, memories, timezone
//   user   (platform): dataTables, navigation (extended with MemoriaHub's `pinned`)
//
// The app namespaces below marked `PLATFORM-ADOPTION-SHIM` are TEMPORARY copies of a namespace whose
// platform slice MemoriaHub adopts later: email (D2),
// notifications, system and user (D3), storage (D1). `jobs` was the sixth; the
// jobs slice (RETRO-C1) swapped it for the platform declaration, same stored shape. `databaseBackup`
// was the fifth; the db-backup slice (RETRO-D4) swapped it for the platform declaration, and
// `scripts/migrate-db-backup-settings.ts` rewrites the stored value into the platform's shape. Each keeps today's
// stored shape under the same key, so the swap is a change of declaration and nothing moves in
// the `global` row. docs/platform-adoption/local-exceptions.md lists them.
//
// STORED SHAPE: NO KEY IS RENAMED. A field a namespace does not declare is dropped from the
// response but carried forward on every write (the platform preserves unmodelled keys), which is
// what keeps `email.smtpPassword` in the row and out of every response.
// =============================================================================

import { AI_SYSTEM_SETTINGS } from '@marinoscar/platform-api/ai';
import type {
  SettingsDefaultsOverride,
  SystemSettingsNamespace,
  SystemSettingsNamespaceExtension,
  UserSettingsNamespace,
  UserSettingsNamespaceExtension,
} from '@marinoscar/platform-api/settings';

import { AUTO_TAGGING_SYSTEM_SETTINGS, type AutoTaggingSettingsValue } from '../settings/registry/namespaces/system/auto-tagging';
import { BACKUP_SYSTEM_SETTINGS, type BackupSettingsValue } from '../settings/registry/namespaces/system/backup';
import { BURST_SYSTEM_SETTINGS, type BurstSettingsValue } from '../settings/registry/namespaces/system/burst';
import { DEDUP_SYSTEM_SETTINGS, type DedupSettingsValue } from '../settings/registry/namespaces/system/dedup';
import { EMAIL_SYSTEM_SETTINGS, type EmailSettingsValue } from '../settings/registry/namespaces/system/email';
import { FACE_SYSTEM_SETTINGS, type FaceSettingsValue } from '../settings/registry/namespaces/system/face';
import { FEATURES_SYSTEM_SETTINGS, type FeaturesSettingsValue } from '../settings/registry/namespaces/system/features';
import { GEO_SYSTEM_SETTINGS, type GeoSettingsValue } from '../settings/registry/namespaces/system/geo';
import { LOCATION_GROUPING_SYSTEM_SETTINGS, type LocationGroupingSettingsValue } from '../settings/registry/namespaces/system/location-grouping';
import { LOCATION_INFERENCE_SYSTEM_SETTINGS, type LocationInferenceSettingsValue } from '../settings/registry/namespaces/system/location-inference';
import { MEMORIES_SYSTEM_SETTINGS, type MemoriesSettingsValue } from '../settings/registry/namespaces/system/memories';
import { NOTIFICATIONS_SYSTEM_SETTINGS, type NotificationsSettingsValue } from '../settings/registry/namespaces/system/notifications';
import { PICTURE_ENHANCEMENT_SYSTEM_SETTINGS, type PictureEnhancementSettingsValue } from '../settings/registry/namespaces/system/picture-enhancement';
import { REVIEW_RUNS_SYSTEM_SETTINGS, type ReviewRunsSettingsValue } from '../settings/registry/namespaces/system/review-runs';
import { SOCIAL_MEDIA_SYSTEM_SETTINGS, type SocialMediaSettingsValue } from '../settings/registry/namespaces/system/social-media';
import { STORAGE_SYSTEM_SETTINGS, type StorageSettingsValue } from '../settings/registry/namespaces/system/storage';
import { UI_SYSTEM_SETTINGS, type UiSettingsValue } from '../settings/registry/namespaces/system/ui';
import { WORKFLOWS_SYSTEM_SETTINGS, type WorkflowsSettingsValue } from '../settings/registry/namespaces/system/workflows';
import { MEMORIES_USER_SETTINGS, type MemoriesPreferencesValue } from '../settings/registry/namespaces/user/memories';
import { NAVIGATION_USER_SETTINGS_EXTENSION } from '../settings/registry/namespaces/user/navigation';
import { NOTIFICATIONS_USER_SETTINGS, type NotificationPreferencesValue } from '../settings/registry/namespaces/user/notifications';
import { SEARCH_USER_SETTINGS, type SearchPreferencesValue } from '../settings/registry/namespaces/user/search';
import { TIMEZONE_USER_SETTINGS } from '../settings/registry/namespaces/user/timezone';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';
import { MEMORIAHUB_AI_SETTINGS_EXTENSION } from '../platform/ai/ai-settings.extension';

/** MemoriaHub's system namespaces, in order (the platform's `maintenance` is registered by the host). */
export const APP_SYSTEM_SETTINGS_NAMESPACES: readonly SystemSettingsNamespace[] = [
  UI_SYSTEM_SETTINGS,
  FEATURES_SYSTEM_SETTINGS,
  // The platform AI slice's policy since RETRO-E1 (#595), kept at this position so the stored key
  // order of the `global` row does not change; MemoriaHub's `features` selections are folded in by
  // `MEMORIAHUB_AI_SETTINGS_EXTENSION` below.
  AI_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace,
  AUTO_TAGGING_SYSTEM_SETTINGS,
  FACE_SYSTEM_SETTINGS,
  STORAGE_SYSTEM_SETTINGS, // PLATFORM-ADOPTION-SHIM(RETRO-D1)
  BURST_SYSTEM_SETTINGS,
  DEDUP_SYSTEM_SETTINGS,
  LOCATION_INFERENCE_SYSTEM_SETTINGS,
  LOCATION_GROUPING_SYSTEM_SETTINGS,
  SOCIAL_MEDIA_SYSTEM_SETTINGS,
  GEO_SYSTEM_SETTINGS,
  EMAIL_SYSTEM_SETTINGS, // PLATFORM-ADOPTION-SHIM(RETRO-D2): legacy, read-only rollback copy since #570
  REVIEW_RUNS_SYSTEM_SETTINGS,
  NOTIFICATIONS_SYSTEM_SETTINGS, // PLATFORM-ADOPTION-SHIM(RETRO-D3)
  PICTURE_ENHANCEMENT_SYSTEM_SETTINGS,
  BACKUP_SYSTEM_SETTINGS,
  WORKFLOWS_SYSTEM_SETTINGS,
  MEMORIES_SYSTEM_SETTINGS,
  // `databaseBackup` is the db-backup slice's since RETRO-D4 (#580): settings/registry/system-settings.manifest.ts.
] as unknown as readonly SystemSettingsNamespace[];

/**
 * Fields this app stores in a platform-declared system namespace that the platform lacks.
 *
 * `ai` (RETRO-E1, #595): the per-feature provider/model selections (`features.*`) MemoriaHub has
 * always stored in the `ai` block; same names and shapes, so the row is unchanged.
 */
export const APP_SYSTEM_SETTINGS_EXTENSIONS: readonly SystemSettingsNamespaceExtension[] = [
  MEMORIAHUB_AI_SETTINGS_EXTENSION,
];

/**
 * Defaults where this app differs from the platform's declaration.
 *
 * `databaseBackup` (RETRO-D4, #580): MemoriaHub's own defaults before the slice, kept so a fresh
 * install behaves as before. `compressionLevel` 1 because the embedding vectors that dominate the
 * dump are near-incompressible (higher levels buy CPU, not bytes); `oldDatabaseRetentionHours` 168 is
 * the week-long seconds-fast rollback window; `runStaleMinutes` 30 releases a dead run sooner than
 * the platform's 120. A stored value always wins over a default.
 */
export const APP_SYSTEM_SETTINGS_DEFAULTS: readonly SettingsDefaultsOverride[] = [
  {
    key: 'databaseBackup',
    defaults: { runStaleMinutes: 30, compressionLevel: 1, oldDatabaseRetentionHours: 168 },
  },
];

/** MemoriaHub's user namespaces, in order (after the platform's `dataTables` and `navigation`). */
export const APP_USER_SETTINGS_NAMESPACES: readonly UserSettingsNamespace[] = [
  SEARCH_USER_SETTINGS,
  NOTIFICATIONS_USER_SETTINGS, // PLATFORM-ADOPTION-SHIM(RETRO-D3)
  MEMORIES_USER_SETTINGS,
  TIMEZONE_USER_SETTINGS,
] as unknown as readonly UserSettingsNamespace[];

/** Fields this app stores in a platform-declared user namespace that the platform lacks. */
export const APP_USER_SETTINGS_EXTENSIONS: readonly UserSettingsNamespaceExtension[] = [
  NAVIGATION_USER_SETTINGS_EXTENSION,
];

// `ai` is the platform AI slice's since RETRO-E1 (#595): the platform declares and augments it, and
// MemoriaHub adds `features` through `MEMORIAHUB_AI_SETTINGS_EXTENSION` (read through
// `AppSystemSettings.ai`).
// The augmentation covers the namespaces MemoriaHub owns for good. The temporary ones (system:
// storage, notifications, email; user: notifications) are left out ON
// PURPOSE: the platform slices declare the same keys with their own types, and declaring a key twice
// with different types is TS2717 (and which one wins depends on file order). The app reads those
// through `AppSystemSettings` (settings/app-settings.types.ts) instead.
declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    ui: UiSettingsValue;
    features: FeaturesSettingsValue;
    autoTagging: AutoTaggingSettingsValue;
    face: FaceSettingsValue;
    burst: BurstSettingsValue;
    dedup: DedupSettingsValue;
    locationInference: LocationInferenceSettingsValue;
    locationGrouping: LocationGroupingSettingsValue;
    socialMedia: SocialMediaSettingsValue;
    geo: GeoSettingsValue;
    reviewRuns: ReviewRunsSettingsValue;
    pictureEnhancement: PictureEnhancementSettingsValue;
    backup: BackupSettingsValue;
    workflows: WorkflowsSettingsValue;
    memories: MemoriesSettingsValue;
  }

  interface UserSettingsNamespaces {
    search: SearchPreferencesValue;
    memories: MemoriesPreferencesValue;
    timezone: string;
  }
}
