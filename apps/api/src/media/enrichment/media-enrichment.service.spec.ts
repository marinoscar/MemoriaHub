import { Test, TestingModule } from '@nestjs/testing';
import { MediaEnrichmentService } from './media-enrichment.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import {
  MediaType,
  JobReason,
  MediaTagStatusType,
  MediaFaceStatusType,
} from '@prisma/client';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';

/** Minimal settings object with all three feature flags ON and video face enabled. */
function makeSettingsAllOn() {
  return {
    features: {
      autoTagging: true,
      faceRecognition: true,
      burstDetection: true,
    },
    face: { video: { enabled: true } },
  };
}

describe('MediaEnrichmentService', () => {
  let service: MediaEnrichmentService;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let mockSystemSettings: { getSettings: jest.Mock };

  const photoItem = {
    id: 'media-1',
    type: MediaType.photo,
    circleId: 'circle-1',
    deletedAt: null,
  };

  /** Helper to extract the list of enqueued job types from mock.calls */
  const enqueuedTypes = (): string[] =>
    mockEnrichmentJobService.enqueue.mock.calls.map((c: any[]) => c[0].type);

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = {
      enqueue: jest.fn().mockResolvedValue({ id: 'job-x' }),
    };
    mockSystemSettings = { getSettings: jest.fn() };

    // Default: all three features enabled, video face enabled
    mockSystemSettings.getSettings.mockResolvedValue(makeSettingsAllOn());

    mockPrisma.mediaTagStatus.upsert.mockResolvedValue({} as any);
    mockPrisma.mediaFaceStatus.upsert.mockResolvedValue({} as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaEnrichmentService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
      ],
    }).compile();

    service = module.get<MediaEnrichmentService>(MediaEnrichmentService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Restore env kill-switches changed during tests
    delete process.env['AUTO_TAG_ENABLED'];
    delete process.env['FACE_AUTO_DETECT'];
    delete process.env['BURST_DETECTION_ENABLED'];
  });

  // ---------------------------------------------------------------------------
  // enqueueUploadEnrichment
  // ---------------------------------------------------------------------------
  describe('enqueueUploadEnrichment', () => {
    describe('all three features ON', () => {
      it('enqueues auto_tagging with priority 20', async () => {
        await service.enqueueUploadEnrichment(photoItem);

        expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith({
          type: 'auto_tagging',
          mediaItemId: photoItem.id,
          circleId: photoItem.circleId,
          reason: JobReason.upload,
          priority: 20,
        });
      });

      it('enqueues face_detection with priority 10', async () => {
        await service.enqueueUploadEnrichment(photoItem);

        expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith({
          type: 'face_detection',
          mediaItemId: photoItem.id,
          circleId: photoItem.circleId,
          reason: JobReason.upload,
          priority: 10,
        });
      });

      it('enqueues burst_detection with priority 10', async () => {
        await service.enqueueUploadEnrichment(photoItem);

        expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith({
          type: 'burst_detection',
          mediaItemId: photoItem.id,
          circleId: photoItem.circleId,
          reason: JobReason.upload,
          priority: 10,
        });
      });

      it('upserts MediaTagStatus to pending with circleId in create', async () => {
        await service.enqueueUploadEnrichment(photoItem);

        expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledWith({
          where: { mediaItemId: photoItem.id },
          create: {
            mediaItemId: photoItem.id,
            circleId: photoItem.circleId,
            status: MediaTagStatusType.pending,
            tagCount: 0,
          },
          update: {
            status: MediaTagStatusType.pending,
          },
        });
      });

      it('upserts MediaFaceStatus to pending (no circleId in create)', async () => {
        await service.enqueueUploadEnrichment(photoItem);

        expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledWith({
          where: { mediaItemId: photoItem.id },
          create: {
            mediaItemId: photoItem.id,
            status: MediaFaceStatusType.pending,
            faceCount: 0,
          },
          update: {
            status: MediaFaceStatusType.pending,
          },
        });
      });

      it('does NOT upsert any status row for burst_detection', async () => {
        await service.enqueueUploadEnrichment(photoItem);

        // Only tagging and face trigger status upserts
        expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledTimes(1);
        expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledTimes(1);
        // Three enqueue calls total (tagging + face + burst)
        expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(3);
      });
    });

    // -------------------------------------------------------------------------
    // Feature-flag gating (each feature OFF independently)
    // -------------------------------------------------------------------------
    describe('feature flag gating', () => {
      it('omits auto_tagging and its status upsert when autoTagging is OFF, others still enqueue', async () => {
        mockSystemSettings.getSettings.mockResolvedValueOnce({
          features: { autoTagging: false, faceRecognition: true, burstDetection: true },
          face: { video: { enabled: true } },
        });

        await service.enqueueUploadEnrichment(photoItem);

        expect(enqueuedTypes()).not.toContain('auto_tagging');
        expect(enqueuedTypes()).toContain('face_detection');
        expect(enqueuedTypes()).toContain('burst_detection');
        expect(mockPrisma.mediaTagStatus.upsert).not.toHaveBeenCalled();
        expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledTimes(1);
      });

      it('omits face_detection and its status upsert when faceRecognition is OFF, others still enqueue', async () => {
        mockSystemSettings.getSettings.mockResolvedValueOnce({
          features: { autoTagging: true, faceRecognition: false, burstDetection: true },
          face: { video: { enabled: true } },
        });

        await service.enqueueUploadEnrichment(photoItem);

        expect(enqueuedTypes()).toContain('auto_tagging');
        expect(enqueuedTypes()).not.toContain('face_detection');
        expect(enqueuedTypes()).toContain('burst_detection');
        expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledTimes(1);
        expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
      });

      it('omits burst_detection when burstDetection is OFF, tagging and face still enqueue', async () => {
        mockSystemSettings.getSettings.mockResolvedValueOnce({
          features: { autoTagging: true, faceRecognition: true, burstDetection: false },
          face: { video: { enabled: true } },
        });

        await service.enqueueUploadEnrichment(photoItem);

        expect(enqueuedTypes()).toContain('auto_tagging');
        expect(enqueuedTypes()).toContain('face_detection');
        expect(enqueuedTypes()).not.toContain('burst_detection');
        expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledTimes(1);
        expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledTimes(1);
      });
    });

    // -------------------------------------------------------------------------
    // Non-photo / deleted guards
    // -------------------------------------------------------------------------
    it('enqueues video_face_detection (not auto_tagging or burst_detection) for a video item', async () => {
      const videoItem = { ...photoItem, type: MediaType.video };

      await service.enqueueUploadEnrichment(videoItem);

      expect(enqueuedTypes()).not.toContain('auto_tagging');
      expect(enqueuedTypes()).not.toContain('face_detection');
      expect(enqueuedTypes()).not.toContain('burst_detection');
      expect(enqueuedTypes()).toContain('video_face_detection');
      // getSettings IS called for video items (no early exit for video type)
      expect(mockSystemSettings.getSettings).toHaveBeenCalledTimes(1);
      expect(mockPrisma.mediaTagStatus.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledTimes(1);
    });

    it('skips everything for a soft-deleted item', async () => {
      const deletedItem = { ...photoItem, deletedAt: new Date() };

      await service.enqueueUploadEnrichment(deletedItem);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
      // getSettings is NOT called — early return before settings read
      expect(mockSystemSettings.getSettings).not.toHaveBeenCalled();
      expect(mockPrisma.mediaTagStatus.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // Single-read design: getSettings called exactly once per enqueue call
    // -------------------------------------------------------------------------
    it('reads settings once via getSettings per call (single DB round-trip, not per-feature-key)', async () => {
      await service.enqueueUploadEnrichment(photoItem);

      expect(mockSystemSettings.getSettings).toHaveBeenCalledTimes(1);
    });

    // -------------------------------------------------------------------------
    // Env kill-switches override a feature flag that is ON
    // -------------------------------------------------------------------------
    describe('env kill-switches', () => {
      it('skips auto_tagging when AUTO_TAG_ENABLED=false even if feature flag is ON', async () => {
        process.env['AUTO_TAG_ENABLED'] = 'false';

        await service.enqueueUploadEnrichment(photoItem);

        expect(enqueuedTypes()).not.toContain('auto_tagging');
        expect(mockPrisma.mediaTagStatus.upsert).not.toHaveBeenCalled();
        // Other jobs must still be enqueued
        expect(enqueuedTypes()).toContain('face_detection');
        expect(enqueuedTypes()).toContain('burst_detection');
      });

      it('skips face_detection when FACE_AUTO_DETECT=false even if feature flag is ON', async () => {
        process.env['FACE_AUTO_DETECT'] = 'false';

        await service.enqueueUploadEnrichment(photoItem);

        expect(enqueuedTypes()).not.toContain('face_detection');
        expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
        // Other jobs must still be enqueued
        expect(enqueuedTypes()).toContain('auto_tagging');
        expect(enqueuedTypes()).toContain('burst_detection');
      });

      it('skips burst_detection when BURST_DETECTION_ENABLED=false even if feature flag is ON', async () => {
        process.env['BURST_DETECTION_ENABLED'] = 'false';

        await service.enqueueUploadEnrichment(photoItem);

        expect(enqueuedTypes()).not.toContain('burst_detection');
        // Other jobs must still be enqueued
        expect(enqueuedTypes()).toContain('auto_tagging');
        expect(enqueuedTypes()).toContain('face_detection');
      });
    });

    // -------------------------------------------------------------------------
    // Never-throws contract
    // -------------------------------------------------------------------------
    it('resolves without throwing even when enqueue rejects', async () => {
      mockEnrichmentJobService.enqueue.mockRejectedValueOnce(
        new Error('DB connection lost'),
      );

      await expect(
        service.enqueueUploadEnrichment(photoItem),
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // enqueueForStorageObject
  // ---------------------------------------------------------------------------
  describe('enqueueForStorageObject', () => {
    it('does nothing when no MediaItem exists for the given storageObjectId', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await service.enqueueForStorageObject('storage-obj-missing');

      expect(mockPrisma.mediaItem.findUnique).toHaveBeenCalledWith({
        where: { storageObjectId: 'storage-obj-missing' },
        select: { id: true, type: true, circleId: true, deletedAt: true },
      });
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('delegates to enqueueUploadEnrichment when a MediaItem is found', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        id: 'media-found',
        type: MediaType.photo,
        circleId: 'circle-1',
        deletedAt: null,
      } as any);

      await service.enqueueForStorageObject('storage-obj-1');

      // The delegated call should enqueue all three jobs (all features are ON)
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(3);
      expect(enqueuedTypes()).toContain('auto_tagging');
      expect(enqueuedTypes()).toContain('face_detection');
      expect(enqueuedTypes()).toContain('burst_detection');
    });
  });
});
