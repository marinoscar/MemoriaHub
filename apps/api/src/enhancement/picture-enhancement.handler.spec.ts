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
import { EnrichmentJob, JobReason, JobStatus, MediaEnhancementStatus, MediaType } from '@prisma/client';
import { PictureEnhancementHandler } from './picture-enhancement.handler';
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';
import { streamToBuffer } from '../storage/processing/processors/stream-utils';

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

    handler = new PictureEnhancementHandler(
      mockRegistry as any,
      mockPrisma as any,
      mockResolver as any,
      mockAiSettings as any,
      mockAiProviderRegistry as any,
      mockSystemSettings as any,
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

      await expect(handler.process(makeJob())).rejects.toThrow('not an eligible photo');

      expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledWith({
        where: { id: 'enh-1' },
        data: { status: MediaEnhancementStatus.failed, lastError: expect.stringContaining('not an eligible photo') },
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

      await expect(handler.process(makeJob())).rejects.toThrow('does not support image enhancement');

      const failedCall = mockPrisma.mediaEnhancement.update.mock.calls.find(
        (c: any[]) => c[0].data.status === MediaEnhancementStatus.failed,
      );
      expect(failedCall).toBeDefined();
      expect(failedCall![0].data.lastError).toContain('does not support image enhancement');
    });

    it('marks the row failed and rethrows when provider.enhanceImage rejects', async () => {
      mockEnhanceImage.mockRejectedValue(new Error('OpenAI image edit exploded'));

      await expect(handler.process(makeJob())).rejects.toThrow('OpenAI image edit exploded');

      const failedCall = mockPrisma.mediaEnhancement.update.mock.calls.find(
        (c: any[]) => c[0].data.status === MediaEnhancementStatus.failed,
      );
      expect(failedCall).toBeDefined();
      expect(failedCall![0]).toEqual({
        where: { id: 'enh-1' },
        data: { status: MediaEnhancementStatus.failed, lastError: 'OpenAI image edit exploded' },
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
});

// Sanity: ensure streamToBuffer is the real implementation (not mocked) so the
// download-buffering assertions above reflect real stream-draining behavior.
describe('streamToBuffer sanity (used internally by the handler)', () => {
  it('concatenates a Readable into a single Buffer', async () => {
    const buf = await streamToBuffer(Readable.from(Buffer.from('abc')));
    expect(buf.toString()).toBe('abc');
  });
});
