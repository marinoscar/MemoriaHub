import type { ModelOwnershipDef } from '@marinoscar/platform-api/core';
import type { Prisma } from '@prisma/client';

// =============================================================================
// MemoriaHub's model ownership kinds (RETRO-B2, issue #611)
// =============================================================================
//
// The platform's models are classified by `registerPlatformModelOwnership`.
// Every MemoriaHub model is `system` for now: the app runs in single-organization
// mode and none of its own tables carries an `org_id` (the platform's
// `storage_objects` is the one org-scoped table the app writes, and it is the
// platform's). Per-organization isolation of circles and media arrives with
// Epic I (circles become sharing groups), which reclassifies the circle models.

const SINGLE_ORG = 'MemoriaHub app table: single-organization mode, no org_id column until Epic I.';

const SYSTEM_MODELS = [
  'UserProfile', 'Circle', 'CircleMember', 'CircleInvite', 'MediaItem', 'Album', 'AlbumItem', 'Tag', 'MediaTag',
  'Person', 'Face', 'MediaFaceStatus', 'TagLabel', 'MediaTagStatus', 'MediaTranscript', 'InsightsSnapshot',
  'MediaItemEmbedding', 'BurstGroup', 'DuplicateGroup', 'MediaMetadataStatus',
  'MediaGeocodeStatus', 'MediaSocialStatus', 'LocationSuggestion', 'LocationGroup', 'LocationGroupAlias', 'MediaShare',
  'ReviewRun', 'ReviewRunItem', 'TrashEmptyRun', 'TrashEmptyRunItem', 'Workflow', 'WorkflowRun', 'WorkflowRunItem',
  'MediaEnhancement', 'MediaEnhancementBatch', 'Memory', 'MemoryItem', 'MemoryUserState', 'MediaSyncDevice',
  'MediaSyncRun', 'MediaSyncDiagnosticReport', 'NodeBackupConfig', 'NodeBackupRun', 'EnrichmentJob',
  'AiProviderCredential', 'FaceProviderCredential', 'GeoProviderCredential', 'StorageProviderCredential',
  'MhLegacyStorageMigrationRun', 'MhLegacyStorageMigrationItem', 'MhLegacyNotification', 'MhLegacyPushSubscription',
  'MhLegacyNotificationDelivery', 'MhLegacyNotificationBroadcast', 'MhLegacyWorkerNode',
  'MhLegacyNodeCredential', 'MhLegacyDatabaseBackupRun', 'MhLegacyAndroidAppRelease',
] as const satisfies readonly Prisma.ModelName[];

export const APP_MODEL_OWNERSHIP: readonly ModelOwnershipDef<Prisma.ModelName>[] = SYSTEM_MODELS.map((model) => ({
  model,
  kind: 'system' as const,
  rationale: SINGLE_ORG,
}));
