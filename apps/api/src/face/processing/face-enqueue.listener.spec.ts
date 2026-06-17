/**
 * Unit tests for FaceEnqueueListener.
 *
 * Tests: enqueue on photo upload, idempotency, type guard (video skip),
 * null mediaItem, soft-deleted mediaItem, FACE_AUTO_DETECT=false.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { FaceEnqueueListener } from './face-enqueue.listener';
import { PrismaService } from '../../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import { FaceJobReason, FaceJobStatus, MediaFaceStatusType, MediaType } from '@prisma/client';
import { ObjectProcessedEvent } from '../../storage/processing/events/object-processed.event';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMediaItem(overrides: Partial<{
  id: string;
  circleId: string;
  type: MediaType;
  deletedAt: Date | null;
}> = {}) {
  return {
    id: 'media-1',
    circleId: 'circle-1',
    type: MediaType.photo,
    deletedAt: null,
    ...overrides,
  };
}

function makeEvent(storageObjectId = 'storage-obj-1'): ObjectProcessedEvent {
  return { storageObjectId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FaceEnqueueListener', () => {
  let listener: FaceEnqueueListener;
  let mockPrisma: MockPrismaService;
  let originalAutoDetect: string | undefined;

  beforeEach(async () => {
    originalAutoDetect = process.env['FACE_AUTO_DETECT'];
    // Default: auto-detect enabled
    delete process.env['FACE_AUTO_DETECT'];

    mockPrisma = createMockPrismaService();

    // Default: no existing jobs
    (mockPrisma.faceJob.findFirst as jest.Mock).mockResolvedValue(null);
    // Default: job creation succeeds
    (mockPrisma.faceJob.create as jest.Mock).mockResolvedValue({
      id: 'job-1',
      mediaItemId: 'media-1',
      circleId: 'circle-1',
      status: FaceJobStatus.pending,
      reason: FaceJobReason.upload,
      attempts: 0,
    });
    // Default: status upsert succeeds
    (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mockResolvedValue({});
    // Default: circle has faceRecognitionEnabled=true
    (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ faceRecognitionEnabled: true });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FaceEnqueueListener,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    listener = module.get<FaceEnqueueListener>(FaceEnqueueListener);
  });

  afterEach(() => {
    if (originalAutoDetect === undefined) {
      delete process.env['FACE_AUTO_DETECT'];
    } else {
      process.env['FACE_AUTO_DETECT'] = originalAutoDetect;
    }
  });

  // -------------------------------------------------------------------------
  // Happy path: photo media item
  // -------------------------------------------------------------------------

  describe('photo media item', () => {
    it('creates a FaceJob and upserts MediaFaceStatus to pending', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await listener.handleObjectProcessed(makeEvent());

      expect(mockPrisma.faceJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            mediaItemId: 'media-1',
            circleId: 'circle-1',
            status: FaceJobStatus.pending,
            reason: FaceJobReason.upload,
            attempts: 0,
          }),
        }),
      );

      expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { mediaItemId: 'media-1' },
          create: expect.objectContaining({ status: MediaFaceStatusType.pending }),
          update: expect.objectContaining({ status: MediaFaceStatusType.pending }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency: existing pending/running job
  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    it('does NOT create a new FaceJob when a pending job already exists', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.faceJob.findFirst as jest.Mock).mockResolvedValue({
        id: 'existing-job',
        status: FaceJobStatus.pending,
      });

      await listener.handleObjectProcessed(makeEvent());

      expect(mockPrisma.faceJob.create).not.toHaveBeenCalled();
    });

    it('does NOT create a new FaceJob when a running job already exists', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.faceJob.findFirst as jest.Mock).mockResolvedValue({
        id: 'existing-job',
        status: FaceJobStatus.running,
      });

      await listener.handleObjectProcessed(makeEvent());

      expect(mockPrisma.faceJob.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Type guard: video
  // -------------------------------------------------------------------------

  describe('non-photo media type', () => {
    it('does NOT create a FaceJob for video media items', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ type: MediaType.video }),
      );

      await listener.handleObjectProcessed(makeEvent());

      expect(mockPrisma.faceJob.create).not.toHaveBeenCalled();
      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // MediaItem not found
  // -------------------------------------------------------------------------

  describe('mediaItem not found', () => {
    it('does NOT create a FaceJob when no mediaItem exists for the storageObject', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await listener.handleObjectProcessed(makeEvent());

      expect(mockPrisma.faceJob.create).not.toHaveBeenCalled();
      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Soft-deleted mediaItem
  // -------------------------------------------------------------------------

  describe('soft-deleted mediaItem', () => {
    it('does NOT create a FaceJob when mediaItem has deletedAt set', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await listener.handleObjectProcessed(makeEvent());

      expect(mockPrisma.faceJob.create).not.toHaveBeenCalled();
      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // FACE_AUTO_DETECT=false
  // -------------------------------------------------------------------------

  describe('FACE_AUTO_DETECT=false', () => {
    it('does NOT create a FaceJob when FACE_AUTO_DETECT is explicitly false', async () => {
      process.env['FACE_AUTO_DETECT'] = 'false';
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await listener.handleObjectProcessed(makeEvent());

      expect(mockPrisma.faceJob.create).not.toHaveBeenCalled();
      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });

    it('DOES create a FaceJob when FACE_AUTO_DETECT=true (default)', async () => {
      process.env['FACE_AUTO_DETECT'] = 'true';
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await listener.handleObjectProcessed(makeEvent());

      expect(mockPrisma.faceJob.create).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling: exceptions inside handleObjectProcessed do NOT rethrow
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('does NOT rethrow errors from enqueueForObject (swallows exceptions)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockRejectedValue(new Error('DB error'));

      // Should not throw — listener swallows errors to avoid blocking event emission
      await expect(listener.handleObjectProcessed(makeEvent())).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // per-circle faceRecognitionEnabled gate
  // -------------------------------------------------------------------------

  describe('per-circle faceRecognitionEnabled gate', () => {
    it('does NOT enqueue when circle faceRecognitionEnabled is false', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ faceRecognitionEnabled: false });
      await listener.handleObjectProcessed(makeEvent());
      expect(mockPrisma.faceJob.create).not.toHaveBeenCalled();
      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });

    it('does NOT enqueue when circle is null', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(null);
      await listener.handleObjectProcessed(makeEvent());
      expect(mockPrisma.faceJob.create).not.toHaveBeenCalled();
    });

    it('DOES enqueue when circle faceRecognitionEnabled is true and FACE_AUTO_DETECT is true', async () => {
      process.env['FACE_AUTO_DETECT'] = 'true';
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ faceRecognitionEnabled: true });
      await listener.handleObjectProcessed(makeEvent());
      expect(mockPrisma.faceJob.create).toHaveBeenCalledTimes(1);
    });
  });
});
