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
 *   - OOM-fix regression: the memoized downloadVideo() temp-file path is
 *     downloaded exactly once and cleaned up exactly once even when BOTH the
 *     legacy re-probe path and the OCR path run in the same job (ffprobe is
 *     mocked via ffprobe.util so no real ffmpeg binary is invoked for that
 *     scenario)
 *   - Pre-flight caps (queue-resilience): duration over
 *     socialMedia.maxDurationSeconds → clean via 'skip-duration-cap' with no
 *     download; unknown duration + size over socialMedia.maxSizeBytes (or the
 *     VIDEO_ENRICHMENT_MAX_BYTES env hard cap) → 'skip-size-cap'; fan-out
 *     still runs and previously-flagged items still get their tags stripped
 *   - Landscape orientation gate: strictly-landscape videos are never
 *     downloaded for the legacy re-probe and never get Tier-2 OCR (Tier-1
 *     filename/persisted-metadata rules still run); portrait items with no
 *     persisted probe still download + re-probe + OCR (control)
 *   - Disk-space guard: downloadVideo() runs assertDiskSpaceForDownload
 *     (statfs stubbed deterministically in the fs mock below) before streaming
 *
 * Fixture note: storageObject now carries `size` (BigInt) — the handler's
 * select includes it for the pre-flight caps and the disk guard.
 */

// Mock ffprobe.util so the legacy re-probe branch never shells out to a real
// ffprobe binary — only used by the OOM-fix "downloadVideo() memoization"
// tests below, which deliberately omit the persisted `video-probe` block to
// force that branch.
jest.mock('../storage/processing/processors/ffprobe.util', () => ({
  probeVideoFile: jest.fn().mockResolvedValue({}),
  extractContainerMetadata: jest.fn().mockReturnValue({
    formatTags: {},
    streamTags: [],
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  }),
}));

// Spy on fs.promises.unlink (delegating to the real implementation) so tests
// can assert the memoized downloaded temp file is cleaned up exactly once,
// without replacing the rest of the real `fs` module — @prisma/client and
// other transitive imports need real fs to load.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      unlink: jest.fn().mockImplementation((...args: unknown[]) =>
        (actual.promises.unlink as (...a: unknown[]) => Promise<void>)(...args),
      ),
      // Deterministic statfs stub for the disk-space guard in downloadVideo():
      // default to ample free space (bavail * bsize = ~1 TB); the disk-guard
      // test overrides per-call with mockResolvedValueOnce.
      statfs: jest.fn().mockResolvedValue({ bavail: 1_000_000, bsize: 1_000_000 }),
    },
  };
});

import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'stream';
import { promises as fsPromises } from 'fs';
import {
  EnrichmentJob,
  JobReason,
  JobStatus,
  MediaSocialStatusType,
  MediaTagSource,
  MediaType,
} from '@prisma/client';
import {
  socialMediaDetectionResultSchema,
  type SocialMediaDetectionResult,
} from '@memoriahub/enrichment-compute/dto';
import { SocialMediaDetectionHandler } from './social-media-detection.handler';
import { SocialMediaDetectorService, type VideoDetectionInput } from './social-media-detector.service';
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
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null,
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
      // Selected by the handler for the pre-flight caps + disk guard. Small
      // enough that no size-based cap can trip by default.
      size: BigInt(1024),
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

/** Default settings: feature ON, default minConfidence, OCR enabled, default caps. */
function makeSettings(overrides: Record<string, any> = {}) {
  return {
    features: { socialMediaDetection: true },
    socialMedia: {
      minConfidence: 0.8,
      ocrEnabled: true,
      ocrMaxFrames: 4,
      ocrLanguages: ['eng'],
      ocrTimeoutSeconds: 60,
      // Pre-flight caps (schema defaults): clips longer than 5 minutes are
      // treated as clean without download; the size cap only applies when the
      // duration is unknown.
      maxDurationSeconds: 300,
      maxSizeBytes: 500_000_000,
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

  // -------------------------------------------------------------------------
  // OOM-fix regression: memoized downloadVideo() temp-file cleanup
  //
  // The handler streams the video to a temp file (constant memory) the first
  // time downloadVideo() is called and memoizes the path so a second logical
  // "use" in the same job run (legacy re-probe AND the OCR fallback) reuses
  // the same file instead of downloading again. The temp file must be cleaned
  // up EXACTLY ONCE, in the outer finally block, after every use is done.
  // -------------------------------------------------------------------------
  describe('downloaded temp file cleanup — memoized across legacy re-probe + OCR (OOM fix)', () => {
    const mockUnlink = fsPromises.unlink as jest.Mock;
    let mockDownload: jest.Mock;

    /**
     * No persisted `video-probe` block at all → readPersistedProbe() returns
     * null, forcing the legacy re-probe branch (downloadVideo() call #1). The
     * WhatsApp-reshare-style filename triggers heur-reshare-filename
     * (suspicious, no conclusive tier-1 rule) so recommendTier2 is also true
     * — the OCR fallback branch then calls downloadVideo() again (call #2,
     * memoized) in the very same job run.
     */
    function makeLegacyMediaItemNeedingReprobeAndOcr(overrides: Record<string, any> = {}) {
      return makeMediaItem({
        originalFilename: 'VID-20260101-WA0012.mp4',
        storageObject: {
          storageKey: 'key-1',
          storageProvider: 's3',
          bucket: 'bucket-1',
          name: 'video.mp4',
          size: BigInt(1024),
          metadata: {},
        },
        ...overrides,
      });
    }

    beforeEach(() => {
      mockDownload = jest.fn().mockResolvedValue(Readable.from(Buffer.from('fake-video-bytes')));
      mockResolver.getProviderFor.mockResolvedValue({ download: mockDownload });
      mockOcr.recognizeVideo.mockResolvedValue({ texts: [], available: true });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeLegacyMediaItemNeedingReprobeAndOcr() as any,
      );
    });

    it('downloads exactly once even though both re-probe and OCR need the video', async () => {
      await handler.process(makeJob());

      // downloadVideo() is invoked from both the re-probe branch and the OCR
      // branch, but the actual download (getProviderFor + provider.download)
      // must only happen once — the second call reuses the memoized path.
      expect(mockResolver.getProviderFor).toHaveBeenCalledTimes(1);
      expect(mockDownload).toHaveBeenCalledTimes(1);
      expect(mockOcr.recognizeVideo).toHaveBeenCalledTimes(1);
    });

    it('cleans up the memoized temp file exactly once, after both uses complete', async () => {
      await handler.process(makeJob());

      expect(mockUnlink).toHaveBeenCalledTimes(1);
      const [tmpPath] = mockUnlink.mock.calls[0];
      expect(tmpPath).toMatch(/memoriaHub-social-dl-.*\.mp4$/);

      // The OCR call received the very same memoized path.
      const [ocrPathArg] = mockOcr.recognizeVideo.mock.calls[0];
      expect(ocrPathArg).toBe(tmpPath);
    });

    it('still cleans up the memoized temp file exactly once (not leaked, not double-cleaned) when the OCR call throws', async () => {
      mockOcr.recognizeVideo.mockRejectedValue(new Error('tesseract exploded'));

      await expect(handler.process(makeJob())).rejects.toThrow('tesseract exploded');

      expect(mockDownload).toHaveBeenCalledTimes(1);
      expect(mockUnlink).toHaveBeenCalledTimes(1);
    });

    it('still cleans up the memoized temp file exactly once when the legacy re-probe itself throws', async () => {
      const ffprobeUtil = jest.requireMock(
        '../storage/processing/processors/ffprobe.util',
      ) as { probeVideoFile: jest.Mock };
      ffprobeUtil.probeVideoFile.mockRejectedValueOnce(new Error('ffprobe exploded'));

      await expect(handler.process(makeJob())).rejects.toThrow('ffprobe exploded');

      // The OCR branch is never reached — the re-probe error aborts the job first.
      expect(mockOcr.recognizeVideo).not.toHaveBeenCalled();
      expect(mockDownload).toHaveBeenCalledTimes(1);
      expect(mockUnlink).toHaveBeenCalledTimes(1);
    });

    it('fails fast with the insufficient-disk-space error BEFORE streaming when the temp filesystem is too full', async () => {
      const mockStatfs = fsPromises.statfs as unknown as jest.Mock;
      // Zero free space — assertDiskSpaceForDownload throws inside downloadVideo().
      mockStatfs.mockResolvedValueOnce({ bavail: 0, bsize: 4096 });

      await expect(handler.process(makeJob())).rejects.toThrow(
        /insufficient disk space for video download/,
      );

      // The guard runs before provider.download and before the temp path is
      // recorded — nothing was downloaded, so nothing needs cleanup.
      expect(mockDownload).not.toHaveBeenCalled();
      expect(mockUnlink).not.toHaveBeenCalled();

      // The error routes through the normal failed-status path.
      const finalCall =
        mockPrisma.mediaSocialStatus.upsert.mock.calls[
          mockPrisma.mediaSocialStatus.upsert.mock.calls.length - 1
        ][0];
      expect(finalCall.update.status).toBe(MediaSocialStatusType.failed);
      expect(String(finalCall.update.lastError)).toContain('insufficient disk space');
    });
  });

  // -------------------------------------------------------------------------
  // Pre-flight caps (queue-resilience): skip-duration-cap / skip-size-cap
  //
  // Operator domain fact: genuine social-media clips never exceed ~5 minutes.
  // Videos over socialMedia.maxDurationSeconds are treated as CLEAN via the
  // normal clean path (status upsert records the skip in matchedRule, stale
  // tags stripped for previously-flagged items, downstream video enrichment
  // fans out) without downloading a single byte. When the duration is unknown,
  // socialMedia.maxSizeBytes is the fallback signal; the shared
  // VIDEO_ENRICHMENT_MAX_BYTES env hard cap is checked first, unconditionally.
  // -------------------------------------------------------------------------

  describe('pre-flight caps (skip-duration-cap / skip-size-cap)', () => {
    const SAVED_MAX_BYTES = process.env['VIDEO_ENRICHMENT_MAX_BYTES'];

    afterEach(() => {
      if (SAVED_MAX_BYTES === undefined) {
        delete process.env['VIDEO_ENRICHMENT_MAX_BYTES'];
      } else {
        process.env['VIDEO_ENRICHMENT_MAX_BYTES'] = SAVED_MAX_BYTES;
      }
    });

    /** MediaItem whose persisted probe reports the given duration (ms). */
    function makeItemWithProbeDuration(durationMs: number | undefined, overrides: Record<string, any> = {}) {
      return makeMediaItem({
        storageObject: {
          ...makeMediaItem().storageObject,
          metadata: {
            _processing: {
              'video-probe': {
                formatTags: {},
                streamTags: [],
                formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
                ...(durationMs !== undefined ? { durationMs } : {}),
                width: 1080,
                height: 1920,
              },
            },
          },
        },
        ...overrides,
      });
    }

    function findSkipUpsert(rule: string) {
      return mockPrisma.mediaSocialStatus.upsert.mock.calls.find(
        (c: any[]) => c[0].create.matchedRule === rule,
      );
    }

    it('duration over the cap → clean via skip-duration-cap, no download, fan-out still runs', async () => {
      // 400 s > default maxDurationSeconds (300 s)
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeItemWithProbeDuration(400_000) as any,
      );

      await handler.process(makeJob({ reason: JobReason.upload }));

      const skipCall = findSkipUpsert('skip-duration-cap');
      expect(skipCall).toBeDefined();
      expect(skipCall![0].update).toMatchObject({
        status: MediaSocialStatusType.processed,
        isSocialMedia: false,
        platform: null,
        detectionMethod: null,
        matchedRule: 'skip-duration-cap',
      });

      // Not a single byte downloaded; no OCR; no tags applied.
      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
      expect(mockOcr.recognizeVideo).not.toHaveBeenCalled();
      expect(mockPrisma.tag.upsert).not.toHaveBeenCalled();

      // Withheld downstream video enrichment still fans out.
      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).toHaveBeenCalledWith(
        { id: 'media-1', type: MediaType.video, circleId: 'circle-1', deletedAt: null },
        JobReason.upload,
      );
    });

    it('duration exactly AT the cap is NOT skipped (strictly greater-than)', async () => {
      // 300 s == maxDurationSeconds → not over the cap → full detection runs.
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeItemWithProbeDuration(300_000) as any,
      );

      await handler.process(makeJob());

      expect(findSkipUpsert('skip-duration-cap')).toBeUndefined();
      expect(findSkipUpsert('skip-size-cap')).toBeUndefined();
    });

    it('falls back to mediaItem.durationMs when the persisted probe has no duration', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeItemWithProbeDuration(undefined, { durationMs: 400_000 }) as any,
      );

      await handler.process(makeJob());

      expect(findSkipUpsert('skip-duration-cap')).toBeDefined();
      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
    });

    it('respects a custom socialMedia.maxDurationSeconds setting', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ socialMedia: { maxDurationSeconds: 60 } }),
      );
      // 90 s is fine under the default 300 s but over the custom 60 s cap.
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeItemWithProbeDuration(90_000) as any,
      );

      await handler.process(makeJob());

      expect(findSkipUpsert('skip-duration-cap')).toBeDefined();
    });

    it('unknown duration + size over socialMedia.maxSizeBytes → skip-size-cap without downloading', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeItemWithProbeDuration(undefined, {
          durationMs: null,
          storageObject: {
            ...makeMediaItem().storageObject,
            size: BigInt(600_000_000), // > default 500 MB
            metadata: {
              _processing: {
                'video-probe': { formatTags: {}, streamTags: [], formatName: 'mov' },
              },
            },
          },
        }) as any,
      );

      await handler.process(makeJob({ reason: JobReason.rerun }));

      const skipCall = findSkipUpsert('skip-size-cap');
      expect(skipCall).toBeDefined();
      expect(skipCall![0].update.isSocialMedia).toBe(false);
      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'media-1' }),
        JobReason.rerun,
      );
    });

    it('unknown duration + size under the cap is NOT skipped (size is only a fallback signal)', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeItemWithProbeDuration(undefined, { durationMs: null }) as any, // size stays BigInt(1024)
      );

      await handler.process(makeJob());

      expect(findSkipUpsert('skip-size-cap')).toBeUndefined();
      expect(findSkipUpsert('skip-duration-cap')).toBeUndefined();
      // Falls through to a genuine clean pass (matchedRule null) + fan-out.
      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).toHaveBeenCalled();
    });

    it('known short duration does NOT trigger the settings size cap even for a large file', async () => {
      // Duration is known and small → the maxSizeBytes fallback must not apply.
      // Dimensions are nulled so no suspicion heuristic can route this into
      // the (unmocked-download) OCR path — the point here is only the cap.
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeItemWithProbeDuration(5_000, {
          width: null,
          height: null,
          storageObject: {
            ...makeMediaItem().storageObject,
            size: BigInt(600_000_000),
            metadata: {
              _processing: {
                'video-probe': {
                  formatTags: {}, streamTags: [], formatName: 'mov', durationMs: 5_000,
                },
              },
            },
          },
        }) as any,
      );

      await handler.process(makeJob());

      expect(findSkipUpsert('skip-size-cap')).toBeUndefined();
      expect(findSkipUpsert('skip-duration-cap')).toBeUndefined();
    });

    it('VIDEO_ENRICHMENT_MAX_BYTES env hard cap forces skip-size-cap even when the duration is short', async () => {
      process.env['VIDEO_ENRICHMENT_MAX_BYTES'] = '1000';
      // Default fixture: probe durationMs 5000 (well under the duration cap),
      // size overridden above the env hard cap.
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({
          storageObject: { ...makeMediaItem().storageObject, size: BigInt(5000) },
        }) as any,
      );

      await handler.process(makeJob());

      expect(findSkipUpsert('skip-size-cap')).toBeDefined();
      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
    });

    it('a previously-flagged item skipped by a cap still gets its system tags stripped and source cleared', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeItemWithProbeDuration(400_000, { socialMediaSource: 'tiktok' }) as any,
      );

      await handler.process(makeJob({ reason: JobReason.rerun }));

      expect(mockPrisma.mediaTag.deleteMany).toHaveBeenCalledWith({
        where: {
          mediaItemId: 'media-1',
          source: MediaTagSource.system,
          tag: { name: { in: ['Social Media', 'TikTok', 'Instagram', 'Facebook'] } },
        },
      });
      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: 'media-1' },
        data: { socialMediaSource: null },
      });
      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Landscape orientation gate (queue-resilience)
  //
  // TikTok/Instagram videos are never landscape — a strictly-landscape video
  // is never downloaded for this job: the legacy re-probe is skipped (Tier-1
  // runs on filename + whatever persisted metadata exists) and Tier-2 OCR is
  // forced off even when Tier-1 recommends it. Filename rules still apply, so
  // landscape re-shares with telltale names are still caught.
  // -------------------------------------------------------------------------

  describe('landscape orientation gate', () => {
    let mockDownload: jest.Mock;

    /** Landscape item with NO persisted probe (would otherwise re-probe). */
    function makeLandscapeNoProbeItem(overrides: Record<string, any> = {}) {
      return makeMediaItem({
        // WhatsApp-reshare-style filename → heur-reshare-filename fires, so
        // tier-1 RECOMMENDS OCR; the orientation gate must veto it.
        originalFilename: 'VID-20260101-WA0012.mp4',
        width: 1920,
        height: 1080,
        storageObject: {
          storageKey: 'key-1',
          storageProvider: 's3',
          bucket: 'bucket-1',
          name: 'video.mp4',
          size: BigInt(1024),
          metadata: {}, // no persisted probe
        },
        ...overrides,
      });
    }

    beforeEach(() => {
      mockDownload = jest.fn().mockResolvedValue(Readable.from(Buffer.from('fake-video-bytes')));
      mockResolver.getProviderFor.mockResolvedValue({ download: mockDownload });
      mockOcr.recognizeVideo.mockResolvedValue({ texts: [], available: true });
    });

    it('never downloads a strictly-landscape video for the legacy re-probe', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(makeLandscapeNoProbeItem() as any);

      await handler.process(makeJob());

      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
      expect(mockDownload).not.toHaveBeenCalled();
    });

    it('never runs Tier-2 OCR on a landscape video, even when the suspicious filename recommends it — item reads clean and fans out', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(makeLandscapeNoProbeItem() as any);

      await handler.process(makeJob({ reason: JobReason.upload }));

      expect(mockOcr.recognizeVideo).not.toHaveBeenCalled();

      // Tier-1 alone was inconclusive → genuine clean (matchedRule null) + fan-out.
      const finalCall =
        mockPrisma.mediaSocialStatus.upsert.mock.calls[
          mockPrisma.mediaSocialStatus.upsert.mock.calls.length - 1
        ][0];
      expect(finalCall.update).toMatchObject({
        status: MediaSocialStatusType.processed,
        isSocialMedia: false,
        matchedRule: null,
      });
      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'media-1' }),
        JobReason.upload,
      );
    });

    it('Tier-1 filename rules still fire for landscape videos (detected with no download, no fan-out)', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeLandscapeNoProbeItem({ originalFilename: 'snaptik_export_video.mp4' }) as any,
      );

      await handler.process(makeJob());

      // Detected via the filename rule without downloading a byte.
      const tagNames = mockPrisma.tag.upsert.mock.calls.map((c: any[]) => c[0].create.name);
      expect(tagNames).toEqual(['Social Media', 'TikTok']);
      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
      expect(mockOcr.recognizeVideo).not.toHaveBeenCalled();
      expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).not.toHaveBeenCalled();
    });

    it('portrait control: the same suspicious filename with no persisted probe still downloads for the re-probe and runs OCR', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeLandscapeNoProbeItem({ width: 1080, height: 1920 }) as any,
      );

      await handler.process(makeJob());

      expect(mockResolver.getProviderFor).toHaveBeenCalledTimes(1);
      expect(mockDownload).toHaveBeenCalledTimes(1);
      expect(mockOcr.recognizeVideo).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // node-result surface (distributed worker nodes)
  // -------------------------------------------------------------------------

  describe('node-result surface', () => {
    const noopDownload = async () => 'unused-path';

    it('exposes the shared package schema as nodeResultSchema', () => {
      expect(handler.nodeResultSchema).toBe(socialMediaDetectionResultSchema);
      const cleanPayload = {
        verdict: 'clean' as const,
        score: 0,
        ocrText: null,
        platform: null,
        detectionMethod: null,
        matchedRule: null,
        confidence: 0,
      };
      expect(() => handler.nodeResultSchema.parse(cleanPayload)).not.toThrow();
    });

    describe('computeSocialMedia', () => {
      it('returns a detected DTO from a Tier-1 filename match, without downloading', async () => {
        const input: VideoDetectionInput = { kind: 'video', filename: 'snaptik_export_video.mp4' };

        const result = await handler.computeSocialMedia(input, {
          minConfidence: 0.8,
          isLandscape: false,
          ocrEnabled: true,
          downloadVideo: noopDownload,
          durationMs: 5000,
          fileExt: '.mp4',
          ocrMaxFrames: 4,
          ocrLanguages: ['eng'],
          ocrTimeoutMs: 60000,
        });

        expect(result.verdict).toBe('detected');
        expect(result.platform).toBe('tiktok');
        expect(result.detectionMethod).toBe('filename');
        expect(result.matchedRule).toBe('tt-fn-downloader'); // "snaptik" downloader pattern
        expect(result.confidence).toBeGreaterThanOrEqual(0.8);
        expect(result.score).toBe(result.confidence);
        expect(mockOcr.recognizeVideo).not.toHaveBeenCalled();
      });

      it('returns a clean DTO (matchedRule null) when Tier-1 is conclusively negative', async () => {
        const input: VideoDetectionInput = { kind: 'video', filename: 'IMG_1234.MOV' };

        const result = await handler.computeSocialMedia(input, {
          minConfidence: 0.8,
          isLandscape: false,
          ocrEnabled: true,
          downloadVideo: noopDownload,
          durationMs: 5000,
          fileExt: '.mov',
          ocrMaxFrames: 4,
          ocrLanguages: ['eng'],
          ocrTimeoutMs: 60000,
        });

        expect(result).toEqual({
          verdict: 'clean',
          score: 0,
          ocrText: null,
          platform: null,
          detectionMethod: null,
          matchedRule: null,
          confidence: 0,
        });
      });

      it('falls back to Tier-2 OCR when Tier-1 is inconclusive-but-suspicious, calling the memoized downloadVideo exactly once', async () => {
        // Portrait, short, no device-capture tags, epoch/missing creation_time
        // → heur-portrait-short fires, recommending Tier-2.
        const input: VideoDetectionInput = {
          kind: 'video',
          filename: 'clip.mp4',
          width: 1080,
          height: 1920,
          durationMs: 10000,
        };
        mockOcr.recognizeVideo.mockResolvedValue({ texts: ['instagram'], available: true });
        const downloadVideo = jest.fn().mockResolvedValue('/tmp/downloaded.mp4');

        const result = await handler.computeSocialMedia(input, {
          minConfidence: 0.8,
          isLandscape: false,
          ocrEnabled: true,
          downloadVideo,
          durationMs: 10000,
          fileExt: '.mp4',
          ocrMaxFrames: 4,
          ocrLanguages: ['eng'],
          ocrTimeoutMs: 60000,
        });

        expect(downloadVideo).toHaveBeenCalledTimes(1);
        expect(mockOcr.recognizeVideo).toHaveBeenCalledTimes(1);
        expect(result.verdict).toBe('detected');
        expect(result.platform).toBe('instagram');
        expect(result.detectionMethod).toBe('ocr');
        expect(result.ocrText).toBe('instagram');
      });

      it('never calls downloadVideo/OCR when isLandscape is true, even if Tier-1 recommends Tier-2', async () => {
        const input: VideoDetectionInput = {
          kind: 'video',
          filename: 'clip.mp4',
          width: 1920,
          height: 1080,
          durationMs: 10000,
        };
        const downloadVideo = jest.fn().mockResolvedValue('/tmp/downloaded.mp4');

        const result = await handler.computeSocialMedia(input, {
          minConfidence: 0.8,
          isLandscape: true,
          ocrEnabled: true,
          downloadVideo,
          durationMs: 10000,
          fileExt: '.mp4',
          ocrMaxFrames: 4,
          ocrLanguages: ['eng'],
          ocrTimeoutMs: 60000,
        });

        expect(downloadVideo).not.toHaveBeenCalled();
        expect(mockOcr.recognizeVideo).not.toHaveBeenCalled();
        expect(result.verdict).toBe('clean');
      });
    });

    describe('persistSocialMedia', () => {
      function makeDetectedResult(overrides: Partial<SocialMediaDetectionResult> = {}): SocialMediaDetectionResult {
        return {
          verdict: 'detected',
          score: 0.95,
          ocrText: null,
          platform: 'tiktok',
          detectionMethod: 'filename',
          matchedRule: 'tt-fn-word',
          confidence: 0.95,
          ...overrides,
        };
      }

      function makeCleanResult(overrides: Partial<SocialMediaDetectionResult> = {}): SocialMediaDetectionResult {
        return {
          verdict: 'clean',
          score: 0,
          ocrText: null,
          platform: null,
          detectionMethod: null,
          matchedRule: null,
          confidence: 0,
          ...overrides,
        };
      }

      it('throws when job.mediaItemId is missing', async () => {
        await expect(
          handler.persistSocialMedia(makeJob({ mediaItemId: null }), makeCleanResult()),
        ).rejects.toThrow('social_media_detection job missing mediaItemId');
      });

      it('throws when the MediaItem cannot be found and no preloaded item was supplied', async () => {
        mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

        await expect(
          handler.persistSocialMedia(makeJob(), makeDetectedResult()),
        ).rejects.toThrow('MediaItem media-1 not found');
      });

      it('re-fetches the MediaItem when no preloaded item is supplied (node persist path)', async () => {
        mockPrisma.mediaItem.findUnique.mockResolvedValue(makeMediaItem() as any);

        await handler.persistSocialMedia(makeJob(), makeCleanResult());

        expect(mockPrisma.mediaItem.findUnique).toHaveBeenCalledWith({
          where: { id: 'media-1' },
          select: {
            id: true,
            circleId: true,
            type: true,
            deletedAt: true,
            addedById: true,
            socialMediaSource: true,
          },
        });
      });

      it('does NOT re-fetch the MediaItem when a preloaded item is supplied (in-process path)', async () => {
        await handler.persistSocialMedia(makeJob(), makeCleanResult(), makeMediaItem() as any);

        expect(mockPrisma.mediaItem.findUnique).not.toHaveBeenCalled();
      });

      it('applies tags + status + source for a detected verdict', async () => {
        await handler.persistSocialMedia(makeJob(), makeDetectedResult(), makeMediaItem() as any);

        const tagNames = mockPrisma.tag.upsert.mock.calls.map((c: any[]) => c[0].create.name);
        expect(tagNames).toEqual(['Social Media', 'TikTok']);
        expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith({
          where: { id: 'media-1' },
          data: { socialMediaSource: 'tiktok' },
        });
        expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).not.toHaveBeenCalled();
      });

      it('throws when a detected verdict is missing platform/detectionMethod', async () => {
        await expect(
          handler.persistSocialMedia(
            makeJob(),
            makeDetectedResult({ platform: null }),
            makeMediaItem() as any,
          ),
        ).rejects.toThrow('platform and detectionMethod are required');
      });

      it('strips stale tags, clears source, and fans out for a clean verdict on a previously-flagged item', async () => {
        const previouslyFlagged = makeMediaItem({ socialMediaSource: 'tiktok' });

        await handler.persistSocialMedia(makeJob({ reason: JobReason.rerun }), makeCleanResult(), previouslyFlagged as any);

        expect(mockPrisma.mediaTag.deleteMany).toHaveBeenCalled();
        expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith({
          where: { id: 'media-1' },
          data: { socialMediaSource: null },
        });
        expect(mockMediaEnrichment.enqueueVideoPostDetectionEnrichment).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'media-1' }),
          JobReason.rerun,
        );
      });

      it('passes through matchedRule (e.g. a pre-flight skip reason) to the clean status row', async () => {
        await handler.persistSocialMedia(
          makeJob(),
          makeCleanResult({ matchedRule: 'skip-duration-cap' }),
          makeMediaItem() as any,
        );

        const call = mockPrisma.mediaSocialStatus.upsert.mock.calls[0][0];
        expect(call.update.matchedRule).toBe('skip-duration-cap');
      });
    });

    describe('persistNodeResult', () => {
      it('parses the payload and delegates to persistSocialMedia (re-fetching the MediaItem)', async () => {
        mockPrisma.mediaItem.findUnique.mockResolvedValue(makeMediaItem() as any);
        const payload = {
          verdict: 'detected',
          score: 0.9,
          ocrText: null,
          platform: 'instagram',
          detectionMethod: 'ocr',
          matchedRule: 'ocr-instagram-word',
          confidence: 0.9,
        };

        await handler.persistNodeResult(makeJob(), payload);

        expect(mockPrisma.mediaItem.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: 'media-1' } }),
        );
        const tagNames = mockPrisma.tag.upsert.mock.calls.map((c: any[]) => c[0].create.name);
        expect(tagNames).toEqual(['Social Media', 'Instagram']);
      });

      it('rejects a schema-invalid payload without touching the database', async () => {
        const bad = { verdict: 'maybe', score: 0.5 };
        await expect(handler.persistNodeResult(makeJob(), bad)).rejects.toThrow();
        expect(mockPrisma.mediaItem.findUnique).not.toHaveBeenCalled();
      });
    });
  });
});
