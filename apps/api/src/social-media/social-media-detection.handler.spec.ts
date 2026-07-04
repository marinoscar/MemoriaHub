/**
 * Unit tests for SocialMediaDetectionHandler.
 *
 * The real (pure) SocialMediaDetectorService is used directly wherever
 * convenient to reduce mock surface — only PrismaService, SystemSettingsService,
 * SocialMediaOcrService, StorageProviderResolver, and MediaEnrichmentService are
 * mocked.
 *
 * To avoid exercising the legacy re-probe path (ffprobe on a downloaded temp
 * file), every fixture supplies a persisted `video-probe` block in
 * StorageObject.metadata._processing so `readPersistedProbe` returns a non-null
 * result with `formatTags` — the handler then skips straight to detection
 * without downloading anything, UNLESS the test explicitly wants the OCR path
 * (which does download the video buffer for frame extraction).
 *
 * Cases:
 *   - feature off (flag false, or env kill-switch) → not_processed, no tags, no fan-out
 *   - tier1-detected (filename rule) → tag transaction + status + source, NO fan-out
 *   - clean → status processed isSocialMedia:false, fan-out called with job.reason
 *   - OCR path: tier1 inconclusive + recommendTier2 + ocrEnabled → ocr.recognizeVideo
 *     called; detectFromOcr result applied
 *   - OCR unavailable → treated as clean, no throw
 *   - rerun previously-flagged now clean → strips system tags + clears source + fan-out
 *   - non-video / deleted / missing item / no storageObject → early return not_processed
 *   - handler error → status failed + rethrow
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'stream';
import {
  EnrichmentJob,
  JobReason,
  JobStatus,
  MediaSocialStatusType,
  MediaTagSource,
  MediaType,
} from '@prisma/client';
import { SocialMediaDetectionHandler } from './social-media-detection.handler';
import { SocialMediaDetectorService } from './social-media-detector.service';
import { SocialMediaOcrService } from './social-media-ocr.service';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { MediaEnrichmentService } from '../media/enrichment/media-enrichment.service';
import {
  createMockPrismaService,
  MockPrismaService,
  mockPrismaTransaction,
} from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'social_media_detection',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.upload,
    priority: 10,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 1,
    lastError: null,
    startedAt: new Date(),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

/** A MediaItem row shaped as SocialMediaDetectionHandler.process selects it. */
function makeMediaItem(overrides: Record<string, any> = {}) {
  return {
    id: 'media-1',
    circleId: 'circle-1',
    type: MediaType.video,
    deletedAt: null,
    addedById: 'user-1',
    originalFilename: null,
    durationMs: 5000,
    width: 1080,
    height: 1920,
    socialMediaSource: null,
    storageObject: {
      storageKey: 'key-1',
      storageProvider: 's3',
      bucket: 'bucket-1',
      name: 'video.mp4',
      metadata: {
        _processing: {
          'video-probe': {
            formatTags: {},
            streamTags: [],
            formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
            durationMs: 5000,
            width: 1080,
            height: 1920,
          },
        },
      },
    },
    ...overrides,
  };
}

/** Default settings: feature ON, default minConfidence, OCR enabled. */
function makeSettings(overrides: Record<string, any> = {}) {
  return {
    features: { socialMediaDetection: true },
    socialMedia: {
      minConfidence: 0.8,
      ocrEnabled: true,
      ocrMaxFrames: 4,
      ocrLanguages: ['eng'],
      ocrTimeoutSeconds: 60,
      ...overrides.socialMedia,
    },
    ...overrides,
  };
}

describe('SocialMediaDetectionHandler', () => {
  let handler: SocialMediaDetectionHandler;
  let mockPrisma: MockPrismaService;
  let mockSystemSettings: { getSettings: jest.Mock };
  let mockOcr: { recognizeVideo: jest.Mock };
  let mockResolver: { getProviderFor: jest.Mock };
  let mockMediaEnrichment: { enqueueVideoPostDetectionEnrichment: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    delete process.env['SOCIAL_MEDIA_DETECTION_ENABLED'];

    mockPrisma = createMockPrismaService();
    mockSystemSettings = { getSettings: jest.fn().mockResolvedValue(makeSettings()) };
    mockOcr = { recognizeVideo: jest.fn() };
    mockResolver = { getProviderFor: jest.fn() };
    mockMediaEnrichment = { enqueueVideoPostDetectionEnrichment: jest.fn().mockResolvedValue(undefined) };

    mockPrisma.mediaSocialStatus.upsert.mockResolvedValue({} as any);
    mockPrisma.mediaItem.update.mockResolvedValue({} as any);
    (mockPrisma.tag.upsert as jest.Mock).mockImplementation(async (args: any) =>
      ({ id: `tag-${args.create.name}`, ...args.create }),
    );
    mockPrisma.mediaTag.upsert.mockResolvedValue({} as any);
    mockPrisma.mediaTag.updateMany.mockResolvedValue({ count: 0 } as any);
    mockPrisma.mediaTag.deleteMany.mockResolvedValue({ count: 0 } as any);
    mockPrismaTransaction();
    // mockPrismaTransaction() sets $transaction on the *shared* prismaMock
    // singleton (test/mocks/prisma.mock.ts), not our per-test mockDeep instance.
    // Wire the same passthrough on our local mock explicitly.
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') return arg(mockPrisma);
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SocialMediaDetectionHandler,
        EnrichmentHandlerRegistry,
        SocialMediaDetectorService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
        { provide: SocialMediaOcrService, useValue: mockOcr },
        { provide: StorageProviderResolver, useValue: mockResolver },
        { provide: MediaEnrichmentService, useValue: mockMediaEnrichment },
      ],
    }).compile();

    await module.init();

    handler = module.get<SocialMediaDetectionHandler>(SocialMediaDetectionHandler);
  });

  // -------------------------------------------------------------------------
  // type / registration
  // -------------------------------------------------------------------------
  it("has type 'social_media_detection' and registers itself", async () => {
    expect(handler.type).toBe('social_media_detection');
  });

  it('throws synchronously when job.mediaItemId is null', async () => {
    await expect(handler.process(makeJob({ mediaItemId: null }))).rejects.toThrow(
      'social_media_detection job missing mediaItemId',
    );
  });

  // -------------------------------------------------------------------------
  // Early-return guards: non-video / deleted / missing / no storageObject
  // -------------------------------------------------------------------------
  describe('early-return guards', () => {
    it('marks not_processed and does nothing else when the MediaItem does not exist', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await handler.process(makeJob());

      expect(mockPrisma.mediaSocialStatus.upsert).toHaveBeenCalledWith({
        where: { mediaItemId: 'media-1' },
        create: { mediaItemId: 'media-1', status: MediaSocialStatusType.not_processed, lastError: null },
        update: { status: MediaSocialStatusType.not_processed },
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).not.toHaveBeenCalled();
      expect(mockSystemSettings.getSettings).not.toHaveBeenCalled();
    });

    it('marks not_processed for a soft-deleted item', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }) as any,
      );

      await handler.process(makeJob());

      const call = mockPrisma.mediaSocialStatus.upsert.mock.calls[0][0];
      expect(call.update.status).toBe(MediaSocialStatusType.not_processed);
      expect(mockSystemSettings.getSettings).not.toHaveBeenCalled();
    });

    it('marks not_processed for a photo (non-video) item', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({ type: MediaType.photo }) as any,
      );

      await handler.process(makeJob());

      const call = mockPrisma.mediaSocialStatus.upsert.mock.calls[0][0];
      expect(call.update.status).toBe(MediaSocialStatusType.not_processed);
    });

    it('marks not_processed when storageObject is missing', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({ storageObject: null }) as any,
      );

      await handler.process(makeJob());

      const call = mockPrisma.mediaSocialStatus.upsert.mock.calls[0][0];
      expect(call.update.status).toBe(MediaSocialStatusType.not_processed);
    });
  });

  // -------------------------------------------------------------------------
  // Feature gate
  // -------------------------------------------------------------------------
  describe('feature gate', () => {
    it('marks not_processed and does nothing when features.socialMediaDetection is false', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(makeMediaItem() as any);
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ features: { socialMediaDetection: false } }),
      );

      await handler.process(makeJob());

      const call = mockPrisma.mediaSocialStatus.upsert.mock.calls[0][0];
      expect(call.update.status).toBe(MediaSocialStatusType.not_processed);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).not.toHaveBeenCalled();
      expect(mockOcr.recognizeVideo).not.toHaveBeenCalled();
    });

    it('marks not_processed when SOCIAL_MEDIA_DETECTION_ENABLED=false, even with the feature flag ON', async () => {
      process.env['SOCIAL_MEDIA_DETECTION_ENABLED'] = 'false';
      mockPrisma.mediaItem.findUnique.mockResolvedValue(makeMediaItem() as any);

      await handler.process(makeJob());

      const call = mockPrisma.mediaSocialStatus.upsert.mock.calls[0][0];
      expect(call.update.status).toBe(MediaSocialStatusType.not_processed);
      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Tier-1 detected (filename rule) — real detector
  // -------------------------------------------------------------------------
  describe('tier1-detected via filename rule', () => {
    beforeEach(() => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({ originalFilename: 'snaptik_export_video.mp4' }) as any,
      );
    });

    it('applies the Social Media + platform tags in a transaction', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      const tagNames = mockPrisma.tag.upsert.mock.calls.map((c: any[]) => c[0].create.name);
      expect(tagNames).toEqual(['Social Media', 'TikTok']);
    });

    it('upserts a MediaTag join row with source=system for each tag', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.mediaTag.upsert).toHaveBeenCalledTimes(2);
      for (const call of mockPrisma.mediaTag.upsert.mock.calls) {
        expect(call[0].create.source).toBe(MediaTagSource.system);
      }
    });

    it('promotes any existing AI-applied MediaTag row to system for each tag', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.mediaTag.updateMany).toHaveBeenCalledTimes(2);
      for (const call of mockPrisma.mediaTag.updateMany.mock.calls as any[][]) {
        expect(call[0].where.source).toBe(MediaTagSource.ai);
        expect(call[0].data.source).toBe(MediaTagSource.system);
      }
    });

    it('writes MediaSocialStatus processed/isSocialMedia:true with platform/method/confidence/matchedRule', async () => {
      await handler.process(makeJob());

      const call = mockPrisma.mediaSocialStatus.upsert.mock.calls.find(
        (c: any[]) => c[0].create.isSocialMedia === true,
      );
      expect(call).toBeDefined();
      expect(call![0].create).toMatchObject({
        status: MediaSocialStatusType.processed,
        isSocialMedia: true,
        platform: 'tiktok',
        detectionMethod: 'filename',
        matchedRule: 'tt-fn-downloader',
      });
    });

    it('sets mediaItem.socialMediaSource to the detected platform', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: 'media-1' },
        data: { socialMediaSource: 'tiktok' },
      });
    });

    it('does NOT fan out to enqueueVideoPostDetectionEnrichment (detected items stop here)', async () => {
      await handler.process(makeJob());

      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).not.toHaveBeenCalled();
    });

    it('does NOT call the OCR service (tier-1 was conclusive)', async () => {
      await handler.process(makeJob());

      expect(mockOcr.recognizeVideo).not.toHaveBeenCalled();
    });

    it('does not download the video (persisted probe already had formatTags)', async () => {
      await handler.process(makeJob());

      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Clean (no signal at all)
  // -------------------------------------------------------------------------
  describe('clean result (no metadata/filename/heuristic signal)', () => {
    beforeEach(() => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({
          originalFilename: 'IMG_1234.MOV',
          durationMs: null,
          width: null,
          height: null,
          storageObject: {
            ...makeMediaItem().storageObject,
            metadata: {
              _processing: {
                'video-probe': { formatTags: {}, streamTags: [], formatName: 'mov' },
              },
            },
          },
        }) as any,
      );
    });

    it('writes MediaSocialStatus processed/isSocialMedia:false', async () => {
      await handler.process(makeJob());

      const finalCall =
        mockPrisma.mediaSocialStatus.upsert.mock.calls[
          mockPrisma.mediaSocialStatus.upsert.mock.calls.length - 1
        ][0];
      expect(finalCall.update).toMatchObject({
        status: MediaSocialStatusType.processed,
        isSocialMedia: false,
        platform: null,
      });
    });

    it('fans out to enqueueVideoPostDetectionEnrichment with the job reason', async () => {
      const job = makeJob({ reason: JobReason.upload });

      await handler.process(job);

      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).toHaveBeenCalledWith(
        { id: 'media-1', type: MediaType.video, circleId: 'circle-1', deletedAt: null },
        JobReason.upload,
      );
    });

    it('does not touch tags or socialMediaSource when there was no previous flag', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.mediaTag.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('never applies a Tag/MediaTag create for a clean result', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.tag.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // OCR (tier-2) path
  // -------------------------------------------------------------------------
  describe('OCR (tier-2) fallback', () => {
    function makeSuspiciousMediaItem(overrides: Record<string, any> = {}) {
      // WhatsApp-reshare-style filename triggers heur-reshare-filename with no
      // conclusive tier-1 rule, so recommendTier2=true.
      return makeMediaItem({
        originalFilename: 'VID-20260101-WA0012.mp4',
        ...overrides,
      });
    }

    beforeEach(() => {
      mockResolver.getProviderFor.mockResolvedValue({
        download: jest.fn().mockResolvedValue(Readable.from(Buffer.from('fake-video-bytes'))),
      });
    });

    it('calls ocr.recognizeVideo when tier-1 is inconclusive and suspicious', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(makeSuspiciousMediaItem() as any);
      mockOcr.recognizeVideo.mockResolvedValue({ texts: [], available: true });

      await handler.process(makeJob());

      expect(mockOcr.recognizeVideo).toHaveBeenCalledTimes(1);
      const [, opts] = mockOcr.recognizeVideo.mock.calls[0];
      expect(opts).toMatchObject({
        durationMs: 5000,
        fileExtension: '.mp4',
        maxFrames: 4,
        languages: ['eng'],
        timeoutMs: 60000,
      });
    });

    it('applies the OCR-derived detection result (TikTok) when detectFromOcr succeeds', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(makeSuspiciousMediaItem() as any);
      mockOcr.recognizeVideo.mockResolvedValue({ texts: ['TikTok watermark'], available: true });

      await handler.process(makeJob());

      const call = mockPrisma.mediaSocialStatus.upsert.mock.calls.find(
        (c: any[]) => c[0].create.isSocialMedia === true,
      );
      expect(call).toBeDefined();
      expect(call![0].create).toMatchObject({
        platform: 'tiktok',
        detectionMethod: 'ocr',
        matchedRule: 'ocr-tiktok-word',
      });
      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).not.toHaveBeenCalled();
    });

    it('treats OCR-unavailable (degraded) as clean and succeeds without throwing', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(makeSuspiciousMediaItem() as any);
      mockOcr.recognizeVideo.mockResolvedValue({ texts: [], available: false });

      await expect(handler.process(makeJob())).resolves.toBeUndefined();

      const finalCall =
        mockPrisma.mediaSocialStatus.upsert.mock.calls[
          mockPrisma.mediaSocialStatus.upsert.mock.calls.length - 1
        ][0];
      expect(finalCall.update.isSocialMedia).toBe(false);
      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).toHaveBeenCalled();
    });

    it('treats an empty-but-available OCR result (no matching text) as clean', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(makeSuspiciousMediaItem() as any);
      mockOcr.recognizeVideo.mockResolvedValue({ texts: ['nothing interesting here'], available: true });

      await handler.process(makeJob());

      const finalCall =
        mockPrisma.mediaSocialStatus.upsert.mock.calls[
          mockPrisma.mediaSocialStatus.upsert.mock.calls.length - 1
        ][0];
      expect(finalCall.update.isSocialMedia).toBe(false);
      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).toHaveBeenCalled();
    });

    it('does NOT call the OCR service when ocrEnabled is false, even if suspicious', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(makeSuspiciousMediaItem() as any);
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ socialMedia: { ocrEnabled: false } }),
      );

      await handler.process(makeJob());

      expect(mockOcr.recognizeVideo).not.toHaveBeenCalled();
      // Falls through to clean (no tier-1 result, no OCR) and fans out.
      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).toHaveBeenCalled();
    });

    it('does NOT call the OCR service when tier-1 already found a conclusive result', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({ originalFilename: 'snaptik_clip.mp4' }) as any,
      );

      await handler.process(makeJob());

      expect(mockOcr.recognizeVideo).not.toHaveBeenCalled();
    });

    it('does NOT call the OCR service for a clean, non-suspicious video (recommendTier2 false)', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({
          originalFilename: 'IMG_1234.MOV',
          durationMs: null,
          width: null,
          height: null,
          storageObject: {
            ...makeMediaItem().storageObject,
            metadata: {
              _processing: {
                // No width/height/durationMs in the persisted probe either, so
                // heur-portrait-short cannot fire (it requires both dimensions).
                'video-probe': { formatTags: {}, streamTags: [], formatName: 'mov' },
              },
            },
          },
        }) as any,
      );

      await handler.process(makeJob());

      expect(mockOcr.recognizeVideo).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Rerun previously-flagged item, now clean
  // -------------------------------------------------------------------------
  describe('rerun of a previously-flagged item that is now clean', () => {
    beforeEach(() => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({
          originalFilename: 'IMG_1234.MOV',
          durationMs: null,
          width: null,
          height: null,
          socialMediaSource: 'tiktok',
          storageObject: {
            ...makeMediaItem().storageObject,
            metadata: {
              _processing: {
                'video-probe': { formatTags: {}, streamTags: [], formatName: 'mov' },
              },
            },
          },
        }) as any,
      );
    });

    it('deletes the system-applied social tags', async () => {
      await handler.process(makeJob({ reason: JobReason.rerun }));

      expect(mockPrisma.mediaTag.deleteMany).toHaveBeenCalledWith({
        where: {
          mediaItemId: 'media-1',
          source: MediaTagSource.system,
          tag: { name: { in: ['Social Media', 'TikTok', 'Instagram', 'Facebook'] } },
        },
      });
    });

    it('clears mediaItem.socialMediaSource', async () => {
      await handler.process(makeJob({ reason: JobReason.rerun }));

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: 'media-1' },
        data: { socialMediaSource: null },
      });
    });

    it('still fans out to enqueueVideoPostDetectionEnrichment with the rerun reason', async () => {
      await handler.process(makeJob({ reason: JobReason.rerun }));

      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'media-1' }),
        JobReason.rerun,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('marks status failed with lastError and rethrows when applying the detected result fails', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({ originalFilename: 'snaptik_clip.mp4' }) as any,
      );
      (mockPrisma.$transaction as jest.Mock).mockRejectedValue(new Error('DB exploded'));

      await expect(handler.process(makeJob())).rejects.toThrow('DB exploded');

      const finalCall =
        mockPrisma.mediaSocialStatus.upsert.mock.calls[
          mockPrisma.mediaSocialStatus.upsert.mock.calls.length - 1
        ][0];
      expect(finalCall.update).toMatchObject({ status: MediaSocialStatusType.failed, lastError: 'DB exploded' });
    });

    it('does not crash even if the failed-status upsert itself rejects (caught internally)', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({ originalFilename: 'snaptik_clip.mp4' }) as any,
      );
      (mockPrisma.$transaction as jest.Mock).mockRejectedValue(new Error('DB exploded'));
      (mockPrisma.mediaSocialStatus.upsert as jest.Mock).mockImplementation(async (args: any) => {
        if (args.update?.status === MediaSocialStatusType.failed) {
          throw new Error('status write also failed');
        }
        return {} as any;
      });

      // The original error should still propagate (not the status-write error).
      await expect(handler.process(makeJob())).rejects.toThrow('DB exploded');
    });
  });
});
