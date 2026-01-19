import sharp from 'sharp';
import { workerConfig } from '../config/index.js';
import { logger, LogEventTypes } from '../infrastructure/logging/index.js';

/**
 * Options for generating a thumbnail
 */
export interface ThumbnailOptions {
  size?: number;
  quality?: number;
}

/**
 * Options for generating a preview
 */
export interface PreviewOptions {
  maxSize?: number;
  quality?: number;
}

/**
 * Result from image processing
 */
export interface ImageProcessingResult {
  buffer: Buffer;
  width: number;
  height: number;
  format: string;
  size: number;
}

/**
 * Image processor using Sharp
 * Handles resizing, format conversion, and EXIF orientation
 */
export class ImageProcessor {
  /**
   * Generate a thumbnail (square center crop)
   */
  async generateThumbnail(
    input: Buffer,
    options: ThumbnailOptions = {}
  ): Promise<ImageProcessingResult> {
    const size = options.size || workerConfig.processing.thumbnail.size;
    const quality = options.quality || workerConfig.processing.thumbnail.quality;
    const startTime = Date.now();

    try {
      logger.debug({
        eventType: LogEventTypes.PROCESSOR_STARTED,
        processor: 'image',
        operation: 'thumbnail',
        inputSize: input.length,
        targetSize: size,
      }, 'Starting thumbnail generation');

      // Create sharp instance
      const image = sharp(input);

      // Get metadata for logging
      const metadata = await image.metadata();

      // Process: rotate based on EXIF, resize with cover fit, center crop, convert to JPEG
      const result = await image
        .rotate() // Auto-rotate based on EXIF orientation
        .resize(size, size, {
          fit: 'cover',
          position: 'centre',
        })
        .jpeg({
          quality,
          mozjpeg: true, // Better compression
        })
        .toBuffer({ resolveWithObject: true });

      const processingResult: ImageProcessingResult = {
        buffer: result.data,
        width: result.info.width,
        height: result.info.height,
        format: result.info.format,
        size: result.data.length,
      };

      logger.debug({
        eventType: LogEventTypes.PROCESSOR_COMPLETED,
        processor: 'image',
        operation: 'thumbnail',
        inputSize: input.length,
        inputFormat: metadata.format,
        inputWidth: metadata.width,
        inputHeight: metadata.height,
        outputSize: processingResult.size,
        outputWidth: processingResult.width,
        outputHeight: processingResult.height,
        durationMs: Date.now() - startTime,
      }, 'Thumbnail generated');

      return processingResult;
    } catch (error) {
      logger.error({
        eventType: LogEventTypes.PROCESSOR_ERROR,
        processor: 'image',
        operation: 'thumbnail',
        error: error instanceof Error ? error.message : 'Unknown error',
        durationMs: Date.now() - startTime,
      }, 'Thumbnail generation failed');
      throw error;
    }
  }

  /**
   * Generate a preview (maintain aspect ratio, max dimension)
   */
  async generatePreview(
    input: Buffer,
    options: PreviewOptions = {}
  ): Promise<ImageProcessingResult> {
    const maxSize = options.maxSize || workerConfig.processing.preview.maxSize;
    const quality = options.quality || workerConfig.processing.preview.quality;
    const startTime = Date.now();

    try {
      logger.debug({
        eventType: LogEventTypes.PROCESSOR_STARTED,
        processor: 'image',
        operation: 'preview',
        inputSize: input.length,
        maxSize,
      }, 'Starting preview generation');

      // Create sharp instance
      const image = sharp(input);

      // Get metadata
      const metadata = await image.metadata();

      // Determine if we need to resize (only if larger than maxSize)
      const needsResize = metadata.width && metadata.height &&
        (metadata.width > maxSize || metadata.height > maxSize);

      // Build processing pipeline
      let pipeline = image.rotate(); // Auto-rotate based on EXIF

      if (needsResize) {
        pipeline = pipeline.resize(maxSize, maxSize, {
          fit: 'inside', // Maintain aspect ratio
          withoutEnlargement: true, // Don't upscale
        });
      }

      // Convert to JPEG
      const result = await pipeline
        .jpeg({
          quality,
          mozjpeg: true,
        })
        .toBuffer({ resolveWithObject: true });

      const processingResult: ImageProcessingResult = {
        buffer: result.data,
        width: result.info.width,
        height: result.info.height,
        format: result.info.format,
        size: result.data.length,
      };

      logger.debug({
        eventType: LogEventTypes.PROCESSOR_COMPLETED,
        processor: 'image',
        operation: 'preview',
        inputSize: input.length,
        inputFormat: metadata.format,
        inputWidth: metadata.width,
        inputHeight: metadata.height,
        outputSize: processingResult.size,
        outputWidth: processingResult.width,
        outputHeight: processingResult.height,
        wasResized: needsResize,
        durationMs: Date.now() - startTime,
      }, 'Preview generated');

      return processingResult;
    } catch (error) {
      logger.error({
        eventType: LogEventTypes.PROCESSOR_ERROR,
        processor: 'image',
        operation: 'preview',
        error: error instanceof Error ? error.message : 'Unknown error',
        durationMs: Date.now() - startTime,
      }, 'Preview generation failed');
      throw error;
    }
  }

  /**
   * Extract the first frame from an animated image (GIF, WebP)
   */
  async extractFirstFrame(input: Buffer): Promise<Buffer> {
    const startTime = Date.now();

    try {
      logger.debug({
        eventType: LogEventTypes.PROCESSOR_STARTED,
        processor: 'image',
        operation: 'extractFirstFrame',
        inputSize: input.length,
      }, 'Extracting first frame');

      // Sharp automatically uses the first page/frame for animated images
      // We just need to convert to a static format
      const result = await sharp(input, { pages: 1 }) // Only load first page/frame
        .png() // Convert to PNG to preserve quality
        .toBuffer();

      logger.debug({
        eventType: LogEventTypes.PROCESSOR_COMPLETED,
        processor: 'image',
        operation: 'extractFirstFrame',
        inputSize: input.length,
        outputSize: result.length,
        durationMs: Date.now() - startTime,
      }, 'First frame extracted');

      return result;
    } catch (error) {
      logger.error({
        eventType: LogEventTypes.PROCESSOR_ERROR,
        processor: 'image',
        operation: 'extractFirstFrame',
        error: error instanceof Error ? error.message : 'Unknown error',
        durationMs: Date.now() - startTime,
      }, 'First frame extraction failed');
      throw error;
    }
  }

  /**
   * Check if an image format is animated (GIF, animated WebP)
   */
  async isAnimated(input: Buffer): Promise<boolean> {
    try {
      const metadata = await sharp(input).metadata();
      // GIF with multiple pages or WebP with multiple frames
      return (metadata.pages !== undefined && metadata.pages > 1);
    } catch {
      return false;
    }
  }

  /**
   * Get image metadata
   */
  async getMetadata(input: Buffer): Promise<sharp.Metadata> {
    return sharp(input).metadata();
  }
}

// Export singleton instance
export const imageProcessor = new ImageProcessor();
