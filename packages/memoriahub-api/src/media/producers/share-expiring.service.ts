// =============================================================================
// Expiring-Share Notification Producer (epic #240, issue #247; RETRO-I4, #578; RETRO-J10 #624)
// =============================================================================
//
// Daily sweep producing `shares.expiring` notifications for public LINKS whose `expires_at` falls inside a
// 7-day lead window: long enough that the owner can extend or re-publish before a link a family member is
// using goes dark.
//
// The links come from the sharing port (`listExpiringLinks`; the host decides what a link is and what "now"
// is). Links that never expire, revoked links and links already expired are excluded by the port, never by
// post-filtering here.
//
// AUDIENCE: the link's creator. A link whose creator is gone is skipped (counted, not emitted).
//
// VOLUME GUARD: the `data.notifiedFor` stamp. The sweep runs every day and the lead window is seven days
// wide, so the same link is a candidate on seven consecutive days. Each emitted row carries
// `data.shareId = <link id>` and `data.notifiedFor = <expiresAt ISO>`, and the sweep skips any link that
// already has a row, LIVE **or DISMISSED**, carrying the same pair (the notify port's `hasNotified`).
// Checking dismissed rows too is the load-bearing half: an owner who dismisses today's warning must not be
// re-warned about the same expiry tomorrow. Keying on the expiry VALUE rather than a boolean "notified"
// flag is what makes a re-dated link work: if the owner pushes `expires_at` out, the stamp no longer
// matches and a fresh notification is allowed, which is right, because the new date is new information.
//
// A host whose notify port cannot answer `hasNotified` gets NO notification: without the probe the sweep
// would repeat itself every day, so it skips (counted) instead.
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  MEMORIAHUB_NOTIFY,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SHARING,
  type MemoriahubExpiringLink,
  type MemoriahubNotifyPort,
  type MemoriahubSharingPort,
} from '../../ports/index.js';
import type { MediaDb } from '../data/media-db.js';
import { SHARE_EXPIRING_EVENT_KEY } from './share-expiring.constants.js';

/** The two resource types a MemoriaHub link can open. */
const LINK_TYPES: readonly string[] = ['media_item', 'album'];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How far ahead of expiry the owner is warned, in days.
 *
 * @stability experimental
 */
export const SHARE_EXPIRY_LEAD_DAYS = 7;

/** Links fetched per keyset page: the sweep never loads them all at once. */
const SHARE_PAGE_SIZE = 200;

/**
 * Outcome tally for one sweep, returned for the job's log line.
 *
 * @stability experimental
 */
export interface ShareExpiringSweepResult {
  /** Links of a MemoriaHub kind the sweep looked at. */
  candidates: number;
  /** Warnings raised. */
  emitted: number;
  /** Links skipped: already warned, no creator, or the record is gone. */
  skipped: number;
  /** Links whose warning failed. */
  errors: number;
}

/**
 * The daily expiring-share sweep.
 *
 * @stability experimental
 */
@Injectable()
export class ShareExpiringService {
  private readonly logger = new Logger(ShareExpiringService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: MediaDb,
    @Inject(MEMORIAHUB_NOTIFY) private readonly notify: MemoriahubNotifyPort,
    @Inject(MEMORIAHUB_SHARING) private readonly sharing: MemoriahubSharingPort,
  ) {}

  /**
   * Sweeps every link expiring within the lead window. Keyset-paged, so the memory profile is one page
   * regardless of deployment size. A per-link failure is logged and counted, never fatal to the rest.
   */
  async sweep(): Promise<ShareExpiringSweepResult> {
    const result: ShareExpiringSweepResult = { candidates: 0, emitted: 0, skipped: 0, errors: 0 };

    const within = SHARE_EXPIRY_LEAD_DAYS * MS_PER_DAY;
    let cursor: string | undefined;

    for (;;) {
      // The window is `(now, now + within]`: links that have ALREADY expired are excluded; warning about a
      // link that is already dark is noise.
      const page = await this.sharing.listExpiringLinks({ within, cursor, limit: SHARE_PAGE_SIZE });
      if (page.items.length === 0) break;

      for (const link of page.items.filter((l) => LINK_TYPES.includes(l.resourceType))) {
        result.candidates += 1;
        try {
          if (await this.notifyForLink(link)) result.emitted += 1;
          else result.skipped += 1;
        } catch (err) {
          result.errors += 1;
          this.logger.warn(
            `share_expiring notification failed for link ${link.id}: ` + (err instanceof Error ? err.message : String(err)),
          );
        }
      }

      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    return result;
  }

  /** @returns true when a row was emitted, false when the stamp already existed or nobody owns the link. */
  private async notifyForLink(link: MemoriahubExpiringLink): Promise<boolean> {
    if (!link.grantedById || !this.notify.hasNotified) return false;

    const userId = link.grantedById;
    const notifiedFor = link.expiresAt.toISOString();

    // Deliberately matches LIVE and DISMISSED rows: a dismissed warning still counts as "already told".
    if (await this.notify.hasNotified(SHARE_EXPIRING_EVENT_KEY, userId, { shareId: link.id, notifiedFor })) return false;

    const target = await this.describeTarget(link);
    if (!target) return false; // the record is gone (hard-deleted): nothing to warn about

    // The title is rendered by the event's template at dispatch time ("expires tomorrow"); `notifiedFor` is
    // the idempotency stamp above.
    this.notify.notify(SHARE_EXPIRING_EVENT_KEY, userId, {
      shareId: link.id,
      notifiedFor,
      targetType: link.resourceType,
      targetName: target.name,
      circleId: target.circleId,
    });

    return true;
  }

  /** The shared record's display name and library, or `null` when it no longer exists. */
  private async describeTarget(link: MemoriahubExpiringLink): Promise<{ name: string; circleId: string } | null> {
    if (link.resourceType === 'album') {
      const album = await this.prisma.album.findUnique({ where: { id: link.resourceId }, select: { name: true, circleId: true } });
      return album ? { name: album.name, circleId: album.circleId } : null;
    }
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: link.resourceId },
      select: { originalFilename: true, circleId: true },
    });
    return item ? { name: item.originalFilename ?? 'a photo', circleId: item.circleId } : null;
  }
}
