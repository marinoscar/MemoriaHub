/**
 * Unit tests for ReviewQueueReconcileService (epic #240, issue #246; platform
 * notifications since RETRO-D3, #576).
 *
 * The reconcile writes through the platform's STATE primitive,
 * `NotificationsService.notifyState`, which owns the one-live-row guarantee
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
 *  - the rendered titles and links of all four queues (the event templates)
 *  - a per-circle failure is counted, never fatal
 */

import { Test, TestingModule } from '@nestjs/testing';
import { OwnerScopeSweepService } from '../platform/sharing/owner-scope-sweep.service';
import { NotificationsService } from '@marinoscar/platform-api/notifications';

import { createPlatformNotificationsMock } from '../../test/mocks/platform-notifications.mock';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { MediaService } from '@marinoscar/memoriahub-api/media';
import { PrismaService } from '../prisma/prisma.service';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';
import { ReviewQueueReconcileService } from './review-queue-reconcile.service';

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
  let mockPrisma: MockPrismaService;
  let platform: ReturnType<typeof createPlatformNotificationsMock>;
  let mockSystemSettings: { getSettings: jest.Mock };
  let scopes: { allScopes: jest.Mock; membersOf: jest.Mock };
  let mockMediaService: { computeReviewCounts: jest.Mock };

  const stateCalls = () => platform.calls('notifyState');
  const writes = () => stateCalls().filter((c) => (c.data['count'] as number) > 0);
  const drains = () => stateCalls().filter((c) => c.data['count'] === 0);

  beforeEach(async () => {
    for (const key of ['PICTURE_ENHANCEMENT_ENABLED', 'BURST_DETECTION_ENABLED', 'DUPLICATE_DETECTION_ENABLED', 'LOCATION_INFERENCE_ENABLED']) {
      delete process.env[key];
    }
    mockPrisma = createMockPrismaService();
    scopes = { allScopes: jest.fn(), membersOf: jest.fn() };
    platform = createPlatformNotificationsMock();
    mockSystemSettings = { getSettings: jest.fn().mockResolvedValue(features()) };
    mockMediaService = { computeReviewCounts: jest.fn().mockResolvedValue(counts()) };

    scopes.allScopes.mockResolvedValue([asScope(CIRCLE_A)]);
    scopes.membersOf.mockResolvedValue([{ userId: USER_A, role: 'editor' }]);
    (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewQueueReconcileService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: platform.mock },
        { provide: AppSystemSettingsService, useValue: mockSystemSettings },
        { provide: MediaService, useValue: mockMediaService },
        { provide: OwnerScopeSweepService, useValue: scopes },
      ],
    }).compile();

    service = module.get(ReviewQueueReconcileService);
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
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([
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
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([
        { userId: USER_A, eventKey: 'review.bursts', scopeId: CIRCLE_A.id },
        { userId: USER_DEMOTED, eventKey: 'review.bursts', scopeId: CIRCLE_A.id },
      ]);

      await service.reconcileAll();

      expect(drains().map((c) => c.userId)).toEqual([USER_DEMOTED]);
      expect(writes().map((c) => c.userId)).toEqual([USER_A]);
    });

    it('reads live rows of STATE events only (dedup key state:*) in the circle', async () => {
      await service.reconcileAll();
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ dismissedAt: null, dedupKey: { startsWith: 'state:' }, scopeId: CIRCLE_A.id }),
        }),
      );
    });
  });

  describe('feature flags', () => {
    it('a disabled queue produces nothing and drains its live rows deployment-wide', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(features({ burstDetection: false }));
      mockMediaService.computeReviewCounts.mockResolvedValue(counts({ pendingBurstGroups: 9 }));
      (mockPrisma.notification.findMany as jest.Mock).mockImplementation(async (args: { where: { scopeId?: string } }) =>
        args.where.scopeId ? [] : [{ userId: USER_B, eventKey: 'review.bursts', scopeId: CIRCLE_B.id }],
      );

      await service.reconcileAll();

      expect(writes().some((c) => c.eventKey === 'review.bursts')).toBe(false);
      expect(drains()).toEqual([expect.objectContaining({ eventKey: 'review.bursts', userId: USER_B, circleId: CIRCLE_B.id })]);
    });

    it('every queue off: no circle is paged', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({ features: {} });
      process.env['PICTURE_ENHANCEMENT_ENABLED'] = 'false';
      await service.reconcileAll();
      expect(scopes.allScopes).not.toHaveBeenCalled();
      expect(mockMediaService.computeReviewCounts).not.toHaveBeenCalled();
    });
  });

  describe('rendered rows (the event templates)', () => {
    it.each([
      ['pendingBurstGroups', 'review.bursts', '1 burst group ready to review in Family', '3 burst groups ready to review in Family', '/bursts'],
      ['pendingDuplicateGroups', 'review.duplicates', '1 duplicate group ready to review in Family', '3 duplicate groups ready to review in Family', '/duplicates'],
      ['pendingLocationSuggestions', 'review.location_suggestions', '1 location suggestion ready to review in Family', '3 location suggestions ready to review in Family', '/location-suggestions'],
      ['pendingEnhancements', 'review.enhancements', '1 AI enhancement awaiting review in Family', '3 AI enhancements awaiting review in Family', '/enhancements'],
    ])('%s -> %s', async (countKey, eventKey, one, three, link) => {
      mockMediaService.computeReviewCounts.mockResolvedValue(counts({ [countKey]: 3 }));
      await service.reconcileAll();
      const [call] = writes();
      expect(call!.eventKey).toBe(eventKey);
      expect(call!.buildTitle(1)).toBe(one);
      expect(call!.buildTitle(3)).toBe(three);
      expect(call!.link).toBe(link);
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
