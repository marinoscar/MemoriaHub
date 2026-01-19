import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';

// Mock sharp before importing the processor
vi.mock('sharp', () => {
  const mockSharp = vi.fn();
  return {
    default: mockSharp,
  };
});

// Mock the config
vi.mock('../../../src/config/index.js', () => ({
  workerConfig: {
    processing: {
      thumbnail: {
        size: 300,
        quality: 80,
      },
      preview: {
        maxSize: 1200,
        quality: 85,
      },
    },
  },
}));

// Mock the logger
vi.mock('../../../src/infrastructure/logging/index.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  LogEventTypes: {
    PROCESSOR_STARTED: 'processor.started',
    PROCESSOR_COMPLETED: 'processor.completed',
    PROCESSOR_ERROR: 'processor.error',
  },
}));

import { ImageProcessor } from '../../../src/processors/image.processor.js';

describe('ImageProcessor', () => {
  let imageProcessor: ImageProcessor;
  let mockSharpInstance: ReturnType<typeof createMockSharpInstance>;

  function createMockSharpInstance() {
    const instance = {
      metadata: vi.fn(),
      rotate: vi.fn(),
      resize: vi.fn(),
      jpeg: vi.fn(),
      png: vi.fn(),
      toBuffer: vi.fn(),
    };

    // Chain methods return self
    instance.rotate.mockReturnValue(instance);
    instance.resize.mockReturnValue(instance);
    instance.jpeg.mockReturnValue(instance);
    instance.png.mockReturnValue(instance);

    return instance;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    imageProcessor = new ImageProcessor();
    mockSharpInstance = createMockSharpInstance();
    vi.mocked(sharp).mockReturnValue(mockSharpInstance as unknown as ReturnType<typeof sharp>);
  });

  describe('generateThumbnail', () => {
    it('generates a 300x300 square thumbnail with center crop', async () => {
      const inputBuffer = Buffer.from('fake image data');
      const outputBuffer = Buffer.from('thumbnail data');

      mockSharpInstance.metadata.mockResolvedValue({
        width: 1920,
        height: 1080,
        format: 'jpeg',
      });

      mockSharpInstance.toBuffer.mockResolvedValue({
        data: outputBuffer,
        info: {
          width: 300,
          height: 300,
          format: 'jpeg',
        },
      });

      const result = await imageProcessor.generateThumbnail(inputBuffer);

      expect(sharp).toHaveBeenCalledWith(inputBuffer);
      expect(mockSharpInstance.rotate).toHaveBeenCalled();
      expect(mockSharpInstance.resize).toHaveBeenCalledWith(300, 300, {
        fit: 'cover',
        position: 'centre',
      });
      expect(mockSharpInstance.jpeg).toHaveBeenCalledWith({
        quality: 80,
        mozjpeg: true,
      });

      expect(result).toEqual({
        buffer: outputBuffer,
        width: 300,
        height: 300,
        format: 'jpeg',
        size: outputBuffer.length,
      });
    });

    it('uses custom size and quality when provided', async () => {
      const inputBuffer = Buffer.from('fake image data');
      const outputBuffer = Buffer.from('thumbnail data');

      mockSharpInstance.metadata.mockResolvedValue({
        width: 1920,
        height: 1080,
        format: 'jpeg',
      });

      mockSharpInstance.toBuffer.mockResolvedValue({
        data: outputBuffer,
        info: {
          width: 150,
          height: 150,
          format: 'jpeg',
        },
      });

      const result = await imageProcessor.generateThumbnail(inputBuffer, {
        size: 150,
        quality: 90,
      });

      expect(mockSharpInstance.resize).toHaveBeenCalledWith(150, 150, {
        fit: 'cover',
        position: 'centre',
      });
      expect(mockSharpInstance.jpeg).toHaveBeenCalledWith({
        quality: 90,
        mozjpeg: true,
      });

      expect(result.width).toBe(150);
      expect(result.height).toBe(150);
    });

    it('throws error when sharp processing fails', async () => {
      const inputBuffer = Buffer.from('fake image data');
      const error = new Error('Sharp processing failed');

      mockSharpInstance.metadata.mockRejectedValue(error);

      await expect(imageProcessor.generateThumbnail(inputBuffer)).rejects.toThrow(
        'Sharp processing failed'
      );
    });
  });

  describe('generatePreview', () => {
    it('generates a preview maintaining aspect ratio', async () => {
      const inputBuffer = Buffer.from('fake image data');
      const outputBuffer = Buffer.from('preview data');

      mockSharpInstance.metadata.mockResolvedValue({
        width: 3000,
        height: 2000,
        format: 'jpeg',
      });

      mockSharpInstance.toBuffer.mockResolvedValue({
        data: outputBuffer,
        info: {
          width: 1200,
          height: 800,
          format: 'jpeg',
        },
      });

      const result = await imageProcessor.generatePreview(inputBuffer);

      expect(sharp).toHaveBeenCalledWith(inputBuffer);
      expect(mockSharpInstance.rotate).toHaveBeenCalled();
      expect(mockSharpInstance.resize).toHaveBeenCalledWith(1200, 1200, {
        fit: 'inside',
        withoutEnlargement: true,
      });
      expect(mockSharpInstance.jpeg).toHaveBeenCalledWith({
        quality: 85,
        mozjpeg: true,
      });

      expect(result).toEqual({
        buffer: outputBuffer,
        width: 1200,
        height: 800,
        format: 'jpeg',
        size: outputBuffer.length,
      });
    });

    it('skips resize if image is smaller than maxSize', async () => {
      const inputBuffer = Buffer.from('fake image data');
      const outputBuffer = Buffer.from('preview data');

      mockSharpInstance.metadata.mockResolvedValue({
        width: 800,
        height: 600,
        format: 'jpeg',
      });

      mockSharpInstance.toBuffer.mockResolvedValue({
        data: outputBuffer,
        info: {
          width: 800,
          height: 600,
          format: 'jpeg',
        },
      });

      const result = await imageProcessor.generatePreview(inputBuffer);

      // resize should NOT be called since image is smaller than maxSize
      expect(mockSharpInstance.resize).not.toHaveBeenCalled();

      expect(result.width).toBe(800);
      expect(result.height).toBe(600);
    });

    it('uses custom maxSize and quality when provided', async () => {
      const inputBuffer = Buffer.from('fake image data');
      const outputBuffer = Buffer.from('preview data');

      mockSharpInstance.metadata.mockResolvedValue({
        width: 3000,
        height: 2000,
        format: 'jpeg',
      });

      mockSharpInstance.toBuffer.mockResolvedValue({
        data: outputBuffer,
        info: {
          width: 800,
          height: 533,
          format: 'jpeg',
        },
      });

      const result = await imageProcessor.generatePreview(inputBuffer, {
        maxSize: 800,
        quality: 70,
      });

      expect(mockSharpInstance.resize).toHaveBeenCalledWith(800, 800, {
        fit: 'inside',
        withoutEnlargement: true,
      });
      expect(mockSharpInstance.jpeg).toHaveBeenCalledWith({
        quality: 70,
        mozjpeg: true,
      });

      expect(result.width).toBe(800);
    });

    it('throws error when sharp processing fails', async () => {
      const inputBuffer = Buffer.from('fake image data');
      const error = new Error('Preview generation failed');

      mockSharpInstance.metadata.mockRejectedValue(error);

      await expect(imageProcessor.generatePreview(inputBuffer)).rejects.toThrow(
        'Preview generation failed'
      );
    });
  });

  describe('extractFirstFrame', () => {
    it('extracts first frame from animated image', async () => {
      const inputBuffer = Buffer.from('animated gif data');
      const outputBuffer = Buffer.from('first frame png');

      // First call for the extraction
      mockSharpInstance.toBuffer.mockResolvedValue(outputBuffer);

      const result = await imageProcessor.extractFirstFrame(inputBuffer);

      expect(sharp).toHaveBeenCalledWith(inputBuffer, { pages: 1 });
      expect(mockSharpInstance.png).toHaveBeenCalled();
      expect(result).toEqual(outputBuffer);
    });

    it('throws error when extraction fails', async () => {
      const inputBuffer = Buffer.from('corrupted data');
      const error = new Error('Invalid image format');

      mockSharpInstance.toBuffer.mockRejectedValue(error);

      await expect(imageProcessor.extractFirstFrame(inputBuffer)).rejects.toThrow(
        'Invalid image format'
      );
    });
  });

  describe('isAnimated', () => {
    it('returns true for multi-page images (animated GIF)', async () => {
      const inputBuffer = Buffer.from('animated gif');

      mockSharpInstance.metadata.mockResolvedValue({
        pages: 10,
        format: 'gif',
      });

      const result = await imageProcessor.isAnimated(inputBuffer);

      expect(result).toBe(true);
    });

    it('returns true for animated WebP', async () => {
      const inputBuffer = Buffer.from('animated webp');

      mockSharpInstance.metadata.mockResolvedValue({
        pages: 5,
        format: 'webp',
      });

      const result = await imageProcessor.isAnimated(inputBuffer);

      expect(result).toBe(true);
    });

    it('returns false for single-page images', async () => {
      const inputBuffer = Buffer.from('static jpeg');

      mockSharpInstance.metadata.mockResolvedValue({
        pages: 1,
        format: 'jpeg',
      });

      const result = await imageProcessor.isAnimated(inputBuffer);

      expect(result).toBe(false);
    });

    it('returns false when pages is undefined', async () => {
      const inputBuffer = Buffer.from('static jpeg');

      mockSharpInstance.metadata.mockResolvedValue({
        format: 'jpeg',
      });

      const result = await imageProcessor.isAnimated(inputBuffer);

      expect(result).toBe(false);
    });

    it('returns false when metadata extraction fails', async () => {
      const inputBuffer = Buffer.from('corrupted data');

      mockSharpInstance.metadata.mockRejectedValue(new Error('Invalid format'));

      const result = await imageProcessor.isAnimated(inputBuffer);

      expect(result).toBe(false);
    });
  });

  describe('getMetadata', () => {
    it('returns image metadata', async () => {
      const inputBuffer = Buffer.from('jpeg image');
      const expectedMetadata = {
        width: 1920,
        height: 1080,
        format: 'jpeg',
        space: 'srgb',
        channels: 3,
        depth: 'uchar',
        density: 72,
        hasAlpha: false,
        orientation: 1,
      };

      mockSharpInstance.metadata.mockResolvedValue(expectedMetadata);

      const result = await imageProcessor.getMetadata(inputBuffer);

      expect(sharp).toHaveBeenCalledWith(inputBuffer);
      expect(result).toEqual(expectedMetadata);
    });

    it('throws error when metadata extraction fails', async () => {
      const inputBuffer = Buffer.from('corrupted data');
      const error = new Error('Cannot determine image format');

      mockSharpInstance.metadata.mockRejectedValue(error);

      await expect(imageProcessor.getMetadata(inputBuffer)).rejects.toThrow(
        'Cannot determine image format'
      );
    });
  });
});
