/**
 * Unit tests for LocationSuggestionReviewStrategy — the review-run strategy
 * carrying forward the accept/reject transaction body that used to live
 * inside LocationSuggestionRunExecuteBatchHandler (issue #190).
 *
 * Covers:
 *   - evaluatePage: accept matches confidence >= floor, reject matches
 *     confidence < floor — a NON-nullable Float column, so (unlike burst/
 *     duplicate) there is no `not: null` branch to assert.
 *   - executeItem (accept): writes MediaItem.takenLat/takenLng +
 *     coordSource='inferred', marks the suggestion 'accepted', all inside
 *     ONE $transaction; pushes { mediaItemId, circleId } onto ctx.geocode;
 *     returns 'applied'.
 *   - executeItem (reject): marks the suggestion 'rejected' — NO coord
 *     write, NO $transaction (single update), NO ctx.geocode push; returns
 *     'applied'.
 *   - executeItem skip conditions: suggestion gone, suggestion no longer
 *     pending (resolved individually since evaluation).
 *   - deferredEffects: enqueues ONE geocode job PER ctx.geocode entry (NOT
 *     batched/deduped by circle, unlike burst's dedup re-enqueue) — dedup-
 *     safe default (no skipDedup), priority 100, reason backfill. A
 *     rejected per-item enqueue is caught (best-effort, logged) and does
 *     not abort the remaining entries.
 *   - hydrateItems: resolves the media item THROUGH the suggestion.
 *
 * No database required — PrismaService and EnrichmentJobService are mocked;
 * the strategy is constructed directly (plain class, no Nest wiring
 * needed).
 */

import { LocationSuggestionStatus, ReviewRunAction, ReviewRunSubject } from '@prisma/client';
import { randomUUID } from 'crypto';
import { LocationSuggestionReviewStrategy } from './location-suggestion.strategy';
import { PrismaService } from '../../prisma/prisma.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { createExecutionContext } from '../review-run-subject.strategy';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const CIRCLE_ID = randomUUID();
const ACTOR_ID = randomUUID();
const SUGGESTION_ID = randomUUID();

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    circleId: CIRCLE_ID,
    subjectType: ReviewRunSubject.location_suggestion,
    action: ReviewRunAction.accept,
    threshold: 80,
    startedById: ACTOR_ID,
    ...overrides,
  };
}

function makeSuggestion(overrides: Record<string, unknown> = {}) {
  return {
    id: SUGGESTION_ID,
    mediaItemId: randomUUID(),
    circleId: CIRCLE_ID,
    lat: 12.34,
    lng: 56.78,
    status: LocationSuggestionStatus.pending,
    ...overrides,
  };
}

describe('LocationSuggestionReviewStrategy', () => {
  let strategy: LocationSuggestionReviewStrategy;
  let prisma: MockPrismaService;
  let enrichmentJobs: jest.Mocked<Pick<EnrichmentJobService, 'enqueue'>>;

  beforeEach(() => {
    prisma = createMockPrismaService();
    enrichmentJobs = { enqueue: jest.fn().mockResolvedValue({ id: randomUUID() }) };

    strategy = new LocationSuggestionReviewStrategy(
      prisma as unknown as PrismaService,
      enrichmentJobs as unknown as EnrichmentJobService,
    );

    prisma.$transaction.mockImplementation(async (arg: any) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      if (typeof arg === 'function') return arg(prisma);
      return arg;
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('declares subject = location_suggestion, subjectColumn = locationSuggestionId', () => {
    expect(strategy.subject).toBe(ReviewRunSubject.location_suggestion);
    expect(strategy.subjectColumn).toBe('locationSuggestionId');
  });

  it('supports accept and reject only', () => {
    expect(strategy.supportedActions).toEqual([ReviewRunAction.accept, ReviewRunAction.reject]);
  });

  // ---------------------------------------------------------------------------
  // evaluatePage
  // ---------------------------------------------------------------------------

  describe('evaluatePage', () => {
    it('an ACCEPT run filters confidence >= threshold/100 — no `not: null` (non-nullable column)', async () => {
      (prisma.locationSuggestion.findMany as jest.Mock).mockResolvedValue([]);

      await strategy.evaluatePage(
        makeRun({ action: ReviewRunAction.accept, threshold: 80 }) as any,
        null,
        1000,
      );

      const where = (prisma.locationSuggestion.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where).toEqual({ circleId: CIRCLE_ID, status: 'pending', confidence: { gte: 0.8 } });
    });

    it('a REJECT run filters confidence < threshold/100', async () => {
      (prisma.locationSuggestion.findMany as jest.Mock).mockResolvedValue([]);

      await strategy.evaluatePage(
        makeRun({ action: ReviewRunAction.reject, threshold: 80 }) as any,
        null,
        1000,
      );

      const where = (prisma.locationSuggestion.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where).toEqual({ circleId: CIRCLE_ID, status: 'pending', confidence: { lt: 0.8 } });
    });

    it('orders by (createdAt DESC, id DESC)', async () => {
      (prisma.locationSuggestion.findMany as jest.Mock).mockResolvedValue([]);

      await strategy.evaluatePage(makeRun() as any, null, 1000);

      const call = (prisma.locationSuggestion.findMany as jest.Mock).mock.calls[0][0];
      expect(call.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });
  });

  // ---------------------------------------------------------------------------
  // executeItem — accept
  // ---------------------------------------------------------------------------

  describe('executeItem — accept', () => {
    it('writes MediaItem coords + coordSource="inferred" and marks the suggestion accepted, both in ONE $transaction', async () => {
      const suggestion = makeSuggestion();
      (prisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(suggestion);
      const ctx = createExecutionContext();
      const run = makeRun({ action: ReviewRunAction.accept });

      const outcome = await strategy.executeItem(run as any, SUGGESTION_ID, ctx);

      expect(outcome).toBe('applied');
      expect(prisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: suggestion.mediaItemId },
        data: { takenLat: suggestion.lat, takenLng: suggestion.lng, coordSource: 'inferred' },
      });
      expect(prisma.locationSuggestion.update).toHaveBeenCalledWith({
        where: { id: SUGGESTION_ID },
        data: {
          status: LocationSuggestionStatus.accepted,
          resolvedById: ACTOR_ID,
          resolvedAt: expect.any(Date),
        },
      });
      const [txArg] = (prisma.$transaction as jest.Mock).mock.calls[0];
      expect(Array.isArray(txArg)).toBe(true);
      expect(txArg).toHaveLength(2);
    });

    it('pushes { mediaItemId, circleId } onto ctx.geocode', async () => {
      const suggestion = makeSuggestion();
      (prisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(suggestion);
      const ctx = createExecutionContext();

      await strategy.executeItem(makeRun({ action: ReviewRunAction.accept }) as any, SUGGESTION_ID, ctx);

      expect(ctx.geocode).toEqual([{ mediaItemId: suggestion.mediaItemId, circleId: CIRCLE_ID }]);
    });
  });

  // ---------------------------------------------------------------------------
  // executeItem — reject
  // ---------------------------------------------------------------------------

  describe('executeItem — reject', () => {
    it('marks the suggestion rejected — NO coord write, NO ctx.geocode push', async () => {
      const suggestion = makeSuggestion();
      (prisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(suggestion);
      const ctx = createExecutionContext();

      const outcome = await strategy.executeItem(makeRun({ action: ReviewRunAction.reject }) as any, SUGGESTION_ID, ctx);

      expect(outcome).toBe('applied');
      expect(prisma.locationSuggestion.update).toHaveBeenCalledWith({
        where: { id: SUGGESTION_ID },
        data: {
          status: LocationSuggestionStatus.rejected,
          resolvedById: ACTOR_ID,
          resolvedAt: expect.any(Date),
        },
      });
      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
      expect(ctx.geocode).toEqual([]);
    });

    it('does NOT use $transaction for reject (single update, unlike accept)', async () => {
      const suggestion = makeSuggestion();
      (prisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(suggestion);
      const ctx = createExecutionContext();

      await strategy.executeItem(makeRun({ action: ReviewRunAction.reject }) as any, SUGGESTION_ID, ctx);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Skip conditions
  // ---------------------------------------------------------------------------

  describe('skip conditions', () => {
    it('skips when the suggestion is gone', async () => {
      (prisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(null);
      const ctx = createExecutionContext();

      const outcome = await strategy.executeItem(makeRun() as any, SUGGESTION_ID, ctx);

      expect(outcome).toBe('skipped');
      expect(prisma.locationSuggestion.update).not.toHaveBeenCalled();
      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('skips when the suggestion is no longer pending (resolved individually since evaluation)', async () => {
      (prisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(
        makeSuggestion({ status: LocationSuggestionStatus.accepted }),
      );
      const ctx = createExecutionContext();

      const outcome = await strategy.executeItem(makeRun() as any, SUGGESTION_ID, ctx);

      expect(outcome).toBe('skipped');
      expect(prisma.locationSuggestion.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // deferredEffects — one geocode job per entry, NOT batched
  // ---------------------------------------------------------------------------

  describe('deferredEffects', () => {
    it('enqueues one geocode job PER ctx.geocode entry — no per-circle batching/grouping (unlike burst)', async () => {
      const ctx = createExecutionContext();
      ctx.geocode.push(
        { mediaItemId: 'm-1', circleId: CIRCLE_ID },
        { mediaItemId: 'm-2', circleId: CIRCLE_ID },
      );

      await strategy.deferredEffects(makeRun() as any, ctx);

      expect(enrichmentJobs.enqueue).toHaveBeenCalledTimes(2);
      expect(enrichmentJobs.enqueue).toHaveBeenCalledWith({
        type: 'geocode',
        mediaItemId: 'm-1',
        circleId: CIRCLE_ID,
        reason: 'backfill',
        priority: 100,
      });
      expect(enrichmentJobs.enqueue).toHaveBeenCalledWith({
        type: 'geocode',
        mediaItemId: 'm-2',
        circleId: CIRCLE_ID,
        reason: 'backfill',
        priority: 100,
      });
    });

    it('does NOT set skipDedup (dedup-safe default, collapses with a pending geocode for the same item)', async () => {
      const ctx = createExecutionContext();
      ctx.geocode.push({ mediaItemId: 'm-1', circleId: CIRCLE_ID });

      await strategy.deferredEffects(makeRun() as any, ctx);

      const call = (enrichmentJobs.enqueue as jest.Mock).mock.calls[0][0];
      expect(call.skipDedup).toBeUndefined();
    });

    it('is a no-op when ctx.geocode is empty', async () => {
      const ctx = createExecutionContext();

      await strategy.deferredEffects(makeRun() as any, ctx);

      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });

    it('a rejected enqueue for one entry is caught (best-effort, logged) and does not abort the rest', async () => {
      enrichmentJobs.enqueue
        .mockRejectedValueOnce(new Error('queue unavailable'))
        .mockResolvedValueOnce({ id: randomUUID() } as any);
      const ctx = createExecutionContext();
      ctx.geocode.push(
        { mediaItemId: 'm-1', circleId: CIRCLE_ID },
        { mediaItemId: 'm-2', circleId: CIRCLE_ID },
      );

      await expect(strategy.deferredEffects(makeRun() as any, ctx)).resolves.not.toThrow();
      expect(enrichmentJobs.enqueue).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // hydrateItems
  // ---------------------------------------------------------------------------

  describe('hydrateItems', () => {
    it('resolves the media item THROUGH the suggestion', async () => {
      const mediaItemId = randomUUID();
      (prisma.locationSuggestion.findMany as jest.Mock).mockResolvedValue([
        {
          id: SUGGESTION_ID,
          mediaItemId,
          mediaItem: {
            id: mediaItemId,
            type: 'photo',
            capturedAt: new Date('2024-01-01'),
            originalFilename: 'a.jpg',
            width: 100,
            height: 100,
            metadata: { thumbnailKey: 'thumbs/a.jpg' },
          },
        },
      ]);

      const result = await strategy.hydrateItems([SUGGESTION_ID]);

      expect(result.get(SUGGESTION_ID)).toEqual({
        mediaItemId,
        type: 'photo',
        capturedAt: new Date('2024-01-01'),
        filename: 'a.jpg',
        width: 100,
        height: 100,
        metadata: { thumbnailKey: 'thumbs/a.jpg' },
      });
    });

    it('maps to null fields when the suggestion has no resolvable media item', async () => {
      (prisma.locationSuggestion.findMany as jest.Mock).mockResolvedValue([
        { id: SUGGESTION_ID, mediaItemId: randomUUID(), mediaItem: null },
      ]);

      const result = await strategy.hydrateItems([SUGGESTION_ID]);

      expect(result.get(SUGGESTION_ID)).toMatchObject({ type: null, filename: null, metadata: null });
    });
  });
});
