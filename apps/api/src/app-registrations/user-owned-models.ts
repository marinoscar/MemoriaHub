import type { UserOwnedModelDef } from '@marinoscar/platform-api/core';
import type { Prisma } from '@prisma/client';

// =============================================================================
// MemoriaHub's user-owned models (RETRO-B2, issue #611)
// =============================================================================
//
// Every MemoriaHub model with a foreign key to `User`, classified against its
// `onDelete`. The platform's own models (`PersonalAccessToken`, `UserSettings`,
// `StorageObject`, ...) are `registerPlatformUserOwnedModels`'s; these are the
// app's. The `user-owned-data` conformance suite
// (`test/conformance.spec.ts`) fails when this list and the schema disagree:
//
//   OWNER  the row belongs to the user. `purge: 'delete'` requires
//          `onDelete: Cascade`.
//   ACTOR  the row only names a user who acted (resolved, created, updated).
//          `'detach'` requires `SetNull`; `'retain'` requires `Restrict` and
//          means the user cannot be deleted while the row exists.
//
// Media, albums, tags, people and circles are shared circle content: their
// `added_by` / `owner` key is a `Restrict` actor field. A user who still owns
// content cannot be deleted until it is transferred or removed, which is the
// behaviour the schema always had.
//
// The legacy notification, node and backup models (`MhLegacy*`) leave this list
// with the slice that replaces them (RETRO-D3, C2, D4, D5).
// =============================================================================

const SHARED_CONTENT =
  'Shared circle content: the user is the uploader, not the owner. The key is Restrict, so the user cannot be deleted while it exists; content is transferred or removed first.';
// RETRO-I2 (#569): `owner_user_id` is the owner of a former personal circle's row,
// `Restrict` like the personal circle's `owner_id` it replaces: the user removal
// hook empties the personal library before the user row goes, and a user row is
// never deleted with a library still attached. The nine content models that also
// carry a SetNull actor key (burst and duplicate groups, location suggestions,
// enhancements and their batches, review, trash and workflow runs) cannot list
// it here (one purge policy per entry): their foreign key exists in the database
// only (`PLATFORM-ADOPTION-SHIM(#573)`, local-exceptions.md).
const PERSONAL_LIBRARY =
  'A row of a former personal circle: owner_user_id names the library\'s user (Restrict, like the circle\'s owner_id); the user removal hook empties the personal library before the user row is deleted.';
const RESOLVER =
  'Records who resolved or acted on a review item. The review row outlives the person, so the reference is detached.';

export const APP_USER_OWNED_MODELS: readonly UserOwnedModelDef<Prisma.ModelName>[] = [
  // ---- owner models, deleted with the user (onDelete: Cascade) ----------------
  {
    model: 'UserProfile',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    // RETRO-H2 (#596): the derived avatar's object key never leaves the server.
    exportOmit: ['avatarStorageKey'],
    rationale: "The user's profile-picture state and person link; meaningless without the user.",
  },
  {
    model: 'CircleMember',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The user's membership of a circle, with the per-circle role.",
  },
  {
    model: 'MediaSyncDevice',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "A phone the user paired for Media Sync, with its desired config. The device's token is a personal access token, deleted with the user.",
  },
  {
    model: 'MemoryUserState',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The user's own seen, hidden and favourite marks on a memory.",
  },
  {
    model: 'MhLegacyNotification',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The user's in-app notifications. Replaced by the platform notifications slice (RETRO-D3).",
  },
  {
    model: 'MhLegacyPushSubscription',
    ownerField: 'userId',
    purge: 'delete',
    export: 'exclude',
    rationale: 'A browser push subscription: device state with keys that never leave the server. Replaced by RETRO-D3.',
  },

  // ---- actor-only models -------------------------------------------------------
  {
    model: 'Circle',
    actorFields: ['ownerId'],
    purge: 'retain',
    export: 'exclude',
    rationale: 'A circle has members besides its owner; the owner hands it over or deletes it before the user can be deleted.',
  },
  { model: 'MediaItem', actorFields: ['addedById', 'ownerUserId'], purge: 'retain', export: 'exclude', rationale: SHARED_CONTENT },
  { model: 'Album', actorFields: ['addedById', 'ownerUserId'], purge: 'retain', export: 'exclude', rationale: SHARED_CONTENT },
  { model: 'Tag', actorFields: ['addedById', 'ownerUserId'], purge: 'retain', export: 'exclude', rationale: SHARED_CONTENT },
  { model: 'Person', actorFields: ['addedById', 'ownerUserId'], purge: 'retain', export: 'exclude', rationale: SHARED_CONTENT },
  { model: 'Face', actorFields: ['ownerUserId'], purge: 'retain', export: 'exclude', rationale: PERSONAL_LIBRARY },
  { model: 'Memory', actorFields: ['ownerUserId'], purge: 'retain', export: 'exclude', rationale: PERSONAL_LIBRARY },
  { model: 'MediaItemEmbedding', actorFields: ['ownerUserId'], purge: 'retain', export: 'exclude', rationale: PERSONAL_LIBRARY },
  { model: 'MediaGeocodeStatus', actorFields: ['ownerUserId'], purge: 'retain', export: 'exclude', rationale: PERSONAL_LIBRARY },
  { model: 'MediaMetadataStatus', actorFields: ['ownerUserId'], purge: 'retain', export: 'exclude', rationale: PERSONAL_LIBRARY },
  { model: 'MediaTagStatus', actorFields: ['ownerUserId'], purge: 'retain', export: 'exclude', rationale: PERSONAL_LIBRARY },
  { model: 'MediaTranscript', actorFields: ['ownerUserId'], purge: 'retain', export: 'exclude', rationale: PERSONAL_LIBRARY },

  { model: 'BurstGroup', actorFields: ['resolvedById'], purge: 'detach', export: 'exclude', rationale: RESOLVER },
  { model: 'DuplicateGroup', actorFields: ['resolvedById'], purge: 'detach', export: 'exclude', rationale: RESOLVER },
  { model: 'LocationSuggestion', actorFields: ['resolvedById'], purge: 'detach', export: 'exclude', rationale: RESOLVER },
  {
    model: 'MediaEnhancement',
    actorFields: ['createdById'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'Records who requested an enhancement; the staged result belongs to the media item.',
  },
  {
    model: 'MediaEnhancementBatch',
    actorFields: ['createdById'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'Records who queued a bulk enhancement.',
  },
  {
    model: 'LocationGroup',
    actorFields: ['createdById'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'An admin-curated place name; the group outlives the admin who created it.',
  },
  {
    model: 'ReviewRun',
    actorFields: ['startedById'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'Records who started a bulk review action; the run history is the circle\'s.',
  },
  {
    model: 'TrashEmptyRun',
    actorFields: ['startedById'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'Records who started an empty-trash run; the run history is the circle\'s.',
  },
  {
    model: 'Workflow',
    actorFields: ['createdById'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'A circle automation; it outlives its author (an unattended run falls back to the starter).',
  },
  {
    model: 'WorkflowRun',
    actorFields: ['startedById', 'approvedById'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'Records who started and approved a run; the run history is the circle\'s.',
  },
  {
    model: 'AiProviderCredential',
    actorFields: ['updatedByUserId'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'Records which admin last updated a deployment credential; the credential is the deployment\'s.',
  },
  {
    model: 'FaceProviderCredential',
    actorFields: ['updatedByUserId'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'Records which admin last updated a deployment credential; the credential is the deployment\'s.',
  },
  {
    model: 'GeoProviderCredential',
    actorFields: ['updatedByUserId'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'Records which admin last updated a deployment credential; the credential is the deployment\'s.',
  },
  {
    model: 'StorageProviderCredential',
    actorFields: ['updatedByUserId'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'Records which admin last updated a deployment credential; the credential is the deployment\'s.',
  },
  {
    model: 'MhLegacyAndroidAppRelease',
    actorFields: ['uploadedById'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'A release is a deployment artifact and survives its uploader. Replaced by RETRO-D5.',
  },
  {
    model: 'MhLegacyDatabaseBackupRun',
    actorFields: ['createdById', 'restoredById'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'A database backup is the deployment\'s; the run records who started and restored it. Replaced by RETRO-D4.',
  },
  {
    model: 'MhLegacyNotificationBroadcast',
    actorFields: ['createdById', 'canceledById'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'An announcement outlives the admin who sent or canceled it. Replaced by RETRO-D3.',
  },
  {
    model: 'MhLegacyNotificationDelivery',
    actorFields: ['userId'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'A delivery audit row outlives the user it was sent to. Replaced by RETRO-D3.',
  },
];
