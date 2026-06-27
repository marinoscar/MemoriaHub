/**
 * Unit tests for MediaEnrichmentService — video face detection routing.
 *
 * Focus: the `video_face_detection` routing paths added in the video face
 * detection feature.  The existing spec file covers photo paths; this file
 * extends coverage to the video branch.
 *
 * Real service implementation uses `systemSettings.getSettings()` which
 * returns a full settings object.  We mock `SystemSettingsService` to return
 * a settings object with any combination of flags.
 *
 * Cases:
 *  1. Video item + faceRecognition ON + face.video.enabled ON
 *       → enqueues video_face_detection (priority 20), upserts MediaFaceStatus.
 *       → does NOT enqueue auto_tagging or burst_detection for a video.
 *  2. Video item + faceRecognition OFF + face.video.enabled ON
 *       → does NOT enqueue video_face_detection.
 *  3. Video item + faceRecognition ON + face.video.enabled FALSE
 *       → does NOT enqueue video_face_detection.
 *  4. Video item + FACE_AUTO_DETECT=false env kill-switch
 *       → does NOT enqueue video_face_detection.
 *  5. Photo item + faceRecognition ON + face.video.enabled ON
 *       → enqueues face_detection (NOT video_face_detection).
 *  6. Soft-deleted video item
 *       → enqueues nothing.
 *  7. video_face_detection uses priority 20 (higher number = lower priority,
 *     so photo face_detection at 10 drains first).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MediaEnrichmentService } from './media-enrichment.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { MediaType, JobReason, MediaFaceStatusType } from '@prisma/client';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal settings object understood by MediaEnrichmentService */
function makeSettings(opts: {
  faceRecognition?: boolean;
  autoTagging?: boolean;
  burstDetection?: boolean;
  videoEnabled?: boolean;
} = {}) {
  return {
    features: {
      autoTagging: opts.autoTagging ?? false,
      faceRecognition: opts.faceRecognition ?? true,
      burstDetection: opts.burstDetection ?? false,
    },
    face: {
      video: {
        enabled: opts.videoEnabled ?? true,
        sampleIntervalSeconds: 5,
        maxFramesPerVideo: 60,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('MediaEnrichmentService — video_face_detection routing', () => {
  let service: MediaEnrichmentService;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let mockSystemSettings: { getSettings: jest.Mock };

  const videoItem = {
    id: 'media-v1',
    type: MediaType.video,
    circleId: 'circle-1',
    deletedAt: null,
  };

  const photoItem = {
    id: 'media-p1',
    type: MediaType.photo,
    circleId: 'circle-1',
    deletedAt: null,
  };

  /** Return the list of job types passed to enqueue.  */
  const enqueuedTypes = (): string[] =>
    mockEnrichmentJobService.enqueue.mock.calls.map((c: any[]) => c[0].type as string);

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = {
      enqueue: jest.fn().mockResolvedValue({ id: 'job-x' }),
    };
    mockSystemSettings = {
      getSettings: jest.fn().mockResolvedValue(makeSettings()),
    };

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
    delete process.env['FACE_AUTO_DETECT'];
    delete process.env['AUTO_TAG_ENABLED'];
    delete process.env['BURST_DETECTION_ENABLED'];
  });

  // -----------------------------------------------------------------------
  // 1. Happy path: video + faceRecognition ON + face.video.enabled ON
  // -----------------------------------------------------------------------
  describe('video item with faceRecognition and face.video.enabled ON', () => {
    beforeEach(() => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ faceRecognition: true, videoEnabled: true }),
      );
    });

    it('enqueues video_face_detection', async () => {
      await service.enqueueUploadEnrichment(videoItem);
      expect(enqueuedTypes()).toContain('video_face_detection');
    });

    it('enqueues video_face_detection with priority 20', async () => {
      await service.enqueueUploadEnrichment(videoItem);
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'video_face_detection',
          priority: 20,
          reason: JobReason.upload,
          mediaItemId: videoItem.id,
          circleId: videoItem.circleId,
        }),
      );
    });

    it('upserts MediaFaceStatus to pending', async () => {
      await service.enqueueUploadEnrichment(videoItem);
      expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { mediaItemId: videoItem.id },
          create: expect.objectContaining({ status: MediaFaceStatusType.pending }),
          update: expect.objectContaining({ status: MediaFaceStatusType.pending }),
        }),
      );
    });

    it('does NOT enqueue auto_tagging for a video', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ faceRecognition: true, autoTagging: true, videoEnabled: true }),
      );
      await service.enqueueUploadEnrichment(videoItem);
      expect(enqueuedTypes()).not.toContain('auto_tagging');
    });

    it('does NOT enqueue burst_detection for a video', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ faceRecognition: true, burstDetection: true, videoEnabled: true }),
      );
      await service.enqueueUploadEnrichment(videoItem);
      expect(enqueuedTypes()).not.toContain('burst_detection');
    });

    it('does NOT enqueue face_detection (photo handler) for a video', async () => {
      await service.enqueueUploadEnrichment(videoItem);
      expect(enqueuedTypes()).not.toContain('face_detection');
    });
  });

  // -----------------------------------------------------------------------
  // 2. faceRecognition feature flag OFF
  // -----------------------------------------------------------------------
  describe('faceRecognition feature flag OFF', () => {
    it('does NOT enqueue video_face_detection', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ faceRecognition: false, videoEnabled: true }),
      );

      await service.enqueueUploadEnrichment(videoItem);

      expect(enqueuedTypes()).not.toContain('video_face_detection');
    });

    it('does not upsert MediaFaceStatus', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ faceRecognition: false, videoEnabled: true }),
      );

      await service.enqueueUploadEnrichment(videoItem);

      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 3. face.video.enabled = false
  // -----------------------------------------------------------------------
  describe('face.video.enabled = false', () => {
    it('does NOT enqueue video_face_detection when face.video.enabled=false', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ faceRecognition: true, videoEnabled: false }),
      );

      await service.enqueueUploadEnrichment(videoItem);

      expect(enqueuedTypes()).not.toContain('video_face_detection');
    });

    it('does not upsert MediaFaceStatus when face.video.enabled=false', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ faceRecognition: true, videoEnabled: false }),
      );

      await service.enqueueUploadEnrichment(videoItem);

      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 4. FACE_AUTO_DETECT=false env kill-switch
  // -----------------------------------------------------------------------
  describe('FACE_AUTO_DETECT=false env kill-switch', () => {
    beforeEach(() => {
      process.env['FACE_AUTO_DETECT'] = 'false';
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ faceRecognition: true, videoEnabled: true }),
      );
    });

    it('does NOT enqueue video_face_detection when FACE_AUTO_DETECT=false', async () => {
      await service.enqueueUploadEnrichment(videoItem);
      expect(enqueuedTypes()).not.toContain('video_face_detection');
    });

    it('does not upsert MediaFaceStatus when FACE_AUTO_DETECT=false', async () => {
      await service.enqueueUploadEnrichment(videoItem);
      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 5. Photo item still routes to face_detection (not video_face_detection)
  // -----------------------------------------------------------------------
  describe('photo item — routes to face_detection, not video_face_detection', () => {
    beforeEach(() => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ faceRecognition: true, videoEnabled: true }),
      );
    });

    it('enqueues face_detection for a photo', async () => {
      await service.enqueueUploadEnrichment(photoItem);
      expect(enqueuedTypes()).toContain('face_detection');
    });

    it('does NOT enqueue video_face_detection for a photo', async () => {
      await service.enqueueUploadEnrichment(photoItem);
      expect(enqueuedTypes()).not.toContain('video_face_detection');
    });

    it('face_detection for a photo has priority 10', async () => {
      await service.enqueueUploadEnrichment(photoItem);
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'face_detection',
          priority: 10,
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // 6. Soft-deleted video item — nothing enqueued
  // -----------------------------------------------------------------------
  describe('soft-deleted video item', () => {
    it('skips enrichment for a deleted video', async () => {
      await service.enqueueUploadEnrichment({
        ...videoItem,
        deletedAt: new Date(),
      });
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 7. Priority: video (20) > photo face (10) in numeric terms
  //    meaning photo face_detection drains first (lower number = higher priority)
  // -----------------------------------------------------------------------
  describe('priority ordering', () => {
    it('video_face_detection has priority 20 (photo face_detection priority 10 drains first)', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ faceRecognition: true, videoEnabled: true }),
      );

      await service.enqueueUploadEnrichment(videoItem);

      const call = mockEnrichmentJobService.enqueue.mock.calls.find(
        (c: any[]) => c[0].type === 'video_face_detection',
      );
      expect(call?.[0].priority).toBe(20);
    });
  });

  // -----------------------------------------------------------------------
  // 8. face.video absent from settings → defaults to enabled=true
  // -----------------------------------------------------------------------
  describe('face.video absent from settings (defaults to enabled)', () => {
    it('enqueues video_face_detection when face.video is not set in settings', async () => {
      // Settings object without face.video key
      mockSystemSettings.getSettings.mockResolvedValue({
        features: { faceRecognition: true, autoTagging: false, burstDetection: false },
        // face.video intentionally absent
      });

      await service.enqueueUploadEnrichment(videoItem);

      // face.video.enabled defaults to true (enabled !== false → true)
      expect(enqueuedTypes()).toContain('video_face_detection');
    });
  });
});
