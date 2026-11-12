// =============================================================================
// The review-queue counter registry (epic #240, issue #246; RETRO-J10 #624)
// =============================================================================
//
// The media slice shows four review-queue counts (the dashboard banner, the sidebar badge, the hourly
// notification reconcile) but owns none of the queues: bursts, near-duplicates, location suggestions and AI
// enhancements belong to their own slices. Each of those slices registers ONE counter here; the media slice
// only aggregates them, so it never names another slice's table.
//
// A counter gives: the wire key the count is reported under (`pendingBurstGroups` ... : the four keys of
// `GET /api/media/dashboard` and `GET /api/media/review-counts`, unchanged), the notification event the
// queue raises (a STATE row per user and library), whether the queue is on (a `features` flag, and for one
// queue an environment kill switch) and how to count the pending groups of ONE library.
//
// A queue whose slice is not in the host reports 0 and raises nothing.
// =============================================================================

import { Injectable } from '@nestjs/common';

/**
 * The four wire keys of the review-queue counts. Permanent: the dashboard, the badge and the Android and
 * web clients read them.
 *
 * @stability experimental
 */
export const REVIEW_QUEUE_COUNT_KEYS = [
  'pendingBurstGroups',
  'pendingDuplicateGroups',
  'pendingLocationSuggestions',
  'pendingEnhancements',
] as const;

/**
 * One review-queue count key.
 *
 * @stability experimental
 */
export type ReviewQueueCountKey = (typeof REVIEW_QUEUE_COUNT_KEYS)[number];

/**
 * The counts of every review queue of one library, by wire key.
 *
 * @stability experimental
 */
export type ReviewQueueCounts = Record<ReviewQueueCountKey, number>;

/**
 * One review queue, as its owning slice declares it.
 *
 * @stability experimental
 */
export interface ReviewQueueCounter {
  /** The wire key the count is reported under. */
  readonly countKey: ReviewQueueCountKey;
  /** The STATE notification event the queue raises (`review.bursts`). Permanent. */
  readonly eventKey: string;
  /**
   * Whether the queue is on.
   *
   * @param features - the `features` settings namespace.
   */
  isEnabled(features: Record<string, unknown> | undefined): boolean;
  /**
   * The groups waiting for review in one library.
   *
   * @param libraryId - the library (circle).
   */
  count(libraryId: string): Promise<number>;
}

/**
 * The registry of review-queue counters. A slice registers its counter from `onModuleInit`.
 *
 * @extensionPoint registry
 * @stability experimental
 */
@Injectable()
export class ReviewQueueCounterRegistry {
  private readonly counters = new Map<ReviewQueueCountKey, ReviewQueueCounter>();

  /**
   * Registers a counter. Idempotent per `countKey`: registering the same key again replaces the earlier
   * counter (a host that counts a queue its own way overrides the slice's).
   *
   * @param counter - the queue.
   */
  registerReviewQueueCounter(counter: ReviewQueueCounter): void {
    this.counters.set(counter.countKey, counter);
  }

  /** Every registered counter, in the order of {@link REVIEW_QUEUE_COUNT_KEYS}. */
  all(): readonly ReviewQueueCounter[] {
    return REVIEW_QUEUE_COUNT_KEYS.flatMap((key) => {
      const counter = this.counters.get(key);
      return counter ? [counter] : [];
    });
  }

  /**
   * The pending counts of one library: every registered queue counted in parallel, the queues of a slice
   * that is not in the host as 0.
   *
   * @param libraryId - the library (circle).
   */
  async countAll(libraryId: string): Promise<ReviewQueueCounts> {
    const counts: ReviewQueueCounts = {
      pendingBurstGroups: 0,
      pendingDuplicateGroups: 0,
      pendingLocationSuggestions: 0,
      pendingEnhancements: 0,
    };
    await Promise.all(
      this.all().map(async (counter) => {
        counts[counter.countKey] = await counter.count(libraryId);
      }),
    );
    return counts;
  }
}
