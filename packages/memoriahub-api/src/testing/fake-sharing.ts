import type {
  MemoriahubExpiringLink,
  MemoriahubExpiringLinkPage,
  MemoriahubExpiringLinkQuery,
  MemoriahubSharingPort,
} from '../ports/index.js';

/**
 * A fake `MEMORIAHUB_SHARING`: the links a test sets in `links`, filtered by the look-ahead the way the host
 * does (expires inside `(now, now + within]`) and paged by the link id.
 *
 * @stability experimental
 */
export class FakeMemoriahubSharing implements MemoriahubSharingPort {
  /** The public links the fake knows about. */
  links: MemoriahubExpiringLink[] = [];

  /** The clock the look-ahead is measured from; the system clock when absent. */
  now: (() => Date) | undefined;

  /** Lists the links that expire inside the window, one page at a time. */
  async listExpiringLinks(query: MemoriahubExpiringLinkQuery): Promise<MemoriahubExpiringLinkPage> {
    const now = (this.now?.() ?? new Date()).getTime();
    const due = this.links
      .filter((l) => l.expiresAt.getTime() > now && l.expiresAt.getTime() <= now + query.within)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .filter((l) => query.cursor === undefined || l.id > query.cursor);
    const items = due.slice(0, query.limit);
    return { items, nextCursor: due.length > query.limit ? items[items.length - 1]!.id : null };
  }
}
