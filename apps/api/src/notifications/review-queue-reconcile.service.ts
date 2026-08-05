// =============================================================================
// Review-Queue Notification Reconcile (epic #240, issue #246)
// =============================================================================
//
// Keeps exactly ONE live notification row per (user, circle, review-queue type)
// in sync with the real pending count — replacing the derived Home banners that
// only existed while the user happened to be looking at the dashboard.
//
// This is a RECONCILE, not an event producer: it does not react to a group
// being created or resolved, it periodically re-states the truth. That is what
// makes the dedup guarantee cheap — a circle with 929 pending duplicate groups
// is ONE row whose `data.count` is 929, never 929 rows — and what makes the
// sweep self-healing: a missed write, a crash mid-run, or a row a user resolved
// by hand all converge on the next tick.
//
// AUDIENCE — collaborators and circle admins only:
//   Resolving or dismissing a review group needs media:write plus the
//   per-circle `collaborator` role, so a `viewer` member cannot act on any of
//   these notifications. Notifying them would be pure noise, so the member
//   query filters role IN ('collaborator', 'circle_admin').
//
// SOURCE OF TRUTH — MediaService.computeReviewCounts:
//   The same method behind GET /api/media/dashboard and
//   GET /api/media/review-counts, called ONCE PER CIRCLE and fanned out to
//   every eligible member. There is deliberately no second counting path here
//   that could drift from what the user sees on those surfaces.
//
// WRITE PATH — NotificationsService only:
//   Inserts/refreshes go through upsertState() (never a direct create, so a
//   concurrent run folds into the existing row instead of racing the partial
//   unique index into a P2002), resolves through resolveStatesByIds(), and
//   re-unreads through markStatesUnreadByIds().
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { CircleRole, NotificationType, Prisma } from '@prisma/client';

import { FEATURE_KEYS, isPictureEnhancementEnabled } from '../common/types/settings.types';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { NotificationsService } from './notifications.service';

/** Circles fetched per keyset page — the sweep never loads them all at once. */
const CIRCLE_PAGE_SIZE = 100;

/** Per-circle roles that can actually act on a review queue. See header. */
const ELIGIBLE_ROLES: CircleRole[] = [CircleRole.circle_admin, CircleRole.collaborator];

/** The four integers computeReviewCounts() returns. */
type ReviewCounts = Awaited<ReturnType<MediaService['computeReviewCounts']>>;

/** Resolved system settings, narrowed to what the flag gates read. */
type FeatureSettings = { features?: Record<string, boolean> };

/**
 * One review queue's mapping from a pending count to a notification row.
 *
 * `link` is circle-AGNOSTIC by design: the client switches the active circle
 * from the row's `circleId` before navigating (#249/#250), so these stay the
 * same plain routes the sidebar uses.
 */
interface ReviewQueueDescriptor {
  type: NotificationType;
  countKey: keyof ReviewCounts;
  link: string;
  /** [singular, plural] noun — "1 burst group" vs "2 burst groups". */
  noun: readonly [string, string];
  /** Trailing phrase before " in {circle}". */
  verb: string;
  isEnabled: (settings: FeatureSettings) => boolean;
}

const REVIEW_QUEUES: readonly ReviewQueueDescriptor[] = [
  {
    type: NotificationType.review_queue_bursts,
    countKey: 'pendingBurstGroups',
    link: '/bursts',
    noun: ['burst group', 'burst groups'],
    verb: 'ready to review',
    isEnabled: (s) => s.features?.[FEATURE_KEYS.BURST_DETECTION] === true,
  },
  {
    type: NotificationType.review_queue_duplicates,
    countKey: 'pendingDuplicateGroups',
    link: '/duplicates',
    noun: ['duplicate group', 'duplicate groups'],
    verb: 'ready to review',
    isEnabled: (s) => s.features?.[FEATURE_KEYS.DUPLICATE_DETECTION] === true,
  },
  {
    type: NotificationType.review_queue_location_suggestions,
    countKey: 'pendingLocationSuggestions',
    link: '/location-suggestions',
    noun: ['location suggestion', 'location suggestions'],
    verb: 'ready to review',
    isEnabled: (s) => s.features?.[FEATURE_KEYS.LOCATION_INFERENCE] === true,
  },
  {
    type: NotificationType.review_queue_enhancements,
    countKey: 'pendingEnhancements',
    link: '/enhancements',
    noun: ['AI enhancement', 'AI enhancements'],
    verb: 'awaiting review',
    // The one queue with a shared canonical gate (it folds in the
    // PICTURE_ENHANCEMENT_ENABLED env kill-switch), reused verbatim so this
    // sweep can never advertise a queue the enhance endpoints would reject.
    isEnabled: (s) => isPictureEnhancementEnabled(s),
  },
];

/** Outcome tally for one sweep — logged, and returned for the task's log line. */
export interface ReviewQueueReconcileResult {
  circles: number;
  upserted: number;
  resolved: number;
  reunread: number;
  errors: number;
}

/** Live row fields the reconcile needs to make its decisions. */
interface LiveStateRow {
  id: string;
  userId: string;
  type: NotificationType;
  readAt: Date | null;
  data: Prisma.JsonValue | null;
}

@Injectable()
export class ReviewQueueReconcileService {
  private readonly logger = new Logger(ReviewQueueReconcileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly systemSettings: SystemSettingsService,
    private readonly mediaService: MediaService,
  ) {}

  /**
   * Reconcile every circle. Feature flags are read ONCE for the whole sweep
   * (not per circle) through the cached SystemSettingsService.getSettings(),
   * so a 500-circle deployment costs one settings read, not 500.
   *
   * A per-circle failure is logged and counted, never fatal — one circle with a
   * bad row must not stop the other 499 from being reconciled.
   */
  async reconcileAll(): Promise<ReviewQueueReconcileResult> {
    const result: ReviewQueueReconcileResult = {
      circles: 0,
      upserted: 0,
      resolved: 0,
      reunread: 0,
      errors: 0,
    };

    const settings = (await this.systemSettings.getSettings()) as FeatureSettings;
    const enabled = REVIEW_QUEUES.filter((q) => q.isEnabled(settings));
    const disabled = REVIEW_QUEUES.filter((q) => !q.isEnabled(settings));

    // A disabled queue produces nothing — but any row produced BEFORE it was
    // disabled would otherwise stay live forever (the reconcile that drains it
    // to zero is exactly the thing that no longer runs for it), pointing at a
    // surface the admin has turned off. One bounded statement per sweep.
    if (disabled.length > 0) {
      result.resolved += await this.notifications.resolveStatesByType(
        disabled.map((q) => q.type),
      );
    }

    // Every queue off: nothing to count, so skip circle paging entirely.
    if (enabled.length === 0) return result;

    let cursor: string | undefined;
    for (;;) {
      const circles = await this.prisma.circle.findMany({
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
        take: CIRCLE_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (circles.length === 0) break;

      for (const circle of circles) {
        result.circles += 1;
        try {
          const circleResult = await this.reconcileCircle(circle, enabled);
          result.upserted += circleResult.upserted;
          result.resolved += circleResult.resolved;
          result.reunread += circleResult.reunread;
        } catch (err) {
          result.errors += 1;
          this.logger.warn(
            `Review-queue reconcile failed for circle ${circle.id}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }

      if (circles.length < CIRCLE_PAGE_SIZE) break;
      cursor = circles[circles.length - 1]!.id;
    }

    return result;
  }

  /**
   * Reconcile one circle across every enabled queue.
   *
   * Three queries up front (members, counts, live rows), then at most
   * members × enabled-queues upserts plus two batched writes.
   */
  private async reconcileCircle(
    circle: { id: string; name: string },
    queues: readonly ReviewQueueDescriptor[],
  ): Promise<{ upserted: number; resolved: number; reunread: number }> {
    // Only ids are loaded, so a circle's whole eligible membership is a few KB
    // even in the pathological case — no paging needed at this level.
    const members = await this.prisma.circleMember.findMany({
      where: { circleId: circle.id, role: { in: ELIGIBLE_ROLES } },
      select: { userId: true },
    });
    if (members.length === 0) {
      return { upserted: 0, resolved: 0, reunread: 0 };
    }
    const userIds = members.map((m) => m.userId);

    // ONE call per circle, fanned out to every member below.
    const counts = await this.mediaService.computeReviewCounts(circle.id);

    const types = queues.map((q) => q.type);

    // Scoped by userId so the (user_id, dismissed_at) index serves this; the
    // notifications table has no circle_id index of its own. Consequence,
    // deliberately accepted: a member DEMOTED to viewer (or removed from the
    // circle) is outside this set, so their now-unactionable row is not
    // resolved here — they can dismiss it, and #248's retention sweep reaps it.
    const liveRows = (await this.prisma.notification.findMany({
      where: {
        userId: { in: userIds },
        circleId: circle.id,
        dismissedAt: null,
        type: { in: types },
      },
      select: { id: true, userId: true, type: true, readAt: true, data: true },
    })) as LiveStateRow[];

    const liveByKey = new Map<string, LiveStateRow>();
    for (const row of liveRows) liveByKey.set(`${row.userId}:${row.type}`, row);

    const toResolve: Array<{ id: string; userId: string }> = [];
    const toReunread: Array<{ id: string; userId: string }> = [];
    let upserted = 0;

    for (const queue of queues) {
      const count = counts[queue.countKey];

      // Drained queue: resolve every live row of this type so it stops nagging.
      // Iterates liveRows (not the map) so a duplicate row from some earlier
      // state is resolved too, not just the last one seen for its key.
      if (count <= 0) {
        for (const row of liveRows) {
          if (row.type === queue.type) toResolve.push({ id: row.id, userId: row.userId });
        }
        continue;
      }

      const title = this.buildTitle(queue, count, circle.name);

      for (const userId of userIds) {
        const existing = liveByKey.get(`${userId}:${queue.type}`);
        const countAtRead = this.readCountAtRead(existing?.data);

        // countAtRead is CARRIED FORWARD, never synthesized: upsertState
        // replaces `data` wholesale, and dropping the snapshot would silently
        // disable the re-unread rule for that row until its next read.
        await this.notifications.upsertState({
          userId,
          circleId: circle.id,
          type: queue.type,
          title,
          link: queue.link,
          data: countAtRead === null ? { count } : { count, countAtRead },
        });
        upserted += 1;

        // RE-UNREAD RULE. A count change never touches read_at, with exactly
        // one exception: a READ row whose queue has GROWN past the count the
        // user acknowledged. Never on a decrease, never on an equal count, and
        // never on a row that has no countAtRead snapshot — an absent key is
        // treated conservatively as "already seen", because re-unreading on it
        // would re-nag every legacy/hand-written row on every single tick.
        if (existing && existing.readAt !== null && countAtRead !== null && count > countAtRead) {
          toReunread.push({ id: existing.id, userId });
        }
      }
    }

    const resolved = await this.notifications.resolveStatesByIds(toResolve);
    const reunread = await this.notifications.markStatesUnreadByIds(toReunread);

    return { upserted, resolved, reunread };
  }

  /** "3 burst groups ready to review in Family" / "1 burst group ready …". */
  private buildTitle(
    queue: ReviewQueueDescriptor,
    count: number,
    circleName: string,
  ): string {
    const noun = count === 1 ? queue.noun[0] : queue.noun[1];
    return `${count} ${noun} ${queue.verb} in ${circleName}`;
  }

  /**
   * Read `data.countAtRead` — the snapshot NotificationsService writes when a
   * row is marked read. Anything that is not a finite number (absent, null,
   * a string, a non-object `data`) reads as null, i.e. "no snapshot".
   */
  private readCountAtRead(data: Prisma.JsonValue | null | undefined): number | null {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const raw = (data as Prisma.JsonObject)['countAtRead'];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  }
}
