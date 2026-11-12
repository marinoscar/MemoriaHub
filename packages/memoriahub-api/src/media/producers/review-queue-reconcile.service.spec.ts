/**
 * Unit tests for ReviewQueueReconcileService (epic #240, issue #246; platform
 * notifications since RETRO-D3, #576; moved to the media slice by RETRO-J10, #624). Host-free:
 * the ports are plain doubles.
 *
 * The reconcile writes through the notify port's STATE primitive,
 * `notifyState`, which the host's platform slice owns the one-live-row guarantee
 * (advisory lock + `notifications_live_dedup_uniq_idx`) and the countAtRead
 * re-unread rule. This file proves the producer asks for the right writes:
 *  - 929 groups -> ONE notifyState call per eligible member with count 929,
 *    never a per-group loop
 *  - viewer members are excluded from the eligible-member query
 *  - count -> 0 drains every live row of the queue in the circle (count 0)
 *  - a member who can no longer act (demoted / removed) has their live row drained
 *  - a disabled feature flag produces nothing for that queue AND drains its live rows
 *  - two circles produce two independent writes (scope = circle) for the same user
 *  - computeReviewCounts is called ONCE PER CIRCLE, not once per member
  *  - a per-circle failure is counted, never fatal
 */

import { ReviewQueueCounterRegistry, type ReviewQueueCounter } from './review-queue-counter.registry.js';
import { REVIEW_QUEUE_EVENT_KEYS } from './review-queue.constants.js';
import { ReviewQueueReconcileService } from './review-queue-reconcile.service.js';

/** The four counters the owning slices register, with their flag gates (the counts are the media double's). */
function queueCounters(): ReviewQueueCounterRegistry {
  const registry = new ReviewQueueCounterRegistry();
  const counter = (countKey: ReviewQueueCounter['countKey'], eventKey: string, isEnabled: ReviewQueueCounter['isEnabled']): ReviewQueueCounter => ({
    countKey,
    eventKey,
    isEnabled,
    count: async () => 0,
  });
  registry.registerReviewQueueCounter(counter('pendingBurstGroups', REVIEW_QUEUE_EVENT_KEYS.bursts, (f) => f?.['burstDetection'] === true));
  registry.registerReviewQueueCounter(counter('pendingDuplicateGroups', REVIEW_QUEUE_EVENT_KEYS.duplicates, (f) => f?.['duplicateDetection'] === true));
  registry.registerReviewQueueCounter(counter('pendingLocationSuggestions', REVIEW_QUEUE_EVENT_KEYS.locationSuggestions, (f) => f?.['locationInference'] === true));
  registry.registerReviewQueueCounter(
    counter('pendingEnhancements', REVIEW_QUEUE_EVENT_KEYS.enhancements, (f) => f?.['pictureEnhancement'] === true && process.env['PICTURE_ENHANCEMENT_ENABLED'] !== 'false'),
  );
  return registry;
}

const CIRCLE_A = { id: 'circle-a', name: 'Family' };
const CIRCLE_B = { id: 'circle-b', name: 'Work' };
const asScope = (c: { id: string; name: string }) => ({ ...c, kind: 'group' as const, ownerId: null, createdById: null });
const USER_A = 'user-a';
const USER_B = 'user-b';
const USER_DEMOTED = 'user-demoted';

function counts(overrides: Partial<Record<string, number>> = {}) {
  return {
    pendingBurstGroups: 0,
    pendingDuplicateGroups: 0,
    pendingLocationSuggestions: 0,
    pendingEnhancements: 0,
    ...overrides,
  };
}

function features(overrides: Partial<Record<string, boolean>> = {}) {
  return {
    features: {
      burstDetection: true,
      duplicateDetection: true,
      locationInference: true,
      pictureEnhancement: true,
      ...overrides,
    },
  };
}

describe('ReviewQueueReconcileService', () => {
  let service: ReviewQueueReconcileService;
  let notify: { notifyState: jest.Mock; liveStates: jest.Mock };
  let settings: { readSystem: jest.Mock };
  let scopes: { allScopes: jest.Mock; membersOf: jest.Mock };
  let mockMediaService: { computeReviewCounts: jest.Mock };
  let liveRows: jest.Mock;

  /** Each `notifyState` call as `{ eventKey, userId, data, circleId }`. */
  const stateCalls = () =>
    notify.notifyState.mock.calls.map(([eventKey, userId, data, options]) => ({
      eventKey: eventKey as string,
      userId: userId as string,
      data: data as Record<string, unknown>,
      circleId: (options as { scopeId?: string } | undefined)?.scopeId,
    }));
  const writes = () => stateCalls().filter((c) => (c.data['count'] as number) > 0);
  const drains = () => stateCalls().filter((c) => c.data['count'] === 0);

  beforeEach(() => {
    for (const key of ['PICTURE_ENHANCEMENT_ENABLED', 'BURST_DETECTION_ENABLED', 'DUPLICATE_DETECTION_ENABLED', 'LOCATION_INFERENCE_ENABLED']) {
      delete process.env[key];
    }
    scopes = { allScopes: jest.fn(), membersOf: jest.fn() };
    liveRows = jest.fn().mockResolvedValue([]);
    notify = { notifyState: jest.fn(), liveStates: liveRows };
    settings = { readSystem: jest.fn(async () => ({ value: features().features, version: 1 })) };
    mockMediaService = { computeReviewCounts: jest.fn().mockResolvedValue(counts()) };

    scopes.allScopes.mockResolvedValue([asScope(CIRCLE_A)]);
    scopes.membersOf.mockResolvedValue([{ userId: USER_A, role: 'editor' }]);

    service = new ReviewQueueReconcileService(notify as never, scopes as never, settings as never, mockMediaService as never, queueCounters());
  });

  afterEach(() => jest.clearAllMocks());

  describe('fan-out is per member, never per group', () => {
    it('929 pending duplicate groups produce ONE notifyState per eligible member, scoped to the circle', async () => {
      scopes.membersOf.mockResolvedValue([{ userId: USER_A, role: 'editor' }, { userId: USER_B, role: 'admin' }]);
      mockMediaService.computeReviewCounts.mockResolvedValue(counts({ pendingDuplicateGroups: 929 }));

      const result = await service.reconcileAll();

      expect(writes()).toHaveLength(2);
      for (const call of writes()) {
        expect(call.eventKey).toBe('review.duplicates');
        expect(call.circleId).toBe(CIRCLE_A.id);
        expect(call.data).toEqual({ count: 929, circleId: CIRCLE_A.id, circleName: 'Family' });
      }
      expect(writes().map((c) => c.userId).sort()).toEqual([USER_A, USER_B].sort());
      expect(result).toMatchObject({ circles: 1, upserted: 2, resolved: 0, errors: 0 });
    });

    it('queries only collaborators and circle admins (viewers cannot act on a review queue)', async () => {
      await service.reconcileAll();
      expect(scopes.membersOf).toHaveBeenCalledWith(CIRCLE_A.id, ['admin', 'editor']);
    });

    it('calls computeReviewCounts ONCE per circle, and scopes each circle separately', async () => {
      scopes.allScopes.mockResolvedValue([asScope(CIRCLE_A), asScope(CIRCLE_B)]);
      scopes.membersOf.mockResolvedValue([{ userId: USER_A, role: 'editor' }, { userId: USER_B, role: 'admin' }]);
      mockMediaService.computeReviewCounts.mockResolvedValue(counts({ pendingBurstGroups: 3 }));

      await service.reconcileAll();

      expect(mockMediaService.computeReviewCounts).toHaveBeenCalledTimes(2);
      expect(new Set(writes().filter((c) => c.userId === USER_A).map((c) => c.circleId))).toEqual(
        new Set([CIRCLE_A.id, CIRCLE_B.id]),
      );
    });
  });

  describe('draining', () => {
    it('a queue at zero drains every live row of it in the circle (count 0), and writes nothing else', async () => {
      liveRows.mockResolvedValue([
        { userId: USER_A, eventKey: 'review.bursts', scopeId: CIRCLE_A.id },
      ]);

      const result = await service.reconcileAll();

      expect(writes()).toHaveLength(0);
      expect(drains()).toEqual([
        expect.objectContaining({ eventKey: 'review.bursts', userId: USER_A, circleId: CIRCLE_A.id, data: { count: 0 } }),
      ]);
      expect(result.resolved).toBe(1);
    });

    it('drains the row of a member who can no longer act (demoted to viewer or removed)', async () => {
      mockMediaService.computeReviewCounts.mockResolvedValue(counts({ pendingBurstGroups: 4 }));
      liveRows.mockResolvedValue([
        { userId: USER_A, eventKey: 'review.bursts', scopeId: CIRCLE_A.id },
        { userId: USER_DEMOTED, eventKey: 'review.bursts', scopeId: CIRCLE_A.id },
      ]);

      await service.reconcileAll();

      expect(drains().map((c) => c.userId)).toEqual([USER_DEMOTED]);
      expect(writes().map((c) => c.userId)).toEqual([USER_A]);
    });

    it('reads the live state rows of the four events in the circle through the port', async () => {
      await service.reconcileAll();
      expect(liveRows).toHaveBeenCalledWith(
        ['review.bursts', 'review.duplicates', 'review.location_suggestions', 'review.enhancements'],
        CIRCLE_A.id,
      );
    });

    it('writes the counts but drains nothing when the host cannot list live rows', async () => {
      delete (notify as { liveStates?: unknown }).liveStates;
      mockMediaService.computeReviewCounts.mockResolvedValue(counts({ pendingBurstGroups: 2 }));
      const result = await service.reconcileAll();
      expect(writes()).toHaveLength(1);
      expect(drains()).toHaveLength(0);
      expect(result.errors).toBe(0);
    });
  });

  describe('feature flags', () => {
    it('a disabled queue produces nothing and drains its live rows deployment-wide', async () => {
      settings.readSystem.mockResolvedValue({ value: features({ burstDetection: false }).features, version: 1 });
      mockMediaService.computeReviewCounts.mockResolvedValue(counts({ pendingBurstGroups: 9 }));
      liveRows.mockImplementation(async (_eventKeys: string[], scopeId?: string) =>
        scopeId ? [] : [{ userId: USER_B, eventKey: 'review.bursts', scopeId: CIRCLE_B.id }],
      );

      await service.reconcileAll();

      expect(writes().some((c) => c.eventKey === 'review.bursts')).toBe(false);
      expect(drains()).toEqual([expect.objectContaining({ eventKey: 'review.bursts', userId: USER_B, circleId: CIRCLE_B.id })]);
    });

    it('every queue off: no circle is paged', async () => {
      settings.readSystem.mockResolvedValue({ value: {}, version: 1 });
      process.env['PICTURE_ENHANCEMENT_ENABLED'] = 'false';
      await service.reconcileAll();
      expect(scopes.allScopes).not.toHaveBeenCalled();
      expect(mockMediaService.computeReviewCounts).not.toHaveBeenCalled();
    });
  });

  it('a per-circle failure is counted and the sweep moves on', async () => {
    scopes.allScopes.mockResolvedValue([asScope(CIRCLE_A), asScope(CIRCLE_B)]);
    mockMediaService.computeReviewCounts
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(counts({ pendingBurstGroups: 1 }));

    const result = await service.reconcileAll();

    expect(result.errors).toBe(1);
    expect(writes()).toHaveLength(1);
  });
});
