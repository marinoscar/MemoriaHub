/**
 * Unit tests for SocialMediaBackfillService — mirrors FaceBackfillService's spec
 * structure (see face/face-backfill.service.spec.ts), adapted for the
 * video-only `social_media_detection` job type.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { JobReason, MediaSocialStatusType, MediaType } from '@prisma/client';
import { SocialMediaBackfillService } from './social-media-backfill.service';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

describe('SocialMediaBackfillService', () => {
  let service: SocialMediaBackfillService;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: { enqueue: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1', status: 'pending' }) };

    (mockPrisma.mediaSocialStatus.upsert as jest.Mock).mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SocialMediaBackfillService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
      ],
    }).compile();

    service = module.get<SocialMediaBackfillService>(SocialMediaBackfillService);
  });

  // ---------------------------------------------------------------------------
  // backfillCircle
  // ---------------------------------------------------------------------------
  describe('backfillCircle', () => {
    const CIRCLE_ID = 'circle-1';

    describe('base filters always present', () => {
      it('includes circleId, type=video (not photo), and deletedAt null', async () => {
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

        await service.backfillCircle(CIRCLE_ID, {});

        const [callArgs] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
        const where = callArgs[0].where;

        expect(where.circleId).toBe(CIRCLE_ID);
        expect(where.type).toBe(MediaType.video);
        expect(where.deletedAt).toBeNull();
      });
    });

    describe('date range in findMany where', () => {
      it('includes capturedAt gte and lte when both from and to are provided', async () => {
        const fromStr = '2024-01-01T00:00:00.000Z';
        const toStr = '2024-12-31T23:59:59.000Z';

        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

        await service.backfillCircle(CIRCLE_ID, { from: fromStr, to: toStr });

        const [callArgs] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
        const where = callArgs[0].where;

        expect(where.capturedAt).toEqual({ gte: new Date(fromStr), lte: new Date(toStr) });
      });

      it('omits capturedAt entirely when neither from nor to is provided', async () => {
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

        await service.backfillCircle(CIRCLE_ID, {});

        const [callArgs] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
        const where = callArgs[0].where;

        expect(where).not.toHaveProperty('capturedAt');
      });
    });

    describe('force flag changes status filter', () => {
      it('includes an OR status filter (socialStatus null OR not processed) when force is false', async () => {
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

        await service.backfillCircle(CIRCLE_ID, { force: false });

        const [callArgs] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
        const where = callArgs[0].where;

        expect(where.OR).toEqual(
          expect.arrayContaining([
            { socialStatus: null },
            expect.objectContaining({
              socialStatus: expect.objectContaining({
                status: expect.objectContaining({ not: MediaSocialStatusType.processed }),
              }),
            }),
          ]),
        );
      });

      it('includes the OR status filter when force is omitted (defaults false)', async () => {
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

        await service.backfillCircle(CIRCLE_ID, {});

        const [callArgs] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
        expect(callArgs[0].where.OR).toBeDefined();
      });

      it('omits the OR status filter when force is true', async () => {
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

        await service.backfillCircle(CIRCLE_ID, { force: true });

        const [callArgs] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
        expect(callArgs[0].where).not.toHaveProperty('OR');
      });
    });

    describe('enqueuing and status upsert', () => {
      it('enqueues a social_media_detection backfill job (priority 100) for each matched item', async () => {
        const items = [
          { id: 'item-1', circleId: CIRCLE_ID },
          { id: 'item-2', circleId: CIRCLE_ID },
        ];
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(items);

        const count = await service.backfillCircle(CIRCLE_ID, {});

        expect(count).toBe(2);
        expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(2);
        expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'social_media_detection',
            mediaItemId: 'item-1',
            circleId: CIRCLE_ID,
            reason: JobReason.backfill,
            priority: 100,
          }),
        );
        expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'social_media_detection',
            mediaItemId: 'item-2',
            circleId: CIRCLE_ID,
            reason: JobReason.backfill,
            priority: 100,
          }),
        );
      });

      it('upserts MediaSocialStatus to pending for each matched item', async () => {
        const items = [{ id: 'item-1', circleId: CIRCLE_ID }];
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(items);

        await service.backfillCircle(CIRCLE_ID, {});

        expect(mockPrisma.mediaSocialStatus.upsert).toHaveBeenCalledWith({
          where: { mediaItemId: 'item-1' },
          create: { mediaItemId: 'item-1', status: MediaSocialStatusType.pending },
          update: { status: MediaSocialStatusType.pending },
        });
      });

      it('returns 0 and skips enqueue/upsert when no items match', async () => {
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

        const count = await service.backfillCircle(CIRCLE_ID, {});

        expect(count).toBe(0);
        expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
        expect(mockPrisma.mediaSocialStatus.upsert).not.toHaveBeenCalled();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // backfillAllCircles
  // ---------------------------------------------------------------------------
  describe('backfillAllCircles', () => {
    it('processes all circles and returns total enqueued count plus circle count', async () => {
      (mockPrisma.circle.findMany as jest.Mock).mockResolvedValue([
        { id: 'circle-a' },
        { id: 'circle-b' },
      ]);
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'item-1', circleId: 'circle-a' },
          { id: 'item-2', circleId: 'circle-a' },
        ])
        .mockResolvedValueOnce([{ id: 'item-3', circleId: 'circle-b' }]);

      const result = await service.backfillAllCircles({});

      expect(result).toEqual({ enqueued: 3, circles: 2 });
    });

    it('forwards from/to/force into every circle backfillCircle call', async () => {
      (mockPrisma.circle.findMany as jest.Mock).mockResolvedValue([{ id: 'circle-a' }]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.backfillAllCircles({ from: '2024-01-01', to: '2024-12-31', force: true });

      const [callArgs] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      const where = callArgs[0].where;
      expect(where.capturedAt).toEqual({
        gte: new Date('2024-01-01'),
        lte: new Date('2024-12-31'),
      });
      expect(where).not.toHaveProperty('OR');
    });

    it('returns { enqueued: 0, circles: 0 } and skips mediaItem.findMany when no circles exist', async () => {
      (mockPrisma.circle.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.backfillAllCircles({});

      expect(result).toEqual({ enqueued: 0, circles: 0 });
      expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // enqueueRerun
  // ---------------------------------------------------------------------------
  describe('enqueueRerun', () => {
    it('enqueues a priority-0 rerun job and upserts MediaSocialStatus to pending', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        id: 'item-1',
        circleId: 'circle-1',
        deletedAt: null,
      });

      const result = await service.enqueueRerun('item-1', 'user-1');

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith({
        type: 'social_media_detection',
        mediaItemId: 'item-1',
        circleId: 'circle-1',
        reason: JobReason.rerun,
        priority: 0,
      });
      expect(mockPrisma.mediaSocialStatus.upsert).toHaveBeenCalledWith({
        where: { mediaItemId: 'item-1' },
        create: { mediaItemId: 'item-1', status: MediaSocialStatusType.pending },
        update: { status: MediaSocialStatusType.pending },
      });
      expect(result).toEqual({ jobId: 'job-1', status: 'pending' });
    });

    it('throws NotFoundException when the media item does not exist', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.enqueueRerun('missing-item', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the media item is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        id: 'item-1',
        circleId: 'circle-1',
        deletedAt: new Date(),
      });

      await expect(service.enqueueRerun('item-1', 'user-1')).rejects.toThrow(NotFoundException);
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // getStatus
  // ---------------------------------------------------------------------------
  describe('getStatus', () => {
    it('returns a synthetic not_processed record when no status row exists', async () => {
      (mockPrisma.mediaSocialStatus.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.getStatus('item-1');

      expect(result).toEqual({
        status: 'not_processed',
        isSocialMedia: false,
        platform: null,
        detectionMethod: null,
        confidence: null,
        matchedRule: null,
        processedAt: null,
        lastError: null,
      });
    });

    it('returns the persisted status row fields when one exists', async () => {
      const processedAt = new Date();
      (mockPrisma.mediaSocialStatus.findUnique as jest.Mock).mockResolvedValue({
        status: MediaSocialStatusType.processed,
        isSocialMedia: true,
        platform: 'tiktok',
        detectionMethod: 'filename',
        confidence: 0.95,
        matchedRule: 'tt-fn-downloader',
        processedAt,
        lastError: null,
      });

      const result = await service.getStatus('item-1');

      expect(result).toEqual({
        status: MediaSocialStatusType.processed,
        isSocialMedia: true,
        platform: 'tiktok',
        detectionMethod: 'filename',
        confidence: 0.95,
        matchedRule: 'tt-fn-downloader',
        processedAt,
        lastError: null,
      });
    });
  });
});
