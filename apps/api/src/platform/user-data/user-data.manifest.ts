import type { Prisma } from '@prisma/client';
import {
  registerPlatformUserData,
  registerUserDataCategory,
  registerUserDataModels,
  registerUserDataScope,
  storageObjectModelHint,
  userDataModelRegistry,
  type UserDataModelHint,
  type UserDataPurgeDelegate,
} from '@marinoscar/platform-api/user-data';

import { MEMORIAHUB_PURGE_JOB_TYPES } from './memoriahub-purge.handlers';
// The factory reset steps register here, BEFORE `registerPlatformUserData()`, so
// they run ahead of the platform's own deployment steps.
import './factory-reset.steps';

// =============================================================================
// MemoriaHub's registrations on the platform user-data slice (RETRO-H1, #591)
// =============================================================================
//
// The platform owns `/api/user-data/*` (the Danger Zone, `user_settings:write`),
// `/api/admin/factory-reset/*` (`system:factory_reset`), the `user.data.purge`,
// `admin.factory_reset` and `org.offboard` jobs and the pages. This file is the
// keep-or-delete DECISION for every MemoriaHub owner model (a model the
// user-owned registry, `app-registrations/user-owned-models.ts`, gives an
// `ownerField`), the categories and scopes the Danger Zone shows, and kept-list
// lines. The delete ORDER is the planner's, from the composed Prisma schema.
//
// IMPORTED BEFORE THE MODULE IS COMPOSED (`user-data.config.ts`), and
// `registerPlatformUserData()` runs LAST: the platform skips an entry whose id is
// already registered, so ours win where they overlap (the `files` category and
// the `StorageObject` hint). The assertion at the bottom turns a wrong order
// into a boot failure.
//
// -----------------------------------------------------------------------------
// WHICH MODELS ARE DECIDED HERE
// -----------------------------------------------------------------------------
//
// The planner decides OWNER models: a user-owned registry entry with an
// `ownerField` (`app-registrations/user-owned-models.ts`). MemoriaHub's are
// `UserProfile`, `CircleMember`, `MediaSyncDevice`, `MemoryUserState` and the
// legacy node and notification tables, plus the platform's
// `StorageObject` (owner `uploaded_by_id`, SetNull). Circles (`owner_id`) and
// media, albums, tags and people (`added_by_id`) are ACTOR models whose key is
// `Restrict`: the registry refuses `ownerField` with `purge: 'retain'` ("a
// user's own rows are deleted or detached"), and making them owners would mean
// changing `onDelete` (a migration the issue keeps out of scope). So the
// personal library hangs off the one owner model that names every uploaded
// file, `StorageObject`:
//
//   StorageObject   -> memoriahub.circle.purge      (category `files`, "Your personal library")
//   MediaSyncDevice -> memoriahub.media_sync.purge  (also deletes each phone's token)
//   UserProfile     -> memoriahub.profile.purge     (also deletes the avatar files)
//
// `memoriahub.circle.purge` empties the user's PERSONAL circle: photos and
// videos with every stored file (original, thumbnails, video face frames, staged
// enhancements), albums, tags, people and faces, memories and workflows. What the
// user added to a circle shared with others stays there for its members (and is
// reassigned to the circle owner only when the user ROW is deleted:
// `user-removal.hook.ts`, Open decision 1).
//
// The Danger Zone count of `files` is the platform's: storage objects by
// `uploaded_by_id`. It includes the files behind what the user added to shared
// circles (which stay) and the derived thumbnails. A hint cannot narrow its
// count or delete set by circle: seam gap, recorded in local-exceptions.md.
//
// -----------------------------------------------------------------------------
// STORAGE OBJECTS ARE NEVER THE PLATFORM'S TO DELETE HERE
// -----------------------------------------------------------------------------
//
// The platform's own `StorageObject` hint is `storageObjects: true`: a purge
// collects EVERY object the user uploaded and deletes it through the ACTIVE
// storage provider. Both halves are wrong for MemoriaHub: the user's uploads
// include the originals behind photos in shared circles (deleting them would
// break the family's library), and each object lives on the provider recorded
// on its row (an admin may have switched since). So `StorageObject` is
// registered first, DELEGATED (the circle purge deletes files row by row through
// their own provider) and with `factoryReset: 'keep'` (the reset's org-data step
// would otherwise `deleteMany` the table under `media_items.storage_object_id`;
// the reset's `memoriahub.storage` step owns it).
//
// `MemoryUserState` (seen / hidden / favourite marks) and the two legacy
// notification tables are deleted inline.
//
// PUBLIC LINKS (RETRO-I4, #578) are platform link grants. The sharing slice
// decides them: a link belongs to the RECORD's owner, not to who created it
// (`grants.granted_by_id` is only recorded, SetNull), so a data reset no longer
// revokes the links a user created, and the `shares` category and scope are
// retired (a deliberate behaviour difference, docs/platform-adoption/local-exceptions.md).
//
// WHAT EACH SCOPE DELETES
//
//   library     files            the personal circle emptied, with its files
//   devices     devices          paired phones and their tokens
//   content     every `content: true` category: library, memory marks,
//               notifications, AI history and "other"
//   everything  every category: content plus devices, access tokens,
//               credentials, settings and the profile picture
//
// KEPT by every data reset: the user's circle memberships, the circles they
// share with others and what they added there, the worker-node fleet (the platform
// reassigns it to the administrator) and the platform's account state.
// =============================================================================

const delegate = (jobType: string): UserDataPurgeDelegate => ({
  jobType,
  payload: (userId: string): Record<string, unknown> => ({ userId }),
});

// Categories, in Danger Zone display order (the platform's are 10, 20, ... 90).
// `files` replaces the platform category of the same id (registered first).
registerUserDataCategory({
  id: 'files',
  label: 'Your personal library',
  description:
    'Everything in your personal circle: photos and videos with their files, albums, tags, people and faces, memories and workflows. What you added to a circle shared with others stays there. The count is the files you uploaded anywhere.',
  content: true,
  order: 1,
});
registerUserDataCategory({
  id: 'memories',
  label: 'Memory marks',
  description: 'Which memories you have seen, hidden or marked as a favourite.',
  content: true,
  order: 6,
});
registerUserDataCategory({
  id: 'devices',
  label: 'Paired Android devices',
  description: 'Phones paired for Media Sync, with their sync history and sign-in tokens. They stop syncing.',
  content: false,
  order: 8,
});

// Narrow scopes (ids and confirmation phrases are permanent API once a job carried them).
registerUserDataScope({
  id: 'library',
  label: 'Personal library',
  description: 'Empty your personal circle: photos, videos, albums, tags, people, faces, memories and workflows.',
  categories: ['files'],
  confirmation: 'LIBRARY',
  layer: 'specific',
  order: 10,
});
registerUserDataScope({
  id: 'devices',
  label: 'Paired devices',
  description: 'Unpair every phone and delete its token.',
  categories: ['devices'],
  confirmation: 'DEVICES',
  layer: 'specific',
  order: 30,
});

/** The decision for every MemoriaHub model the user-owned registry gives an owner column, plus kept-list lines. */
export const MEMORIAHUB_USER_DATA_MODELS: readonly UserDataModelHint<Prisma.ModelName>[] = [
  // ---- the personal library, delegated (ahead of the platform's `storageObjects: true`) ----
  {
    model: 'StorageObject',
    category: 'files',
    delegate: delegate(MEMORIAHUB_PURGE_JOB_TYPES.CIRCLE),
    factoryReset: 'keep',
  },

  // ---- the user's own rows ---------------------------------------------------
  { model: 'MemoryUserState', category: 'memories' },
  { model: 'MediaSyncDevice', category: 'devices', delegate: delegate(MEMORIAHUB_PURGE_JOB_TYPES.DEVICES) },
  { model: 'UserProfile', category: 'settings', delegate: delegate(MEMORIAHUB_PURGE_JOB_TYPES.PROFILE) },
  // Legacy notification tables (RETRO-D3 moves the data to the platform's).
  { model: 'MhLegacyNotification', category: 'notifications' },
  { model: 'MhLegacyPushSubscription', category: 'notifications' },

  // ---- kept ----------------------------------------------------------------------
  {
    model: 'CircleMember',
    keep: 'Access model: a data reset never removes the user from a circle; the circle and what they added to it are the members\'.',
    summary: 'Your circle memberships, and what you added to circles shared with others',
  },

  // ---- not owner models: lines for the factory reset page's "Kept" list ------------
  { model: 'TagLabel', factoryReset: 'keep', summary: 'The AI tag vocabulary' },
  { model: 'LocationGroup', factoryReset: 'keep', summary: 'Location groups and their aliases' },
  { model: 'AndroidAppRelease', factoryReset: 'keep', summary: 'Android app releases and their APK files' },
  // The pre-slice table, frozen since RETRO-D5 (#586) copied its rows into `android_app_releases`.
  { model: 'MhLegacyAndroidAppRelease', factoryReset: 'keep', summary: 'Android app releases from before the platform slice' },
];

registerUserDataModels<Prisma.ModelName>(MEMORIAHUB_USER_DATA_MODELS);

// The platform's categories, models and factory reset steps, LAST so ours win.
registerPlatformUserData();

/**
 * Boot-time proof that the registration order held: no model is the platform's
 * `storageObjects: true`, and `StorageObject` still delegates to the media purge.
 *
 * @throws Error naming the mistake.
 */
export function assertMemoriaHubUserDataRegistrations(): void {
  if (storageObjectModelHint() !== undefined) {
    throw new Error(
      'user-data: a model is registered with storageObjects: true, so a deletion would remove the files behind ' +
        "shared circles' photos through the active provider. user-data.manifest.ts must register the StorageObject " +
        'hint before registerPlatformUserData() runs.',
    );
  }
  const hint = userDataModelRegistry.get('StorageObject');
  if (hint?.delegate?.jobType !== MEMORIAHUB_PURGE_JOB_TYPES.CIRCLE || hint.factoryReset !== 'keep') {
    throw new Error(
      `user-data: the StorageObject hint must delegate to ${MEMORIAHUB_PURGE_JOB_TYPES.CIRCLE} and keep the table in a factory reset.`,
    );
  }
}

assertMemoriaHubUserDataRegistrations();
