// =============================================================================
// MEMORIAHUB_SHARING: the link-sharing port (RETRO-J10, #624)
// =============================================================================
//
// A public link to a photo or an album lives where the host keeps its sharing (the web edition binds it
// over the platform sharing slice, where a link is a grant). A slice that needs to know about links, such
// as the daily warning that one is about to expire, reads them through this port and never names the
// host's grant model.
//
// Read-only: a link is created, changed and revoked by the host's own sharing routes.
// Optional: an unbound port is a no-op that lists nothing (`NOOP_MEMORIAHUB_SHARING` of
// `@marinoscar/memoriahub-api/core`), so a host without link sharing loses only what needs it.
// =============================================================================

/**
 * Injection token of {@link MemoriahubSharingPort}. The description string is permanent. Optional in
 * `MemoriahubPortsModule.forRoot`: the default lists no link.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_SHARING = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_SHARING');

/**
 * One public link that will stop working soon.
 *
 * @stability experimental
 */
export interface MemoriahubExpiringLink {
  /** The link's id (stable: an idempotency stamp is keyed on it). */
  id: string;
  /** What the link opens: `media_item` or `album`. Another kind is the host's own and is ignored. */
  resourceType: string;
  /** The id of the photo or album. */
  resourceId: string;
  /** The user who created the link, or `null` when that user is gone. */
  grantedById: string | null;
  /** When the link stops working. */
  expiresAt: Date;
}

/**
 * Which links {@link MemoriahubSharingPort.listExpiringLinks} returns.
 *
 * @stability experimental
 */
export interface MemoriahubExpiringLinkQuery {
  /** The look-ahead in milliseconds: links that expire within `(now, now + within]`. */
  within: number;
  /** The `nextCursor` of the previous page; absent for the first. */
  cursor?: string;
  /** The page size. */
  limit: number;
}

/**
 * A page of expiring links.
 *
 * @stability experimental
 */
export interface MemoriahubExpiringLinkPage {
  /** The links of this page, in the host's stable order. */
  items: readonly MemoriahubExpiringLink[];
  /** The cursor of the next page, or `null` when this is the last. */
  nextCursor: string | null;
}

/**
 * The link-sharing port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubSharingPort {
  /**
   * The public links that expire inside a look-ahead window, paged by a cursor. A link that never
   * expires, one that is revoked and one that already expired are not listed; the host's clock decides
   * "now".
   *
   * @param query - the look-ahead, the cursor and the page size.
   */
  listExpiringLinks(query: MemoriahubExpiringLinkQuery): Promise<MemoriahubExpiringLinkPage>;
}
