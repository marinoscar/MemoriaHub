/**
 * Unit tests for PictureEnhancementHandler.
 *
 * Mocking strategy (mirrors video-face-detection.handler.spec.ts /
 * social-media-detection.handler.spec.ts):
 *   - `../storage/processing/image-orientation.util` is module-mocked so
 *     `prepareImageForProcessing` never touches sharp/libvips — it returns a
 *     deterministic "prepared" buffer + dimensions.
 *   - PrismaService, StorageProviderResolver, AiSettingsService,
 *     AiProviderRegistry, and SystemSettingsService are plain jest mocks
 *     (constructed directly, no NestJS TestingModule needed since the handler
 *     has no other DI surface besides EnrichmentHandlerRegistry.register()).
 *
 * Covers:
 *   - type + registration
 *   - missing enhancementId in payload -> warn, no-op
 *   - enhancement row not found -> warn, no-op
 *   - row already in a terminal/non-actionable state (applied/discarded) -> skip
 *   - happy path: processing transition, download + prepare, provider call
 *     shape, staging upload, ready transition with dims/size recorded
 *   - inputFidelity resolution matrix (preserveFaces x strength)
 *   - ineligible MediaItem (deleted / non-photo / missing storageObject /
 *     non-image mime) -> failed + rethrow
 *   - provider without enhanceImage support -> failed + rethrow
 *   - provider.enhanceImage rejection -> failed + rethrow
 */

jest.mock('../storage/processing/image-orientation.util', () => ({
  prepareImageForProcessing: jest.fn().mockResolvedValue({
    buffer: Buffer.from('prepared-jpeg-bytes'),
    width: 800,
    height: 600,
  }),
}));

import { Readable } from 'stream';
import sharp from 'sharp';
import { EnrichmentJob, JobReason, JobStatus, MediaEnhancementStatus, MediaType } from '@prisma/client';
import { PictureEnhancementHandler } from './picture-enhancement.handler';
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';
import { streamToBuffer } from '../storage/processing/processors/stream-utils';
import { RateLimitError } from '../enrichment/rate-limit.error';
import {
  ENRICHMENT_MAX_ATTEMPTS,
  ENRICHMENT_RATELIMIT_MAX_HITS,
} from '../enrichment/enrichment-terminal.service';

const mockPrepareImageForProcessing = prepareImageForProcessing as jest.Mock;

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'picture_enhancement',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.rerun,
    priority: 0,
    providerKey: 'openai',
    modelVersion: 'gpt-image-1',
    payload: { enhancementId: 'enh-1' },
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
  } as EnrichmentJob;
}

function makeEnhancementRow(overrides: Record<string, any> = {}) {
  return {
    id: 'enh-1',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: MediaEnhancementStatus.pending,
    decision: null,
    params: {},
    provider: 'openai',
    model: 'gpt-image-1',
    prompt: 'Enhance this photograph...',
    stagingStorageKey: null,
    stagingProvider: null,
    stagingBucket: null,
    originalWidth: 1200,
    originalHeight: 900,
    enhancedWidth: null,
    enhancedHeight: null,
    enhancedSize: null,
    resultMediaItemId: null,
    lastError: null,
    createdById: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMediaItem(overrides: Record<string, any> = {}) {
  return {
    id: 'media-1',
    type: MediaType.photo,
    deletedAt: null,
    width: 1200,
    height: 900,
    storageObject: {
      storageKey: 'key-1',
      storageProvider: 's3',
      bucket: 'bucket-1',
      mimeType: 'image/jpeg',
    },
    ...overrides,
  };
}

describe('PictureEnhancementHandler', () => {
  let handler: PictureEnhancementHandler;
  let mockRegistry: { register: jest.Mock };
  let mockPrisma: {
    mediaEnhancement: { findUnique: jest.Mock; update: jest.Mock };
    mediaEnhancementBatch: { findUnique: jest.Mock };
    mediaItem: { findUnique: jest.Mock };
  };
  let mockDownload: jest.Mock;
  let mockUpload: jest.Mock;
  let mockObjectProvider: { download: jest.Mock };
  let mockActiveProvider: { upload: jest.Mock; getBucket: jest.Mock };
  let mockResolver: { getProviderFor: jest.Mock; getActiveProvider: jest.Mock };
  let mockAiSettings: { resolveCredentials: jest.Mock };
  let mockEnhanceImage: jest.Mock;
  let mockAiProviderRegistry: { get: jest.Mock };
  let mockSystemSettings: { getSettings: jest.Mock };
  let mockApplyCarryover: jest.Mock;
  let mockExifCarryover: { applyCarryover: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepareImageForProcessing.mockResolvedValue({
      buffer: Buffer.from('prepared-jpeg-bytes'),
      width: 800,
      height: 600,
    });

    mockRegistry = { register: jest.fn() };

    mockPrisma = {
      mediaEnhancement: {
        findUnique: jest.fn().mockResolvedValue(makeEnhancementRow()),
        update: jest.fn().mockResolvedValue({}),
      },
      // Batch-cancellation gate (issue #421). Only consulted when the row
      // carries a batchId; the default row is a single-item enhancement.
      mediaEnhancementBatch: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      mediaItem: {
        findUnique: jest.fn().mockResolvedValue(makeMediaItem()),
      },
    };

    mockDownload = jest.fn().mockResolvedValue(
      Readable.from(Buffer.from('original-bytes')),
    );
    mockObjectProvider = { download: mockDownload };

    mockUpload = jest.fn().mockResolvedValue({});
    mockActiveProvider = {
      upload: mockUpload,
      getBucket: jest.fn().mockReturnValue('active-bucket'),
    };

    mockResolver = {
      getProviderFor: jest.fn().mockResolvedValue(mockObjectProvider),
      getActiveProvider: jest.fn().mockResolvedValue({
        id: 'r2',
        provider: mockActiveProvider,
      }),
    };

    mockAiSettings = {
      resolveCredentials: jest.fn().mockResolvedValue({ apiKey: 'sk-test' }),
    };

    mockEnhanceImage = jest.fn().mockResolvedValue({
      imageBase64: Buffer.from('enhanced-jpeg-bytes').toString('base64'),
      mimeType: 'image/jpeg',
    });
    mockAiProviderRegistry = {
      get: jest.fn().mockReturnValue({ enhanceImage: mockEnhanceImage }),
    };

    mockSystemSettings = {
      getSettings: jest.fn().mockResolvedValue({
        pictureEnhancement: { defaultQuality: 'high', defaultStrength: 'balanced' },
      }),
    };

    // Pass-through default: mirrors the ExifCarryoverService best-effort
    // contract (returns the enhanced buffer unchanged) so tests that don't
    // care about EXIF carryover see identical behavior to before it existed.
    mockApplyCarryover = jest.fn().mockImplementation(async (_original: Buffer, enhanced: Buffer) => enhanced);
    mockExifCarryover = { applyCarryover: mockApplyCarryover };

    handler = new PictureEnhancementHandler(
      mockRegistry as any,
      mockPrisma as any,
      mockResolver as any,
      mockAiSettings as any,
      mockAiProviderRegistry as any,
      mockSystemSettings as any,
      mockExifCarryover as any,
    );
  });

  // -------------------------------------------------------------------------
  // type / registration
  // -------------------------------------------------------------------------

  it('exposes type "picture_enhancement"', () => {
    expect(handler.type).toBe('picture_enhancement');
  });

  it('registers itself with the EnrichmentHandlerRegistry on module init', () => {
    handler.onModuleInit();
    expect(mockRegistry.register).toHaveBeenCalledWith(handler);
  });

  // -------------------------------------------------------------------------
  // Early-return guards
  // -------------------------------------------------------------------------

  describe('early-return guards', () => {
    it('does nothing when payload has no enhancementId', async () => {
      await handler.process(makeJob({ payload: null }));

      expect(mockPrisma.mediaEnhancement.findUnique).not.toHaveBeenCalled();
    });

    it('does nothing when the enhancement row cannot be found', async () => {
      mockPrisma.mediaEnhancement.findUnique.mockResolvedValue(null);

      await handler.process(makeJob());

      expect(mockPrisma.mediaEnhancement.update).not.toHaveBeenCalled();
      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
    });

    it('skips a row that is already applied (superseded / terminal)', async () => {
      mockPrisma.mediaEnhancement.findUnique.mockResolvedValue(
        makeEnhancementRow({ status: MediaEnhancementStatus.applied }),
      );

      await handler.process(makeJob());

      expect(mockPrisma.mediaEnhancement.update).not.toHaveBeenCalled();
      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
    });

    it('skips a row that has been discarded', async () => {
      mockPrisma.mediaEnhancement.findUnique.mockResolvedValue(
        makeEnhancementRow({ status: MediaEnhancementStatus.discarded }),
      );

      await handler.process(makeJob());

      expect(mockPrisma.mediaEnhancement.update).not.toHaveBeenCalled();
    });

    it('proceeds for a row still in "processing" (e.g. re-claimed after a stuck reset)', async () => {
      mockPrisma.mediaEnhancement.findUnique.mockResolvedValue(
        makeEnhancementRow({ status: MediaEnhancementStatus.processing }),
      );

      await handler.process(makeJob());

      expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: MediaEnhancementStatus.processing }) }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('happy path', () => {
    it('transitions the row to processing before doing any work', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledWith({
        where: { id: 'enh-1' },
        data: { status: MediaEnhancementStatus.processing, lastError: null },
      });
    });

    it('downloads the original bytes from the object provider recorded on the StorageObject', async () => {
      await handler.process(makeJob());

      expect(mockResolver.getProviderFor).toHaveBeenCalledWith('s3', 'bucket-1');
      expect(mockDownload).toHaveBeenCalledWith('key-1');
    });

    it('runs the downloaded bytes through prepareImageForProcessing with maxDim 2048', async () => {
      await handler.process(makeJob());

      expect(mockPrepareImageForProcessing).toHaveBeenCalledWith(
        expect.any(Buffer),
        { maxDim: 2048 },
      );
    });

    it('calls provider.enhanceImage with the compiled prompt, resolved size, and quality', async () => {
      await handler.process(makeJob());

      expect(mockAiProviderRegistry.get).toHaveBeenCalledWith('openai');
      expect(mockAiSettings.resolveCredentials).toHaveBeenCalledWith('openai');
      expect(mockEnhanceImage).toHaveBeenCalledWith(
        { apiKey: 'sk-test' },
        expect.objectContaining({
          model: 'gpt-image-1',
          prompt: 'Enhance this photograph...',
          size: '1536x1024', // 1200x900 -> closest to landscape canvas
          quality: 'high',
          outputFormat: 'jpeg',
          outputCompression: 90,
        }),
      );
    });

    it('base64-encodes the prepared image buffer as the request payload', async () => {
      await handler.process(makeJob());

      const [, req] = mockEnhanceImage.mock.calls[0];
      expect(req.imageBase64).toBe(Buffer.from('prepared-jpeg-bytes').toString('base64'));
      expect(req.mimeType).toBe('image/jpeg');
    });

    it('uploads the enhanced bytes to the ACTIVE provider under enhancements/<id>/result.jpg', async () => {
      await handler.process(makeJob());

      expect(mockResolver.getActiveProvider).toHaveBeenCalled();
      expect(mockUpload).toHaveBeenCalledWith(
        'enhancements/enh-1/result.jpg',
        expect.any(Readable),
        expect.objectContaining({ mimeType: 'image/jpeg' }),
      );
    });

    it('records the staged provider/bucket/key and transitions to ready with recorded dims/size', async () => {
      await handler.process(makeJob());

      const readyCall = mockPrisma.mediaEnhancement.update.mock.calls.find(
        (c: any[]) => c[0].data.status === MediaEnhancementStatus.ready,
      );
      expect(readyCall).toBeDefined();
      expect(readyCall![0]).toEqual({
        where: { id: 'enh-1' },
        data: {
          status: MediaEnhancementStatus.ready,
          stagingStorageKey: 'enhancements/enh-1/result.jpg',
          // Null here because the default mock returns the non-decodable stub
          // 'enhanced-jpeg-bytes' — thumbnail generation is best-effort and
          // degrades to null rather than failing the enhancement (issue #203).
          // The decodable-bytes case is covered in "staging thumbnail" below.
          stagingThumbnailKey: null,
          stagingProvider: 'r2',
          stagingBucket: 'active-bucket',
          originalWidth: 1200,
          originalHeight: 900,
          enhancedWidth: 1536,
          enhancedHeight: 1024,
          enhancedSize: BigInt(Buffer.from('enhanced-jpeg-bytes').length),
          lastError: null,
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // inputFidelity resolution matrix (preserveFaces x strength)
  // -------------------------------------------------------------------------

  describe('inputFidelity resolution', () => {
    it('uses "high" fidelity when preserveFaces is true (default), regardless of strength', async () => {
      mockPrisma.mediaEnhancement.findUnique.mockResolvedValue(
        makeEnhancementRow({ params: { strength: 'strong' } }),
      );

      await handler.process(makeJob());

      const [, req] = mockEnhanceImage.mock.calls[0];
      expect(req.inputFidelity).toBe('high');
    });

    it('uses "low" fidelity only when preserveFaces is false AND strength is "strong"', async () => {
      mockPrisma.mediaEnhancement.findUnique.mockResolvedValue(
        makeEnhancementRow({ params: { preserveFaces: false, strength: 'strong' } }),
      );

      await handler.process(makeJob());

      const [, req] = mockEnhanceImage.mock.calls[0];
      expect(req.inputFidelity).toBe('low');
    });

    it('uses "high" fidelity when preserveFaces is false but strength is not "strong"', async () => {
      mockPrisma.mediaEnhancement.findUnique.mockResolvedValue(
        makeEnhancementRow({ params: { preserveFaces: false, strength: 'balanced' } }),
      );

      await handler.process(makeJob());

      const [, req] = mockEnhanceImage.mock.calls[0];
      expect(req.inputFidelity).toBe('high');
    });
  });

  // -------------------------------------------------------------------------
  // Ineligible MediaItem guards
  // -------------------------------------------------------------------------

  describe('ineligible MediaItem', () => {
    it('fails when the MediaItem no longer exists', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      // attempts defaults to 1 (< ENRICHMENT_MAX_ATTEMPTS), so this is a
      // retryable failure — the row must be requeued to pending, not
      // tombstoned as failed, or the automatic retry becomes a silent no-op.
      await expect(handler.process(makeJob())).rejects.toThrow('not an eligible photo');

      expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledWith({
        where: { id: 'enh-1' },
        data: { status: MediaEnhancementStatus.pending, lastError: expect.stringContaining('not an eligible photo') },
      });
    });

    it('fails when the MediaItem is soft-deleted', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(makeMediaItem({ deletedAt: new Date() }));

      await expect(handler.process(makeJob())).rejects.toThrow('not an eligible photo');
    });

    it('fails when the MediaItem is a video (non-photo)', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(makeMediaItem({ type: MediaType.video }));

      await expect(handler.process(makeJob())).rejects.toThrow('not an eligible photo');
    });

    it('fails when the MediaItem has no StorageObject', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(makeMediaItem({ storageObject: null }));

      await expect(handler.process(makeJob())).rejects.toThrow('not an eligible photo');
    });

    it('fails when the underlying object is not an image MIME type', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({
          storageObject: {
            storageKey: 'key-1',
            storageProvider: 's3',
            bucket: 'bucket-1',
            mimeType: 'application/pdf',
          },
        }),
      );

      await expect(handler.process(makeJob())).rejects.toThrow('not an eligible photo');
    });
  });

  // -------------------------------------------------------------------------
  // Provider errors
  // -------------------------------------------------------------------------

  describe('provider errors', () => {
    it('fails when the resolved provider does not implement enhanceImage', async () => {
      mockAiProviderRegistry.get.mockReturnValue({ /* no enhanceImage */ });

      // attempts defaults to 1 (< ENRICHMENT_MAX_ATTEMPTS) — retryable, so the
      // row goes back to pending rather than failed (see commit fixing this).
      await expect(handler.process(makeJob())).rejects.toThrow('does not support image enhancement');

      const pendingCall = mockPrisma.mediaEnhancement.update.mock.calls.find(
        (c: any[]) => c[0].data.status === MediaEnhancementStatus.pending,
      );
      expect(pendingCall).toBeDefined();
      expect(pendingCall![0].data.lastError).toContain('does not support image enhancement');
    });

    it('requeues the row to pending (to retry) and rethrows when provider.enhanceImage rejects', async () => {
      mockEnhanceImage.mockRejectedValue(new Error('OpenAI image edit exploded'));

      // attempts defaults to 1 (< ENRICHMENT_MAX_ATTEMPTS): this is a
      // retryable failure. Previously the row was unconditionally tombstoned
      // as `failed` here, which silently killed all future retries because a
      // requeued job would then early-return on a non-actionable row.
      await expect(handler.process(makeJob())).rejects.toThrow('OpenAI image edit exploded');

      const pendingCall = mockPrisma.mediaEnhancement.update.mock.calls.find(
        (c: any[]) => c[0].data.status === MediaEnhancementStatus.pending,
      );
      expect(pendingCall).toBeDefined();
      expect(pendingCall![0]).toEqual({
        where: { id: 'enh-1' },
        data: { status: MediaEnhancementStatus.pending, lastError: 'OpenAI image edit exploded' },
      });
      // No staging bytes should have been uploaded.
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('never transitions to ready after a provider failure', async () => {
      mockEnhanceImage.mockRejectedValue(new Error('boom'));

      await expect(handler.process(makeJob())).rejects.toThrow('boom');

      const readyCall = mockPrisma.mediaEnhancement.update.mock.calls.find(
        (c: any[]) => c[0].data.status === MediaEnhancementStatus.ready,
      );
      expect(readyCall).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Retry / rate-limit / final-attempt state machine (fixed by commit
  // e27f00c "defer rate-limited enhancements instead of stranding them").
  //
  // The handler mirrors EnrichmentTerminalService.completeFailed's own
  // classification so its `media_enhancements` row status never disagrees
  // with the underlying job's next state:
  //   - retryable, non-final attempt -> row pending, original error rethrown
  //   - retryable, final attempt (attempts >= ENRICHMENT_MAX_ATTEMPTS)
  //     -> row failed
  //   - rate-limited, under the deferral cap -> row pending, RateLimitError
  //     thrown (routes through the queue's rate-limit deferral path)
  //   - rate-limited, deferral cap exhausted (rateLimitHits + 1 >=
  //     ENRICHMENT_RATELIMIT_MAX_HITS) -> row failed
  // -------------------------------------------------------------------------

  describe('retry / rate-limit / final-attempt state machine', () => {
    it('marks the row failed on the final attempt (attempts >= ENRICHMENT_MAX_ATTEMPTS)', async () => {
      mockEnhanceImage.mockRejectedValue(new Error('boom'));

      await expect(
        handler.process(makeJob({ attempts: ENRICHMENT_MAX_ATTEMPTS })),
      ).rejects.toThrow('boom');

      const failedCall = mockPrisma.mediaEnhancement.update.mock.calls.find(
        (c: any[]) => c[0].data.status === MediaEnhancementStatus.failed,
      );
      expect(failedCall).toBeDefined();
      expect(failedCall![0]).toEqual({
        where: { id: 'enh-1' },
        data: { status: MediaEnhancementStatus.failed, lastError: 'boom' },
      });
    });

    it('defers to pending and throws a RateLimitError on a rate-limited failure (non-final attempt)', async () => {
      const rateLimitErr = Object.assign(new Error('Too Many Requests'), { status: 429 });
      mockEnhanceImage.mockRejectedValue(rateLimitErr);

      await expect(
        handler.process(makeJob({ rateLimitHits: 0 })),
      ).rejects.toBeInstanceOf(RateLimitError);

      const pendingCall = mockPrisma.mediaEnhancement.update.mock.calls.find(
        (c: any[]) => c[0].data.status === MediaEnhancementStatus.pending,
      );
      expect(pendingCall).toBeDefined();
      expect(pendingCall![0].data.lastError).toContain('Too Many Requests');
      // A rate-limit deferral must not have been misclassified as a final
      // failure.
      const failedCall = mockPrisma.mediaEnhancement.update.mock.calls.find(
        (c: any[]) => c[0].data.status === MediaEnhancementStatus.failed,
      );
      expect(failedCall).toBeUndefined();
    });

    it('marks the row failed when rate-limit deferrals are exhausted (rateLimitHits + 1 >= ENRICHMENT_RATELIMIT_MAX_HITS)', async () => {
      const rateLimitErr = Object.assign(new Error('Too Many Requests'), { status: 429 });
      mockEnhanceImage.mockRejectedValue(rateLimitErr);

      await expect(
        handler.process(makeJob({ rateLimitHits: ENRICHMENT_RATELIMIT_MAX_HITS - 1 })),
      ).rejects.toBeInstanceOf(RateLimitError);

      const failedCall = mockPrisma.mediaEnhancement.update.mock.calls.find(
        (c: any[]) => c[0].data.status === MediaEnhancementStatus.failed,
      );
      expect(failedCall).toBeDefined();
      expect(failedCall![0].data.lastError).toContain('Too Many Requests');
    });
  });

  // -------------------------------------------------------------------------
  // EXIF carryover gating (commit ff53510 "carry original EXIF onto enhanced
  // images with an AI stamp"). The base `handler` built in the outer
  // beforeEach already has a PASS-THROUGH mock ExifCarryoverService injected
  // (see the outer beforeEach — it returns the enhanced buffer unchanged, so
  // every other test in this file behaves as if carryover were a no-op).
  // These tests build their own handler instance with a mock that returns
  // DISTINGUISHABLE ("stamped-jpeg-bytes") output, so invocation/gating/
  // failure-handling can be asserted precisely without disturbing the
  // pass-through default the rest of the file relies on.
  // -------------------------------------------------------------------------

  describe('EXIF carryover gating', () => {
    let mockApplyCarryover: jest.Mock;
    let mockExifCarryover: { applyCarryover: jest.Mock };
    let handlerWithCarryover: PictureEnhancementHandler;

    beforeEach(() => {
      mockApplyCarryover = jest
        .fn()
        .mockResolvedValue(Buffer.from('stamped-jpeg-bytes'));
      mockExifCarryover = { applyCarryover: mockApplyCarryover };

      handlerWithCarryover = new PictureEnhancementHandler(
        mockRegistry as any,
        mockPrisma as any,
        mockResolver as any,
        mockAiSettings as any,
        mockAiProviderRegistry as any,
        mockSystemSettings as any,
        mockExifCarryover as any,
      );
    });

    it('invokes carryover when stampExif is explicitly true', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        pictureEnhancement: { defaultQuality: 'high', defaultStrength: 'balanced', stampExif: true },
      });

      await handlerWithCarryover.process(makeJob());

      expect(mockApplyCarryover).toHaveBeenCalledTimes(1);
    });

    it('invokes carryover when stampExif is left undefined (defaults to on)', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        pictureEnhancement: { defaultQuality: 'high', defaultStrength: 'balanced' },
      });

      await handlerWithCarryover.process(makeJob());

      expect(mockApplyCarryover).toHaveBeenCalledTimes(1);
    });

    it('skips carryover entirely when stampExif is explicitly false', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        pictureEnhancement: { defaultQuality: 'high', defaultStrength: 'balanced', stampExif: false },
      });

      await handlerWithCarryover.process(makeJob());

      expect(mockApplyCarryover).not.toHaveBeenCalled();
      // Staged bytes are the plain enhanced bytes, never even offered to carryover.
      const [, , uploadOpts] = mockUpload.mock.calls[0];
      expect(uploadOpts).toEqual(expect.objectContaining({ mimeType: 'image/jpeg' }));
    });

    it('passes the model, real output dims, and an extension hint derived from the source mime type', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        pictureEnhancement: { defaultQuality: 'high', defaultStrength: 'balanced', stampExif: true },
      });

      await handlerWithCarryover.process(makeJob());

      expect(mockApplyCarryover).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.any(Buffer),
        expect.objectContaining({ model: 'gpt-image-1', originalExtension: '.jpg' }),
      );
    });

    it('a carryover failure is NON-FATAL: the job still reaches ready, using the UNSTAMPED bytes', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        pictureEnhancement: { defaultQuality: 'high', defaultStrength: 'balanced', stampExif: true },
      });
      mockApplyCarryover.mockRejectedValue(new Error('exiftool exploded'));

      await handlerWithCarryover.process(makeJob());

      const readyCall = mockPrisma.mediaEnhancement.update.mock.calls.find(
        (c: any[]) => c[0].data.status === MediaEnhancementStatus.ready,
      );
      expect(readyCall).toBeDefined();

      // The bytes actually uploaded to staging are the plain (unstamped)
      // enhanced bytes, not the (never-produced) stamped bytes.
      const uploadedStream = mockUpload.mock.calls[0][1];
      const uploadedBuffer = await streamToBuffer(uploadedStream);
      expect(uploadedBuffer.toString()).toBe('enhanced-jpeg-bytes');
    });

    it('falls back to the unstamped bytes when applyCarryover resolves an empty buffer', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        pictureEnhancement: { defaultQuality: 'high', defaultStrength: 'balanced', stampExif: true },
      });
      mockApplyCarryover.mockResolvedValue(Buffer.alloc(0));

      await handlerWithCarryover.process(makeJob());

      const uploadedStream = mockUpload.mock.calls[0][1];
      const uploadedBuffer = await streamToBuffer(uploadedStream);
      expect(uploadedBuffer.toString()).toBe('enhanced-jpeg-bytes');
    });

    it('uploads the STAMPED bytes to staging when carryover succeeds', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        pictureEnhancement: { defaultQuality: 'high', defaultStrength: 'balanced', stampExif: true },
      });

      await handlerWithCarryover.process(makeJob());

      const uploadedStream = mockUpload.mock.calls[0][1];
      const uploadedBuffer = await streamToBuffer(uploadedStream);
      expect(uploadedBuffer.toString()).toBe('stamped-jpeg-bytes');
    });
  });

  // -------------------------------------------------------------------------
  // Actual output dimensions read via sharp (vs. the sizeToDims fallback
  // estimate). The default mock `enhanceImage` returns the non-decodable
  // string 'enhanced-jpeg-bytes', so every OTHER test in this file only ever
  // exercises the fallback path (see the "records the staged provider..."
  // happy-path assertion, which asserts the 1536x1024 REQUESTED canvas size).
  // These tests use a real, sharp-encoded JPEG to exercise the real-dims path.
  // -------------------------------------------------------------------------

  describe('actual output dimensions (real decodable bytes)', () => {
    it('persists the ACTUAL decoded dimensions of the enhanced bytes, not the requested-canvas fallback', async () => {
      const realJpeg = await sharp({
        create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 20, b: 30 } },
      })
        .jpeg()
        .toBuffer();
      mockEnhanceImage.mockResolvedValue({
        imageBase64: realJpeg.toString('base64'),
        mimeType: 'image/jpeg',
      });

      await handler.process(makeJob());

      const readyCall = mockPrisma.mediaEnhancement.update.mock.calls.find(
        (c: any[]) => c[0].data.status === MediaEnhancementStatus.ready,
      );
      expect(readyCall).toBeDefined();
      expect(readyCall![0].data.enhancedWidth).toBe(300);
      expect(readyCall![0].data.enhancedHeight).toBe(200);
      // Distinct from the 1536x1024 canvas fallback that the non-decodable
      // stub bytes produce elsewhere in this file.
      expect(readyCall![0].data.enhancedWidth).not.toBe(1536);
      expect(readyCall![0].data.enhancedHeight).not.toBe(1024);
      expect(readyCall![0].data.enhancedSize).toBe(BigInt(realJpeg.length));
    });
  });

  // -------------------------------------------------------------------------
  // Staging thumbnail derivative (issue #203). Needs REAL decodable bytes,
  // since the renderer runs sharp for real; the default stub bytes elsewhere in
  // this file exercise the best-effort degradation path instead.
  // -------------------------------------------------------------------------

  describe('staging thumbnail', () => {
    async function stageRealJpeg(): Promise<Buffer> {
      const realJpeg = await sharp({
        create: { width: 1200, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } },
      })
        .jpeg()
        .toBuffer();
      mockEnhanceImage.mockResolvedValue({
        imageBase64: realJpeg.toString('base64'),
        mimeType: 'image/jpeg',
      });
      return realJpeg;
    }

    it('uploads a thumbnail derivative alongside the staged result and records its key', async () => {
      await stageRealJpeg();

      await handler.process(makeJob());

      expect(mockUpload).toHaveBeenCalledWith(
        'enhancements/enh-1/thumb.jpg',
        expect.any(Readable),
        expect.objectContaining({
          mimeType: 'image/jpeg',
          // Same immutable caching contract as every other thumbnail.
          cacheControl: 'public, max-age=31536000, immutable',
        }),
      );

      const readyCall = mockPrisma.mediaEnhancement.update.mock.calls.find(
        (c: any[]) => c[0].data.status === MediaEnhancementStatus.ready,
      );
      expect(readyCall![0].data.stagingThumbnailKey).toBe('enhancements/enh-1/thumb.jpg');
    });

    it('the thumbnail is genuinely smaller than the staged full-resolution bytes', async () => {
      const realJpeg = await stageRealJpeg();

      await handler.process(makeJob());

      const thumbCall = mockUpload.mock.calls.find(
        (c: any[]) => c[0] === 'enhancements/enh-1/thumb.jpg',
      );
      const thumbBytes = await streamToBuffer(thumbCall![1]);
      const meta = await sharp(thumbBytes).metadata();
      // Default THUMBNAIL_MAX_DIM is 800; a 1200x900 source must come down.
      expect(meta.width).toBeLessThanOrEqual(800);
      expect(meta.height).toBeLessThanOrEqual(800);
      expect(thumbBytes.length).toBeLessThan(realJpeg.length);
    });

    it('a thumbnail failure is NON-FATAL: the row still reaches ready with a null thumbnail key', async () => {
      // Default (non-decodable) stub bytes: the renderer cannot produce a
      // thumbnail, and the enhancement must survive it untouched.
      await handler.process(makeJob());

      const readyCall = mockPrisma.mediaEnhancement.update.mock.calls.find(
        (c: any[]) => c[0].data.status === MediaEnhancementStatus.ready,
      );
      expect(readyCall).toBeDefined();
      expect(readyCall![0].data.stagingThumbnailKey).toBeNull();
      // The full-resolution result was still staged.
      expect(mockUpload).toHaveBeenCalledWith(
        'enhancements/enh-1/result.jpg',
        expect.any(Readable),
        expect.objectContaining({ mimeType: 'image/jpeg' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Per-run quality override (commit db8648d "add enhancement presets and
  // per-run quality override")
  // -------------------------------------------------------------------------

  describe('per-run quality override', () => {
    it('uses the row params quality over the system-setting default when both are present', async () => {
      mockPrisma.mediaEnhancement.findUnique.mockResolvedValue(
        makeEnhancementRow({ params: { quality: 'low' } }),
      );
      mockSystemSettings.getSettings.mockResolvedValue({
        pictureEnhancement: { defaultQuality: 'high', defaultStrength: 'balanced' },
      });

      await handler.process(makeJob());

      const [, req] = mockEnhanceImage.mock.calls[0];
      expect(req.quality).toBe('low');
    });

    it('falls back to the system-setting default quality when no per-run override is present', async () => {
      mockPrisma.mediaEnhancement.findUnique.mockResolvedValue(makeEnhancementRow({ params: {} }));
      mockSystemSettings.getSettings.mockResolvedValue({
        pictureEnhancement: { defaultQuality: 'medium', defaultStrength: 'balanced' },
      });

      await handler.process(makeJob());

      const [, req] = mockEnhanceImage.mock.calls[0];
      expect(req.quality).toBe('medium');
    });

    it('falls back to "high" when neither a per-run override nor a system-setting default is present', async () => {
      mockPrisma.mediaEnhancement.findUnique.mockResolvedValue(makeEnhancementRow({ params: {} }));
      mockSystemSettings.getSettings.mockResolvedValue({ pictureEnhancement: {} });

      await handler.process(makeJob());

      const [, req] = mockEnhanceImage.mock.calls[0];
      expect(req.quality).toBe('high');
    });
  });
});

// Sanity: ensure streamToBuffer is the real implementation (not mocked) so the
// download-buffering assertions above reflect real stream-draining behavior.
describe('streamToBuffer sanity (used internally by the handler)', () => {
  it('concatenates a Readable into a single Buffer', async () => {
    const buf = await streamToBuffer(Readable.from(Buffer.from('abc')));
    expect(buf.toString()).toBe('abc');
  });
});
