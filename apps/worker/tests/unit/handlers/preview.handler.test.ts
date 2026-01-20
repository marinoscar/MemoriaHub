import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessingJob, MediaAsset } from '@memoriahub/shared';
import type { JobContext } from '../../../src/core/job-context.js';
import { Readable } from 'stream';

// Mock dependencies
vi.mock('../../../src/repositories/index.js', () => ({
  mediaAssetRepository: {
    findById: vi.fn(),
    updatePreviewKey: vi.fn(),
    hasDerivatives: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('../../../src/infrastructure/storage/index.js', () => ({
  s3StorageProvider: {
    getObject: vi.fn(),
    putObject: vi.fn(),
  },
}));

vi.mock('../../../src/processors/index.js', () => ({
  imageProcessor: {
    generatePreview: vi.fn(),
    extractFirstFrame: vi.fn(),
  },
  videoProcessor: {
    extractFrame: vi.fn(),
    cleanupFrame: vi.fn(),
  },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn(),
}));

import { previewHandler } from '../../../src/handlers/preview.handler.js';
import { mediaAssetRepository } from '../../../src/repositories/index.js';
import { s3StorageProvider } from '../../../src/infrastructure/storage/index.js';
import { imageProcessor, videoProcessor } from '../../../src/processors/index.js';
import * as fs from 'fs/promises';

describe('PreviewHandler', () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  function createMockJob(overrides?: Partial<ProcessingJob>): ProcessingJob {
    return {
      id: 'job-123',
      assetId: 'asset-456',
      jobType: 'generate_preview',
      queue: 'default',
      priority: 1,
      payload: {},
      status: 'processing',
      attempts: 1,
      maxAttempts: 3,
      lastError: null,
      workerId: 'worker-1',
      result: null,
      traceId: 'trace-789',
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
      nextRetryAt: null,
      ...overrides,
    };
  }

  function createMockContext(job?: ProcessingJob): JobContext {
    return {
      job: job || createMockJob(),
      logger: mockLogger as unknown as import('pino').Logger,
      workerId: 'worker-1',
      startTime: Date.now(),
      getElapsedMs: () => Date.now() - Date.now(),
      abortSignal: new AbortController().signal,
    };
  }

  function createMockAsset(overrides?: Partial<MediaAsset>): MediaAsset {
    return {
      id: 'asset-456',
      ownerId: 'owner-123',
      storageKey: 'users/owner-123/originals/asset-456.jpg',
      storageBucket: 'memoriahub',
      thumbnailKey: null,
      previewKey: null,
      originalFilename: 'photo.jpg',
      mediaType: 'image',
      mimeType: 'image/jpeg',
      fileSize: 1024000,
      fileSource: 'web',
      width: 3000,
      height: 2000,
      durationSeconds: null,
      cameraMake: null,
      cameraModel: null,
      latitude: null,
      longitude: null,
      country: null,
      state: null,
      city: null,
      locationName: null,
      capturedAtUtc: null,
      timezoneOffset: null,
      exifData: {},
      faces: [],
      tags: [],
      status: 'UPLOADED',
      errorMessage: null,
      traceId: 'trace-789',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function createReadableStream(data: Buffer): Readable {
    const stream = new Readable();
    stream.push(data);
    stream.push(null);
    return stream;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('jobType', () => {
    it('has correct job type', () => {
      expect(previewHandler.jobType).toBe('generate_preview');
    });
  });

  describe('process', () => {
    it('generates preview for static image maintaining aspect ratio', async () => {
      const context = createMockContext();
      const asset = createMockAsset();
      const originalBuffer = Buffer.from('original image data');
      const previewBuffer = Buffer.from('preview data');

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(asset);
      vi.mocked(s3StorageProvider.getObject).mockResolvedValue({
        body: createReadableStream(originalBuffer),
        contentType: 'image/jpeg',
        contentLength: originalBuffer.length,
      });
      vi.mocked(imageProcessor.generatePreview).mockResolvedValue({
        buffer: previewBuffer,
        width: 1200,
        height: 800,
        format: 'jpeg',
        size: previewBuffer.length,
      });
      vi.mocked(s3StorageProvider.putObject).mockResolvedValue(undefined);
      vi.mocked(mediaAssetRepository.updatePreviewKey).mockResolvedValue(asset);
      vi.mocked(mediaAssetRepository.hasDerivatives).mockResolvedValue(false);

      const result = await previewHandler.process(context);

      expect(mediaAssetRepository.findById).toHaveBeenCalledWith('asset-456');
      expect(s3StorageProvider.getObject).toHaveBeenCalledWith(
        'memoriahub',
        'users/owner-123/originals/asset-456.jpg'
      );
      expect(imageProcessor.generatePreview).toHaveBeenCalledWith(originalBuffer);
      expect(s3StorageProvider.putObject).toHaveBeenCalledWith(
        'memoriahub',
        'users/owner-123/previews/asset-456.jpg',
        previewBuffer,
        expect.objectContaining({
          contentType: 'image/jpeg',
        })
      );
      expect(mediaAssetRepository.updatePreviewKey).toHaveBeenCalledWith(
        'asset-456',
        'users/owner-123/previews/asset-456.jpg'
      );

      expect(result.outputKey).toBe('users/owner-123/previews/asset-456.jpg');
      expect(result.outputSize).toBe(previewBuffer.length);
      expect(result.outputWidth).toBe(1200);
      expect(result.outputHeight).toBe(800);
    });

    it('extracts first frame from animated GIF before generating preview', async () => {
      const context = createMockContext();
      const asset = createMockAsset({
        mimeType: 'image/gif',
      });
      const originalBuffer = Buffer.from('animated gif data');
      const firstFrameBuffer = Buffer.from('first frame');
      const previewBuffer = Buffer.from('preview data');

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(asset);
      vi.mocked(s3StorageProvider.getObject).mockResolvedValue({
        body: createReadableStream(originalBuffer),
        contentType: 'image/gif',
        contentLength: originalBuffer.length,
      });
      vi.mocked(imageProcessor.extractFirstFrame).mockResolvedValue(firstFrameBuffer);
      vi.mocked(imageProcessor.generatePreview).mockResolvedValue({
        buffer: previewBuffer,
        width: 1200,
        height: 800,
        format: 'jpeg',
        size: previewBuffer.length,
      });
      vi.mocked(s3StorageProvider.putObject).mockResolvedValue(undefined);
      vi.mocked(mediaAssetRepository.updatePreviewKey).mockResolvedValue(asset);
      vi.mocked(mediaAssetRepository.hasDerivatives).mockResolvedValue(false);

      await previewHandler.process(context);

      expect(imageProcessor.extractFirstFrame).toHaveBeenCalledWith(originalBuffer);
      expect(imageProcessor.generatePreview).toHaveBeenCalledWith(firstFrameBuffer);
    });

    it('extracts first frame from animated WebP before generating preview', async () => {
      const context = createMockContext();
      const asset = createMockAsset({
        mimeType: 'image/webp',
      });
      const originalBuffer = Buffer.from('animated webp data');
      const firstFrameBuffer = Buffer.from('first frame');
      const previewBuffer = Buffer.from('preview data');

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(asset);
      vi.mocked(s3StorageProvider.getObject).mockResolvedValue({
        body: createReadableStream(originalBuffer),
        contentType: 'image/webp',
        contentLength: originalBuffer.length,
      });
      vi.mocked(imageProcessor.extractFirstFrame).mockResolvedValue(firstFrameBuffer);
      vi.mocked(imageProcessor.generatePreview).mockResolvedValue({
        buffer: previewBuffer,
        width: 1200,
        height: 800,
        format: 'jpeg',
        size: previewBuffer.length,
      });
      vi.mocked(s3StorageProvider.putObject).mockResolvedValue(undefined);
      vi.mocked(mediaAssetRepository.updatePreviewKey).mockResolvedValue(asset);
      vi.mocked(mediaAssetRepository.hasDerivatives).mockResolvedValue(false);

      await previewHandler.process(context);

      expect(imageProcessor.extractFirstFrame).toHaveBeenCalledWith(originalBuffer);
      expect(imageProcessor.generatePreview).toHaveBeenCalledWith(firstFrameBuffer);
    });

    it('extracts frame from video before generating preview', async () => {
      const context = createMockContext();
      const asset = createMockAsset({
        mediaType: 'video',
        mimeType: 'video/mp4',
      });
      const originalBuffer = Buffer.from('video data');
      const frameBuffer = Buffer.from('video frame');
      const previewBuffer = Buffer.from('preview data');

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(asset);
      vi.mocked(s3StorageProvider.getObject).mockResolvedValue({
        body: createReadableStream(originalBuffer),
        contentType: 'video/mp4',
        contentLength: originalBuffer.length,
      });
      vi.mocked(videoProcessor.extractFrame).mockResolvedValue({
        framePath: '/tmp/frame-123.jpg',
        timestamp: 1,
        durationSeconds: 60,
      });
      vi.mocked(fs.readFile).mockResolvedValue(frameBuffer);
      vi.mocked(videoProcessor.cleanupFrame).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      vi.mocked(imageProcessor.generatePreview).mockResolvedValue({
        buffer: previewBuffer,
        width: 1200,
        height: 675,
        format: 'jpeg',
        size: previewBuffer.length,
      });
      vi.mocked(s3StorageProvider.putObject).mockResolvedValue(undefined);
      vi.mocked(mediaAssetRepository.updatePreviewKey).mockResolvedValue(asset);
      vi.mocked(mediaAssetRepository.hasDerivatives).mockResolvedValue(false);

      await previewHandler.process(context);

      expect(videoProcessor.extractFrame).toHaveBeenCalled();
      expect(fs.readFile).toHaveBeenCalledWith('/tmp/frame-123.jpg');
      expect(videoProcessor.cleanupFrame).toHaveBeenCalledWith('/tmp/frame-123.jpg');
      expect(imageProcessor.generatePreview).toHaveBeenCalledWith(frameBuffer);
    });

    it('updates asset status to DERIVATIVES_READY when all derivatives are complete', async () => {
      const context = createMockContext();
      const asset = createMockAsset();
      const originalBuffer = Buffer.from('original image data');
      const previewBuffer = Buffer.from('preview data');

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(asset);
      vi.mocked(s3StorageProvider.getObject).mockResolvedValue({
        body: createReadableStream(originalBuffer),
        contentType: 'image/jpeg',
        contentLength: originalBuffer.length,
      });
      vi.mocked(imageProcessor.generatePreview).mockResolvedValue({
        buffer: previewBuffer,
        width: 1200,
        height: 800,
        format: 'jpeg',
        size: previewBuffer.length,
      });
      vi.mocked(s3StorageProvider.putObject).mockResolvedValue(undefined);
      vi.mocked(mediaAssetRepository.updatePreviewKey).mockResolvedValue(asset);
      vi.mocked(mediaAssetRepository.hasDerivatives).mockResolvedValue(true); // Both derivatives exist

      await previewHandler.process(context);

      expect(mediaAssetRepository.hasDerivatives).toHaveBeenCalledWith('asset-456');
      expect(mediaAssetRepository.updateStatus).toHaveBeenCalledWith('asset-456', 'DERIVATIVES_READY');
    });

    it('does not update status when derivatives are not complete', async () => {
      const context = createMockContext();
      const asset = createMockAsset();
      const originalBuffer = Buffer.from('original image data');
      const previewBuffer = Buffer.from('preview data');

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(asset);
      vi.mocked(s3StorageProvider.getObject).mockResolvedValue({
        body: createReadableStream(originalBuffer),
        contentType: 'image/jpeg',
        contentLength: originalBuffer.length,
      });
      vi.mocked(imageProcessor.generatePreview).mockResolvedValue({
        buffer: previewBuffer,
        width: 1200,
        height: 800,
        format: 'jpeg',
        size: previewBuffer.length,
      });
      vi.mocked(s3StorageProvider.putObject).mockResolvedValue(undefined);
      vi.mocked(mediaAssetRepository.updatePreviewKey).mockResolvedValue(asset);
      vi.mocked(mediaAssetRepository.hasDerivatives).mockResolvedValue(false); // Thumbnail still missing

      await previewHandler.process(context);

      expect(mediaAssetRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('throws error when asset is not found', async () => {
      const context = createMockContext();

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(null);

      await expect(previewHandler.process(context)).rejects.toThrow(
        'Asset not found: asset-456'
      );
    });

    it('throws error when image processing fails', async () => {
      const context = createMockContext();
      const asset = createMockAsset();
      const originalBuffer = Buffer.from('original image data');

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(asset);
      vi.mocked(s3StorageProvider.getObject).mockResolvedValue({
        body: createReadableStream(originalBuffer),
        contentType: 'image/jpeg',
        contentLength: originalBuffer.length,
      });
      vi.mocked(imageProcessor.generatePreview).mockRejectedValue(
        new Error('Image processing failed')
      );

      await expect(previewHandler.process(context)).rejects.toThrow(
        'Image processing failed'
      );
    });

    it('throws error when S3 upload fails', async () => {
      const context = createMockContext();
      const asset = createMockAsset();
      const originalBuffer = Buffer.from('original image data');
      const previewBuffer = Buffer.from('preview data');

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(asset);
      vi.mocked(s3StorageProvider.getObject).mockResolvedValue({
        body: createReadableStream(originalBuffer),
        contentType: 'image/jpeg',
        contentLength: originalBuffer.length,
      });
      vi.mocked(imageProcessor.generatePreview).mockResolvedValue({
        buffer: previewBuffer,
        width: 1200,
        height: 800,
        format: 'jpeg',
        size: previewBuffer.length,
      });
      vi.mocked(s3StorageProvider.putObject).mockRejectedValue(
        new Error('S3 upload failed')
      );

      await expect(previewHandler.process(context)).rejects.toThrow(
        'S3 upload failed'
      );
    });
  });
});
