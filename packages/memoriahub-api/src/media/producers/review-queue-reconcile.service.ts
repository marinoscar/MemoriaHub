// =============================================================================
// Review-Queue Notification Reconcile (epic #240, issue #246; RETRO-D3 #576; RETRO-J10 #624)
// =============================================================================
//
// Keeps exactly ONE live notification row per (user, library, review-queue event) in sync with the real
// pending count, replacing the derived Home banners that only existed while the user happened to be
// looking at the dashboard.
//
// This is a RECONCILE, not an event producer: it does not react to a group being created or resolved, it
// periodically re-states the truth. That is what makes the dedup guarantee cheap (a library with 929
// pending duplicate groups is ONE row whose `data.count` is 929, never 929 rows) and what makes the sweep
// self-healing: a missed write, a crash mid-run, or a row a user resolved by hand all converge on the next
// tick.
//
// AUDIENCE: collaborators and library admins only. Resolving or dismissing a review group needs
// `media:write` plus the per-library `collaborator` role, so a `viewer` cannot act on any of these
// notifications; notifying them would be pure noise.
//
// SOURCE OF TRUTH: `MediaService.computeReviewCounts`, the method behind `GET /api/media/dashboard` and
// `GET /api/media/review-counts`, called ONCE PER LIBRARY and fanned out to every eligible member. There is
// deliberately no second counting path here that could drift from what the user sees on those surfaces.
//
// WRITE PATH: the notify port's `notifyState` only. A pending count refreshes the one live row in place
// and a count of 0 dismisses it; re-unread on growth past `countAtRead` is the host's rule. The writes are
// detached (they never reject and never block the sweep), and the user's preferences gate them in the host.
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_NOTIFY,
  MEMORIAHUB_SETTINGS,
  type MemoriahubAccessPort,
  type MemoriahubLiveStateRow,
  type MemoriahubNotifyPort,
  type MemoriahubScopeRole,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import { MediaService } from '../gallery/media.service.js';
import { REVIEW_QUEUE_EVENT_KEYS } from './review-queue.constants.js';

/** Per-library roles that can actually act on a review queue. See the header. */
const ELIGIBLE_ROLES: MemoriahubScopeRole[] = ['admin', 'editor'];

/** The four integers `computeReviewCounts()` returns. */
type ReviewCounts = Awaited<ReturnType<MediaService['computeReviewCounts']>>;

/** The `features` namespace, narrowed to what the flag gates read. */
type FeatureFlags = Record<string, unknown> | undefined;

/**
 * One review queue's mapping from a pending count to a STATE event. The title ("3 burst groups ready to
 * review in Family") and the library-agnostic link are the event's template, which the host declares.
 */
interface ReviewQueueDescriptor {
  eventKey: string;
  countKey: keyof ReviewCounts;
  isEnabled: (features: FeatureFlags) => boolean;
}

const REVIEW_QUEUES: readonly ReviewQueueDescriptor[] = [
  {
    eventKey: REVIEW_QUEUE_EVENT_KEYS.bursts,
    countKey: 'pendingBurstGroups',
    isEnabled: (f) => f?.['burstDetection'] === true,
  },
  {
    eventKey: REVIEW_QUEUE_EVENT_KEYS.duplicates,
    countKey: 'pendingDuplicateGroups',
    isEnabled: (f) => f?.['duplicateDetection'] === true,
  },
  {
    eventKey: REVIEW_QUEUE_EVENT_KEYS.locationSuggestions,
    countKey: 'pendingLocationSuggestions',
    isEnabled: (f) => f?.['locationInference'] === true,
  },
  {
    eventKey: REVIEW_QUEUE_EVENT_KEYS.enhancements,
    countKey: 'pendingEnhancements',
    // The one queue with an environment kill switch, folded in so this sweep can never advertise a queue
    // the enhance endpoints would reject.
    isEnabled: (f) => f?.['pictureEnhancement'] === true && process.env['PICTURE_ENHANCEMENT_ENABLED'] !== 'false',
  },
];

/**
 * Outcome tally for one sweep: logged, and returned for the job's log line.
 *
 * @stability experimental
 */
export interface ReviewQueueReconcileResult {
  /** Libraries visited. */
  circles: number;
  /** STATE writes with a pending count (each a refresh in place or a new row). */
  upserted: number;
  /** Live rows drained to zero (dismissed): empty queue, disabled queue, or a member who can no longer act. */
  resolved: number;
  /** Libraries whose reconcile failed. */
  errors: number;
}

/**
 * The reconcile of the four review-queue notifications.
 *
 * @stability experimental
 */
@Injectable()
export class ReviewQueueReconcileService {
  private readonly logger = new Logger(ReviewQueueReconcileService.name);

  constructor(
    @Inject(MEMORIAHUB_NOTIFY) private readonly notify: MemoriahubNotifyPort,
    @Inject(MEMORIAHUB_ACCESS) private readonly access: MemoriahubAccessPort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly mediaService: MediaService,
  ) {}

  /**
   * Reconciles every library. The feature flags are read ONCE for the whole sweep (not per library), so a
   * 500-library deployment costs one settings read, not 500. A per-library failure is logged and counted,
   * never fatal: one library with a bad row must not stop the other 499.
   */
  async reconcileAll(): Promise<ReviewQueueReconcileResult> {
    const result: ReviewQueueReconcileResult = { circles: 0, upserted: 0, resolved: 0, errors: 0 };

    const features = (await this.settings.readSystem<FeatureFlags>('features')).value;
    const enabled = REVIEW_QUEUES.filter((q) => q.isEnabled(features));
    const disabled = REVIEW_QUEUES.filter((q) => !q.isEnabled(features));

    // A disabled queue produces nothing, but any row produced BEFORE it was disabled would otherwise stay
    // live forever (the reconcile that drains it to zero is exactly the thing that no longer runs for it),
    // pointing at a surface the admin has turned off. Bounded by the live rows themselves.
    if (disabled.length > 0) {
      const live = await this.liveRows({ eventKeys: disabled.map((q) => q.eventKey) });
      for (const row of live) this.drain(row);
      result.resolved += live.length;
    }

    // Every queue off: nothing to count, so skip library paging entirely.
    if (enabled.length === 0) return result;

    for (const circle of await this.access.allScopes()) {
      result.circles += 1;
      try {
        const circleResult = await this.reconcileCircle(circle, enabled);
        result.upserted += circleResult.upserted;
        result.resolved += circleResult.resolved;
      } catch (err) {
        result.errors += 1;
        this.logger.warn(
          `Review-queue reconcile failed for circle ${circle.id}: ` + (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    return result;
  }

  /**
   * Reconciles one library across every enabled queue: one STATE write per (eligible member x queue with a
   * pending count), and a drain (count 0) for every live row that should no longer be live. A refresh with
   * an unchanged count is quiet; a read row is re-marked unread only when the count grew past the
   * `countAtRead` the user saw (the host's rule).
   */
  private async reconcileCircle(
    circle: { id: string; name: string },
    queues: readonly ReviewQueueDescriptor[],
  ): Promise<{ upserted: number; resolved: number }> {
    // Only ids are loaded, so a library's whole eligible membership is a few KB even in the pathological
    // case: no paging needed at this level.
    const members = await this.access.membersOf(circle.id, ELIGIBLE_ROLES);
    const eligible = new Set(members.map((m) => m.userId));
    const live = await this.liveRows({ eventKeys: queues.map((q) => q.eventKey), scopeId: circle.id });
    if (eligible.size === 0 && live.length === 0) return { upserted: 0, resolved: 0 };

    // ONE call per library, fanned out to every member below.
    const counts = await this.mediaService.computeReviewCounts(circle.id);

    let upserted = 0;
    let resolved = 0;
    for (const queue of queues) {
      const count = counts[queue.countKey];
      const liveForQueue = live.filter((row) => row.eventKey === queue.eventKey);

      // A member DEMOTED to viewer (or removed from the library) cannot act on the queue any more: their
      // row is drained like an empty queue's.
      for (const row of liveForQueue) {
        if (count <= 0 || !eligible.has(row.userId)) {
          this.drain(row);
          resolved += 1;
        }
      }
      if (count <= 0) continue;

      for (const userId of eligible) {
        this.notify.notifyState(
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

  /** The live (not dismissed) STATE rows of the given queues, optionally in one library. */
  private async liveRows(where: { eventKeys: string[]; scopeId?: string }): Promise<MemoriahubLiveStateRow[]> {
    if (!this.notify.liveStates) return [];
    return this.notify.liveStates(where.eventKeys, where.scopeId);
  }

  /** A count of 0 dismisses the live row (dismissal implies read) and sends nothing. */
  private drain(row: MemoriahubLiveStateRow): void {
    this.notify.notifyState(row.eventKey, row.userId, { count: 0 }, { scopeId: row.scopeId });
  }
}
