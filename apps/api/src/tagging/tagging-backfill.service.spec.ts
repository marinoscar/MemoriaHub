/**
 * Unit tests for TaggingBackfillService (epic #452, issue #458).
 *
 * The load-bearing behavior is that videos are OPT-IN. An admin used to
 * running photo backfills would otherwise, on their first run after
 * upgrading, dispatch an AI call for EVERY video in the library — a large,
 * unexpected bill from a command whose behavior they thought they understood.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobReason, MediaTagStatusType, MediaType } from '@prisma/client';
import { TaggingBackfillService } from './tagging-backfill.service';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

describe('TaggingBackfillService', () => {
  let service: TaggingBackfillService;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: { enqueue: jest.Mock };

  /** The `type` filter the eligibility query was built with. */
  const typeFilter = () =>
    (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0].where.type;

  const enqueuedTypes = (): string[] =>
    mockEnrichmentJobService.enqueue.mock.calls.map((c: any[]) => c[0].type as string);

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = { enqueue: jest.fn().mockResolvedValue({ id: 'job-x' }) };
    (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaggingBackfillService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
      ],
    }).compile();

    service = module.get(TaggingBackfillService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('media-type scoping', () => {
    it('backfills PHOTOS ONLY when mediaTypes is omitted — videos are opt-in', async () => {
      await service.backfillCircle('circle-1', {});

      expect(typeFilter()).toEqual({ in: [MediaType.photo] });
    });

    it('backfills photos only when mediaTypes is an empty array', async () => {
      await service.backfillCircle('circle-1', { mediaTypes: [] });

      expect(typeFilter()).toEqual({ in: [MediaType.photo] });
    });

    it('includes videos when they are explicitly requested', async () => {
      await service.backfillCircle('circle-1', {
        mediaTypes: [MediaType.photo, MediaType.video],
      });

      expect(typeFilter()).toEqual({ in: [MediaType.photo, MediaType.video] });
    });

    it('can target videos alone', async () => {
      await service.backfillCircle('circle-1', { mediaTypes: [MediaType.video] });

      expect(typeFilter()).toEqual({ in: [MediaType.video] });
    });
  });

  describe('job-type routing', () => {
    it('routes each matched item by its own type', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        { id: 'p1', circleId: 'circle-1', type: MediaType.photo },
        { id: 'v1', circleId: 'circle-1', type: MediaType.video },
      ]);

      const enqueued = await service.backfillCircle('circle-1', {
        mediaTypes: [MediaType.photo, MediaType.video],
      });

      expect(enqueuedTypes()).toEqual(['auto_tagging', 'video_auto_tagging']);
      expect(enqueued).toBe(2);
    });

    it('enqueues at backfill priority 100 so it never starves upload enrichment', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        { id: 'v1', circleId: 'circle-1', type: MediaType.video },
      ]);

      await service.backfillCircle('circle-1', { mediaTypes: [MediaType.video] });

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ reason: JobReason.backfill, priority: 100 }),
      );
    });

    it('marks each item pending regardless of which type it routed to', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        { id: 'v1', circleId: 'circle-1', type: MediaType.video },
      ]);

      await service.backfillCircle('circle-1', { mediaTypes: [MediaType.video] });

      expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { status: MediaTagStatusType.pending } }),
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
      (mockPrisma.circle.findMany as jest.Mock).mockResolvedValue([
        { id: 'circle-1' },
        { id: 'circle-2' },
      ]);

      const result = await service.backfillAllCircles({
        mediaTypes: [MediaType.photo, MediaType.video],
      });

      expect(result.circles).toBe(2);
      for (const call of (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls) {
        expect(call[0].where.type).toEqual({ in: [MediaType.photo, MediaType.video] });
      }
    });

    it('still defaults to photos only across every circle', async () => {
      (mockPrisma.circle.findMany as jest.Mock).mockResolvedValue([{ id: 'circle-1' }]);

      await service.backfillAllCircles({});

      expect(typeFilter()).toEqual({ in: [MediaType.photo] });
    });
  });
});
