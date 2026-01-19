import * as fs from 'fs/promises';
import type { ProcessingJobResult } from '@memoriahub/shared';
import type { JobContext } from '../core/job-context.js';
import { BaseHandler } from './base.handler.js';
import { imageProcessor, videoProcessor } from '../processors/index.js';
import { mediaAssetRepository } from '../repositories/index.js';

/**
 * Handler for generate_thumbnail jobs
 * Creates 300x300 square center-crop thumbnails
 */
class ThumbnailHandler extends BaseHandler {
  readonly jobType = 'generate_thumbnail' as const;

  async process(context: JobContext): Promise<ProcessingJobResult> {
    const startTime = Date.now();

    // Get asset metadata
    const asset = await this.getAsset(context);

    context.logger.info({
      eventType: 'thumbnail.processing',
      assetId: asset.id,
      mediaType: asset.mediaType,
      mimeType: asset.mimeType,
      fileSize: asset.fileSize,
    }, `Processing thumbnail for ${asset.mediaType}`);

    // Download original
    const originalBuffer = await this.downloadOriginal(
      asset.storageBucket,
      asset.storageKey,
      context
    );

    let inputBuffer: Buffer;

    // Handle different media types
    if (asset.mediaType === 'video') {
      // Extract frame from video
      inputBuffer = await this.extractVideoFrame(originalBuffer, asset.id, context);
    } else if (this.isAnimatedFormat(asset.mimeType)) {
      // Extract first frame from animated images
      inputBuffer = await imageProcessor.extractFirstFrame(originalBuffer);
    } else {
      // Use original buffer for static images
      inputBuffer = originalBuffer;
    }

    // Generate thumbnail
    const thumbnail = await imageProcessor.generateThumbnail(inputBuffer);

    // Build storage key
    const thumbnailKey = this.buildDerivativeKey(asset.libraryId, asset.id, 'thumbnails');

    // Upload to S3
    await this.uploadDerivative(
      asset.storageBucket,
      thumbnailKey,
      thumbnail.buffer,
      context
    );

    // Update asset with thumbnail key
    await mediaAssetRepository.updateThumbnailKey(asset.id, thumbnailKey);

    // Check if all derivatives are complete
    await this.checkAndUpdateDerivativeStatus(asset.id, context);

    const result: ProcessingJobResult = {
      outputKey: thumbnailKey,
      outputSize: thumbnail.size,
      outputWidth: thumbnail.width,
      outputHeight: thumbnail.height,
      durationMs: Date.now() - startTime,
    };

    context.logger.info({
      eventType: 'thumbnail.completed',
      assetId: asset.id,
      thumbnailKey,
      size: thumbnail.size,
      durationMs: result.durationMs,
    }, 'Thumbnail generated successfully');

    return result;
  }

  /**
   * Extract frame from video for thumbnail
   */
  private async extractVideoFrame(
    _originalBuffer: Buffer,
    assetId: string,
    _context: JobContext
  ): Promise<Buffer> {
    // Note: For video processing, we need to save to a temp file first
    // since FFmpeg works with file paths, not buffers
    // This is a simplified implementation - in production you might want
    // to download directly to disk for large files

    // For now, we'll save the video to a temp file, extract frame, then read it back
    const tempDir = process.env.TEMP_DIR || '/tmp/worker';
    const tempVideoPath = `${tempDir}/video-${assetId}-${Date.now()}.tmp`;
    const frameResult = await videoProcessor.extractFrame(tempVideoPath);

    try {
      // Read the extracted frame
      const frameBuffer = await fs.readFile(frameResult.framePath);

      // Clean up temp files
      await videoProcessor.cleanupFrame(frameResult.framePath);
      await fs.unlink(tempVideoPath).catch(() => {}); // Ignore errors

      return frameBuffer;
    } catch (error) {
      // Clean up on error
      await videoProcessor.cleanupFrame(frameResult.framePath).catch(() => {});
      await fs.unlink(tempVideoPath).catch(() => {});
      throw error;
    }
  }

  /**
   * Check if format is animated (GIF, animated WebP)
   */
  private isAnimatedFormat(mimeType: string): boolean {
    return mimeType === 'image/gif' || mimeType === 'image/webp';
  }
}

// Export singleton instance
export const thumbnailHandler = new ThumbnailHandler();
