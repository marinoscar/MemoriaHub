/**
 * Unit tests for ReviewInsightsService.
 *
 * Covers:
 *  - getReviewInsights: RBAC (assertCircleAccess called with viewer role)
 *  - Aggregate math: identified = sum of all status counts; pending/resolved/
 *    dismissed pulled from the matching status row
 *  - archivedGroups/trashedGroups + itemsKept/itemsArchived/itemsDeleted
 *    derived from the resolutionAction groupBy rows
 *  - itemsKept sums across BOTH archive and trash resolution actions
 *  - Null _sum values (keptCount/removedCount) coalesce to 0
 *  - bursts and duplicates are aggregated independently from their own
 *    groupBy query results
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ReviewInsightsService } from './review-insights.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { CircleRole } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-abc';
const CIRCLE_ID = 'circle-xyz';
const PERMS_MEDIA_READ = ['media:read'];

function statusRow(status: string, count: number) {
  return { status, _count: { _all: count } };
}

function actionRow(
  resolutionAction: string | null,
  count: number,
  kept: number | null,
  removed: number | null,
) {
  return {
    resolutionAction,
    _count: { _all: count },
    _sum: { keptCount: kept, removedCount: removed },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewInsightsService', () => {
  let service: ReviewInsightsService;
  let mockPrisma: MockPrismaService;
  let mockMembership: { assertCircleAccess: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockMembership = { assertCircleAccess: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewInsightsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockMembership },
      ],
    }).compile();

    service = module.get<ReviewInsightsService>(ReviewInsightsService);
  });

  /**
   * Wires up the four sequential groupBy calls made by getReviewInsights, in
   * the exact Promise.all source order: burst status, burst action,
   * duplicate status, duplicate action.
   */
  function mockGroupByResults(opts: {
    burstStatus?: ReturnType<typeof statusRow>[];
    burstAction?: ReturnType<typeof actionRow>[];
    dupStatus?: ReturnType<typeof statusRow>[];
    dupAction?: ReturnType<typeof actionRow>[];
  }) {
    (mockPrisma.burstGroup.groupBy as jest.Mock)
      .mockResolvedValueOnce(opts.burstStatus ?? [])
      .mockResolvedValueOnce(opts.burstAction ?? []);
    (mockPrisma.duplicateGroup.groupBy as jest.Mock)
      .mockResolvedValueOnce(opts.dupStatus ?? [])
      .mockResolvedValueOnce(opts.dupAction ?? []);
  }

  // -------------------------------------------------------------------------
  // RBAC
  // -------------------------------------------------------------------------

  describe('RBAC', () => {
    it('calls assertCircleAccess with viewer role', async () => {
      mockGroupByResults({});

      await service.getReviewInsights(CIRCLE_ID, USER_ID, PERMS_MEDIA_READ);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_READ,
        CircleRole.viewer,
      );
    });

    it('propagates a rejection from assertCircleAccess without querying groupBy', async () => {
      mockMembership.assertCircleAccess.mockRejectedValueOnce(new Error('not a member'));

      await expect(
        service.getReviewInsights(CIRCLE_ID, USER_ID, PERMS_MEDIA_READ),
      ).rejects.toThrow('not a member');

      expect(mockPrisma.burstGroup.groupBy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Response shape
  // -------------------------------------------------------------------------

  describe('response shape', () => {
    it('returns { bursts, duplicates } aggregated independently', async () => {
      mockGroupByResults({
        burstStatus: [statusRow('pending', 3)],
        dupStatus: [statusRow('pending', 9)],
      });

      const result = await service.getReviewInsights(CIRCLE_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result).toHaveProperty('bursts');
      expect(result).toHaveProperty('duplicates');
      expect(result.bursts.identified).toBe(3);
      expect(result.duplicates.identified).toBe(9);
    });

    it('scopes every groupBy query to the requested circleId', async () => {
      mockGroupByResults({});

      await service.getReviewInsights(CIRCLE_ID, USER_ID, PERMS_MEDIA_READ);

      const burstStatusCall = (mockPrisma.burstGroup.groupBy as jest.Mock).mock.calls[0][0];
      const dupStatusCall = (mockPrisma.duplicateGroup.groupBy as jest.Mock).mock.calls[0][0];
      expect(burstStatusCall.where).toMatchObject({ circleId: CIRCLE_ID });
      expect(dupStatusCall.where).toMatchObject({ circleId: CIRCLE_ID });
    });
  });

  // -------------------------------------------------------------------------
  // Status aggregation (identified / pending / resolved / dismissed)
  // -------------------------------------------------------------------------

  describe('status aggregation', () => {
    it('identified equals the sum of all status row counts', async () => {
      mockGroupByResults({
        burstStatus: [statusRow('pending', 4), statusRow('resolved', 6), statusRow('dismissed', 2)],
      });

      const result = await service.getReviewInsights(CIRCLE_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.bursts.identified).toBe(12);
    });

    it('maps each status row to its matching field', async () => {
      mockGroupByResults({
        burstStatus: [statusRow('pending', 4), statusRow('resolved', 6), statusRow('dismissed', 2)],
      });

      const result = await service.getReviewInsights(CIRCLE_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.bursts).toMatchObject({ pending: 4, resolved: 6, dismissed: 2 });
    });

    it('defaults pending/resolved/dismissed to 0 when their status row is absent', async () => {
      mockGroupByResults({
        burstStatus: [statusRow('pending', 5)], // no resolved/dismissed rows at all
      });

      const result = await service.getReviewInsights(CIRCLE_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.bursts).toMatchObject({ pending: 5, resolved: 0, dismissed: 0, identified: 5 });
    });

    it('returns all-zero stats when no groups exist for the circle', async () => {
      mockGroupByResults({});

      const result = await service.getReviewInsights(CIRCLE_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.bursts).toEqual({
        identified: 0,
        pending: 0,
        resolved: 0,
        dismissed: 0,
        archivedGroups: 0,
        trashedGroups: 0,
        itemsKept: 0,
        itemsArchived: 0,
        itemsDeleted: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Resolution-action aggregation (archive vs. trash breakdown)
  // -------------------------------------------------------------------------

  describe('resolution-action aggregation', () => {
    it('archivedGroups + itemsArchived come from the "archive" action row', async () => {
      mockGroupByResults({
        burstAction: [actionRow('archive', 5, 8, 20)],
      });

      const result = await service.getReviewInsights(CIRCLE_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.bursts.archivedGroups).toBe(5);
      expect(result.bursts.itemsArchived).toBe(20);
    });

    it('trashedGroups + itemsDeleted come from the "trash" action row', async () => {
      mockGroupByResults({
        burstAction: [actionRow('trash', 3, 3, 9)],
      });

      const result = await service.getReviewInsights(CIRCLE_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.bursts.trashedGroups).toBe(3);
      expect(result.bursts.itemsDeleted).toBe(9);
    });

    it('itemsKept sums keptCount across BOTH archive and trash action rows', async () => {
      mockGroupByResults({
        burstAction: [actionRow('archive', 5, 8, 20), actionRow('trash', 3, 3, 9)],
      });

      const result = await service.getReviewInsights(CIRCLE_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.bursts.itemsKept).toBe(11); // 8 (archive) + 3 (trash)
      expect(result.bursts.itemsArchived).toBe(20);
      expect(result.bursts.itemsDeleted).toBe(9);
    });

    it('coalesces null _sum.keptCount and _sum.removedCount to 0', async () => {
      mockGroupByResults({
        burstAction: [actionRow('archive', 2, null, null)],
      });

      const result = await service.getReviewInsights(CIRCLE_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.bursts.archivedGroups).toBe(2);
      expect(result.bursts.itemsKept).toBe(0);
      expect(result.bursts.itemsArchived).toBe(0);
    });

    it('leaves archivedGroups/trashedGroups at 0 when there are no resolved groups yet', async () => {
      mockGroupByResults({
        burstStatus: [statusRow('pending', 4)],
        burstAction: [],
      });

      const result = await service.getReviewInsights(CIRCLE_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.bursts.archivedGroups).toBe(0);
      expect(result.bursts.trashedGroups).toBe(0);
      expect(result.bursts.itemsKept).toBe(0);
      expect(result.bursts.itemsArchived).toBe(0);
      expect(result.bursts.itemsDeleted).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Independent aggregation between bursts and duplicates
  // -------------------------------------------------------------------------

  describe('bursts vs. duplicates independence', () => {
    it('does not mix burst rows into the duplicates aggregate or vice versa', async () => {
      mockGroupByResults({
        burstStatus: [statusRow('pending', 4), statusRow('resolved', 1)],
        burstAction: [actionRow('archive', 1, 2, 5)],
        dupStatus: [statusRow('pending', 10), statusRow('dismissed', 3)],
        dupAction: [actionRow('trash', 4, 4, 11)],
      });

      const result = await service.getReviewInsights(CIRCLE_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.bursts).toMatchObject({
        identified: 5,
        pending: 4,
        resolved: 1,
        dismissed: 0,
        archivedGroups: 1,
        itemsArchived: 5,
        trashedGroups: 0,
        itemsDeleted: 0,
      });
      expect(result.duplicates).toMatchObject({
        identified: 13,
        pending: 10,
        resolved: 0,
        dismissed: 3,
        trashedGroups: 4,
        itemsDeleted: 11,
        archivedGroups: 0,
        itemsArchived: 0,
      });
    });
  });
});
