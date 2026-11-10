import type { ModelOwnershipDef } from '@marinoscar/platform-api/core';
import type { Prisma } from '@prisma/client';

// =============================================================================
// MemoriaHub's model ownership kinds (RETRO-B2, issue #611)
// =============================================================================
//
// The platform's models are classified by `registerPlatformModelOwnership`.
// The content tables are `org` since RETRO-I2 (#569): each carries `org_id`
// (NOT NULL, the default organization) under FORCE ROW LEVEL SECURITY and is
// owned by a group (a former shared circle) or a user (a former personal
// circle). The other MemoriaHub models are `system`: the app runs in
// single-organization mode, and the circle tables left with RETRO-K2 (a personal library is a system row).

const SINGLE_ORG = 'MemoriaHub app table: single-organization mode, no org_id column until Epic I.';

const SYSTEM_MODELS = [
  'UserProfile', 'PersonalLibrary', 'AlbumItem', 'MediaTag', 'MediaFaceStatus', 'TagLabel',
  'InsightsSnapshot', 'MediaSocialStatus', 'LocationGroup', 'LocationGroupAlias', 'ReviewRunItem',
  'TrashEmptyRunItem', 'WorkflowRunItem', 'MemoryItem', 'MemoryUserState', 'MediaSyncDevice', 'MediaSyncRun',
  'MediaSyncDiagnosticReport', 'NodeBackupConfig', 'NodeBackupRun', 'EnrichmentJob', 'AiProviderCredential',
  'FaceProviderCredential', 'GeoProviderCredential', 'StorageProviderCredential', 'MhLegacyStorageMigrationRun',
  'MhLegacyStorageMigrationItem', 'MhLegacyNotification', 'MhLegacyPushSubscription', 'MhLegacyNotificationDelivery',
  'MhLegacyNotificationBroadcast', 'MhLegacyDatabaseBackupRun',
  'MhLegacyAndroidAppRelease',
] as const satisfies readonly Prisma.ModelName[];

const CONTENT =
  'MemoriaHub content (RETRO-I2): org_id under FORCE RLS, owned by a group (a former shared circle) or a user (a former personal circle).';

/** The content tables of docs/platform-adoption/circles-to-groups.md §3 (`media_visual_embedding` has no model). */
export const ORG_CONTENT_MODELS = [
  'MediaItem', 'MediaItemEmbedding', 'Album', 'Tag', 'Person', 'Face', 'Memory', 'BurstGroup', 'DuplicateGroup',
  'LocationSuggestion', 'MediaEnhancement', 'MediaEnhancementBatch', 'MediaMetadataStatus', 'MediaGeocodeStatus',
  'MediaTagStatus', 'MediaTranscript', 'ReviewRun', 'TrashEmptyRun', 'Workflow', 'WorkflowRun',
] as const satisfies readonly Prisma.ModelName[];

export const APP_MODEL_OWNERSHIP: readonly ModelOwnershipDef<Prisma.ModelName>[] = [
  ...SYSTEM_MODELS.map((model) => ({ model, kind: 'system' as const, rationale: SINGLE_ORG })),
  ...ORG_CONTENT_MODELS.map((model) => ({ model, kind: 'org' as const, orgField: 'orgId', rationale: CONTENT })),
];
