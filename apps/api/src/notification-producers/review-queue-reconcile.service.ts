// =============================================================================
// Review-Queue Notification Reconcile (epic #240, issue #246)
// =============================================================================
//
// Keeps exactly ONE live notification row per (user, circle, review-queue event)
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
// WRITE PATH — the platform's `NotificationsService.notifyState` only (RETRO-D3,
//   #576): a pending count refreshes the one live row in place (advisory lock
//   plus the partial unique index `notifications_live_dedup_uniq_idx`), and a
//   count of 0 dismisses it. Re-unread on growth past `countAtRead` is the
//   platform's rule. The writes are detached (they never reject and never block
//   the sweep), and the user's preferences gate them in the dispatcher.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { CircleRole } from '@prisma/client';
import { NotificationsService } from '@marinoscar/platform-api/notifications';

import { FEATURE_KEYS, isPictureEnhancementEnabled } from '../settings/feature-gates';
import { MediaService } from '../media/media.service';
import { MEMORIAHUB_EVENT_KEYS } from '../notifications-registry/memoriahub.notifications';
import { PrismaService } from '../prisma/prisma.service';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

/** Circles fetched per keyset page — the sweep never loads them all at once. */
const CIRCLE_PAGE_SIZE = 100;

/** Per-circle roles that can actually act on a review queue. See header. */
const ELIGIBLE_ROLES: CircleRole[] = [CircleRole.circle_admin, CircleRole.collaborator];

/** The four integers computeReviewCounts() returns. */
type ReviewCounts = Awaited<ReturnType<MediaService['computeReviewCounts']>>;

/** Resolved system settings, narrowed to what the flag gates read. */
type FeatureSettings = { features?: Record<string, boolean> };

/**
 * One review queue's mapping from a pending count to a STATE event. The title
 * ("3 burst groups ready to review in Family") and the circle-agnostic link
 * are the event's template (`notifications-registry/memoriahub.notifications.ts`).
 */
interface ReviewQueueDescriptor {
  eventKey: string;
  countKey: keyof ReviewCounts;
  isEnabled: (settings: FeatureSettings) => boolean;
}

const REVIEW_QUEUES: readonly ReviewQueueDescriptor[] = [
  {
    eventKey: MEMORIAHUB_EVENT_KEYS.reviewBursts,
    countKey: 'pendingBurstGroups',
    isEnabled: (s) => s.features?.[FEATURE_KEYS.BURST_DETECTION] === true,
  },
  {
    eventKey: MEMORIAHUB_EVENT_KEYS.reviewDuplicates,
    countKey: 'pendingDuplicateGroups',
    isEnabled: (s) => s.features?.[FEATURE_KEYS.DUPLICATE_DETECTION] === true,
  },
  {
    eventKey: MEMORIAHUB_EVENT_KEYS.reviewLocationSuggestions,
    countKey: 'pendingLocationSuggestions',
    isEnabled: (s) => s.features?.[FEATURE_KEYS.LOCATION_INFERENCE] === true,
  },
  {
    eventKey: MEMORIAHUB_EVENT_KEYS.reviewEnhancements,
    countKey: 'pendingEnhancements',
    // The one queue with a shared canonical gate (it folds in the
    // PICTURE_ENHANCEMENT_ENABLED env kill-switch), reused verbatim so this
    // sweep can never advertise a queue the enhance endpoints would reject.
    isEnabled: (s) => isPictureEnhancementEnabled(s),
  },
];

/** Outcome tally for one sweep — logged, and returned for the task's log line. */
export interface ReviewQueueReconcileResult {
  circles: number;
  /** STATE writes with a pending count (each a refresh in place or a new row). */
  upserted: number;
  /** Live rows drained to zero (dismissed): empty queue, disabled queue, or a member who can no longer act. */
  resolved: number;
  errors: number;
}

/** A live STATE row of a review queue, as the platform inbox holds it. */
interface LiveStateRow {
  userId: string;
  eventKey: string;
  scopeId: string | null;
}

@Injectable()
export class ReviewQueueReconcileService {
  private readonly logger = new Logger(ReviewQueueReconcileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly systemSettings: AppSystemSettingsService,
    private readonly mediaService: MediaService,
  ) {}

  /**
   * Reconcile every circle. Feature flags are read ONCE for the whole sweep
   * (not per circle) through the cached AppSystemSettingsService.getSettings(),
   * so a 500-circle deployment costs one settings read, not 500.
   *
   * A per-circle failure is logged and counted, never fatal — one circle with a
   * bad row must not stop the other 499 from being reconciled.
   */
  async reconcileAll(): Promise<ReviewQueueReconcileResult> {
    const result: ReviewQueueReconcileResult = { circles: 0, upserted: 0, resolved: 0, errors: 0 };

    const settings = (await this.systemSettings.getSettings()) as FeatureSettings;
    const enabled = REVIEW_QUEUES.filter((q) => q.isEnabled(settings));
    const disabled = REVIEW_QUEUES.filter((q) => !q.isEnabled(settings));

    // A disabled queue produces nothing — but any row produced BEFORE it was
    // disabled would otherwise stay live forever (the reconcile that drains it
    // to zero is exactly the thing that no longer runs for it), pointing at a
    // surface the admin has turned off. Bounded by the live rows themselves.
    if (disabled.length > 0) {
      const live = await this.liveRows({ eventKeys: disabled.map((q) => q.eventKey) });
      for (const row of live) this.drain(row);
      result.resolved += live.length;
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
   * Reconcile one circle across every enabled queue: one STATE write per
   * (eligible member x queue with a pending count), and a drain (count 0) for
   * every live row that should no longer be live.
   *
   * The platform's `notifyState` is the volume guard: ONE live row per
   * (user, event, circle), refreshed in place, a read row re-marked unread
   * only when the count grew past the `countAtRead` the user saw, never on an
   * equal or smaller count. A refresh with an unchanged count is quiet.
   */
  private async reconcileCircle(
    circle: { id: string; name: string },
    queues: readonly ReviewQueueDescriptor[],
  ): Promise<{ upserted: number; resolved: number }> {
    // Only ids are loaded, so a circle's whole eligible membership is a few KB
    // even in the pathological case — no paging needed at this level.
    const members = await this.prisma.circleMember.findMany({
      where: { circleId: circle.id, role: { in: ELIGIBLE_ROLES } },
      select: { userId: true },
    });
    const eligible = new Set(members.map((m) => m.userId));
    const live = await this.liveRows({ eventKeys: queues.map((q) => q.eventKey), scopeId: circle.id });
    if (eligible.size === 0 && live.length === 0) return { upserted: 0, resolved: 0 };

    // ONE call per circle, fanned out to every member below.
    const counts = await this.mediaService.computeReviewCounts(circle.id);

    let upserted = 0;
    let resolved = 0;
    for (const queue of queues) {
      const count = counts[queue.countKey];
      const liveForQueue = live.filter((row) => row.eventKey === queue.eventKey);

      // A member DEMOTED to viewer (or removed from the circle) cannot act on
      // the queue any more: their row is drained like an empty queue's.
      for (const row of liveForQueue) {
        if (count <= 0 || !eligible.has(row.userId)) {
          this.drain(row);
          resolved += 1;
        }
      }
      if (count <= 0) continue;

      for (const userId of eligible) {
        this.notifications.notifyState(
          queue.eventKey,
          userId,
          { count, circleId: circle.id, circleName: circle.name },
          { scopeId: circle.id },
        );
        upserted += 1;
      }
    }

    return { upserted, resolved };
  }

  /** The live (not dismissed) STATE rows of the given queues, optionally in one circle. */
  private async liveRows(where: { eventKeys: string[]; scopeId?: string }): Promise<LiveStateRow[]> {
    return this.prisma.notification.findMany({
      where: {
        eventKey: { in: where.eventKeys },
        dismissedAt: null,
        dedupKey: { startsWith: 'state:' },
        ...(where.scopeId ? { scopeId: where.scopeId } : {}),
      },
      select: { userId: true, eventKey: true, scopeId: true },
    });
  }

  /** A count of 0 dismisses the live row (dismissal implies read) and sends nothing. */
  private drain(row: LiveStateRow): void {
    this.notifications.notifyState(row.eventKey, row.userId, { count: 0 }, { scopeId: row.scopeId });
  }
}
