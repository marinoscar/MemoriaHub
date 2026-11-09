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
// Registered at import time (the registry freezes at bootstrap); imported by
// `prisma/prisma-system.service.ts`.
// =============================================================================

export const MEDIA_HOUSEKEEPING_REASON = 'media-housekeeping';

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
}

registerMemoriaHubSystemAccessReasons();
