/**
 * Unit tests for FaceEnqueueListener.
 *
 * Tests: enqueue on photo upload, idempotency (delegated to EnrichmentJobService),
 * type guard (video skip), null mediaItem, soft-deleted mediaItem, FACE_AUTO_DETECT=false.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { FaceEnqueueListener } from './face-enqueue.listener';
import { PrismaService } from '../../prisma/prisma.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import { JobReason, JobStatus, MediaFaceStatusType, MediaType } from '@prisma/client';
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
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let mockSystemSettings: { isFeatureEnabled: jest.Mock };
  let originalAutoDetect: string | undefined;

  beforeEach(async () => {
    originalAutoDetect = process.env['FACE_AUTO_DETECT'];
    // Default: auto-detect enabled
    delete process.env['FACE_AUTO_DETECT'];

    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = { enqueue: jest.fn() };
    mockSystemSettings = { isFeatureEnabled: jest.fn().mockResolvedValue(true) };

    // Default: enqueue returns a pending job
    mockEnrichmentJobService.enqueue.mockResolvedValue({
      id: 'job-1',
      mediaItemId: 'media-1',
      circleId: 'circle-1',
      status: JobStatus.pending,
      reason: JobReason.upload,
      attempts: 0,
    });
    // Default: status upsert succeeds
    (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FaceEnqueueListener,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
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
    it('calls enrichmentJobService.enqueue and upserts MediaFaceStatus to pending', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'face_detection',
          mediaItemId: 'media-1',
          circleId: 'circle-1',
          reason: JobReason.upload,
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
  // Idempotency: handled by EnrichmentJobService internally
  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    it('still calls enrichmentJobService.enqueue (service handles dedup internally)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      // Service returns existing job when one already exists
      mockEnrichmentJobService.enqueue.mockResolvedValue({
        id: 'existing-job',
        status: JobStatus.pending,
      });

      await listener.handleObjectProcessed(makeEvent());

      // Listener always delegates to the service; service decides to skip or create
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Type guard: video
  // -------------------------------------------------------------------------

  describe('non-photo media type', () => {
    it('does NOT call enrichmentJobService.enqueue for video media items', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ type: MediaType.video }),
      );

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // MediaItem not found
  // -------------------------------------------------------------------------

  describe('mediaItem not found', () => {
    it('does NOT call enrichmentJobService.enqueue when no mediaItem exists for the storageObject', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Soft-deleted mediaItem
  // -------------------------------------------------------------------------

  describe('soft-deleted mediaItem', () => {
    it('does NOT call enrichmentJobService.enqueue when mediaItem has deletedAt set', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // FACE_AUTO_DETECT=false
  // -------------------------------------------------------------------------

  describe('FACE_AUTO_DETECT=false', () => {
    it('does NOT call enrichmentJobService.enqueue when FACE_AUTO_DETECT is explicitly false', async () => {
      process.env['FACE_AUTO_DETECT'] = 'false';
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });

    it('DOES call enrichmentJobService.enqueue when FACE_AUTO_DETECT=true (default)', async () => {
      process.env['FACE_AUTO_DETECT'] = 'true';
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // isFeatureEnabled global system-settings gate
  // -------------------------------------------------------------------------

  describe('isFeatureEnabled (system settings gate)', () => {
    it('does NOT enqueue when isFeatureEnabled returns false', async () => {
      mockSystemSettings.isFeatureEnabled.mockResolvedValue(false);
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });

    it('DOES enqueue when isFeatureEnabled returns true', async () => {
      mockSystemSettings.isFeatureEnabled.mockResolvedValue(true);
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(1);
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

});
