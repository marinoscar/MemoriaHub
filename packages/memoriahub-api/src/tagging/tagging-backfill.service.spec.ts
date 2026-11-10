/**
 * Unit tests for TaggingBackfillService (epic #452, issue #458).
 *
 * The load-bearing behavior is that videos are OPT-IN. An admin used to
 * running photo backfills would otherwise, on their first run after
 * upgrading, dispatch an AI call for EVERY video in the library — a large,
 * unexpected bill from a command whose behavior they thought they understood.
 */

import { createMockDb as mockDb, type MockDb } from '../../test/helpers/mock-db.js';
import { JOB_REASON, MEDIA_TYPE, TAG_STATUS } from './constants.js';
import { TaggingBackfillService } from './tagging-backfill.service.js';

/** The scope ids a sweep lists. */
const scopeFindMany = jest.fn();

describe('TaggingBackfillService', () => {
  let service: TaggingBackfillService;
  let mockPrisma: MockDb;
  let mockEnrichmentJobService: { enqueue: jest.Mock };

  /** The `type` filter the eligibility query was built with. */
  const typeFilter = () =>
    (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0].where.type;

  const enqueuedTypes = (): string[] =>
    mockEnrichmentJobService.enqueue.mock.calls.map((c: any[]) => c[0].type as string);

  beforeEach(() => {
    scopeFindMany.mockReset().mockResolvedValue([]);
    mockPrisma = mockDb();
    mockEnrichmentJobService = { enqueue: jest.fn().mockResolvedValue({ id: 'job-x' }) };
    (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});

    // The access port's sweep, stood in for by `scopeFindMany`, which each case fills with the scope ids.
    const access = { allScopeIds: async () => ((await scopeFindMany({})) as { id: string }[]).map((c) => c.id) };
    service = new TaggingBackfillService(mockPrisma as never, mockEnrichmentJobService as never, access as never);

  });

  afterEach(() => jest.clearAllMocks());

  describe('media-type scoping', () => {
    it('backfills PHOTOS ONLY when mediaTypes is omitted — videos are opt-in', async () => {
      await service.backfillCircle('circle-1', {});

      expect(typeFilter()).toEqual({ in: [MEDIA_TYPE.photo] });
    });

    it('backfills photos only when mediaTypes is an empty array', async () => {
      await service.backfillCircle('circle-1', { mediaTypes: [] });

      expect(typeFilter()).toEqual({ in: [MEDIA_TYPE.photo] });
    });

    it('includes videos when they are explicitly requested', async () => {
      await service.backfillCircle('circle-1', {
        mediaTypes: [MEDIA_TYPE.photo, MEDIA_TYPE.video],
      });

      expect(typeFilter()).toEqual({ in: [MEDIA_TYPE.photo, MEDIA_TYPE.video] });
    });

    it('can target videos alone', async () => {
      await service.backfillCircle('circle-1', { mediaTypes: [MEDIA_TYPE.video] });

      expect(typeFilter()).toEqual({ in: [MEDIA_TYPE.video] });
    });
  });

  describe('job-type routing', () => {
    it('routes each matched item by its own type', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        { id: 'p1', circleId: 'circle-1', type: MEDIA_TYPE.photo },
        { id: 'v1', circleId: 'circle-1', type: MEDIA_TYPE.video },
      ]);

      const enqueued = await service.backfillCircle('circle-1', {
        mediaTypes: [MEDIA_TYPE.photo, MEDIA_TYPE.video],
      });

      expect(enqueuedTypes()).toEqual(['auto_tagging', 'video_auto_tagging']);
      expect(enqueued).toBe(2);
    });

    it('enqueues at backfill priority 100 so it never starves upload enrichment', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        { id: 'v1', circleId: 'circle-1', type: MEDIA_TYPE.video },
      ]);

      await service.backfillCircle('circle-1', { mediaTypes: [MEDIA_TYPE.video] });

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ reason: JOB_REASON.backfill, priority: 100 }),
      );
    });

    it('marks each item pending regardless of which type it routed to', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        { id: 'v1', circleId: 'circle-1', type: MEDIA_TYPE.video },
      ]);

      await service.backfillCircle('circle-1', { mediaTypes: [MEDIA_TYPE.video] });

      expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { status: TAG_STATUS.pending } }),
      );
    });
  });

  describe('eligibility', () => {
    it('skips already-processed items unless forced', async () => {
      await service.backfillCircle('circle-1', {});

      const where = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.OR).toBeDefined();
    });

    it('re-tags everything when forced', async () => {
      await service.backfillCircle('circle-1', { force: true });

      const where = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.OR).toBeUndefined();
    });
  });

  describe('backfillAllCircles', () => {
    it('forwards mediaTypes to every circle', async () => {
      scopeFindMany.mockResolvedValue([
        { id: 'circle-1' },
        { id: 'circle-2' },
      ]);

      const result = await service.backfillAllCircles({
        mediaTypes: [MEDIA_TYPE.photo, MEDIA_TYPE.video],
      });

      expect(result.circles).toBe(2);
      for (const call of (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls) {
        expect(call[0].where.type).toEqual({ in: [MEDIA_TYPE.photo, MEDIA_TYPE.video] });
      }
    });

    it('still defaults to photos only across every circle', async () => {
      scopeFindMany.mockResolvedValue([{ id: 'circle-1' }]);

      await service.backfillAllCircles({});

      expect(typeFilter()).toEqual({ in: [MEDIA_TYPE.photo] });
    });
  });
});
