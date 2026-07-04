/**
 * Unit tests for MediaEnrichmentService — social-media detection video routing.
 *
 * The existing media-enrichment.service.spec.ts and
 * media-enrichment-video.service.spec.ts files predate the socialMediaDetection
 * feature and don't set `features.socialMediaDetection` in their settings
 * fixtures, so `socialOn` resolves to falsy there and those files continue to
 * exercise the "social detection off" path unchanged. This file adds dedicated
 * coverage for the social-media routing branch introduced in
 * MediaEnrichmentService.enqueueUploadEnrichment (video routing) and the
 * standalone enqueueVideoPostDetectionEnrichment method.
 *
 * Cases:
 *  1. socialMediaDetection ON + video upload → enqueues ONLY
 *     social_media_detection (priority 10) + MediaSocialStatus pending;
 *     does NOT enqueue video_face_detection.
 *  2. socialMediaDetection OFF (feature flag false, or env kill-switch true)
 *     + video upload → enqueues video_face_detection as before (unchanged
 *     behavior); does NOT enqueue social_media_detection.
 *  3. Photos are unaffected by the social-media flag in either state.
 *  4. enqueueVideoPostDetectionEnrichment: reason → priority mapping
 *     (rerun=0, upload=20, backfill=100) and its own feature/env guards.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MediaEnrichmentService } from './media-enrichment.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import {
  MediaType,
  JobReason,
  MediaSocialStatusType,
  MediaFaceStatusType,
} from '@prisma/client';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSettings(opts: {
  socialMediaDetection?: boolean;
  faceRecognition?: boolean;
  videoEnabled?: boolean;
} = {}) {
  return {
    features: {
      autoTagging: false,
      faceRecognition: opts.faceRecognition ?? true,
      burstDetection: false,
      duplicateDetection: false,
      locationInference: false,
      socialMediaDetection: opts.socialMediaDetection ?? false,
    },
    face: {
      video: { enabled: opts.videoEnabled ?? true },
    },
  };
}

describe('MediaEnrichmentService — social-media detection video routing', () => {
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

  const enqueuedTypes = (): string[] =>
    mockEnrichmentJobService.enqueue.mock.calls.map((c: any[]) => c[0].type as string);

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = {
      enqueue: jest.fn().mockResolvedValue({ id: 'job-x' }),
    };
    mockSystemSettings = { getSettings: jest.fn().mockResolvedValue(makeSettings()) };

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
    delete process.env['SOCIAL_MEDIA_DETECTION_ENABLED'];
    delete process.env['FACE_AUTO_DETECT'];
  });

  // -------------------------------------------------------------------------
  // 1. socialMediaDetection ON
  // -------------------------------------------------------------------------
  describe('socialMediaDetection feature ON', () => {
    beforeEach(() => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ socialMediaDetection: true, faceRecognition: true, videoEnabled: true }),
      );
    });

    it('enqueues ONLY social_media_detection for a video upload', async () => {
      await service.enqueueUploadEnrichment(videoItem);

      expect(enqueuedTypes()).toEqual(['social_media_detection']);
    });

    it('enqueues social_media_detection with priority 10 and reason=upload', async () => {
      await service.enqueueUploadEnrichment(videoItem);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith({
        type: 'social_media_detection',
        mediaItemId: videoItem.id,
        circleId: videoItem.circleId,
        reason: JobReason.upload,
        priority: 10,
      });
    });

    it('upserts MediaSocialStatus to pending', async () => {
      await service.enqueueUploadEnrichment(videoItem);

      expect(mockPrisma.mediaSocialStatus.upsert).toHaveBeenCalledWith({
        where: { mediaItemId: videoItem.id },
        create: { mediaItemId: videoItem.id, status: MediaSocialStatusType.pending },
        update: { status: MediaSocialStatusType.pending },
      });
    });

    it('does NOT enqueue video_face_detection directly (withheld pending classification)', async () => {
      await service.enqueueUploadEnrichment(videoItem);

      expect(enqueuedTypes()).not.toContain('video_face_detection');
    });

    it('does NOT upsert MediaFaceStatus at upload time (only social status)', async () => {
      await service.enqueueUploadEnrichment(videoItem);

      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });

    it('is not affected by SOCIAL_MEDIA_DETECTION_ENABLED=true (no-op; only "false" is a kill-switch)', async () => {
      process.env['SOCIAL_MEDIA_DETECTION_ENABLED'] = 'true';

      await service.enqueueUploadEnrichment(videoItem);

      expect(enqueuedTypes()).toEqual(['social_media_detection']);
    });
  });

  // -------------------------------------------------------------------------
  // 1b. socialMediaDetection ON but killed via env var
  // -------------------------------------------------------------------------
  describe('socialMediaDetection feature ON but SOCIAL_MEDIA_DETECTION_ENABLED=false (env kill-switch)', () => {
    beforeEach(() => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ socialMediaDetection: true, faceRecognition: true, videoEnabled: true }),
      );
      process.env['SOCIAL_MEDIA_DETECTION_ENABLED'] = 'false';
    });

    it('falls back to enqueuing video_face_detection directly (unchanged prior behavior)', async () => {
      await service.enqueueUploadEnrichment(videoItem);

      expect(enqueuedTypes()).not.toContain('social_media_detection');
      expect(enqueuedTypes()).toContain('video_face_detection');
    });
  });

  // -------------------------------------------------------------------------
  // 2. socialMediaDetection OFF — unchanged prior behavior
  // -------------------------------------------------------------------------
  describe('socialMediaDetection feature OFF', () => {
    beforeEach(() => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ socialMediaDetection: false, faceRecognition: true, videoEnabled: true }),
      );
    });

    it('enqueues video_face_detection directly (priority 20, reason=upload)', async () => {
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

    it('does NOT enqueue social_media_detection', async () => {
      await service.enqueueUploadEnrichment(videoItem);

      expect(enqueuedTypes()).not.toContain('social_media_detection');
    });

    it('does NOT upsert MediaSocialStatus', async () => {
      await service.enqueueUploadEnrichment(videoItem);

      expect(mockPrisma.mediaSocialStatus.upsert).not.toHaveBeenCalled();
    });

    it('still upserts MediaFaceStatus to pending via the video_face_detection path', async () => {
      await service.enqueueUploadEnrichment(videoItem);

      expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { mediaItemId: videoItem.id },
          create: expect.objectContaining({ status: MediaFaceStatusType.pending }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. Photos unaffected in either state
  // -------------------------------------------------------------------------
  describe('photos are unaffected by the social-media flag', () => {
    it('does not enqueue social_media_detection or video_face_detection for a photo when socialMediaDetection is ON', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ socialMediaDetection: true }),
      );

      await service.enqueueUploadEnrichment(photoItem);

      expect(enqueuedTypes()).not.toContain('social_media_detection');
      expect(enqueuedTypes()).not.toContain('video_face_detection');
      expect(mockPrisma.mediaSocialStatus.upsert).not.toHaveBeenCalled();
    });

    it('does not enqueue social_media_detection or video_face_detection for a photo when socialMediaDetection is OFF', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ socialMediaDetection: false }),
      );

      await service.enqueueUploadEnrichment(photoItem);

      expect(enqueuedTypes()).not.toContain('social_media_detection');
      expect(enqueuedTypes()).not.toContain('video_face_detection');
      expect(mockPrisma.mediaSocialStatus.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 4. enqueueVideoPostDetectionEnrichment — reason -> priority mapping + guards
  // -------------------------------------------------------------------------
  describe('enqueueVideoPostDetectionEnrichment', () => {
    const settingsAllOn = makeSettings({ faceRecognition: true, videoEnabled: true });

    it.each([
      [JobReason.rerun, 0],
      [JobReason.upload, 20],
      [JobReason.backfill, 100],
    ])('maps reason=%s to priority %d', async (reason, expectedPriority) => {
      await service.enqueueVideoPostDetectionEnrichment(videoItem, reason, settingsAllOn as any);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'video_face_detection',
          reason,
          priority: expectedPriority,
        }),
      );
    });

    it('upserts MediaFaceStatus to pending on successful enqueue', async () => {
      await service.enqueueVideoPostDetectionEnrichment(videoItem, JobReason.upload, settingsAllOn as any);

      expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { mediaItemId: videoItem.id },
          create: expect.objectContaining({ status: MediaFaceStatusType.pending }),
        }),
      );
    });

    it('resolves getSettings itself when resolvedSettings is omitted', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(settingsAllOn);

      await service.enqueueVideoPostDetectionEnrichment(videoItem, JobReason.upload);

      expect(mockSystemSettings.getSettings).toHaveBeenCalledTimes(1);
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'video_face_detection' }),
      );
    });

    it('skips (no enqueue) when faceRecognition is OFF', async () => {
      const settingsOff = makeSettings({ faceRecognition: false, videoEnabled: true });

      await service.enqueueVideoPostDetectionEnrichment(videoItem, JobReason.upload, settingsOff as any);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
      expect(mockPrisma.mediaFaceStatus.upsert).not.toHaveBeenCalled();
    });

    it('skips (no enqueue) when face.video.enabled is false', async () => {
      const settingsVideoOff = makeSettings({ faceRecognition: true, videoEnabled: false });

      await service.enqueueVideoPostDetectionEnrichment(videoItem, JobReason.upload, settingsVideoOff as any);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('skips (no enqueue) when FACE_AUTO_DETECT=false, even with faceRecognition ON', async () => {
      process.env['FACE_AUTO_DETECT'] = 'false';

      await service.enqueueVideoPostDetectionEnrichment(videoItem, JobReason.upload, settingsAllOn as any);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('skips (no enqueue) for a soft-deleted item', async () => {
      await service.enqueueVideoPostDetectionEnrichment(
        { ...videoItem, deletedAt: new Date() },
        JobReason.upload,
        settingsAllOn as any,
      );

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('skips (no enqueue) for a non-video item', async () => {
      await service.enqueueVideoPostDetectionEnrichment(photoItem, JobReason.upload, settingsAllOn as any);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('never throws even when enqueue rejects', async () => {
      mockEnrichmentJobService.enqueue.mockRejectedValueOnce(new Error('DB down'));

      await expect(
        service.enqueueVideoPostDetectionEnrichment(videoItem, JobReason.upload, settingsAllOn as any),
      ).resolves.toBeUndefined();
    });
  });
});
