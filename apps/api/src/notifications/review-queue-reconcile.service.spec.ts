/**
 * Unit tests for ReviewQueueReconcileService (epic #240, issue #246).
 *
 * Covers the acceptance list verbatim:
 *  - 929 groups -> ONE upsertState call per eligible member, never a
 *    per-group loop
 *  - viewer members are excluded from the eligible-member query
 *  - count change while read: no re-unread when new count <= countAtRead
 *  - count growth past countAtRead re-marks the row unread
 *  - never re-unread on decrease or equal count (both asserted explicitly)
 *  - missing countAtRead on a read row does NOT re-unread (conservative
 *    "already seen" default)
 *  - count -> 0 resolves the row
 *  - a disabled feature flag produces nothing for that type AND resolves
 *    pre-existing live rows of that type
 *  - two circles produce two independent rows for the same user
 *  - computeReviewCounts is called ONCE PER CIRCLE, not once per member
 *  - countAtRead is carried forward into the refreshed data payload
 *  - title pluralization + link correctness for all four queue types
 */

import { Test, TestingModule } from '@nestjs/testing';
import { CircleRole, NotificationType } from '@prisma/client';

import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { NotificationsService } from './notifications.service';
import { ReviewQueueReconcileService } from './review-queue-reconcile.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CIRCLE_A = { id: 'circle-a', name: 'Family' };
const CIRCLE_B = { id: 'circle-b', name: 'Work' };
const USER_A = 'user-a';
const USER_B = 'user-b';

function zeroCounts(overrides: Partial<Record<string, number>> = {}) {
  return {
    pendingBurstGroups: 0,
    pendingDuplicateGroups: 0,
    pendingLocationSuggestions: 0,
    pendingEnhancements: 0,
    ...overrides,
  };
}

function allFeaturesEnabled(overrides: Partial<Record<string, boolean>> = {}) {
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

function makeLiveRow(overrides: Partial<{
  id: string;
  userId: string;
  type: NotificationType;
  readAt: Date | null;
  data: Record<string, unknown> | null;
}> = {}) {
  return {
    id: 'row-1',
    userId: USER_A,
    type: NotificationType.review_queue_bursts,
    readAt: null,
    data: null,
    ...overrides,
  };
}

describe('ReviewQueueReconcileService', () => {
  let service: ReviewQueueReconcileService;
  let mockPrisma: MockPrismaService;
  let mockNotifications: {
    upsertState: jest.Mock;
    resolveStatesByIds: jest.Mock;
    resolveStatesByType: jest.Mock;
    markStatesUnreadByIds: jest.Mock;
    /** #251: batched preference warm-up before the per-member fan-out. */
    primePreferences: jest.Mock;
  };
  let mockSystemSettings: { getSettings: jest.Mock };
  let mockMediaService: { computeReviewCounts: jest.Mock };

  beforeEach(async () => {
    delete process.env['PICTURE_ENHANCEMENT_ENABLED'];
    delete process.env['BURST_DETECTION_ENABLED'];
    delete process.env['DUPLICATE_DETECTION_ENABLED'];
    delete process.env['LOCATION_INFERENCE_ENABLED'];

    mockPrisma = createMockPrismaService();
    mockNotifications = {
      upsertState: jest.fn().mockResolvedValue(undefined),
      resolveStatesByIds: jest.fn().mockResolvedValue(0),
      resolveStatesByType: jest.fn().mockResolvedValue(0),
      markStatesUnreadByIds: jest.fn().mockResolvedValue(0),
      primePreferences: jest.fn().mockResolvedValue(undefined),
    };
    mockSystemSettings = { getSettings: jest.fn().mockResolvedValue(allFeaturesEnabled()) };
    mockMediaService = { computeReviewCounts: jest.fn().mockResolvedValue(zeroCounts()) };

    (mockPrisma.circle.findMany as jest.Mock).mockResolvedValue([CIRCLE_A]);
    (mockPrisma.circleMember.findMany as jest.Mock).mockResolvedValue([{ userId: USER_A }]);
    (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewQueueReconcileService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
        { provide: MediaService, useValue: mockMediaService },
      ],
    }).compile();

    service = module.get<ReviewQueueReconcileService>(ReviewQueueReconcileService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. 929 groups -> ONE row per eligible member
  // -------------------------------------------------------------------------

  describe('fan-out is per-member, never per-group', () => {
    it('a circle with 929 pending duplicate groups produces exactly ONE upsertState call per eligible member, with data.count = 929', async () => {
      (mockPrisma.circleMember.findMany as jest.Mock).mockResolvedValue([
        { userId: USER_A },
        { userId: USER_B },
      ]);
      mockMediaService.computeReviewCounts.mockResolvedValue(
        zeroCounts({ pendingDuplicateGroups: 929 }),
      );

      const result = await service.reconcileAll();

      // Exactly one call per member for the duplicates type -- never 929 calls,
      // never a loop keyed on the group count.
      const duplicateCalls = mockNotifications.upsertState.mock.calls.filter(
        ([arg]) => arg.type === NotificationType.review_queue_duplicates,
      );
      expect(duplicateCalls).toHaveLength(2);
      for (const [arg] of duplicateCalls) {
        expect(arg.data).toMatchObject({ count: 929 });
      }
      expect(result.upserted).toBeGreaterThanOrEqual(2);
    });

    it('computeReviewCounts is called ONCE PER CIRCLE, not once per member', async () => {
      (mockPrisma.circleMember.findMany as jest.Mock).mockResolvedValue([
        { userId: 'u1' },
        { userId: 'u2' },
        { userId: 'u3' },
        { userId: 'u4' },
        { userId: 'u5' },
      ]);
      mockMediaService.computeReviewCounts.mockResolvedValue(
        zeroCounts({ pendingBurstGroups: 12 }),
      );

      await service.reconcileAll();

      expect(mockMediaService.computeReviewCounts).toHaveBeenCalledTimes(1);
      expect(mockMediaService.computeReviewCounts).toHaveBeenCalledWith(CIRCLE_A.id);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Viewer members get no row
  // -------------------------------------------------------------------------

  describe('eligibility filter', () => {
    it('queries eligible circle members restricted to collaborator/circle_admin, excluding viewer', async () => {
      mockMediaService.computeReviewCounts.mockResolvedValue(
        zeroCounts({ pendingBurstGroups: 5 }),
      );

      await service.reconcileAll();

      expect(mockPrisma.circleMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            circleId: CIRCLE_A.id,
            role: { in: expect.arrayContaining([CircleRole.circle_admin, CircleRole.collaborator]) },
          }),
        }),
      );
      const call = (mockPrisma.circleMember.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.role.in).not.toContain(CircleRole.viewer);
      expect(call.where.role.in).toHaveLength(2);
    });

    it('a circle with only a viewer member (query returns none) produces zero upsertState calls', async () => {
      // Simulates what the real (unmocked) role-filtered query would return
      // for a circle whose sole member is a viewer.
      (mockPrisma.circleMember.findMany as jest.Mock).mockResolvedValue([]);
      mockMediaService.computeReviewCounts.mockResolvedValue(
        zeroCounts({ pendingBurstGroups: 5 }),
      );

      await service.reconcileAll();

      expect(mockNotifications.upsertState).not.toHaveBeenCalled();
      // computeReviewCounts is short-circuited too: reconcileCircle returns
      // early when there are no eligible members.
      expect(mockMediaService.computeReviewCounts).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 3-6. Re-unread comparison logic
  // -------------------------------------------------------------------------

  describe('re-unread rule', () => {
    it('a read row whose count decreases is updated in place WITHOUT re-marking unread', async () => {
      const readAt = new Date('2026-08-01T00:00:00Z');
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([
        makeLiveRow({ id: 'row-1', userId: USER_A, readAt, data: { count: 10, countAtRead: 10 } }),
      ]);
      mockMediaService.computeReviewCounts.mockResolvedValue(
        zeroCounts({ pendingBurstGroups: 8 }),
      );

      await service.reconcileAll();

      expect(mockNotifications.markStatesUnreadByIds).toHaveBeenCalledWith([]);
      expect(mockNotifications.upsertState).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_A,
          type: NotificationType.review_queue_bursts,
          data: { count: 8, countAtRead: 10 },
        }),
      );
    });

    it('a read row whose count stays EQUAL to countAtRead is not re-marked unread', async () => {
      const readAt = new Date('2026-08-01T00:00:00Z');
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([
        makeLiveRow({ id: 'row-1', userId: USER_A, readAt, data: { count: 10, countAtRead: 10 } }),
      ]);
      mockMediaService.computeReviewCounts.mockResolvedValue(
        zeroCounts({ pendingBurstGroups: 10 }),
      );

      await service.reconcileAll();

      expect(mockNotifications.markStatesUnreadByIds).toHaveBeenCalledWith([]);
    });

    it('a read row whose count GROWS past countAtRead is re-marked unread', async () => {
      const readAt = new Date('2026-08-01T00:00:00Z');
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([
        makeLiveRow({ id: 'row-1', userId: USER_A, readAt, data: { count: 5, countAtRead: 5 } }),
      ]);
      mockMediaService.computeReviewCounts.mockResolvedValue(
        zeroCounts({ pendingBurstGroups: 6 }),
      );

      await service.reconcileAll();

      expect(mockNotifications.markStatesUnreadByIds).toHaveBeenCalledWith([
        { id: 'row-1', userId: USER_A },
      ]);
    });

    it('a read row with NO countAtRead snapshot is NOT re-marked unread even though the count grew', async () => {
      const readAt = new Date('2026-08-01T00:00:00Z');
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([
        makeLiveRow({ id: 'row-1', userId: USER_A, readAt, data: { count: 5 } }), // no countAtRead key
      ]);
      mockMediaService.computeReviewCounts.mockResolvedValue(
        zeroCounts({ pendingBurstGroups: 50 }),
      );

      await service.reconcileAll();

      expect(mockNotifications.markStatesUnreadByIds).toHaveBeenCalledWith([]);
      // Absent snapshot -> upsertState's data omits countAtRead entirely
      // rather than synthesizing one.
      expect(mockNotifications.upsertState).toHaveBeenCalledWith(
        expect.objectContaining({ data: { count: 50 } }),
      );
    });

    it('an UNREAD live row is never re-marked (there is nothing to re-mark)', async () => {
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([
        makeLiveRow({ id: 'row-1', userId: USER_A, readAt: null, data: { count: 5, countAtRead: 5 } }),
      ]);
      mockMediaService.computeReviewCounts.mockResolvedValue(
        zeroCounts({ pendingBurstGroups: 9 }),
      );

      await service.reconcileAll();

      expect(mockNotifications.markStatesUnreadByIds).toHaveBeenCalledWith([]);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Count -> 0 resolves the row
  // -------------------------------------------------------------------------

  describe('drained queue resolves the live row', () => {
    it('resolves every live row of a type whose count has dropped to 0', async () => {
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([
        makeLiveRow({ id: 'row-1', userId: USER_A, data: { count: 3 } }),
      ]);
      mockMediaService.computeReviewCounts.mockResolvedValue(
        zeroCounts({ pendingBurstGroups: 0 }),
      );

      await service.reconcileAll();

      expect(mockNotifications.resolveStatesByIds).toHaveBeenCalledWith([
        { id: 'row-1', userId: USER_A },
      ]);
      // No upsert for the drained type/member -- it is resolved, not refreshed.
      expect(mockNotifications.upsertState).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationType.review_queue_bursts }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 8. Disabled feature flag: produces nothing + resolves pre-existing rows
  // -------------------------------------------------------------------------

  describe('disabled feature flag', () => {
    it('resolves ALL pre-existing live rows of the disabled type via resolveStatesByType', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        allFeaturesEnabled({ burstDetection: false }),
      );

      await service.reconcileAll();

      expect(mockNotifications.resolveStatesByType).toHaveBeenCalledWith([
        NotificationType.review_queue_bursts,
      ]);
    });

    it('never upserts the disabled type even when its underlying count is positive', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        allFeaturesEnabled({ burstDetection: false }),
      );
      // If the flag were (incorrectly) ignored, this nonzero count would
      // otherwise produce an upsertState call for review_queue_bursts.
      mockMediaService.computeReviewCounts.mockResolvedValue(
        zeroCounts({ pendingBurstGroups: 5, pendingDuplicateGroups: 2 }),
      );

      await service.reconcileAll();

      const burstCalls = mockNotifications.upsertState.mock.calls.filter(
        ([arg]) => arg.type === NotificationType.review_queue_bursts,
      );
      expect(burstCalls).toHaveLength(0);
      // The still-enabled duplicates type is unaffected.
      const dupCalls = mockNotifications.upsertState.mock.calls.filter(
        ([arg]) => arg.type === NotificationType.review_queue_duplicates,
      );
      expect(dupCalls).toHaveLength(1);
    });

    it('when EVERY queue is disabled, circle paging is skipped entirely (no members/counts queries)', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        features: {
          burstDetection: false,
          duplicateDetection: false,
          locationInference: false,
          pictureEnhancement: false,
        },
      });

      await service.reconcileAll();

      expect(mockPrisma.circle.findMany).not.toHaveBeenCalled();
      expect(mockMediaService.computeReviewCounts).not.toHaveBeenCalled();
      expect(mockNotifications.resolveStatesByType).toHaveBeenCalledWith(
        expect.arrayContaining([
          NotificationType.review_queue_bursts,
          NotificationType.review_queue_duplicates,
          NotificationType.review_queue_location_suggestions,
          NotificationType.review_queue_enhancements,
        ]),
      );
    });

    it('the PICTURE_ENHANCEMENT_ENABLED=false env kill-switch disables the enhancements queue even with the feature flag on', async () => {
      process.env['PICTURE_ENHANCEMENT_ENABLED'] = 'false';
      mockMediaService.computeReviewCounts.mockResolvedValue(
        zeroCounts({ pendingEnhancements: 4 }),
      );

      await service.reconcileAll();

      expect(mockNotifications.resolveStatesByType).toHaveBeenCalledWith(
        expect.arrayContaining([NotificationType.review_queue_enhancements]),
      );
      const enhanceCalls = mockNotifications.upsertState.mock.calls.filter(
        ([arg]) => arg.type === NotificationType.review_queue_enhancements,
      );
      expect(enhanceCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Two circles -> two independent rows for the same user
  // -------------------------------------------------------------------------

  describe('multi-circle independence', () => {
    it('produces one row per circle for the same user, each carrying its own circleId', async () => {
      (mockPrisma.circle.findMany as jest.Mock).mockResolvedValue([CIRCLE_A, CIRCLE_B]);
      (mockPrisma.circleMember.findMany as jest.Mock).mockResolvedValue([{ userId: USER_A }]);
      mockMediaService.computeReviewCounts.mockResolvedValue(
        zeroCounts({ pendingBurstGroups: 3 }),
      );

      await service.reconcileAll();

      const burstCalls = mockNotifications.upsertState.mock.calls.filter(
        ([arg]) => arg.type === NotificationType.review_queue_bursts,
      );
      expect(burstCalls).toHaveLength(2);
      const circleIds = burstCalls.map(([arg]) => arg.circleId).sort();
      expect(circleIds).toEqual([CIRCLE_A.id, CIRCLE_B.id]);
      expect(burstCalls.every(([arg]) => arg.userId === USER_A)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 11. countAtRead carried forward
  // -------------------------------------------------------------------------

  describe('countAtRead carry-forward', () => {
    it('carries the existing countAtRead snapshot forward unchanged, even while re-unreading', async () => {
      const readAt = new Date('2026-08-01T00:00:00Z');
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([
        makeLiveRow({ id: 'row-1', userId: USER_A, readAt, data: { count: 7, countAtRead: 7 } }),
      ]);
      mockMediaService.computeReviewCounts.mockResolvedValue(
        zeroCounts({ pendingBurstGroups: 9 }),
      );

      await service.reconcileAll();

      // countAtRead stays 7 (the snapshot from the last read), NOT bumped to
      // the new live count of 9 -- only NotificationsService.markRead ever
      // refreshes that snapshot.
      expect(mockNotifications.upsertState).toHaveBeenCalledWith(
        expect.objectContaining({ data: { count: 9, countAtRead: 7 } }),
      );
      expect(mockNotifications.markStatesUnreadByIds).toHaveBeenCalledWith([
        { id: 'row-1', userId: USER_A },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // 12. Title pluralization + link correctness
  // -------------------------------------------------------------------------

  describe('title pluralization and link', () => {
    const cases: Array<{
      countKey: string;
      type: NotificationType;
      link: string;
      singular: string;
      plural: string;
      verb: string;
    }> = [
      {
        countKey: 'pendingBurstGroups',
        type: NotificationType.review_queue_bursts,
        link: '/bursts',
        singular: 'burst group',
        plural: 'burst groups',
        verb: 'ready to review',
      },
      {
        countKey: 'pendingDuplicateGroups',
        type: NotificationType.review_queue_duplicates,
        link: '/duplicates',
        singular: 'duplicate group',
        plural: 'duplicate groups',
        verb: 'ready to review',
      },
      {
        countKey: 'pendingLocationSuggestions',
        type: NotificationType.review_queue_location_suggestions,
        link: '/location-suggestions',
        singular: 'location suggestion',
        plural: 'location suggestions',
        verb: 'ready to review',
      },
      {
        countKey: 'pendingEnhancements',
        type: NotificationType.review_queue_enhancements,
        link: '/enhancements',
        singular: 'AI enhancement',
        plural: 'AI enhancements',
        verb: 'awaiting review',
      },
    ];

    for (const c of cases) {
      it(`${c.type}: singular title + link for count=1`, async () => {
        mockMediaService.computeReviewCounts.mockResolvedValue(zeroCounts({ [c.countKey]: 1 }));

        await service.reconcileAll();

        expect(mockNotifications.upsertState).toHaveBeenCalledWith(
          expect.objectContaining({
            type: c.type,
            link: c.link,
            title: `1 ${c.singular} ${c.verb} in ${CIRCLE_A.name}`,
          }),
        );
      });

      it(`${c.type}: plural title + link for count=2`, async () => {
        mockMediaService.computeReviewCounts.mockResolvedValue(zeroCounts({ [c.countKey]: 2 }));

        await service.reconcileAll();

        expect(mockNotifications.upsertState).toHaveBeenCalledWith(
          expect.objectContaining({
            type: c.type,
            link: c.link,
            title: `2 ${c.plural} ${c.verb} in ${CIRCLE_A.name}`,
          }),
        );
      });
    }
  });

  // -------------------------------------------------------------------------
  // Per-circle failure isolation (also exercised at the task level)
  // -------------------------------------------------------------------------

  describe('per-circle failure isolation', () => {
    it('a failure reconciling one circle is counted in errors and does not throw', async () => {
      (mockPrisma.circle.findMany as jest.Mock).mockResolvedValue([CIRCLE_A, CIRCLE_B]);
      (mockPrisma.circleMember.findMany as jest.Mock)
        .mockRejectedValueOnce(new Error('db boom for circle A'))
        .mockResolvedValueOnce([{ userId: USER_A }]);
      mockMediaService.computeReviewCounts.mockResolvedValue(
        zeroCounts({ pendingBurstGroups: 1 }),
      );

      const result = await service.reconcileAll();

      expect(result.errors).toBe(1);
      expect(result.circles).toBe(2);
      // The second circle still got reconciled despite the first one's error.
      expect(mockNotifications.upsertState).toHaveBeenCalledWith(
        expect.objectContaining({ circleId: CIRCLE_B.id }),
      );
    });
  });
});
