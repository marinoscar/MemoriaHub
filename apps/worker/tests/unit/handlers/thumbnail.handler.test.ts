import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessingJob, MediaAsset } from '@memoriahub/shared';
import type { JobContext } from '../../../src/core/job-context.js';
import { Readable } from 'stream';

// Mock dependencies
vi.mock('../../../src/repositories/index.js', () => ({
  mediaAssetRepository: {
    findById: vi.fn(),
    updateThumbnailKey: vi.fn(),
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
    generateThumbnail: vi.fn(),
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

import { thumbnailHandler } from '../../../src/handlers/thumbnail.handler.js';
import { mediaAssetRepository } from '../../../src/repositories/index.js';
import { s3StorageProvider } from '../../../src/infrastructure/storage/index.js';
import { imageProcessor, videoProcessor } from '../../../src/processors/index.js';
import * as fs from 'fs/promises';

describe('ThumbnailHandler', () => {
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
      jobType: 'generate_thumbnail',
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
      width: 1920,
      height: 1080,
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
      expect(thumbnailHandler.jobType).toBe('generate_thumbnail');
    });
  });

  describe('process', () => {
    it('generates thumbnail for static image', async () => {
      const context = createMockContext();
      const asset = createMockAsset();
      const originalBuffer = Buffer.from('original image data');
      const thumbnailBuffer = Buffer.from('thumbnail data');

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(asset);
      vi.mocked(s3StorageProvider.getObject).mockResolvedValue({
        body: createReadableStream(originalBuffer),
        contentType: 'image/jpeg',
        contentLength: originalBuffer.length,
      });
      vi.mocked(imageProcessor.generateThumbnail).mockResolvedValue({
        buffer: thumbnailBuffer,
        width: 300,
        height: 300,
        format: 'jpeg',
        size: thumbnailBuffer.length,
      });
      vi.mocked(s3StorageProvider.putObject).mockResolvedValue(undefined);
      vi.mocked(mediaAssetRepository.updateThumbnailKey).mockResolvedValue(asset);
      vi.mocked(mediaAssetRepository.hasDerivatives).mockResolvedValue(false);

      const result = await thumbnailHandler.process(context);

      expect(mediaAssetRepository.findById).toHaveBeenCalledWith('asset-456');
      expect(s3StorageProvider.getObject).toHaveBeenCalledWith(
        'memoriahub',
        'users/owner-123/originals/asset-456.jpg'
      );
      expect(imageProcessor.generateThumbnail).toHaveBeenCalledWith(originalBuffer);
      expect(s3StorageProvider.putObject).toHaveBeenCalledWith(
        'memoriahub',
        'users/owner-123/thumbnails/asset-456.jpg',
        thumbnailBuffer,
        expect.objectContaining({
          contentType: 'image/jpeg',
        })
      );
      expect(mediaAssetRepository.updateThumbnailKey).toHaveBeenCalledWith(
        'asset-456',
        'users/owner-123/thumbnails/asset-456.jpg'
      );

      expect(result.outputKey).toBe('users/owner-123/thumbnails/asset-456.jpg');
      expect(result.outputSize).toBe(thumbnailBuffer.length);
      expect(result.outputWidth).toBe(300);
      expect(result.outputHeight).toBe(300);
    });

    it('extracts first frame from animated GIF before generating thumbnail', async () => {
      const context = createMockContext();
      const asset = createMockAsset({
        mimeType: 'image/gif',
      });
      const originalBuffer = Buffer.from('animated gif data');
      const firstFrameBuffer = Buffer.from('first frame');
      const thumbnailBuffer = Buffer.from('thumbnail data');

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(asset);
      vi.mocked(s3StorageProvider.getObject).mockResolvedValue({
        body: createReadableStream(originalBuffer),
        contentType: 'image/gif',
        contentLength: originalBuffer.length,
      });
      vi.mocked(imageProcessor.extractFirstFrame).mockResolvedValue(firstFrameBuffer);
      vi.mocked(imageProcessor.generateThumbnail).mockResolvedValue({
        buffer: thumbnailBuffer,
        width: 300,
        height: 300,
        format: 'jpeg',
        size: thumbnailBuffer.length,
      });
      vi.mocked(s3StorageProvider.putObject).mockResolvedValue(undefined);
      vi.mocked(mediaAssetRepository.updateThumbnailKey).mockResolvedValue(asset);
      vi.mocked(mediaAssetRepository.hasDerivatives).mockResolvedValue(false);

      await thumbnailHandler.process(context);

      expect(imageProcessor.extractFirstFrame).toHaveBeenCalledWith(originalBuffer);
      expect(imageProcessor.generateThumbnail).toHaveBeenCalledWith(firstFrameBuffer);
    });

    it('extracts first frame from animated WebP before generating thumbnail', async () => {
      const context = createMockContext();
      const asset = createMockAsset({
        mimeType: 'image/webp',
      });
      const originalBuffer = Buffer.from('animated webp data');
      const firstFrameBuffer = Buffer.from('first frame');
      const thumbnailBuffer = Buffer.from('thumbnail data');

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(asset);
      vi.mocked(s3StorageProvider.getObject).mockResolvedValue({
        body: createReadableStream(originalBuffer),
        contentType: 'image/webp',
        contentLength: originalBuffer.length,
      });
      vi.mocked(imageProcessor.extractFirstFrame).mockResolvedValue(firstFrameBuffer);
      vi.mocked(imageProcessor.generateThumbnail).mockResolvedValue({
        buffer: thumbnailBuffer,
        width: 300,
        height: 300,
        format: 'jpeg',
        size: thumbnailBuffer.length,
      });
      vi.mocked(s3StorageProvider.putObject).mockResolvedValue(undefined);
      vi.mocked(mediaAssetRepository.updateThumbnailKey).mockResolvedValue(asset);
      vi.mocked(mediaAssetRepository.hasDerivatives).mockResolvedValue(false);

      await thumbnailHandler.process(context);

      expect(imageProcessor.extractFirstFrame).toHaveBeenCalledWith(originalBuffer);
      expect(imageProcessor.generateThumbnail).toHaveBeenCalledWith(firstFrameBuffer);
    });

    it('extracts frame from video before generating thumbnail', async () => {
      const context = createMockContext();
      const asset = createMockAsset({
        mediaType: 'video',
        mimeType: 'video/mp4',
      });
      const originalBuffer = Buffer.from('video data');
      const frameBuffer = Buffer.from('video frame');
      const thumbnailBuffer = Buffer.from('thumbnail data');

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
      vi.mocked(imageProcessor.generateThumbnail).mockResolvedValue({
        buffer: thumbnailBuffer,
        width: 300,
        height: 300,
        format: 'jpeg',
        size: thumbnailBuffer.length,
      });
      vi.mocked(s3StorageProvider.putObject).mockResolvedValue(undefined);
      vi.mocked(mediaAssetRepository.updateThumbnailKey).mockResolvedValue(asset);
      vi.mocked(mediaAssetRepository.hasDerivatives).mockResolvedValue(false);

      await thumbnailHandler.process(context);

      expect(videoProcessor.extractFrame).toHaveBeenCalled();
      expect(fs.readFile).toHaveBeenCalledWith('/tmp/frame-123.jpg');
      expect(videoProcessor.cleanupFrame).toHaveBeenCalledWith('/tmp/frame-123.jpg');
      expect(imageProcessor.generateThumbnail).toHaveBeenCalledWith(frameBuffer);
    });

    it('updates asset status to DERIVATIVES_READY when all derivatives are complete', async () => {
      const context = createMockContext();
      const asset = createMockAsset();
      const originalBuffer = Buffer.from('original image data');
      const thumbnailBuffer = Buffer.from('thumbnail data');

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(asset);
      vi.mocked(s3StorageProvider.getObject).mockResolvedValue({
        body: createReadableStream(originalBuffer),
        contentType: 'image/jpeg',
        contentLength: originalBuffer.length,
      });
      vi.mocked(imageProcessor.generateThumbnail).mockResolvedValue({
        buffer: thumbnailBuffer,
        width: 300,
        height: 300,
        format: 'jpeg',
        size: thumbnailBuffer.length,
      });
      vi.mocked(s3StorageProvider.putObject).mockResolvedValue(undefined);
      vi.mocked(mediaAssetRepository.updateThumbnailKey).mockResolvedValue(asset);
      vi.mocked(mediaAssetRepository.hasDerivatives).mockResolvedValue(true); // Both derivatives exist

      await thumbnailHandler.process(context);

      expect(mediaAssetRepository.hasDerivatives).toHaveBeenCalledWith('asset-456');
      expect(mediaAssetRepository.updateStatus).toHaveBeenCalledWith('asset-456', 'DERIVATIVES_READY');
    });

    it('does not update status when derivatives are not complete', async () => {
      const context = createMockContext();
      const asset = createMockAsset();
      const originalBuffer = Buffer.from('original image data');
      const thumbnailBuffer = Buffer.from('thumbnail data');

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(asset);
      vi.mocked(s3StorageProvider.getObject).mockResolvedValue({
        body: createReadableStream(originalBuffer),
        contentType: 'image/jpeg',
        contentLength: originalBuffer.length,
      });
      vi.mocked(imageProcessor.generateThumbnail).mockResolvedValue({
        buffer: thumbnailBuffer,
        width: 300,
        height: 300,
        format: 'jpeg',
        size: thumbnailBuffer.length,
      });
      vi.mocked(s3StorageProvider.putObject).mockResolvedValue(undefined);
      vi.mocked(mediaAssetRepository.updateThumbnailKey).mockResolvedValue(asset);
      vi.mocked(mediaAssetRepository.hasDerivatives).mockResolvedValue(false); // Preview still missing

      await thumbnailHandler.process(context);

      expect(mediaAssetRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('throws error when asset is not found', async () => {
      const context = createMockContext();

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(null);

      await expect(thumbnailHandler.process(context)).rejects.toThrow(
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
      vi.mocked(imageProcessor.generateThumbnail).mockRejectedValue(
        new Error('Image processing failed')
      );

      await expect(thumbnailHandler.process(context)).rejects.toThrow(
        'Image processing failed'
      );
    });

    it('throws error when S3 upload fails', async () => {
      const context = createMockContext();
      const asset = createMockAsset();
      const originalBuffer = Buffer.from('original image data');
      const thumbnailBuffer = Buffer.from('thumbnail data');

      vi.mocked(mediaAssetRepository.findById).mockResolvedValue(asset);
      vi.mocked(s3StorageProvider.getObject).mockResolvedValue({
        body: createReadableStream(originalBuffer),
        contentType: 'image/jpeg',
        contentLength: originalBuffer.length,
      });
      vi.mocked(imageProcessor.generateThumbnail).mockResolvedValue({
        buffer: thumbnailBuffer,
        width: 300,
        height: 300,
        format: 'jpeg',
        size: thumbnailBuffer.length,
      });
      vi.mocked(s3StorageProvider.putObject).mockRejectedValue(
        new Error('S3 upload failed')
      );

      await expect(thumbnailHandler.process(context)).rejects.toThrow(
        'S3 upload failed'
      );
    });
  });
});
