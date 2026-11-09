// =============================================================================
// Upload Notification Producer (epic #240, issue #247)
// =============================================================================
//
// Raises `media.upload_completed` (platform notifications, RETRO-D3 #576) when
// MediaService.createMedia registers a
// NON-DEDUPLICATED item. A dedup hit is not an upload — nothing new landed in
// the circle — so it deliberately produces nothing.
//
// VOLUME GUARD — a 15-minute ROLLING WINDOW, server-side.
//   A 4 000-file import must be ONE row that grows to `count: 4000`, not 4 000
//   rows. That is achieved with no batch id, no client cooperation and no
//   client change: each registration folds into the live
//   (user, circle, upload_completed) row whose `updated_at` is inside the
//   window, or starts a new one if there is none. Because the window is
//   anchored on `updated_at` (not `created_at`), a steady import keeps
//   extending the SAME row instead of rolling a fresh one every 15 minutes;
//   an import next week is correctly its own row.
//
//   The fold is the platform's COUNTED write (`notifyCounted`, scope = the
//   circle, `windowMs` below): it serializes on a transaction-scoped advisory
//   lock keyed on (user, dedup key), and the partial unique index
//   `notifications_live_dedup_uniq_idx` is the backstop, so two concurrent
//   uploads into the same circle cannot both insert. The title is rendered by
//   the event's template from `data` (`count`, `circleName`, `uploaderName`).
//
// AUDIENCE — the uploader plus EVERY other circle member, regardless of role.
//   This deliberately differs from #246's review-queue audience, which is
//   collaborator/circle_admin only: resolving a review group needs write
//   access, but BROWSING new photos does not, so a `viewer` genuinely can act
//   on "someone added photos".
//
// FIRE-AND-FORGET — recordUploadAsync() returns void and never rejects, exactly
// like EmailService.sendEmailAsync. It is called with the upload's critical
// path already complete, and is never awaited by createMedia: a notification is
// never important enough to add latency to (let alone fail) an upload.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '@marinoscar/platform-api/notifications';

import {
  MEMORIAHUB_EVENT_KEYS,
  UPLOAD_COMPLETED_WINDOW_MS,
} from '../notifications-registry/memoriahub.notifications';
import { PrismaService } from '../prisma/prisma.service';

/** Rolling aggregation window for `media.upload_completed`. See header. */
export const UPLOAD_WINDOW_MS = UPLOAD_COMPLETED_WINDOW_MS;

/**
 * TTL for the per-circle (name + member ids) and per-user (display name)
 * lookups. A bulk import calls this producer once per file; without a cache
 * that is two extra reads per photo for values that essentially never change
 * mid-import. 30 s is long enough to collapse a burst and short enough that a
 * newly-added member starts receiving rows almost immediately.
 */
const LOOKUP_CACHE_TTL_MS = 30_000;

/** Soft bound on each cache; exceeded ⇒ cleared wholesale (never unbounded). */
const LOOKUP_CACHE_MAX_ENTRIES = 1000;

interface CircleLookup {
  name: string;
  memberIds: string[];
}

interface CacheEntry<T> {
  value: T;
  cachedAt: number;
}

@Injectable()
export class UploadNotificationService {
  private readonly logger = new Logger(UploadNotificationService.name);

  private readonly circleCache = new Map<string, CacheEntry<CircleLookup | null>>();
  private readonly userNameCache = new Map<string, CacheEntry<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Fire-and-forget entry point for the request path. Swallows everything —
   * mirrors EmailService.sendEmailAsync.
   */
  recordUploadAsync(input: { circleId: string; uploaderId: string }): void {
    void this.recordUpload(input).catch((err) => {
      this.logger.warn(
        `upload_completed notification for circle ${input.circleId} failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    });
  }

  /**
   * One upload → one increment for the uploader and one for every OTHER member.
   *
   * Recipients are processed sequentially rather than with Promise.all: each is
   * a short transaction taking an advisory lock, and a bulk import already
   * drives plenty of concurrency at the request level. Fanning out in parallel
   * here would only add lock contention on the very keys that must serialize.
   */
  async recordUpload(input: { circleId: string; uploaderId: string }): Promise<void> {
    const circle = await this.loadCircle(input.circleId);
    if (!circle) return; // circle deleted between the upload and this call

    // ---- Uploader's own row -------------------------------------------------
    await this.notifications.notifyCounted(
      MEMORIAHUB_EVENT_KEYS.uploadCompleted,
      input.uploaderId,
      { circleId: input.circleId, circleName: circle.name },
      { scopeId: input.circleId, windowMs: UPLOAD_WINDOW_MS },
    );

    // ---- Every other member -------------------------------------------------
    const others = circle.memberIds.filter((id) => id !== input.uploaderId);
    if (others.length === 0) return;

    const uploaderName = await this.loadUserDisplayName(input.uploaderId);

    for (const userId of others) {
      await this.notifications.notifyCounted(
        MEMORIAHUB_EVENT_KEYS.uploadCompleted,
        userId,
        { circleId: input.circleId, circleName: circle.name, uploaderId: input.uploaderId, uploaderName },
        { scopeId: input.circleId, windowMs: UPLOAD_WINDOW_MS },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Cached lookups
  // ---------------------------------------------------------------------------

  private async loadCircle(circleId: string): Promise<CircleLookup | null> {
    const cached = readCache(this.circleCache, circleId);
    if (cached !== undefined) return cached;

    const circle = await this.prisma.circle.findUnique({
      where: { id: circleId },
      select: {
        name: true,
        // Every member, every role — see the audience note in the header.
        members: { select: { userId: true } },
      },
    });

    const value: CircleLookup | null = circle
      ? { name: circle.name, memberIds: circle.members.map((m) => m.userId) }
      : null;

    writeCache(this.circleCache, circleId, value);
    return value;
  }

  private async loadUserDisplayName(userId: string): Promise<string> {
    const cached = readCache(this.userNameCache, userId);
    if (cached !== undefined) return cached;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true, providerDisplayName: true, email: true },
    });

    // Same fallback ladder as the former circle-invitation email sender.
    const name =
      user?.displayName ?? user?.providerDisplayName ?? user?.email ?? 'Someone';

    writeCache(this.userNameCache, userId, name);
    return name;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------


/** `undefined` = miss (an entry may legitimately cache `null`). */
function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.cachedAt >= LOOKUP_CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
  if (cache.size >= LOOKUP_CACHE_MAX_ENTRIES) cache.clear();
  cache.set(key, { value, cachedAt: Date.now() });
}
