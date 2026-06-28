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
  MediaSocialStatusType,
} from '@prisma/client';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helper: build a minimal settings object returned by getSettings()
// ---------------------------------------------------------------------------
function makeSettings(featureOverrides: Record<string, boolean> = {}, faceVideoEnabled = true) {
  return {
    features: {
      autoTagging: true,
      faceRecognition: true,
      burstDetection: true,
      socialMediaDetection: false, // off by default so photo tests are unaffected
      ...featureOverrides,
    },
    face: {
      video: { enabled: faceVideoEnabled },
    },
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

  const videoItem = {
    id: 'media-v',
    type: MediaType.video,
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
    // Default: all three classic features enabled; socialMediaDetection off
    mockSystemSettings = {
      getSettings: jest.fn().mockResolvedValue(makeSettings()),
    };

    mockPrisma.mediaTagStatus.upsert.mockResolvedValue({} as any);
    mockPrisma.mediaFaceStatus.upsert.mockResolvedValue({} as any);
    mockPrisma.mediaSocialStatus.upsert.mockResolvedValue({} as any);

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
    delete process.env['SOCIAL_MEDIA_DETECTION_ENABLED'];
  });

  // ---------------------------------------------------------------------------
  // enqueueUploadEnrichment
  // ---------------------------------------------------------------------------
  describe('enqueueUploadEnrichment', () => {
    describe('all three classic features ON (photo item)', () => {
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

      it('does NOT enqueue social_media_detection for a photo even when flag is ON', async () => {
        // socialMediaDetection=true but item is a photo → no social job
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({ socialMediaDetection: true }),
        );

        await service.enqueueUploadEnrichment(photoItem);

        expect(enqueuedTypes()).not.toContain('social_media_detection');
      });
    });

    // -------------------------------------------------------------------------
    // Feature-flag gating (each feature OFF independently)
    // -------------------------------------------------------------------------
    describe('feature flag gating', () => {
      it('omits auto_tagging and its status upsert when autoTagging is OFF, others still enqueue', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({ autoTagging: false }),
        );

        await service.enqueueUploadEnrichment(photoItem);

        expect(enqueuedTypes()).not.toContain('auto_tagging');
        expect(enqueuedTypes()).toContain('face_detection');
        expect(enqueuedTypes()).toContain('burst_detection');
        expect(mockPrisma.mediaTagStatus.upsert).not.toHaveBeenCalled();
        expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledTimes(1);
      });

      it('omits face_detection and its status upsert when faceRecognition is OFF, others still enqueue', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({ faceRecognition: false }),
        );

        await service.enqueueUploadEnrichment(photoItem);

        expect(enqueuedTypes()).toContain('auto_tagging');
        expect(enqueuedTypes()).not.toContain('face_detection');
        expect(enqueuedTypes()).toContain('burst_detection');
        expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledTimes(1);
        expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
      });

      it('omits burst_detection when burstDetection is OFF, tagging and face still enqueue', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({ burstDetection: false }),
        );

        await service.enqueueUploadEnrichment(photoItem);

        expect(enqueuedTypes()).toContain('auto_tagging');
        expect(enqueuedTypes()).toContain('face_detection');
        expect(enqueuedTypes()).not.toContain('burst_detection');
        expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledTimes(1);
        expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledTimes(1);
      });
    });

    // -------------------------------------------------------------------------
    // Soft-deleted guard
    // -------------------------------------------------------------------------
    it('skips everything for a soft-deleted item', async () => {
      const deletedItem = { ...photoItem, deletedAt: new Date() };

      await service.enqueueUploadEnrichment(deletedItem);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
      expect(mockSystemSettings.getSettings).not.toHaveBeenCalled();
      expect(mockPrisma.mediaTagStatus.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // Single-read design: getSettings called exactly once per enqueue call
    // -------------------------------------------------------------------------
    it('calls getSettings exactly once regardless of number of jobs', async () => {
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

    // =========================================================================
    // Social media detection — video path (new)
    // =========================================================================
    describe('social_media_detection — video item', () => {
      it('enqueues social_media_detection with priority 15 when flag is ON and item is a video', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({ socialMediaDetection: true }),
        );

        await service.enqueueUploadEnrichment(videoItem);

        expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith({
          type: 'social_media_detection',
          mediaItemId: videoItem.id,
          circleId: videoItem.circleId,
          reason: JobReason.upload,
          priority: 15,
        });
      });

      it('upserts MediaSocialStatus to pending when social job is enqueued', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({ socialMediaDetection: true }),
        );

        await service.enqueueUploadEnrichment(videoItem);

        expect(mockPrisma.mediaSocialStatus.upsert).toHaveBeenCalledWith({
          where: { mediaItemId: videoItem.id },
          create: {
            mediaItemId: videoItem.id,
            circleId: videoItem.circleId,
            status: MediaSocialStatusType.pending,
            detected: false,
          },
          update: {
            status: MediaSocialStatusType.pending,
          },
        });
      });

      it('does NOT enqueue social_media_detection when socialMediaDetection flag is OFF', async () => {
        // Default settings have socialMediaDetection: false
        await service.enqueueUploadEnrichment(videoItem);

        expect(enqueuedTypes()).not.toContain('social_media_detection');
        expect(mockPrisma.mediaSocialStatus.upsert).not.toHaveBeenCalled();
      });

      it('does NOT enqueue social_media_detection when SOCIAL_MEDIA_DETECTION_ENABLED env kill-switch is false', async () => {
        process.env['SOCIAL_MEDIA_DETECTION_ENABLED'] = 'false';
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({ socialMediaDetection: true }),
        );

        await service.enqueueUploadEnrichment(videoItem);

        expect(enqueuedTypes()).not.toContain('social_media_detection');
        expect(mockPrisma.mediaSocialStatus.upsert).not.toHaveBeenCalled();
      });

      it('does NOT enqueue social_media_detection for a photo even when flag is ON', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({ socialMediaDetection: true }),
        );

        await service.enqueueUploadEnrichment(photoItem);

        expect(enqueuedTypes()).not.toContain('social_media_detection');
      });

      it('video + social ON: does NOT enqueue video_face_detection at upload (social gate defers it)', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({ socialMediaDetection: true }),
        );

        await service.enqueueUploadEnrichment(videoItem);

        // social gate is active → video_face_detection is DEFERRED
        expect(enqueuedTypes()).not.toContain('video_face_detection');
        expect(enqueuedTypes()).toContain('social_media_detection');
        // auto_tagging and burst_detection are photo-only
        expect(enqueuedTypes()).not.toContain('auto_tagging');
        expect(enqueuedTypes()).not.toContain('burst_detection');
      });

      it('video + social OFF: enqueues video_face_detection immediately at upload', async () => {
        // socialMediaDetection=false (default settings), faceRecognition=true
        // → social gate is NOT active → video_face_detection enqueued immediately
        await service.enqueueUploadEnrichment(videoItem);

        expect(enqueuedTypes()).toContain('video_face_detection');
        expect(enqueuedTypes()).not.toContain('social_media_detection');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // enqueueVideoFaceIfEligible
  // ---------------------------------------------------------------------------
  describe('enqueueVideoFaceIfEligible', () => {
    const videoItem = {
      id: 'media-v2',
      type: MediaType.video,
      circleId: 'circle-1',
      deletedAt: null,
    };

    it('enqueues video_face_detection and upserts MediaFaceStatus when all conditions met', async () => {
      // Default settings: faceRecognition=true, face.video.enabled=true
      await service.enqueueVideoFaceIfEligible(videoItem);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith({
        type: 'video_face_detection',
        mediaItemId: videoItem.id,
        circleId: videoItem.circleId,
        reason: JobReason.upload,
        priority: 20,
      });

      expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledWith({
        where: { mediaItemId: videoItem.id },
        create: {
          mediaItemId: videoItem.id,
          status: MediaFaceStatusType.pending,
          faceCount: 0,
        },
        update: {
          status: MediaFaceStatusType.pending,
        },
      });
    });

    it('does nothing for a photo item (type guard)', async () => {
      const photoItem = { id: 'media-p', type: MediaType.photo, circleId: 'circle-1', deletedAt: null };

      await service.enqueueVideoFaceIfEligible(photoItem);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('does nothing for a soft-deleted item', async () => {
      const deletedVideo = { ...videoItem, deletedAt: new Date() };

      await service.enqueueVideoFaceIfEligible(deletedVideo);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('does nothing when faceRecognition feature flag is OFF', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ faceRecognition: false }),
      );

      await service.enqueueVideoFaceIfEligible(videoItem);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('does nothing when FACE_AUTO_DETECT=false (env kill-switch)', async () => {
      process.env['FACE_AUTO_DETECT'] = 'false';

      await service.enqueueVideoFaceIfEligible(videoItem);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('does nothing when face.video.enabled=false in settings', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({}, false /* faceVideoEnabled = false */),
      );

      await service.enqueueVideoFaceIfEligible(videoItem);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
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

    it('delegates to enqueueUploadEnrichment when a photo MediaItem is found (3 jobs)', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        id: 'media-found',
        type: MediaType.photo,
        circleId: 'circle-1',
        deletedAt: null,
      } as any);

      await service.enqueueForStorageObject('storage-obj-1');

      // The delegated call should enqueue all three photo jobs (all features are ON)
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(3);
      expect(enqueuedTypes()).toContain('auto_tagging');
      expect(enqueuedTypes()).toContain('face_detection');
      expect(enqueuedTypes()).toContain('burst_detection');
    });
  });
});
