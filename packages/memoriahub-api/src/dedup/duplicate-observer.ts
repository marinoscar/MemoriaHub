// =============================================================================
// The duplicate observer (RETRO-J10, #624)
// =============================================================================
//
// What happens AFTER a duplicate group's resolve commits: the `media.item.trashed` webhook (RETRO-H4). Its
// batching and payload are the host's (the platform webhooks slice), so the slice reaches it through this one
// optional port: a host that wants no webhook binds nothing. Called outside any transaction; must never throw.
// =============================================================================

/**
 * Injection token of the {@link DuplicateObserver}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const DUPLICATE_OBSERVER = Symbol.for('@marinoscar/memoriahub/DUPLICATE_OBSERVER');

/**
 * Side channels of a duplicate resolve.
 *
 * @extensionPoint interface
 * @stability experimental
 */
export interface DuplicateObserver {
  /**
   * Items of one circle were moved to Trash by a duplicate resolve (the transaction committed).
   *
   * @param circleId - the owner scope.
   * @param mediaItemIds - the trashed items.
   */
  mediaTrashed(circleId: string, mediaItemIds: readonly string[]): void;
}
