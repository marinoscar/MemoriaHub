/**
 * Unit tests for LocationInferenceBackfillService.
 *
 * Covers:
 *  - Only circles with mediaItem.groupBy _count > 0 are eligible
 *  - Per-circle guard: an existing pending/running location_inference job for
 *    a circle skips that circle (no enqueue) but it still counts toward
 *    circles/estimatedItems
 *  - Enqueue call shape: type, mediaItemId:null, circleId, reason:backfill,
 *    priority:100, payload {mode:'sweep', from, to, force}, skipDedup:true
 *  - from/to forwarded into both the groupBy where-clause and the payload
 *  - force defaults to false in the payload when omitted
 *  - Return shape { enqueued, circles, estimatedItems }
 *  - Zero eligible circles -> all zeros, no enqueue calls
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobReason, JobStatus } from '@prisma/client';
import { LocationInferenceBackfillService } from './location-inference-backfill.service';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

describe('LocationInferenceBackfillService', () => {
  let service: LocationInferenceBackfillService;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: { enqueue: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationInferenceBackfillService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
      ],
    }).compile();

    service = module.get<LocationInferenceBackfillService>(LocationInferenceBackfillService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('eligibility', () => {
    it('only circles with _count > 0 are eligible', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        { circleId: 'circle-a', _count: 5 },
        { circleId: 'circle-b', _count: 0 },
      ]);
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.backfillAllCircles({});

      expect(result.circles).toBe(1);
      expect(result.estimatedItems).toBe(5);
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(1);
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ circleId: 'circle-a' }),
      );
    });

    it('returns all zeros and enqueues nothing when there are zero eligible circles', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([]);

      const result = await service.backfillAllCircles({});

      expect(result).toEqual({ enqueued: 0, circles: 0, estimatedItems: 0 });
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('per-circle in-flight guard', () => {
    it('skips a circle with an existing pending/running location_inference job (no enqueue), but still counts it', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        { circleId: 'circle-a', _count: 10 },
        { circleId: 'circle-b', _count: 20 },
      ]);
      (mockPrisma.enrichmentJob.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: 'existing-job', status: JobStatus.running }) // circle-a: guarded
        .mockResolvedValueOnce(null); // circle-b: eligible

      const result = await service.backfillAllCircles({});

      expect(result.enqueued).toBe(1);
      expect(result.circles).toBe(2);
      expect(result.estimatedItems).toBe(30);
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(1);
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ circleId: 'circle-b' }),
      );
    });

    it('the guard query filters by type:location_inference, circleId, and status in [pending, running]', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([{ circleId: 'circle-a', _count: 1 }]);
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);

      await service.backfillAllCircles({});

      expect(mockPrisma.enrichmentJob.findFirst).toHaveBeenCalledWith({
        where: {
          type: 'location_inference',
          circleId: 'circle-a',
          status: { in: [JobStatus.pending, JobStatus.running] },
        },
      });
    });
  });

  describe('enqueue call shape', () => {
    it('enqueues with type, mediaItemId:null, circleId, reason:backfill, priority:100, skipDedup:true, payload{mode:sweep,from,to,force}', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([{ circleId: 'circle-a', _count: 3 }]);
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);

      await service.backfillAllCircles({
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
        force: true,
      });

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith({
        type: 'location_inference',
        mediaItemId: null,
        circleId: 'circle-a',
        reason: JobReason.backfill,
        priority: 100,
        payload: {
          mode: 'sweep',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-06-01T00:00:00.000Z',
          force: true,
        },
        skipDedup: true,
      });
    });

    it('force defaults to false in the payload when omitted', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([{ circleId: 'circle-a', _count: 1 }]);
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);

      await service.backfillAllCircles({});

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ force: false }) }),
      );
    });

    it('from/to are forwarded into the groupBy where-clause (capturedAt gte/lte)', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([]);

      await service.backfillAllCircles({ from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' });

      const groupByCall = (mockPrisma.mediaItem.groupBy as jest.Mock).mock.calls[0][0];
      expect(groupByCall.where.capturedAt).toEqual(
        expect.objectContaining({
          not: null,
          gte: new Date('2026-01-01T00:00:00.000Z'),
          lte: new Date('2026-02-01T00:00:00.000Z'),
        }),
      );
    });
  });

  describe('return shape', () => {
    it('returns { enqueued, circles, estimatedItems } summed correctly across circles', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        { circleId: 'circle-a', _count: 7 },
        { circleId: 'circle-b', _count: 3 },
      ]);
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.backfillAllCircles({});

      expect(result).toEqual({ enqueued: 2, circles: 2, estimatedItems: 10 });
    });
  });
});
