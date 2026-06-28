/**
 * Unit tests for SocialDetectionService.
 *
 * All external dependencies are mocked:
 *   - PrismaService (via createMockPrismaService)
 *   - StorageProviderResolver
 *   - VideoProbeProcessor
 *   - SystemSettingsService
 *   - SocialOcrService
 *
 * No real DB or file I/O is required.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobReason, MediaSocialStatusType } from '@prisma/client';
import { SocialDetectionService } from './social-detection.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { VideoProbeProcessor } from '../storage/processing/processors/video-probe.processor';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { SocialOcrService } from './social-ocr.service';
import { MediaEnrichmentService } from '../media/enrichment/media-enrichment.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<{
  id: string;
  mediaItemId: string | null;
  circleId: string | null;
  reason: JobReason;
}> = {}) {
  return {
    id: 'job-social-1',
    type: 'social_media_detection',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    reason: JobReason.upload,
    ...overrides,
  } as any;
}

/** Build a minimal mediaItem row as Prisma would return from findUnique. */
function makeMediaItem(overrides: Partial<any> = {}) {
  return {
    id: 'media-1',
    circleId: 'circle-1',
    deletedAt: null,
    type: 'video',
    originalFilename: 'clip.mp4',
    addedById: 'user-1',
    cameraMake: null,
    cameraModel: null,
    takenLat: null,
    takenLng: null,
    width: 1080,
    height: 1920,
    durationMs: 30000,
    storageObject: {
      id: 'so-1',
      storageKey: 'videos/clip.mp4',
      storageProvider: 's3',
      bucket: 'test-bucket',
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      metadata: {
        _processing: {
          'video-probe': {
            durationMs: 30000,
            width: 1080,
            height: 1920,
            codec: 'h264',
            containerTags: { encoder: 'tiktok_encoder' },
            hasContainerCreationTime: false,
          },
        },
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SocialDetectionService', () => {
  let service: SocialDetectionService;
  let mockPrisma: MockPrismaService;
  let mockResolver: { getProviderFor: jest.Mock };
  let mockVideoProbeProcessor: { process: jest.Mock };
  let mockSystemSettings: { getSettings: jest.Mock };
  let mockSocialOcrService: { extractOcrText: jest.Mock };
  let mockMediaEnrichmentService: { enqueueVideoFaceIfEligible: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    // $transaction executes the callback immediately with mockPrisma as the tx
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => {
      if (typeof fn === 'function') return fn(mockPrisma);
      return fn;
    });

    mockResolver = {
      getProviderFor: jest.fn().mockResolvedValue({
        download: jest.fn().mockResolvedValue(require('stream').Readable.from([])),
      }),
    };

    mockVideoProbeProcessor = {
      process: jest.fn().mockResolvedValue({ success: false, error: 'not called' }),
    };

    mockSystemSettings = {
      getSettings: jest.fn().mockResolvedValue({
        social: { ocr: { enabled: true, frameCount: 3 } },
      }),
    };

    mockSocialOcrService = {
      extractOcrText: jest.fn().mockResolvedValue(''),
    };

    mockMediaEnrichmentService = {
      enqueueVideoFaceIfEligible: jest.fn().mockResolvedValue(undefined),
    };

    // Default Prisma mock returns
    (mockPrisma.mediaSocialStatus.upsert as jest.Mock).mockResolvedValue({} as any);
    (mockPrisma.tag.upsert as jest.Mock).mockResolvedValue({ id: 'tag-1' } as any);
    (mockPrisma.mediaTag.upsert as jest.Mock).mockResolvedValue({} as any);
    (mockPrisma.mediaTag.deleteMany as jest.Mock).mockResolvedValue({ count: 0 } as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SocialDetectionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageProviderResolver, useValue: mockResolver },
        { provide: VideoProbeProcessor, useValue: mockVideoProbeProcessor },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
        { provide: SocialOcrService, useValue: mockSocialOcrService },
        { provide: MediaEnrichmentService, useValue: mockMediaEnrichmentService },
      ],
    }).compile();

    service = module.get<SocialDetectionService>(SocialDetectionService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Guard: missing mediaItemId
  // ---------------------------------------------------------------------------

  describe('mediaItemId guard', () => {
    it('throws when job has no mediaItemId', async () => {
      const job = makeJob({ mediaItemId: null });
      await expect(service.processMediaItem(job)).rejects.toThrow(/missing mediaItemId/);
    });
  });

  // ---------------------------------------------------------------------------
  // Skip: missing, deleted, or no storageObject
  // ---------------------------------------------------------------------------

  describe('graceful skip paths', () => {
    it('marks failed (not throws) when mediaItem is not found', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      // Should NOT throw
      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaSocialStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: MediaSocialStatusType.failed }),
          update: expect.objectContaining({ status: MediaSocialStatusType.failed }),
        }),
      );
    });

    it('marks failed when mediaItem is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaSocialStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: MediaSocialStatusType.failed }),
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Non-video MIME type
  // ---------------------------------------------------------------------------

  describe('non-video MIME type', () => {
    it('marks processed with detected=false for image/* without running detection', async () => {
      const imgItem = makeMediaItem({
        storageObject: {
          ...makeMediaItem().storageObject,
          mimeType: 'image/jpeg',
        },
      });
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(imgItem);

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaSocialStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: MediaSocialStatusType.processed,
            detected: false,
          }),
          update: expect.objectContaining({
            status: MediaSocialStatusType.processed,
            detected: false,
          }),
        }),
      );
      // VideoProbeProcessor must not be called for non-video
      expect(mockVideoProbeProcessor.process).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Detected path: upserts Tag(isSystem) + MediaTag(source:system)
  // ---------------------------------------------------------------------------

  describe('detected path', () => {
    beforeEach(() => {
      // TikTok detected via containerTags
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
    });

    it('upserts Tag with isSystem:true for each detected tag name', async () => {
      await service.processMediaItem(makeJob());

      // For TikTok detection we expect tag upserts for 'Social Media' AND 'TikTok'
      const tagUpsertCalls = (mockPrisma.tag.upsert as jest.Mock).mock.calls;
      expect(tagUpsertCalls.length).toBeGreaterThanOrEqual(2);

      const socialMediaCall = tagUpsertCalls.find(
        (c: any[]) => c[0].create?.name === 'Social Media',
      );
      expect(socialMediaCall).toBeDefined();
      expect(socialMediaCall![0].create.isSystem).toBe(true);

      const tikTokCall = tagUpsertCalls.find(
        (c: any[]) => c[0].create?.name === 'TikTok',
      );
      expect(tikTokCall).toBeDefined();
      expect(tikTokCall![0].create.isSystem).toBe(true);
    });

    it('upserts MediaTag with source:system for each tag', async () => {
      await service.processMediaItem(makeJob());

      const mediaTagCalls = (mockPrisma.mediaTag.upsert as jest.Mock).mock.calls;
      expect(mediaTagCalls.length).toBeGreaterThanOrEqual(2);

      for (const call of mediaTagCalls) {
        expect(call[0].create.source).toBe('system');
      }
    });

    it('upserts mediaSocialStatus with status=processed, detected=true, platform=tiktok', async () => {
      await service.processMediaItem(makeJob());

      const statusCalls = (mockPrisma.mediaSocialStatus.upsert as jest.Mock).mock.calls;
      const processedCall = statusCalls.find(
        (c: any[]) => c[0].create?.status === MediaSocialStatusType.processed,
      );
      expect(processedCall).toBeDefined();
      expect(processedCall![0].create.detected).toBe(true);
      expect(processedCall![0].create.platform).toBe('tiktok');
      expect(processedCall![0].create.score).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Flip-to-not-detected on rerun
  // ---------------------------------------------------------------------------

  describe('not-detected path (rerun result)', () => {
    /**
     * Build an item that clearly scores below the detection threshold:
     *  - Landscape dimensions (aspect ratio 1.78) → no portrait bonus (+2)
     *  - Camera make + model present → no camera-missing bonus (+2)
     *  - Has GPS → no GPS-missing bonus (+1)
     *  - Has container creation_time → no missing-timestamp bonus (+1)
     *  - No Lavf encoder → no encoder bonus (+1)
     *  - Camera-prefixed filename → no suspicious filename bonus (+1)
     * Score = 0 → not detected.
     */
    function makeCameraOriginalItem() {
      return makeMediaItem({
        originalFilename: 'PXL_20240101_120000.mp4',
        cameraMake: 'Google',
        cameraModel: 'Pixel 8',
        width: 1920,
        height: 1080,
        takenLat: 9.9281,
        takenLng: -84.0907,
        storageObject: {
          ...makeMediaItem().storageObject,
          name: 'PXL_20240101_120000.mp4',
          metadata: {
            _processing: {
              'video-probe': {
                durationMs: 10000,
                width: 1920,
                height: 1080,
                codec: 'h264',
                containerTags: {},
                hasContainerCreationTime: true,
              },
            },
          },
        },
      });
    }

    it('calls mediaTag.deleteMany for system-sourced tags when detection returns false', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeCameraOriginalItem());
      // Disable OCR so we don't accidentally flip via OCR
      mockSystemSettings.getSettings.mockResolvedValue({
        social: { ocr: { enabled: false } },
      });

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaTag.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            mediaItemId: 'media-1',
            source: 'system',
          }),
        }),
      );
    });

    it('marks mediaSocialStatus with detected=false when not detected', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeCameraOriginalItem());
      mockSystemSettings.getSettings.mockResolvedValue({
        social: { ocr: { enabled: false } },
      });

      await service.processMediaItem(makeJob());

      const statusCalls = (mockPrisma.mediaSocialStatus.upsert as jest.Mock).mock.calls;
      const processedCall = statusCalls.find(
        (c: any[]) => c[0].create?.status === MediaSocialStatusType.processed,
      );
      expect(processedCall).toBeDefined();
      expect(processedCall![0].create.detected).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Legacy fallback: VideoProbeProcessor called when containerTags absent
  // ---------------------------------------------------------------------------

  describe('legacy fallback — re-probe', () => {
    it('calls VideoProbeProcessor.process when containerTags absent in stored metadata', async () => {
      const itemWithoutContainerTags = makeMediaItem({
        storageObject: {
          ...makeMediaItem().storageObject,
          metadata: {
            _processing: {
              'video-probe': {
                durationMs: 30000,
                width: 1080,
                height: 1920,
                // No containerTags key → triggers fallback
              },
            },
          },
        },
      });
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(itemWithoutContainerTags);

      // Probe returns containerTags that will detect TikTok
      mockVideoProbeProcessor.process.mockResolvedValue({
        success: true,
        metadata: {
          durationMs: 30000,
          containerTags: { encoder: 'tiktok_encoder_v2' },
          hasContainerCreationTime: false,
        },
      });

      await service.processMediaItem(makeJob());

      expect(mockVideoProbeProcessor.process).toHaveBeenCalled();
    });

    it('does NOT call VideoProbeProcessor when containerTags already present in metadata', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await service.processMediaItem(makeJob());

      expect(mockVideoProbeProcessor.process).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Tiered OCR logic
  // ---------------------------------------------------------------------------

  describe('tiered OCR', () => {
    beforeEach(() => {
      // Item with no strong platform signal — use a generic vertical video
      const genericItem = makeMediaItem({
        originalFilename: '9876543210.mp4',
        cameraMake: null,
        cameraModel: null,
        storageObject: {
          ...makeMediaItem().storageObject,
          name: '9876543210.mp4',
          metadata: {
            _processing: {
              'video-probe': {
                durationMs: 30000,
                width: 1080,
                height: 1920,
                codec: 'h264',
                containerTags: {},
                hasContainerCreationTime: false,
              },
            },
          },
        },
      });
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(genericItem);
    });

    it('calls OCR when no confident platform detected AND ocr.enabled is true', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        social: { ocr: { enabled: true, frameCount: 3 } },
      });
      mockSocialOcrService.extractOcrText.mockResolvedValue('');

      await service.processMediaItem(makeJob());

      expect(mockSocialOcrService.extractOcrText).toHaveBeenCalled();
    });

    it('does NOT call OCR when ocr.enabled is explicitly false', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        social: { ocr: { enabled: false } },
      });

      await service.processMediaItem(makeJob());

      expect(mockSocialOcrService.extractOcrText).not.toHaveBeenCalled();
    });

    it('does NOT call OCR when a platform was already matched in first pass', async () => {
      // Item with clear TikTok filename — first pass detects platform
      const tiktokItem = makeMediaItem({
        originalFilename: '7289341056123456789.mp4',
        storageObject: {
          ...makeMediaItem().storageObject,
          name: '7289341056123456789.mp4',
          metadata: {
            _processing: {
              'video-probe': {
                durationMs: 30000,
                containerTags: {},
                hasContainerCreationTime: false,
              },
            },
          },
        },
      });
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(tiktokItem);

      await service.processMediaItem(makeJob());

      // Platform was already detected — OCR should NOT be called
      expect(mockSocialOcrService.extractOcrText).not.toHaveBeenCalled();
    });

    it('upgrades to platform when OCR text returns tiktok keyword', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        social: { ocr: { enabled: true, frameCount: 2 } },
      });
      // OCR finds TikTok text
      mockSocialOcrService.extractOcrText.mockResolvedValue('follow me on tiktok today');

      await service.processMediaItem(makeJob());

      // Final status should show tiktok platform
      const statusCalls = (mockPrisma.mediaSocialStatus.upsert as jest.Mock).mock.calls;
      const processedCall = statusCalls.find(
        (c: any[]) => c[0].create?.status === MediaSocialStatusType.processed,
      );
      expect(processedCall![0].create.platform).toBe('tiktok');
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling → markFailed + rethrow
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('marks status failed and rethrows when an unexpected error occurs during processing', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      // Force an error inside the transaction
      (mockPrisma.$transaction as jest.Mock).mockRejectedValue(new Error('DB explosion'));

      await expect(service.processMediaItem(makeJob())).rejects.toThrow('DB explosion');

      expect(mockPrisma.mediaSocialStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: MediaSocialStatusType.failed }),
          update: expect.objectContaining({ status: MediaSocialStatusType.failed }),
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 2: social gate chain — enqueueVideoFaceIfEligible
  // ---------------------------------------------------------------------------

  describe('social gate chain (Phase 2)', () => {
    /**
     * Build a camera-original item that scores below the detection threshold
     * so the "not detected" path is exercised.
     */
    function makeCameraOriginalItem() {
      return makeMediaItem({
        originalFilename: 'PXL_20240101_120000.mp4',
        cameraMake: 'Google',
        cameraModel: 'Pixel 8',
        width: 1920,
        height: 1080,
        takenLat: 9.9281,
        takenLng: -84.0907,
        storageObject: {
          ...makeMediaItem().storageObject,
          name: 'PXL_20240101_120000.mp4',
          metadata: {
            _processing: {
              'video-probe': {
                durationMs: 10000,
                width: 1920,
                height: 1080,
                codec: 'h264',
                containerTags: {},
                hasContainerCreationTime: true,
              },
            },
          },
        },
      });
    }

    beforeEach(() => {
      mockSystemSettings.getSettings.mockResolvedValue({
        social: { ocr: { enabled: false } },
      });
    });

    it('calls enqueueVideoFaceIfEligible when job.reason=upload and item is NOT detected', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeCameraOriginalItem());

      const uploadJob = makeJob({ reason: JobReason.upload });
      await service.processMediaItem(uploadJob);

      expect(mockMediaEnrichmentService.enqueueVideoFaceIfEligible).toHaveBeenCalledWith({
        id: 'media-1',
        circleId: 'circle-1',
        type: 'video',
        deletedAt: null,
      });
    });

    it('does NOT call enqueueVideoFaceIfEligible when detected=true (social media clip)', async () => {
      // TikTok item is detected
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      const uploadJob = makeJob({ reason: JobReason.upload });
      await service.processMediaItem(uploadJob);

      expect(mockMediaEnrichmentService.enqueueVideoFaceIfEligible).not.toHaveBeenCalled();
    });

    it('does NOT call enqueueVideoFaceIfEligible when job.reason=rerun (even if not detected)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeCameraOriginalItem());

      const rerunJob = makeJob({ reason: JobReason.rerun });
      await service.processMediaItem(rerunJob);

      expect(mockMediaEnrichmentService.enqueueVideoFaceIfEligible).not.toHaveBeenCalled();
    });

    it('does NOT call enqueueVideoFaceIfEligible when job.reason=backfill (even if not detected)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeCameraOriginalItem());

      const backfillJob = makeJob({ reason: JobReason.backfill });
      await service.processMediaItem(backfillJob);

      expect(mockMediaEnrichmentService.enqueueVideoFaceIfEligible).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // getSupportedTagNames
  // ---------------------------------------------------------------------------

  describe('getSupportedTagNames', () => {
    it('returns a list including Social Media and all platform tag names', () => {
      const names = service.getSupportedTagNames();
      expect(names).toContain('Social Media');
      expect(names).toContain('TikTok');
      expect(names).toContain('Instagram');
      expect(names).toContain('Facebook');
      expect(names).toContain('WhatsApp');
    });

    it('returns a copy (not the module-level reference)', () => {
      const a = service.getSupportedTagNames();
      const b = service.getSupportedTagNames();
      expect(a).not.toBe(b); // different array instances
      expect(a).toEqual(b);
    });
  });
});
