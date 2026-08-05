// =============================================================================
// Expiring-Share Notification Producer (epic #240, issue #247)
// =============================================================================
//
// Daily sweep producing `share_expiring` rows for public shares whose
// `expires_at` falls inside a 7-day lead window — long enough that the owner
// can extend or re-publish before a link a family member is using goes dark.
//
// A sweep, not an event: a share's expiry is a passage of time, not an action,
// so there is nothing to hook. Shares that never expire (`expires_at IS NULL`)
// and revoked shares are excluded by the query, never by post-filtering.
//
// AUDIENCE — the share's creator (`created_by`). `MediaShare.createdBy` is a
// REQUIRED FK with `onDelete: Cascade`, so a deleted user's shares are deleted
// with them and a creator always exists; selecting the relation makes that an
// INNER JOIN, so the "creator still exists" restriction is structural rather
// than a hopeful post-check.
//
// VOLUME GUARD — the `data.notifiedFor` stamp.
//   The sweep runs every day and the lead window is seven days wide, so the
//   same share is a candidate on seven consecutive days. Each emitted row
//   carries `data.notifiedFor = <expiresAt ISO>`, and the sweep skips any share
//   that already has a row — LIVE **or DISMISSED** — carrying the same
//   `(shareId, notifiedFor)` pair. Checking dismissed rows too is the load
//   bearing half: an owner who dismisses today's warning must not be re-warned
//   about the same expiry tomorrow.
//
//   Keying on the expiry VALUE rather than a boolean "notified" flag is what
//   makes a rescheduled share work correctly: if the owner pushes `expires_at`
//   out, the stamp no longer matches and a fresh notification is allowed —
//   which is right, because the new date is genuinely new information.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, Prisma, ShareTargetType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications.service';

/** How far ahead of expiry the owner is warned. */
export const SHARE_EXPIRY_LEAD_DAYS = 7;

/** Shares fetched per keyset page — the sweep never loads them all at once. */
const SHARE_PAGE_SIZE = 200;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
  ) {}

  /**
   * Sweep every share expiring within the lead window.
   *
   * Keyset-paged by `id` (mirrors #246's circle paging), so the memory profile
   * is one page regardless of deployment size. A per-share failure is logged
   * and counted, never fatal to the rest of the sweep.
   */
  async sweep(now: Date = new Date()): Promise<ShareExpiringSweepResult> {
    const result: ShareExpiringSweepResult = {
      candidates: 0,
      emitted: 0,
      skipped: 0,
      errors: 0,
    };

    const horizon = new Date(now.getTime() + SHARE_EXPIRY_LEAD_DAYS * MS_PER_DAY);
    let cursor: string | undefined;

    for (;;) {
      const shares = await this.prisma.mediaShare.findMany({
        where: {
          revokedAt: null,
          // `gt: now` excludes shares that have ALREADY expired — warning about
          // a link that is already dark is noise, not an action item.
          expiresAt: { gt: now, lte: horizon },
        },
        orderBy: { id: 'asc' },
        take: SHARE_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          circleId: true,
          targetType: true,
          expiresAt: true,
          // INNER JOIN — see the audience note in the header.
          createdBy: { select: { id: true } },
          mediaItem: { select: { originalFilename: true } },
          album: { select: { name: true } },
        },
      });
      if (shares.length === 0) break;

      for (const share of shares) {
        result.candidates += 1;
        try {
          const emitted = await this.notifyForShare(share, now);
          if (emitted) result.emitted += 1;
          else result.skipped += 1;
        } catch (err) {
          result.errors += 1;
          this.logger.warn(
            `share_expiring notification failed for share ${share.id}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }

      if (shares.length < SHARE_PAGE_SIZE) break;
      cursor = shares[shares.length - 1]!.id;
    }

    return result;
  }

  /** @returns true when a row was emitted, false when the stamp already existed. */
  private async notifyForShare(
    share: {
      id: string;
      circleId: string;
      targetType: ShareTargetType;
      expiresAt: Date | null;
      createdBy: { id: string } | null;
      mediaItem: { originalFilename: string | null } | null;
      album: { name: string } | null;
    },
    now: Date,
  ): Promise<boolean> {
    if (!share.expiresAt || !share.createdBy) return false;

    const userId = share.createdBy.id;
    const notifiedFor = share.expiresAt.toISOString();

    if (await this.alreadyNotified(userId, share.id, notifiedFor)) return false;

    const targetName = this.resolveTargetName(share);

    await this.notifications.emit({
      userId,
      circleId: share.circleId,
      type: NotificationType.share_expiring,
      title: `A public share of '${targetName}' expires ${relativeDate(share.expiresAt, now)}`,
      link: '/admin/settings/sharing',
      data: {
        shareId: share.id,
        notifiedFor,
        targetType: share.targetType,
      },
    });

    return true;
  }

  /**
   * Idempotency probe. Deliberately does NOT filter on `dismissed_at`: a
   * dismissed warning still counts as "already told them about this expiry".
   *
   * `data @> …::jsonb` (containment) rather than two `->>` comparisons so the
   * predicate is a single expression over the whole payload; there is no index
   * on `data`, but the row set scanned is bounded by `user_id` + `type`, both
   * of which the (user_id, …) indexes cover.
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
        AND type::text = ${String(NotificationType.share_expiring)}
        AND data @> ${JSON.stringify({ shareId, notifiedFor })}::jsonb
      LIMIT 1
    `);
    return rows.length > 0;
  }

  private resolveTargetName(share: {
    targetType: ShareTargetType;
    mediaItem: { originalFilename: string | null } | null;
    album: { name: string } | null;
  }): string {
    if (share.targetType === ShareTargetType.album) {
      return share.album?.name ?? 'an album';
    }
    return share.mediaItem?.originalFilename ?? 'a photo';
  }
}

/**
 * "today" / "tomorrow" / "in N days".
 *
 * Bucketed on elapsed hours rather than calendar days: an expiry 3 hours from
 * now is "today", not the "tomorrow" a naive `Math.ceil(ms / day)` would give.
 */
function relativeDate(expiresAt: Date, now: Date): string {
  const ms = expiresAt.getTime() - now.getTime();
  if (ms < MS_PER_DAY) return 'today';
  const days = Math.floor(ms / MS_PER_DAY);
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}
