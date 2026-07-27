/**
 * Unit tests for DuplicateGroupReviewStrategy — the review-run strategy
 * wrapping DuplicateService's single-group primitives for the bulk
 * duplicate review queue (issue #190).
 *
 * Covers:
 *   - evaluatePage: scopes to circleId + status=pending, ordering shape (the
 *     dedicated null-confidence-both-directions assertion lives in
 *     review-run-evaluate.handler.spec.ts, not duplicated here).
 *   - executeItem (dismiss): delegates to
 *     DuplicateService.dismissOneDuplicateGroup with the group id + live
 *     member ids and actorId; returns 'applied'.
 *   - executeItem (resolve): delegates to
 *     DuplicateService.resolveOneDuplicateGroup with keepIds/removeIds/
 *     action/actorId; returns 'applied'. Unlike burst, NO opts object is
 *     passed (resolveOneDuplicateGroup takes no deferDuplicateDetection —
 *     confirmed via the source: duplicate resolution triggers no follow-up
 *     enqueue at all).
 *   - executeItem skip conditions: group gone, group not pending, no
 *     suggestedBestItemId, suggestedBestItemId no longer a live member.
 *   - NO deferredEffects: DuplicateGroupReviewStrategy does not implement
 *     the optional hook at all (resolving a duplicate group triggers no
 *     follow-up enqueues, unlike burst's dedup re-enqueue).
 *   - hydrateItems: prefers suggestedBestItem, falls back to earliest member.
 *
 * No database required — PrismaService and DuplicateService are mocked; the
 * strategy is constructed directly (plain class, no Nest wiring needed).
 */

import { DuplicateGroupStatus, ReviewRunAction, ReviewRunSubject } from '@prisma/client';
import { randomUUID } from 'crypto';
import { DuplicateGroupReviewStrategy } from './duplicate-group.strategy';
import { PrismaService } from '../../prisma/prisma.service';
import { DuplicateService } from '../../dedup/duplicate.service';
import { createExecutionContext } from '../review-run-subject.strategy';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const CIRCLE_ID = randomUUID();
const ACTOR_ID = randomUUID();
const GROUP_ID = randomUUID();

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    circleId: CIRCLE_ID,
    subjectType: ReviewRunSubject.duplicate_group,
    action: ReviewRunAction.resolve_archive,
    threshold: 60,
    startedById: ACTOR_ID,
    ...overrides,
  };
}

describe('DuplicateGroupReviewStrategy', () => {
  let strategy: DuplicateGroupReviewStrategy;
  let prisma: MockPrismaService;
  let duplicateService: jest.Mocked<
    Pick<DuplicateService, 'resolveOneDuplicateGroup' | 'dismissOneDuplicateGroup'>
  >;

  beforeEach(() => {
    prisma = createMockPrismaService();
    duplicateService = {
      resolveOneDuplicateGroup: jest.fn().mockResolvedValue(undefined),
      dismissOneDuplicateGroup: jest.fn().mockResolvedValue(undefined),
    };

    strategy = new DuplicateGroupReviewStrategy(
      prisma as unknown as PrismaService,
      duplicateService as unknown as DuplicateService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('declares subject = duplicate_group, subjectColumn = duplicateGroupId', () => {
    expect(strategy.subject).toBe(ReviewRunSubject.duplicate_group);
    expect(strategy.subjectColumn).toBe('duplicateGroupId');
  });

  it('supports resolve_archive, resolve_trash, and dismiss', () => {
    expect(strategy.supportedActions).toEqual([
      ReviewRunAction.resolve_archive,
      ReviewRunAction.resolve_trash,
      ReviewRunAction.dismiss,
    ]);
  });

  it('has NO deferredEffects — resolving a duplicate group triggers no follow-up enqueue', () => {
    expect((strategy as any).deferredEffects).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // evaluatePage
  // ---------------------------------------------------------------------------

  describe('evaluatePage', () => {
    it('scopes the query to the run circleId and status=pending', async () => {
      (prisma.duplicateGroup.findMany as jest.Mock).mockResolvedValue([]);

      await strategy.evaluatePage(makeRun() as any, null, 1000);

      const where = (prisma.duplicateGroup.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.circleId).toBe(CIRCLE_ID);
      expect(where.status).toBe(DuplicateGroupStatus.pending);
    });

    it('orders by (capturedAt DESC NULLS LAST, id DESC)', async () => {
      (prisma.duplicateGroup.findMany as jest.Mock).mockResolvedValue([]);

      await strategy.evaluatePage(makeRun() as any, null, 1000);

      const call = (prisma.duplicateGroup.findMany as jest.Mock).mock.calls[0][0];
      expect(call.orderBy).toEqual([{ capturedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }]);
    });
  });

  // ---------------------------------------------------------------------------
  // executeItem — dismiss
  // ---------------------------------------------------------------------------

  describe('executeItem — dismiss', () => {
    it('delegates to DuplicateService.dismissOneDuplicateGroup with the group id + live member ids and actorId', async () => {
      const items = [{ id: 'm-1' }, { id: 'm-2' }];
      (prisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue({
        id: GROUP_ID,
        circleId: CIRCLE_ID,
        status: DuplicateGroupStatus.pending,
        suggestedBestItemId: null,
        items,
      });
      const ctx = createExecutionContext();
      const run = makeRun({ action: ReviewRunAction.dismiss });

      const outcome = await strategy.executeItem(run as any, GROUP_ID, ctx);

      expect(outcome).toBe('applied');
      expect(duplicateService.dismissOneDuplicateGroup).toHaveBeenCalledWith(
        { id: GROUP_ID, items },
        ACTOR_ID,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // executeItem — resolve (archive/trash)
  // ---------------------------------------------------------------------------

  describe('executeItem — resolve', () => {
    function setupGroup(overrides: Record<string, unknown> = {}) {
      (prisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue({
        id: GROUP_ID,
        circleId: CIRCLE_ID,
        status: DuplicateGroupStatus.pending,
        suggestedBestItemId: 'm-1',
        items: [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-3' }],
        ...overrides,
      });
    }

    it('resolve_archive delegates to DuplicateService.resolveOneDuplicateGroup with keepIds=[best], removeIds=rest, action="archive", actorId — no opts object', async () => {
      setupGroup();
      const ctx = createExecutionContext();
      const run = makeRun({ action: ReviewRunAction.resolve_archive });

      const outcome = await strategy.executeItem(run as any, GROUP_ID, ctx);

      expect(outcome).toBe('applied');
      expect(duplicateService.resolveOneDuplicateGroup).toHaveBeenCalledWith(
        expect.objectContaining({ id: GROUP_ID }),
        ['m-1'],
        ['m-2', 'm-3'],
        'archive',
        ACTOR_ID,
      );
      // Exactly 5 positional args — no trailing opts object like burst's strategy.
      expect((duplicateService.resolveOneDuplicateGroup as jest.Mock).mock.calls[0]).toHaveLength(5);
    });

    it('resolve_trash maps to action="trash"', async () => {
      setupGroup();
      const ctx = createExecutionContext();
      const run = makeRun({ action: ReviewRunAction.resolve_trash });

      await strategy.executeItem(run as any, GROUP_ID, ctx);

      expect(duplicateService.resolveOneDuplicateGroup).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'trash',
        expect.anything(),
      );
    });

    it('skips (no DuplicateService call) when the group is gone', async () => {
      (prisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(null);
      const ctx = createExecutionContext();

      const outcome = await strategy.executeItem(makeRun() as any, GROUP_ID, ctx);

      expect(outcome).toBe('skipped');
      expect(duplicateService.resolveOneDuplicateGroup).not.toHaveBeenCalled();
      expect(duplicateService.dismissOneDuplicateGroup).not.toHaveBeenCalled();
    });

    it('skips when the group is no longer pending', async () => {
      setupGroup({ status: DuplicateGroupStatus.resolved });
      const ctx = createExecutionContext();

      const outcome = await strategy.executeItem(makeRun() as any, GROUP_ID, ctx);

      expect(outcome).toBe('skipped');
      expect(duplicateService.resolveOneDuplicateGroup).not.toHaveBeenCalled();
    });

    it('skips when there is no suggestedBestItemId', async () => {
      setupGroup({ suggestedBestItemId: null });
      const ctx = createExecutionContext();

      const outcome = await strategy.executeItem(makeRun() as any, GROUP_ID, ctx);

      expect(outcome).toBe('skipped');
      expect(duplicateService.resolveOneDuplicateGroup).not.toHaveBeenCalled();
    });

    it('skips when the suggestedBestItemId is no longer a live member', async () => {
      setupGroup({ suggestedBestItemId: 'no-longer-a-member', items: [{ id: 'm-2' }, { id: 'm-3' }] });
      const ctx = createExecutionContext();

      const outcome = await strategy.executeItem(makeRun() as any, GROUP_ID, ctx);

      expect(outcome).toBe('skipped');
      expect(duplicateService.resolveOneDuplicateGroup).not.toHaveBeenCalled();
    });

    it('the eligible-member query excludes deleted AND archived items (unlike burst, which only excludes deleted)', async () => {
      setupGroup();
      const ctx = createExecutionContext();

      await strategy.executeItem(makeRun() as any, GROUP_ID, ctx);

      const selectArg = (prisma.duplicateGroup.findUnique as jest.Mock).mock.calls[0][0];
      expect(selectArg.select.items.where).toEqual({ deletedAt: null, archivedAt: null });
    });
  });

  // ---------------------------------------------------------------------------
  // hydrateItems
  // ---------------------------------------------------------------------------

  describe('hydrateItems', () => {
    it('prefers the suggestedBestItem cover when present', async () => {
      (prisma.duplicateGroup.findMany as jest.Mock).mockResolvedValue([
        {
          id: GROUP_ID,
          suggestedBestItem: { id: 'best', type: 'photo', capturedAt: null, originalFilename: 'best.jpg', width: 10, height: 10, metadata: null },
          items: [{ id: 'other', type: 'photo', capturedAt: null, originalFilename: 'other.jpg', width: 5, height: 5, metadata: null }],
        },
      ]);

      const result = await strategy.hydrateItems([GROUP_ID]);

      expect(result.get(GROUP_ID)?.mediaItemId).toBe('best');
    });

    it('falls back to the earliest member when there is no suggestedBestItem', async () => {
      (prisma.duplicateGroup.findMany as jest.Mock).mockResolvedValue([
        {
          id: GROUP_ID,
          suggestedBestItem: null,
          items: [{ id: 'earliest', type: 'photo', capturedAt: null, originalFilename: 'e.jpg', width: 5, height: 5, metadata: null }],
        },
      ]);

      const result = await strategy.hydrateItems([GROUP_ID]);

      expect(result.get(GROUP_ID)?.mediaItemId).toBe('earliest');
    });
  });
});
