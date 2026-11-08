import type { UserRemovalHook } from '@marinoscar/platform-api/user-data';

import { MemoriaHubUserDataService } from './memoriahub-user-data.service';

// =============================================================================
// MemoriaHub's user removal hook (RETRO-H1, #591; Open decisions 1 and 2)
// =============================================================================
//
// Runs before the platform deletes a user ROW (the factory reset's "every other
// user" step, and offboarding with `userDisposition: 'purge'`). Four MemoriaHub
// keys name a user with `Restrict`: `circles.owner_id` and the `added_by_id` of
// `media_items`, `albums`, `tags` and `people`. Without this hook the user delete
// fails on the foreign key. What it does (`MemoriaHubUserDataService.prepareUserRemoval`):
//
//   - BLOCKS (throws, nothing changed) when the user owns a non-personal circle
//     with other members: the circle is the family's, and ownership must be
//     handed over first (Open decision 2; revisited when circles become groups,
//     Epic I). The job fails with the circle ids and the action to take;
//   - deletes the user's own circles (personal, or shared with nobody) with all
//     their content and stored files;
//   - REASSIGNS what the user added to other people's circles to each circle's
//     owner (Open decision 1: no schema change, the attribution stays meaningful,
//     the photos stay for the members).
//
// In a factory reset every circle is already gone (`memoriahub.content`), so the
// hook finds nothing to do.
// =============================================================================

export const memoriaHubCircleContentRemovalHook: UserRemovalHook<MemoriaHubUserDataService> = {
  id: 'memoriahub.circle-content',
  inject: MemoriaHubUserDataService,
  run: (service, userId) => service.prepareUserRemoval(userId),
};
