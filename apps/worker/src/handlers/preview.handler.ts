import * as fs from 'fs/promises';
import type { ProcessingJobResult } from '@memoriahub/shared';
import type { JobContext } from '../core/job-context.js';
import { BaseHandler } from './base.handler.js';
import { imageProcessor, videoProcessor } from '../processors/index.js';
import { mediaAssetRepository } from '../repositories/index.js';

/**
 * Handler for generate_preview jobs
 * Creates preview images with max dimension of 1200px
 */
class PreviewHandler extends BaseHandler {
  readonly jobType = 'generate_preview' as const;

  async process(context: JobContext): Promise<ProcessingJobResult> {
    const startTime = Date.now();

    // Get asset metadata
    const asset = await this.getAsset(context);

    context.logger.info({
      eventType: 'preview.processing',
      assetId: asset.id,
      mediaType: asset.mediaType,
      mimeType: asset.mimeType,
      fileSize: asset.fileSize,
    }, `Processing preview for ${asset.mediaType}`);

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

    // Generate preview
    const preview = await imageProcessor.generatePreview(inputBuffer);

    // Build storage key
    const previewKey = this.buildDerivativeKey(asset.libraryId, asset.id, 'previews');

    // Upload to S3
    await this.uploadDerivative(
      asset.storageBucket,
      previewKey,
      preview.buffer,
      context
    );

    // Update asset with preview key
    await mediaAssetRepository.updatePreviewKey(asset.id, previewKey);

    // Check if all derivatives are complete
    await this.checkAndUpdateDerivativeStatus(asset.id, context);

    const result: ProcessingJobResult = {
      outputKey: previewKey,
      outputSize: preview.size,
      outputWidth: preview.width,
      outputHeight: preview.height,
      durationMs: Date.now() - startTime,
    };

    context.logger.info({
      eventType: 'preview.completed',
      assetId: asset.id,
      previewKey,
      size: preview.size,
      width: preview.width,
      height: preview.height,
      durationMs: result.durationMs,
    }, 'Preview generated successfully');

    return result;
  }

  /**
   * Extract frame from video for preview
   */
  private async extractVideoFrame(
    _originalBuffer: Buffer,
    assetId: string,
    _context: JobContext
  ): Promise<Buffer> {
    const tempDir = process.env.TEMP_DIR || '/tmp/worker';
    const tempVideoPath = `${tempDir}/video-${assetId}-${Date.now()}.tmp`;
    const frameResult = await videoProcessor.extractFrame(tempVideoPath);

    try {
      const frameBuffer = await fs.readFile(frameResult.framePath);
      await videoProcessor.cleanupFrame(frameResult.framePath);
      await fs.unlink(tempVideoPath).catch(() => {});
      return frameBuffer;
    } catch (error) {
      await videoProcessor.cleanupFrame(frameResult.framePath).catch(() => {});
      await fs.unlink(tempVideoPath).catch(() => {});
      throw error;
    }
  }

  /**
   * Check if format is animated
   */
  private isAnimatedFormat(mimeType: string): boolean {
    return mimeType === 'image/gif' || mimeType === 'image/webp';
  }
}

// Export singleton instance
export const previewHandler = new PreviewHandler();
