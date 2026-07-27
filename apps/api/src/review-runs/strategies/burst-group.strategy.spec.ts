/**
 * Unit tests for BurstGroupReviewStrategy — the review-run strategy wrapping
 * BurstService's single-group primitives for the bulk burst review queue
 * (issue #190).
 *
 * Covers:
 *   - evaluatePage: builds the confidence where-clause via the real
 *     BurstService dependency injected as a stub (evaluatePage itself never
 *     calls burstService); resolve/dismiss direction and keyset cursor
 *     shape (see review-run-evaluate.handler.spec.ts for the dedicated
 *     null-confidence-both-directions assertions — not duplicated here).
 *   - executeItem (dismiss): delegates to BurstService.dismissOneBurstGroup
 *     with { deferDuplicateDetection: true }; pushes every live member into
 *     ctx.reenqueueDuplicateDetection; returns 'applied'.
 *   - executeItem (resolve): delegates to BurstService.resolveOneBurstGroup
 *     with the correct keepIds/removeIds/action/actorId AND
 *     { deferDuplicateDetection: true }; pushes only the kept id into
 *     ctx.reenqueueDuplicateDetection; returns 'applied'.
 *   - executeItem skip conditions: group gone, group not pending, no
 *     suggestedBestItemId, suggestedBestItemId no longer a live member —
 *     never calls BurstService, never mutates ctx.
 *   - deferredEffects: entries from TWO different circles collapse into
 *     exactly ONE BurstService.reenqueueDuplicateDetection call PER CIRCLE
 *     with the deduped id list for that circle — not once per group. A
 *     no-op (ctx.reenqueueDuplicateDetection empty) calls nothing. A
 *     rejected per-circle call is caught (best-effort, logged).
 *   - hydrateItems: prefers suggestedBestItem, falls back to the earliest
 *     member.
 *
 * No database required — PrismaService and BurstService are mocked; the
 * strategy is constructed directly (plain class, no Nest wiring needed).
 */

import { BurstGroupStatus, ReviewRunAction, ReviewRunSubject } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BurstGroupReviewStrategy } from './burst-group.strategy';
import { PrismaService } from '../../prisma/prisma.service';
import { BurstService } from '../../burst/burst.service';
import { createExecutionContext } from '../review-run-subject.strategy';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const CIRCLE_ID = randomUUID();
const CIRCLE_B_ID = randomUUID();
const ACTOR_ID = randomUUID();
const GROUP_ID = randomUUID();

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    circleId: CIRCLE_ID,
    subjectType: ReviewRunSubject.burst_group,
    action: ReviewRunAction.resolve_archive,
    threshold: 60,
    startedById: ACTOR_ID,
    ...overrides,
  };
}

describe('BurstGroupReviewStrategy', () => {
  let strategy: BurstGroupReviewStrategy;
  let prisma: MockPrismaService;
  let burstService: jest.Mocked<
    Pick<BurstService, 'resolveOneBurstGroup' | 'dismissOneBurstGroup' | 'reenqueueDuplicateDetection'>
  >;

  beforeEach(() => {
    prisma = createMockPrismaService();
    burstService = {
      resolveOneBurstGroup: jest.fn().mockResolvedValue(undefined),
      dismissOneBurstGroup: jest.fn().mockResolvedValue(3),
      reenqueueDuplicateDetection: jest.fn().mockResolvedValue(undefined),
    };

    strategy = new BurstGroupReviewStrategy(
      prisma as unknown as PrismaService,
      burstService as unknown as BurstService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('declares subject = burst_group, subjectColumn = burstGroupId', () => {
    expect(strategy.subject).toBe(ReviewRunSubject.burst_group);
    expect(strategy.subjectColumn).toBe('burstGroupId');
  });

  it('supports resolve_archive, resolve_trash, and dismiss', () => {
    expect(strategy.supportedActions).toEqual([
      ReviewRunAction.resolve_archive,
      ReviewRunAction.resolve_trash,
      ReviewRunAction.dismiss,
    ]);
  });

  // ---------------------------------------------------------------------------
  // evaluatePage — basic shape (direction detail covered in the evaluate handler spec)
  // ---------------------------------------------------------------------------

  describe('evaluatePage', () => {
    it('scopes the query to the run circleId and status=pending', async () => {
      (prisma.burstGroup.findMany as jest.Mock).mockResolvedValue([]);

      await strategy.evaluatePage(makeRun() as any, null, 1000);

      const where = (prisma.burstGroup.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.circleId).toBe(CIRCLE_ID);
      expect(where.status).toBe(BurstGroupStatus.pending);
    });

    it('orders by (capturedAt DESC NULLS LAST, id DESC)', async () => {
      (prisma.burstGroup.findMany as jest.Mock).mockResolvedValue([]);

      await strategy.evaluatePage(makeRun() as any, null, 1000);

      const call = (prisma.burstGroup.findMany as jest.Mock).mock.calls[0][0];
      expect(call.orderBy).toEqual([{ capturedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }]);
    });

    it('returns nextCursor null when the page is empty', async () => {
      (prisma.burstGroup.findMany as jest.Mock).mockResolvedValue([]);

      const page = await strategy.evaluatePage(makeRun() as any, null, 1000);

      expect(page).toEqual({ subjectIds: [], nextCursor: null });
    });

    it('returns a cursor derived from the last row of a full page', async () => {
      const capturedAt = new Date('2024-05-01T00:00:00Z');
      (prisma.burstGroup.findMany as jest.Mock).mockResolvedValue([
        { id: 'g-1', capturedAt },
        { id: 'g-2', capturedAt },
      ]);

      const page = await strategy.evaluatePage(makeRun() as any, null, 1000);

      expect(page.subjectIds).toEqual(['g-1', 'g-2']);
      expect(page.nextCursor).toEqual({ capturedAt, id: 'g-2' });
    });
  });

  // ---------------------------------------------------------------------------
  // executeItem — dismiss
  // ---------------------------------------------------------------------------

  describe('executeItem — dismiss', () => {
    it('delegates to BurstService.dismissOneBurstGroup with { deferDuplicateDetection: true }', async () => {
      const items = [{ id: 'm-1' }, { id: 'm-2' }];
      (prisma.burstGroup.findUnique as jest.Mock).mockResolvedValue({
        id: GROUP_ID,
        circleId: CIRCLE_ID,
        status: BurstGroupStatus.pending,
        suggestedBestItemId: null,
        items,
      });
      const ctx = createExecutionContext();
      const run = makeRun({ action: ReviewRunAction.dismiss });

      const outcome = await strategy.executeItem(run as any, GROUP_ID, ctx);

      expect(outcome).toBe('applied');
      expect(burstService.dismissOneBurstGroup).toHaveBeenCalledWith(
        expect.objectContaining({ id: GROUP_ID, circleId: CIRCLE_ID }),
        ACTOR_ID,
        { deferDuplicateDetection: true },
      );
    });

    it('pushes EVERY live member into ctx.reenqueueDuplicateDetection (none removed on dismiss)', async () => {
      const items = [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-3' }];
      (prisma.burstGroup.findUnique as jest.Mock).mockResolvedValue({
        id: GROUP_ID,
        circleId: CIRCLE_ID,
        status: BurstGroupStatus.pending,
        suggestedBestItemId: null,
        items,
      });
      const ctx = createExecutionContext();
      const run = makeRun({ action: ReviewRunAction.dismiss });

      await strategy.executeItem(run as any, GROUP_ID, ctx);

      expect(ctx.reenqueueDuplicateDetection).toEqual([
        { mediaItemId: 'm-1', circleId: CIRCLE_ID },
        { mediaItemId: 'm-2', circleId: CIRCLE_ID },
        { mediaItemId: 'm-3', circleId: CIRCLE_ID },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // executeItem — resolve (archive/trash)
  // ---------------------------------------------------------------------------

  describe('executeItem — resolve', () => {
    function setupGroup(overrides: Record<string, unknown> = {}) {
      (prisma.burstGroup.findUnique as jest.Mock).mockResolvedValue({
        id: GROUP_ID,
        circleId: CIRCLE_ID,
        status: BurstGroupStatus.pending,
        suggestedBestItemId: 'm-1',
        items: [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-3' }],
        ...overrides,
      });
    }

    it('resolve_archive delegates to BurstService.resolveOneBurstGroup with keepIds=[best], removeIds=rest, action="archive", actorId, and { deferDuplicateDetection: true }', async () => {
      setupGroup();
      const ctx = createExecutionContext();
      const run = makeRun({ action: ReviewRunAction.resolve_archive });

      const outcome = await strategy.executeItem(run as any, GROUP_ID, ctx);

      expect(outcome).toBe('applied');
      expect(burstService.resolveOneBurstGroup).toHaveBeenCalledWith(
        expect.objectContaining({ id: GROUP_ID }),
        ['m-1'],
        ['m-2', 'm-3'],
        'archive',
        ACTOR_ID,
        { deferDuplicateDetection: true },
      );
    });

    it('resolve_trash maps to action="trash"', async () => {
      setupGroup();
      const ctx = createExecutionContext();
      const run = makeRun({ action: ReviewRunAction.resolve_trash });

      await strategy.executeItem(run as any, GROUP_ID, ctx);

      expect(burstService.resolveOneBurstGroup).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'trash',
        expect.anything(),
        expect.anything(),
      );
    });

    it('pushes ONLY the kept id into ctx.reenqueueDuplicateDetection on resolve', async () => {
      setupGroup();
      const ctx = createExecutionContext();
      const run = makeRun({ action: ReviewRunAction.resolve_archive });

      await strategy.executeItem(run as any, GROUP_ID, ctx);

      expect(ctx.reenqueueDuplicateDetection).toEqual([{ mediaItemId: 'm-1', circleId: CIRCLE_ID }]);
    });

    it('skips (no BurstService call) when the group is gone', async () => {
      (prisma.burstGroup.findUnique as jest.Mock).mockResolvedValue(null);
      const ctx = createExecutionContext();

      const outcome = await strategy.executeItem(makeRun() as any, GROUP_ID, ctx);

      expect(outcome).toBe('skipped');
      expect(burstService.resolveOneBurstGroup).not.toHaveBeenCalled();
      expect(burstService.dismissOneBurstGroup).not.toHaveBeenCalled();
      expect(ctx.reenqueueDuplicateDetection).toEqual([]);
    });

    it('skips when the group is no longer pending (resolved by hand since evaluation)', async () => {
      setupGroup({ status: BurstGroupStatus.resolved });
      const ctx = createExecutionContext();

      const outcome = await strategy.executeItem(makeRun() as any, GROUP_ID, ctx);

      expect(outcome).toBe('skipped');
      expect(burstService.resolveOneBurstGroup).not.toHaveBeenCalled();
    });

    it('skips when there is no suggestedBestItemId', async () => {
      setupGroup({ suggestedBestItemId: null });
      const ctx = createExecutionContext();

      const outcome = await strategy.executeItem(makeRun() as any, GROUP_ID, ctx);

      expect(outcome).toBe('skipped');
      expect(burstService.resolveOneBurstGroup).not.toHaveBeenCalled();
    });

    it('skips when the suggestedBestItemId is no longer a live member', async () => {
      setupGroup({ suggestedBestItemId: 'no-longer-a-member', items: [{ id: 'm-2' }, { id: 'm-3' }] });
      const ctx = createExecutionContext();

      const outcome = await strategy.executeItem(makeRun() as any, GROUP_ID, ctx);

      expect(outcome).toBe('skipped');
      expect(burstService.resolveOneBurstGroup).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // deferredEffects — batched, once per circle
  // ---------------------------------------------------------------------------

  describe('deferredEffects', () => {
    it('is a no-op when ctx.reenqueueDuplicateDetection is empty', async () => {
      const ctx = createExecutionContext();

      await strategy.deferredEffects(makeRun() as any, ctx);

      expect(burstService.reenqueueDuplicateDetection).not.toHaveBeenCalled();
    });

    it('collapses entries from TWO different circles into exactly ONE call PER CIRCLE with the deduped id list', async () => {
      const ctx = createExecutionContext();
      ctx.reenqueueDuplicateDetection.push(
        { mediaItemId: 'm-1', circleId: CIRCLE_ID },
        { mediaItemId: 'm-2', circleId: CIRCLE_ID },
        { mediaItemId: 'm-1', circleId: CIRCLE_ID }, // duplicate within the same circle
        { mediaItemId: 'm-9', circleId: CIRCLE_B_ID },
      );

      await strategy.deferredEffects(makeRun() as any, ctx);

      expect(burstService.reenqueueDuplicateDetection).toHaveBeenCalledTimes(2);
      expect(burstService.reenqueueDuplicateDetection).toHaveBeenCalledWith(
        CIRCLE_ID,
        expect.arrayContaining(['m-1', 'm-2']),
      );
      const circleACall = (burstService.reenqueueDuplicateDetection as jest.Mock).mock.calls.find(
        (c) => c[0] === CIRCLE_ID,
      );
      expect(circleACall[1]).toHaveLength(2); // deduped, not 3
      expect(burstService.reenqueueDuplicateDetection).toHaveBeenCalledWith(CIRCLE_B_ID, ['m-9']);
    });

    it('a rejected per-circle call is caught (best-effort, logged) and does not throw', async () => {
      burstService.reenqueueDuplicateDetection.mockRejectedValueOnce(new Error('queue down'));
      const ctx = createExecutionContext();
      ctx.reenqueueDuplicateDetection.push({ mediaItemId: 'm-1', circleId: CIRCLE_ID });

      await expect(strategy.deferredEffects(makeRun() as any, ctx)).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // hydrateItems
  // ---------------------------------------------------------------------------

  describe('hydrateItems', () => {
    it('prefers the suggestedBestItem cover when present', async () => {
      (prisma.burstGroup.findMany as jest.Mock).mockResolvedValue([
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
      (prisma.burstGroup.findMany as jest.Mock).mockResolvedValue([
        {
          id: GROUP_ID,
          suggestedBestItem: null,
          items: [{ id: 'earliest', type: 'photo', capturedAt: null, originalFilename: 'e.jpg', width: 5, height: 5, metadata: null }],
        },
      ]);

      const result = await strategy.hydrateItems([GROUP_ID]);

      expect(result.get(GROUP_ID)?.mediaItemId).toBe('earliest');
    });

    it('maps to null fields when a group has neither a suggestedBestItem nor any members', async () => {
      (prisma.burstGroup.findMany as jest.Mock).mockResolvedValue([
        { id: GROUP_ID, suggestedBestItem: null, items: [] },
      ]);

      const result = await strategy.hydrateItems([GROUP_ID]);

      expect(result.get(GROUP_ID)).toEqual({
        mediaItemId: null,
        type: null,
        capturedAt: null,
        filename: null,
        width: null,
        height: null,
        metadata: null,
      });
    });
  });
});
