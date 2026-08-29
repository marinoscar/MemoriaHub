/**
 * Unit tests for MediaEnrichmentService — video AI tagging routing
 * (epic #452, issue #458).
 *
 * Four paths enqueue AI tagging, and before this issue ALL of them were
 * photo-only — one of them (bulk rerun) an outright bug that produced a failed
 * job for an action the UI offered. This file covers the upload and per-item
 * rerun paths on the enrichment service; the bulk path is covered in
 * media.service's own spec and the controller path in tagging.controller.spec.
 *
 * The load-bearing behavior here is that video tagging rides the
 * POST-SOCIAL-MEDIA-DETECTION fan-out rather than being enqueued directly at
 * upload — which is what guarantees a TikTok re-share is never sent to the
 * vision model.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MediaType, JobReason, MediaTagStatusType } from '@prisma/client';
import { MediaEnrichmentService } from './media-enrichment.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

function makeSettings(opts: {
  autoTagging?: boolean;
  videoTagging?: boolean;
  faceRecognition?: boolean;
  socialMediaDetection?: boolean;
} = {}) {
  return {
    features: {
      autoTagging: opts.autoTagging ?? true,
      faceRecognition: opts.faceRecognition ?? false,
      burstDetection: false,
      socialMediaDetection: opts.socialMediaDetection ?? false,
    },
    autoTagging: {
      video: {
        enabled: opts.videoTagging ?? true,
        maxFrames: 6,
        sampleIntervalSeconds: 5,
        transcription: { enabled: false, leadSeconds: 30 },
      },
    },
    face: { video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 } },
  };
}

describe('MediaEnrichmentService — video AI tagging routing', () => {
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
    mockEnrichmentJobService = { enqueue: jest.fn().mockResolvedValue({ id: 'job-x' }) };
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

    service = module.get(MediaEnrichmentService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env['AUTO_TAG_ENABLED'];
    delete process.env['SOCIAL_MEDIA_DETECTION_ENABLED'];
  });

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  describe('upload', () => {
    it('enqueues video_auto_tagging (never auto_tagging) for a video', async () => {
      await service.enqueueUploadEnrichment(videoItem);

      expect(enqueuedTypes()).toContain('video_auto_tagging');
      expect(enqueuedTypes()).not.toContain('auto_tagging');
    });

    it('upserts the tag status to pending so the UI badge reflects the queued work', async () => {
      await service.enqueueUploadEnrichment(videoItem);

      expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { mediaItemId: 'media-v1' },
          update: { status: MediaTagStatusType.pending },
        }),
      );
    });

    it('WITHHOLDS video tagging behind social-media detection, so a TikTok re-share is never sent to the vision model', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ socialMediaDetection: true }),
      );

      await service.enqueueUploadEnrichment(videoItem);

      // Only the classifier is queued; video_auto_tagging is fanned out later
      // by SocialMediaDetectionHandler, and only on the CLEAN path.
      expect(enqueuedTypes()).toEqual(['social_media_detection']);
      expect(enqueuedTypes()).not.toContain('video_auto_tagging');
    });

    it('enqueues nothing tagging-related for a video when autoTagging.video.enabled is off (the default)', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(makeSettings({ videoTagging: false }));

      await service.enqueueUploadEnrichment(videoItem);

      expect(enqueuedTypes()).not.toContain('video_auto_tagging');
      expect(mockPrisma.mediaTagStatus.upsert).not.toHaveBeenCalled();
    });

    it('enqueues nothing tagging-related when the master autoTagging flag is off', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(makeSettings({ autoTagging: false }));

      await service.enqueueUploadEnrichment(videoItem);

      expect(enqueuedTypes()).not.toContain('video_auto_tagging');
    });

    it('respects the AUTO_TAG_ENABLED kill-switch — video tagging has none of its own', async () => {
      process.env['AUTO_TAG_ENABLED'] = 'false';

      await service.enqueueUploadEnrichment(videoItem);

      expect(enqueuedTypes()).not.toContain('video_auto_tagging');
    });

    it('still routes photos to auto_tagging — the photo path is unchanged', async () => {
      await service.enqueueUploadEnrichment(photoItem);

      expect(enqueuedTypes()).toContain('auto_tagging');
      expect(enqueuedTypes()).not.toContain('video_auto_tagging');
    });

    it('enqueues nothing for a soft-deleted video', async () => {
      await service.enqueueUploadEnrichment({ ...videoItem, deletedAt: new Date() });

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Post-detection fan-out (the clean path out of social-media detection)
  // -------------------------------------------------------------------------

  describe('post-detection fan-out', () => {
    it('releases BOTH video face detection and video AI tagging once a video is cleared', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ faceRecognition: true, videoTagging: true }),
      );

      await service.enqueueVideoPostDetectionEnrichment(videoItem, JobReason.upload);

      expect(enqueuedTypes().sort()).toEqual(['video_auto_tagging', 'video_face_detection']);
    });

    it('still releases video face detection when video tagging is off — the two gates are independent', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ faceRecognition: true, videoTagging: false }),
      );

      await service.enqueueVideoPostDetectionEnrichment(videoItem, JobReason.upload);

      expect(enqueuedTypes()).toEqual(['video_face_detection']);
    });

    it('still releases video tagging when face recognition is off', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ faceRecognition: false, videoTagging: true }),
      );

      await service.enqueueVideoPostDetectionEnrichment(videoItem, JobReason.upload);

      expect(enqueuedTypes()).toEqual(['video_auto_tagging']);
    });

    it('maps the job reason to the same priority as the face path (rerun 0, upload 20, backfill 100)', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(makeSettings({ videoTagging: true }));

      for (const [reason, priority] of [
        [JobReason.rerun, 0],
        [JobReason.upload, 20],
        [JobReason.backfill, 100],
      ] as const) {
        mockEnrichmentJobService.enqueue.mockClear();
        await service.enqueueVideoPostDetectionEnrichment(videoItem, reason);
        expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'video_auto_tagging', reason, priority }),
        );
      }
    });

    it('never enqueues for a photo handed to the video fan-out', async () => {
      await service.enqueueVideoPostDetectionEnrichment(photoItem, JobReason.upload);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Per-item rerun
  // -------------------------------------------------------------------------

  describe('enqueueTagRerun', () => {
    it('routes a video to video_auto_tagging when the caller supplies the type', async () => {
      await service.enqueueTagRerun({
        id: 'media-v1',
        circleId: 'circle-1',
        type: MediaType.video,
      });

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'video_auto_tagging', priority: 0, reason: JobReason.rerun }),
      );
      // No lookup needed when the caller already knows the type.
      expect(mockPrisma.mediaItem.findUnique).not.toHaveBeenCalled();
    });

    it('routes a photo to auto_tagging', async () => {
      await service.enqueueTagRerun({
        id: 'media-p1',
        circleId: 'circle-1',
        type: MediaType.photo,
      });

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'auto_tagging' }),
      );
    });

    it('resolves the type itself when the caller omits it, so no call site can route wrongly by forgetting', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({ type: MediaType.video });

      await service.enqueueTagRerun({ id: 'media-v1', circleId: 'circle-1' });

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'video_auto_tagging' }),
      );
    });

    it('marks the tag status pending regardless of which type it routed to', async () => {
      await service.enqueueTagRerun({
        id: 'media-v1',
        circleId: 'circle-1',
        type: MediaType.video,
      });

      expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { status: MediaTagStatusType.pending } }),
      );
    });
  });
});
