// =============================================================================
// The burst observer (RETRO-J10, #624)
// =============================================================================
//
// What happens AFTER a burst group's resolve commits: the `media.item.trashed` webhook (RETRO-H4). Its
// batching and payload are the host's (the platform webhooks slice), so the slice reaches it through this one
// optional port: a host that wants no webhook binds nothing. Called outside any transaction; must never throw.
// =============================================================================

/**
 * Injection token of the {@link BurstObserver}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const BURST_OBSERVER = Symbol.for('@marinoscar/memoriahub/BURST_OBSERVER');

/**
 * Side channels of a burst resolve.
 *
 * @extensionPoint interface
 * @stability experimental
 */
export interface BurstObserver {
  /**
   * Items of one circle were moved to Trash by a burst resolve (the transaction committed).
   *
   * @param circleId - the owner scope.
   * @param mediaItemIds - the trashed items.
   */
  mediaTrashed(circleId: string, mediaItemIds: readonly string[]): void;
}
