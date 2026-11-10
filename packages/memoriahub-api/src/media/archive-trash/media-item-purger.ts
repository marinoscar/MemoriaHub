/**
 * Injection token of {@link MediaItemPurger}. The description string is permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEDIA_ITEM_PURGER = Symbol.for('@marinoscar/memoriahub/MEDIA_ITEM_PURGER');

/**
 * The hard delete of trashed media items: the rows, their stored bytes (batched, never one call
 * per item), the grants on them and the album joins. The trash purge handler decides WHICH items
 * are past retention; this is how they are deleted. The host binds it until the gallery service
 * moves into this package.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MediaItemPurger {
  /**
   * Hard-deletes the items.
   *
   * @param ids - the media item ids.
   * @returns how many were deleted and which could not be.
   */
  purgeMediaItemsBatched(ids: string[]): Promise<{ deleted: number; failedIds: string[] }>;
}
