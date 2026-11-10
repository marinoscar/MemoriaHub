import { registerSystemAccessReason } from '@marinoscar/platform-api/core';

// =============================================================================
// MemoriaHub's own system access reasons (RETRO-D1, #563)
// =============================================================================
//
// A `SystemAccessReason` names WHY a path lifts row-level security through
// `PrismaSystemService`; it is recorded on the active span. The platform's
// built-ins (`purge`, `doctor`, `admin-aggregate`, ...) cover the storage and
// db-backup paths. MemoriaHub adds:
//
//   media-housekeeping  the global `thumbnail_repair` sweep: finds media items
//                       whose thumbnail never landed across every organization
//                       and bumps an attempt counter on their storage objects.
//
//   storage-processing-recovery
//                       the `media.storage.recover_stuck` and `media.storage.reprocess`
//                       jobs (RETRO-D1b, #567): find storage objects stuck at
//                       `processing` (or `failed`) across every organization,
//                       bump their retry counter and queue a processing job.
//
//   owner-scope-sweep   the admin backfills and the location rebuild list every
//                       shared library (group) through `GroupsService.listForSystem`
//                       (platform next.29): read-only ids of every organization's
//                       groups, with no organization to scope to.
//
// Registered at import time (the registry freezes at bootstrap); imported by
// `prisma/prisma-system.service.ts`.
// =============================================================================

export const MEDIA_HOUSEKEEPING_REASON = 'media-housekeeping';

/** The stuck/failed storage-object recovery and the admin reprocess jobs (RETRO-D1b, #567). */
export const STORAGE_PROCESSING_RECOVERY_REASON = 'storage-processing-recovery';

/** The admin backfills' and the location rebuild's listing of every group (RETRO-N29). */
export const OWNER_SCOPE_SWEEP_REASON = 'owner-scope-sweep';

let registered = false;

/** Registers the app's reasons once per process. */
export function registerMemoriaHubSystemAccessReasons(): void {
  if (registered) return;
  registered = true;
  registerSystemAccessReason({
    id: MEDIA_HOUSEKEEPING_REASON,
    description:
      'The global thumbnail_repair sweep finds media items with a missing thumbnail in every organization ' +
      'and bumps an attempt counter on their storage objects; it is a system job with no organization to scope to.',
  });
  registerSystemAccessReason({
    id: STORAGE_PROCESSING_RECOVERY_REASON,
    description:
      'The media.storage.recover_stuck and media.storage.reprocess jobs find storage objects stuck at processing ' +
      '(or failed) in every organization, bump their retry counter and queue a storage.object.process job for each; ' +
      'they are system jobs with no organization to scope to.',
  });
  registerSystemAccessReason({
    id: OWNER_SCOPE_SWEEP_REASON,
    description:
      'The admin backfills (metadata, face, burst, duplicate, tagging, social media) and the location-group rebuild ' +
      'list the id of every group in every organization through GroupsService.listForSystem, read-only, ' +
      'to enqueue or run per-library work; they are system sweeps with no organization to scope to.',
  });
}

registerMemoriaHubSystemAccessReasons();
