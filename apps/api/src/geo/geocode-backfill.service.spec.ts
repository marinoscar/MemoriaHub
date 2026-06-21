/**
 * Unit tests for GeocodeBackfillService.
 *
 * Tests:
 *   - backfill without force: filters to items with GPS and geocodeStatus != processed
 *   - backfill with force: includes all items with GPS regardless of status
 *   - date range filtering (from / to / both)
 *   - enqueues a 'geocode' job per item at priority 100
 *   - upserts mediaGeocodeStatus to pending
 *   - returns { enqueued }
 *   - enqueueRerun: enqueues at priority 0 and returns { jobId, status }
 *   - enqueueRerun: throws NotFoundException for missing/deleted items
 *   - getStatus: returns status row when present
 *   - getStatus: returns not_processed with null fields when absent
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { JobReason, JobStatus, MediaMetadataStatusType } from '@prisma/client';
import { GeocodeBackfillService } from './geocode-backfill.service';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    type: 'geocode',
    mediaItemId: null,
    circleId: null,
    status: JobStatus.pending,
    reason: JobReason.backfill,
    priority: 100,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 0,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GeocodeBackfillService', () => {
  let service: GeocodeBackfillService;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: { enqueue: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = { enqueue: jest.fn().mockResolvedValue(makeJob()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeocodeBackfillService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
      ],
    }).compile();

    service = module.get<GeocodeBackfillService>(GeocodeBackfillService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // backfill — default (force=false)
  // -------------------------------------------------------------------------

  describe('backfill (force=false, default)', () => {
    it('queries only non-deleted items with GPS coordinates', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      await service.backfill({});

      const query = mockPrisma.mediaItem.findMany.mock.calls[0][0] as any;
      expect(query.where.deletedAt).toBe(null);
      expect(query.where.takenLat).toEqual({ not: null });
      expect(query.where.takenLng).toEqual({ not: null });
    });

    it('excludes already-processed items (OR: no status row OR status != processed)', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      await service.backfill({});

      const query = mockPrisma.mediaItem.findMany.mock.calls[0][0] as any;
      // The OR filter must be present when force=false
      expect(query.where.OR).toBeDefined();
      expect(Array.isArray(query.where.OR)).toBe(true);
    });

    it('enqueues a geocode job per item at priority 100 with reason=backfill', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id: 'media-1', circleId: 'circle-1' },
        { id: 'media-2', circleId: 'circle-1' },
      ] as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);

      await service.backfill({});

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(2);

      const firstCall = mockEnrichmentJobService.enqueue.mock.calls[0][0];
      expect(firstCall.type).toBe('geocode');
      expect(firstCall.priority).toBe(100);
      expect(firstCall.reason).toBe(JobReason.backfill);
      expect(firstCall.mediaItemId).toBe('media-1');
    });

    it('upserts mediaGeocodeStatus to pending for each item', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id: 'media-1', circleId: 'circle-1' },
      ] as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);

      await service.backfill({});

      expect(mockPrisma.mediaGeocodeStatus.upsert).toHaveBeenCalledTimes(1);

      const upsertCall = mockPrisma.mediaGeocodeStatus.upsert.mock.calls[0][0];
      expect(upsertCall.where.mediaItemId).toBe('media-1');
      expect(upsertCall.create.status).toBe(MediaMetadataStatusType.pending);
      expect(upsertCall.update.status).toBe(MediaMetadataStatusType.pending);
    });

    it('returns { enqueued } equal to the number of items found', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id: 'media-1', circleId: 'c1' },
        { id: 'media-2', circleId: 'c1' },
        { id: 'media-3', circleId: 'c2' },
      ] as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);

      const result = await service.backfill({});

      expect(result).toEqual({ enqueued: 3 });
    });

    it('returns { enqueued: 0 } when no matching items', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      const result = await service.backfill({});

      expect(result).toEqual({ enqueued: 0 });
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // backfill — force=true
  // -------------------------------------------------------------------------

  describe('backfill (force=true)', () => {
    it('does not include the OR status filter', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      await service.backfill({ force: true });

      const query = mockPrisma.mediaItem.findMany.mock.calls[0][0] as any;
      // When force=true the OR clause should be absent
      expect(query.where.OR).toBeUndefined();
    });

    it('still filters by GPS (takenLat/takenLng not null)', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      await service.backfill({ force: true });

      const query = mockPrisma.mediaItem.findMany.mock.calls[0][0] as any;
      expect(query.where.takenLat).toEqual({ not: null });
      expect(query.where.takenLng).toEqual({ not: null });
    });
  });

  // -------------------------------------------------------------------------
  // backfill — date range
  // -------------------------------------------------------------------------

  describe('backfill with date range', () => {
    it('adds capturedAt.gte when from is provided', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      await service.backfill({ from: '2024-01-01T00:00:00.000Z' });

      const query = mockPrisma.mediaItem.findMany.mock.calls[0][0] as any;
      expect(query.where.capturedAt).toMatchObject({
        gte: new Date('2024-01-01T00:00:00.000Z'),
      });
    });

    it('adds capturedAt.lte when to is provided', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      await service.backfill({ to: '2024-12-31T23:59:59.999Z' });

      const query = mockPrisma.mediaItem.findMany.mock.calls[0][0] as any;
      expect(query.where.capturedAt).toMatchObject({
        lte: new Date('2024-12-31T23:59:59.999Z'),
      });
    });

    it('adds both gte and lte when from and to are provided', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      await service.backfill({
        from: '2024-06-01T00:00:00.000Z',
        to: '2024-06-30T23:59:59.999Z',
      });

      const query = mockPrisma.mediaItem.findMany.mock.calls[0][0] as any;
      expect(query.where.capturedAt).toMatchObject({
        gte: new Date('2024-06-01T00:00:00.000Z'),
        lte: new Date('2024-06-30T23:59:59.999Z'),
      });
    });

    it('omits capturedAt filter when neither from nor to is provided', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      await service.backfill({});

      const query = mockPrisma.mediaItem.findMany.mock.calls[0][0] as any;
      expect(query.where.capturedAt).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // enqueueRerun
  // -------------------------------------------------------------------------

  describe('enqueueRerun', () => {
    it('enqueues a geocode job at priority 0 with reason=rerun', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        id: 'media-1',
        circleId: 'circle-1',
        deletedAt: null,
      } as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);
      mockEnrichmentJobService.enqueue.mockResolvedValue(
        makeJob({ id: 'job-rerun', status: JobStatus.pending, reason: JobReason.rerun, priority: 0 }),
      );

      await service.enqueueRerun('media-1', 'user-1');

      const call = mockEnrichmentJobService.enqueue.mock.calls[0][0];
      expect(call.type).toBe('geocode');
      expect(call.priority).toBe(0);
      expect(call.reason).toBe(JobReason.rerun);
      expect(call.mediaItemId).toBe('media-1');
    });

    it('upserts mediaGeocodeStatus to pending', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        id: 'media-1',
        circleId: 'circle-1',
        deletedAt: null,
      } as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);
      mockEnrichmentJobService.enqueue.mockResolvedValue(makeJob({ id: 'job-rerun' }));

      await service.enqueueRerun('media-1', 'user-1');

      const upsertCall = mockPrisma.mediaGeocodeStatus.upsert.mock.calls[0][0];
      expect(upsertCall.where.mediaItemId).toBe('media-1');
      expect(upsertCall.create.status).toBe(MediaMetadataStatusType.pending);
    });

    it('returns { jobId, status }', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        id: 'media-1',
        circleId: 'circle-1',
        deletedAt: null,
      } as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);
      mockEnrichmentJobService.enqueue.mockResolvedValue(
        makeJob({ id: 'job-xyz', status: JobStatus.pending }),
      );

      const result = await service.enqueueRerun('media-1', 'user-1');

      expect(result).toEqual({ jobId: 'job-xyz', status: JobStatus.pending });
    });

    it('throws NotFoundException when mediaItem is not found', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(service.enqueueRerun('nonexistent', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when mediaItem is soft-deleted', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        id: 'media-1',
        circleId: 'circle-1',
        deletedAt: new Date(),
      } as any);

      await expect(service.enqueueRerun('media-1', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // getStatus
  // -------------------------------------------------------------------------

  describe('getStatus', () => {
    it('returns the status row when present', async () => {
      const processedAt = new Date('2024-06-01');
      mockPrisma.mediaGeocodeStatus.findUnique.mockResolvedValue({
        mediaItemId: 'media-1',
        status: MediaMetadataStatusType.processed,
        processedAt,
        lastError: null,
      } as any);

      const result = await service.getStatus('media-1');

      expect(result.status).toBe(MediaMetadataStatusType.processed);
      expect(result.processedAt).toEqual(processedAt);
      expect(result.lastError).toBeNull();
    });

    it('returns not_processed with null fields when no status row exists', async () => {
      mockPrisma.mediaGeocodeStatus.findUnique.mockResolvedValue(null);

      const result = await service.getStatus('nonexistent');

      expect(result.status).toBe('not_processed');
      expect(result.processedAt).toBeNull();
      expect(result.lastError).toBeNull();
    });

    it('returns lastError when status is failed', async () => {
      mockPrisma.mediaGeocodeStatus.findUnique.mockResolvedValue({
        mediaItemId: 'media-1',
        status: MediaMetadataStatusType.failed,
        processedAt: null,
        lastError: 'Provider returned null',
      } as any);

      const result = await service.getStatus('media-1');

      expect(result.status).toBe(MediaMetadataStatusType.failed);
      expect(result.lastError).toBe('Provider returned null');
    });
  });
});
