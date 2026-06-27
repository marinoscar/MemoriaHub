import { Test, TestingModule } from '@nestjs/testing';
import { JobReason, MediaFaceStatusType, MediaType } from '@prisma/client';
import { FaceBackfillService } from './face-backfill.service';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

describe('FaceBackfillService', () => {
  let service: FaceBackfillService;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: { enqueue: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FaceBackfillService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
      ],
    }).compile();

    service = module.get<FaceBackfillService>(FaceBackfillService);
  });

  // ---------------------------------------------------------------------------
  // backfillCircle — date range constraints
  // ---------------------------------------------------------------------------

  describe('backfillCircle', () => {
    const CIRCLE_ID = 'circle-1';

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

      it('includes only capturedAt gte (no lte) when only from is provided', async () => {
        const fromStr = '2024-06-01T00:00:00.000Z';

        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

        await service.backfillCircle(CIRCLE_ID, { from: fromStr });

        const [callArgs] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
        const where = callArgs[0].where;

        expect(where.capturedAt).toEqual({ gte: new Date(fromStr) });
        expect(where.capturedAt).not.toHaveProperty('lte');
      });

      it('omits capturedAt entirely when neither from nor to is provided', async () => {
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

        await service.backfillCircle(CIRCLE_ID, {});

        const [callArgs] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
        const where = callArgs[0].where;

        expect(where).not.toHaveProperty('capturedAt');
      });
    });

    describe('base filters always present', () => {
      it('includes circleId, type photo, and deletedAt null regardless of date opts', async () => {
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

        await service.backfillCircle(CIRCLE_ID, { from: '2024-01-01', to: '2024-12-31' });

        const [callArgs] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
        const where = callArgs[0].where;

        expect(where.circleId).toBe(CIRCLE_ID);
        expect(where.type).toBe(MediaType.photo);
        expect(where.deletedAt).toBeNull();
      });
    });

    describe('force flag changes status filter', () => {
      it('includes OR status filter when force is false', async () => {
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

        await service.backfillCircle(CIRCLE_ID, { force: false });

        const [callArgs] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
        const where = callArgs[0].where;

        expect(where.OR).toBeDefined();
        expect(where.OR).toEqual(
          expect.arrayContaining([
            { faceStatus: null },
            expect.objectContaining({
              faceStatus: expect.objectContaining({
                status: expect.objectContaining({
                  notIn: expect.arrayContaining([
                    MediaFaceStatusType.processed,
                    MediaFaceStatusType.no_faces,
                  ]),
                }),
              }),
            }),
          ]),
        );
      });

      it('includes OR status filter when force is omitted (defaults false)', async () => {
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

        await service.backfillCircle(CIRCLE_ID, {});

        const [callArgs] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
        const where = callArgs[0].where;

        expect(where.OR).toBeDefined();
      });

      it('omits OR status filter when force is true', async () => {
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

        await service.backfillCircle(CIRCLE_ID, { force: true });

        const [callArgs] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
        const where = callArgs[0].where;

        expect(where).not.toHaveProperty('OR');
      });
    });

    describe('enqueuing and status upsert', () => {
      it('enqueues a face_detection backfill job for each matched item', async () => {
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
            type: 'face_detection',
            mediaItemId: 'item-1',
            circleId: CIRCLE_ID,
            reason: JobReason.backfill,
          }),
        );
        expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'face_detection',
            mediaItemId: 'item-2',
            circleId: CIRCLE_ID,
            reason: JobReason.backfill,
          }),
        );
      });

      it('upserts MediaFaceStatus to pending for each matched item', async () => {
        const items = [
          { id: 'item-1', circleId: CIRCLE_ID },
          { id: 'item-2', circleId: CIRCLE_ID },
        ];
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(items);

        await service.backfillCircle(CIRCLE_ID, {});

        expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledTimes(2);
        expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            create: expect.objectContaining({ status: MediaFaceStatusType.pending }),
            update: expect.objectContaining({ status: MediaFaceStatusType.pending }),
          }),
        );
      });

      it('returns 0 and skips enqueue and upsert when no items match', async () => {
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

        const count = await service.backfillCircle(CIRCLE_ID, {});

        expect(count).toBe(0);
        expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
        expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
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

      // circle-a yields 2 items; circle-b yields 1 item
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'item-1', circleId: 'circle-a' },
          { id: 'item-2', circleId: 'circle-a' },
        ])
        .mockResolvedValueOnce([{ id: 'item-3', circleId: 'circle-b' }]);

      const result = await service.backfillAllCircles({ from: '2024-01-01', to: '2024-12-31' });

      expect(result).toEqual({ enqueued: 3, circles: 2 });
    });

    it('forwards from and to as a date-range constraint into every circle findMany', async () => {
      const fromStr = '2024-03-01T00:00:00.000Z';
      const toStr = '2024-09-30T23:59:59.000Z';

      (mockPrisma.circle.findMany as jest.Mock).mockResolvedValue([
        { id: 'circle-a' },
        { id: 'circle-b' },
      ]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.backfillAllCircles({ from: fromStr, to: toStr });

      const findManyCalls = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;

      expect(findManyCalls).toHaveLength(2);
      for (const callArgs of findManyCalls) {
        const where = callArgs[0].where;
        expect(where.capturedAt).toEqual({ gte: new Date(fromStr), lte: new Date(toStr) });
      }
    });

    it('forwards force: true so neither circle findMany includes an OR status filter', async () => {
      (mockPrisma.circle.findMany as jest.Mock).mockResolvedValue([
        { id: 'circle-a' },
        { id: 'circle-b' },
      ]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.backfillAllCircles({ force: true });

      const findManyCalls = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;

      expect(findManyCalls).toHaveLength(2);
      for (const callArgs of findManyCalls) {
        expect(callArgs[0].where).not.toHaveProperty('OR');
      }
    });

    it('returns { enqueued: 0, circles: 0 } and skips mediaItem.findMany when no circles exist', async () => {
      (mockPrisma.circle.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.backfillAllCircles({});

      expect(result).toEqual({ enqueued: 0, circles: 0 });
      expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
    });
  });
});
