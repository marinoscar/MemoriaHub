// =============================================================================
// Expiring-Share Notification Producer (epic #240, issue #247; RETRO-I4, #578)
// =============================================================================
//
// Daily sweep producing `share_expiring` (`shares.expiring`) notifications for
// public LINKS whose `expires_at` falls inside a 7-day lead window — long enough
// that the owner can extend or re-publish before a link a family member is using
// goes dark.
//
// Since RETRO-I4 a public share is a platform link grant (`grants`,
// `grantee_kind = 'link'`, resource type `media_item` or `album`), read through
// `LinkGrantsService.listExpiring` (the sharing slice's expiring-link sweep
// seam, #1136; the platform clock decides "now"). Links that never expire (`expires_at IS NULL`), revoked links and
// links already expired are excluded by the query, never by post-filtering.
//
// AUDIENCE — the link's creator (`granted_by_id`). The column is SetNull on a
// user deletion, so a link whose creator is gone is skipped (counted, not
// emitted).
//
// VOLUME GUARD — the `data.notifiedFor` stamp.
//   The sweep runs every day and the lead window is seven days wide, so the
//   same link is a candidate on seven consecutive days. Each emitted row
//   carries `data.shareId = <grant id>` and `data.notifiedFor = <expiresAt ISO>`,
//   and the sweep skips any link that already has a row — LIVE **or DISMISSED**
//   — carrying the same `(shareId, notifiedFor)` pair. Checking dismissed rows
//   too is the load bearing half: an owner who dismisses today's warning must
//   not be re-warned about the same expiry tomorrow. The import of the old
//   `media_shares` rows re-keys existing stamps from the share id to the new
//   grant id, so a warning sent before the cutover is not sent again.
//
//   Keying on the expiry VALUE rather than a boolean "notified" flag is what
//   makes a re-dated link work correctly: if the owner pushes `expires_at`
//   out, the stamp no longer matches and a fresh notification is allowed —
//   which is right, because the new date is genuinely new information.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import { LinkGrantsService } from '@marinoscar/platform-api/sharing';

import { MEMORIAHUB_EVENT_KEYS } from '../notifications-registry/memoriahub.notifications';
import { DefaultOrgId } from '../common/tenancy/default-org-id';
import { PrismaService } from '../prisma/prisma.service';

/** One link expiring soon: what the sweep needs. */
export interface ExpiringLink {
  id: string;
  resourceType: string;
  resourceId: string;
  grantedById: string | null;
  expiresAt: Date;
}

/** The two resource types a MemoriaHub link can open. */
const LINK_TYPES: readonly string[] = ['media_item', 'album'];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How far ahead of expiry the owner is warned. */
export const SHARE_EXPIRY_LEAD_DAYS = 7;

/** Links fetched per keyset page — the sweep never loads them all at once. */
const SHARE_PAGE_SIZE = 200;

/** Outcome tally for one sweep — returned for the task's log line. */
export interface ShareExpiringSweepResult {
  candidates: number;
  emitted: number;
  skipped: number;
  errors: number;
}

@Injectable()
export class ShareExpiringService {
  private readonly logger = new Logger(ShareExpiringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly links: LinkGrantsService,
    private readonly defaultOrg: DefaultOrgId,
  ) {}

  /**
   * Sweep every share expiring within the lead window.
   *
   * Keyset-paged by `id` (mirrors #246's circle paging), so the memory profile
   * is one page regardless of deployment size. A per-share failure is logged
   * and counted, never fatal to the rest of the sweep.
   */
  async sweep(): Promise<ShareExpiringSweepResult> {
    const result: ShareExpiringSweepResult = {
      candidates: 0,
      emitted: 0,
      skipped: 0,
      errors: 0,
    };

    // PLATFORM-ADOPTION-SHIM(RETRO-MULTI-ORG): the single (default) organization.
    const orgId = await this.defaultOrg.get();
    const within = SHARE_EXPIRY_LEAD_DAYS * MS_PER_DAY;
    let cursor: string | undefined;

    for (;;) {
      // The window is `(now, now + within]`: links that have ALREADY expired
      // are excluded — warning about a link that is already dark is noise.
      const page = await this.links.listExpiring({ orgId, within, cursor, limit: SHARE_PAGE_SIZE });
      const links: ExpiringLink[] = page.items
        .filter((g) => LINK_TYPES.includes(g.resourceType))
        .map((g) => ({
          id: g.grantId,
          resourceType: g.resourceType,
          resourceId: g.resourceId,
          grantedById: g.grantedById,
          expiresAt: g.expiresAt,
        }));
      if (page.items.length === 0) break;

      for (const link of links) {
        result.candidates += 1;
        try {
          const emitted = await this.notifyForLink(link);
          if (emitted) result.emitted += 1;
          else result.skipped += 1;
        } catch (err) {
          result.errors += 1;
          this.logger.warn(
            `share_expiring notification failed for link ${link.id}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }

      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    return result;
  }

  /** @returns true when a row was emitted, false when the stamp already existed or nobody owns the link. */
  private async notifyForLink(link: ExpiringLink): Promise<boolean> {
    if (!link.grantedById) return false;

    const userId = link.grantedById;
    const notifiedFor = link.expiresAt.toISOString();

    if (await this.alreadyNotified(userId, link.id, notifiedFor)) return false;

    const target = await this.describeTarget(link);
    if (!target) return false; // the record is gone (hard-deleted): nothing to warn about

    // The title is rendered by the event's template at dispatch time
    // ("expires tomorrow"); `notifiedFor` is the idempotency stamp below.
    await this.notifications.notify(MEMORIAHUB_EVENT_KEYS.shareExpiring, userId, {
      shareId: link.id,
      notifiedFor,
      targetType: link.resourceType,
      targetName: target.name,
      circleId: target.circleId,
    });

    return true;
  }

  /**
   * Idempotency probe. Deliberately does NOT filter on `dismissed_at`: a
   * dismissed warning still counts as "already told them about this expiry".
   *
   * `data @> …::jsonb` (containment) rather than two `->>` comparisons so the
   * predicate is a single expression over the whole payload; there is no index
   * on `data`, but the row set scanned is bounded by `user_id` (indexed) and
   * `event_key`. The platform inbox (RETRO-D3) carries the `data` the stamp
   * lives in; the carry-over copied the pre-platform rows with their `data`.
   */
  private async alreadyNotified(
    userId: string,
    shareId: string,
    notifiedFor: string,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ exists: number }>>(Prisma.sql`
      SELECT 1 AS exists
      FROM notifications
      WHERE user_id = ${userId}::uuid
        AND event_key = ${MEMORIAHUB_EVENT_KEYS.shareExpiring}
        AND data @> ${JSON.stringify({ shareId, notifiedFor })}::jsonb
      LIMIT 1
    `);
    return rows.length > 0;
  }

  /** The shared record's display name and circle, or `null` when it no longer exists. */
  private async describeTarget(link: ExpiringLink): Promise<{ name: string; circleId: string } | null> {
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
