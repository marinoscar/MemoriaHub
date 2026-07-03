/**
 * Unit tests for DuplicateBackfillService.
 *
 * Covers:
 *  - Chunker: pages of eligible ids are sliced into 100-id chunks
 *  - Chunks never span circles (one backfillCircle loop per circle; each
 *    enqueue call carries a single circleId)
 *  - Every enqueue call passes skipDedup:true, priority:100, and the circleId
 *  - force=false (default): eligibility SQL includes the NOT EXISTS embedding
 *    guard; force=true: the guard is omitted
 *  - Returns { enqueued (jobs), circles, estimatedItems }
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobReason } from '@prisma/client';
import { DuplicateBackfillService } from './duplicate-backfill.service';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

describe('DuplicateBackfillService', () => {
  let service: DuplicateBackfillService;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: { enqueue: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DuplicateBackfillService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
      ],
    }).compile();

    service = module.get<DuplicateBackfillService>(DuplicateBackfillService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function idsPage(count: number, prefix = 'id'): { id: string }[] {
    return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i.toString().padStart(5, '0')}` }));
  }

  // -------------------------------------------------------------------------
  // Chunker: 100-per-job slicing
  // -------------------------------------------------------------------------

  describe('chunking (100 ids per job)', () => {
    it('slices a page of 250 ids into 3 chunks (100, 100, 50)', async () => {
      mockPrisma.circle.findMany.mockResolvedValue([{ id: 'circle-1' }] as any);
      // First page: 250 ids (< PAGE_SIZE of 5000, so loop ends after one page)
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce(idsPage(250));

      const result = await service.backfillAllCircles({});

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(3);
      const payloads = (mockEnrichmentJobService.enqueue as jest.Mock).mock.calls.map(
        (c) => (c[0].payload as { mediaItemIds: string[] }).mediaItemIds.length,
      );
      expect(payloads).toEqual([100, 100, 50]);
      expect(result.enqueued).toBe(3);
      expect(result.estimatedItems).toBe(250);
    });

    it('produces exactly 1 chunk for a page smaller than 100', async () => {
      mockPrisma.circle.findMany.mockResolvedValue([{ id: 'circle-1' }] as any);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce(idsPage(42));

      const result = await service.backfillAllCircles({});

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(1);
      expect(result.enqueued).toBe(1);
      expect(result.estimatedItems).toBe(42);
    });

    it('produces zero jobs for an empty page', async () => {
      mockPrisma.circle.findMany.mockResolvedValue([{ id: 'circle-1' }] as any);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

      const result = await service.backfillAllCircles({});

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
      expect(result.enqueued).toBe(0);
      expect(result.estimatedItems).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Chunks never span circles
  // -------------------------------------------------------------------------

  describe('circle isolation', () => {
    it('processes each circle independently — every enqueued job carries a single circleId', async () => {
      mockPrisma.circle.findMany.mockResolvedValue([
        { id: 'circle-a' },
        { id: 'circle-b' },
      ] as any);
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(idsPage(120, 'a')) // circle-a page
        .mockResolvedValueOnce(idsPage(30, 'b')); // circle-b page

      const result = await service.backfillAllCircles({});

      // circle-a: 120 ids -> 2 chunks (100 + 20); circle-b: 30 ids -> 1 chunk
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(3);

      const calls = (mockEnrichmentJobService.enqueue as jest.Mock).mock.calls;
      const circleACalls = calls.filter((c) => c[0].circleId === 'circle-a');
      const circleBCalls = calls.filter((c) => c[0].circleId === 'circle-b');
      expect(circleACalls).toHaveLength(2);
      expect(circleBCalls).toHaveLength(1);

      // No chunk mixes ids from both circles
      for (const call of circleACalls) {
        const ids = (call[0].payload as { mediaItemIds: string[] }).mediaItemIds;
        expect(ids.every((id: string) => id.startsWith('a-'))).toBe(true);
      }
      for (const call of circleBCalls) {
        const ids = (call[0].payload as { mediaItemIds: string[] }).mediaItemIds;
        expect(ids.every((id: string) => id.startsWith('b-'))).toBe(true);
      }

      expect(result.circles).toBe(2);
      expect(result.enqueued).toBe(3);
      expect(result.estimatedItems).toBe(150);
    });

    it('returns { circles: 0, enqueued: 0, estimatedItems: 0 } when there are no circles', async () => {
      mockPrisma.circle.findMany.mockResolvedValue([]);

      const result = await service.backfillAllCircles({});

      expect(result).toEqual({ enqueued: 0, circles: 0, estimatedItems: 0 });
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Enqueue call shape: skipDedup, priority, reason
  // -------------------------------------------------------------------------

  describe('enqueue call shape', () => {
    it('every enqueue call sets skipDedup:true, priority:100, reason:backfill, type:duplicate_detection_batch', async () => {
      mockPrisma.circle.findMany.mockResolvedValue([{ id: 'circle-1' }] as any);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce(idsPage(5));

      await service.backfillAllCircles({});

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'duplicate_detection_batch',
          circleId: 'circle-1',
          reason: JobReason.backfill,
          priority: 100,
          skipDedup: true,
          payload: { mediaItemIds: expect.any(Array) },
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // force=false vs force=true eligibility (NOT EXISTS embedding guard)
  // -------------------------------------------------------------------------

  describe('force flag', () => {
    it('force=false (default): the eligibility SQL includes a NOT EXISTS media_visual_embedding guard', async () => {
      mockPrisma.circle.findMany.mockResolvedValue([{ id: 'circle-1' }] as any);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

      await service.backfillAllCircles({});

      const sqlCall = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0][0];
      const sqlText = sqlCall.sql as string;
      expect(sqlText).toContain('NOT EXISTS');
      expect(sqlText).toContain('media_visual_embedding');
    });

    it('force=true: the eligibility SQL omits the NOT EXISTS embedding guard', async () => {
      mockPrisma.circle.findMany.mockResolvedValue([{ id: 'circle-1' }] as any);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

      await service.backfillAllCircles({ force: true });

      const sqlCall = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0][0];
      const sqlText = sqlCall.sql as string;
      expect(sqlText).not.toContain('NOT EXISTS');
    });

    it('always filters to type=photo, deleted_at IS NULL, archived_at IS NULL regardless of force', async () => {
      mockPrisma.circle.findMany.mockResolvedValue([{ id: 'circle-1' }] as any);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

      await service.backfillAllCircles({ force: true });

      const sqlCall = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0][0];
      const sqlText = sqlCall.sql as string;
      expect(sqlText).toContain("type = 'photo'");
      expect(sqlText).toContain('deleted_at IS NULL');
      expect(sqlText).toContain('archived_at IS NULL');
    });
  });

  // -------------------------------------------------------------------------
  // Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { enqueued, circles, estimatedItems } summed across all circles', async () => {
      mockPrisma.circle.findMany.mockResolvedValue([
        { id: 'circle-a' },
        { id: 'circle-b' },
      ] as any);
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(idsPage(100, 'a'))
        .mockResolvedValueOnce(idsPage(1, 'b'));

      const result = await service.backfillAllCircles({});

      expect(result).toEqual({ enqueued: 2, circles: 2, estimatedItems: 101 });
    });
  });
});
