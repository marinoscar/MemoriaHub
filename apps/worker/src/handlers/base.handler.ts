import type { ProcessingJobType, ProcessingJobResult } from '@memoriahub/shared';
import type { JobContext } from '../core/job-context.js';
import type { JobHandler } from '../core/job-router.js';
import { mediaAssetRepository } from '../repositories/index.js';
import { s3StorageProvider } from '../infrastructure/storage/index.js';
import { Readable } from 'stream';

/**
 * Base handler class with common functionality
 */
export abstract class BaseHandler implements JobHandler {
  abstract readonly jobType: ProcessingJobType;

  /**
   * Process a job - must be implemented by subclasses
   */
  abstract process(context: JobContext): Promise<ProcessingJobResult>;

  /**
   * Get asset from database
   */
  protected async getAsset(context: JobContext) {
    const asset = await mediaAssetRepository.findById(context.job.assetId);
    if (!asset) {
      throw new Error(`Asset not found: ${context.job.assetId}`);
    }
    return asset;
  }

  /**
   * Download original file from S3
   */
  protected async downloadOriginal(
    bucket: string,
    key: string,
    context: JobContext
  ): Promise<Buffer> {
    context.logger.debug({
      eventType: 's3.download.starting',
      bucket,
      key,
    }, 'Downloading original from S3');

    const { body } = await s3StorageProvider.getObject(bucket, key);

    // Convert stream to buffer
    const buffer = await this.streamToBuffer(body);

    context.logger.debug({
      eventType: 's3.download.completed',
      bucket,
      key,
      size: buffer.length,
    }, `Downloaded ${buffer.length} bytes`);

    return buffer;
  }

  /**
   * Upload derivative to S3
   */
  protected async uploadDerivative(
    bucket: string,
    key: string,
    buffer: Buffer,
    context: JobContext
  ): Promise<void> {
    context.logger.debug({
      eventType: 's3.upload.starting',
      bucket,
      key,
      size: buffer.length,
    }, 'Uploading derivative to S3');

    await s3StorageProvider.putObject(bucket, key, buffer, {
      contentType: 'image/jpeg',
      cacheControl: 'public, max-age=31536000', // 1 year cache
    });

    context.logger.debug({
      eventType: 's3.upload.completed',
      bucket,
      key,
      size: buffer.length,
    }, 'Derivative uploaded');
  }

  /**
   * Check if all derivative jobs are complete and update asset status
   */
  protected async checkAndUpdateDerivativeStatus(
    assetId: string,
    context: JobContext
  ): Promise<void> {
    // Check if asset has both thumbnail and preview keys
    const hasDerivatives = await mediaAssetRepository.hasDerivatives(assetId);

    if (hasDerivatives) {
      context.logger.info({
        eventType: 'asset.derivatives_ready',
        assetId,
      }, 'All derivatives ready, updating asset status');

      await mediaAssetRepository.updateStatus(assetId, 'DERIVATIVES_READY');
    }
  }

  /**
   * Build storage key for derivative
   * Uses owner-based path structure: users/{ownerId}/{type}/{assetId}.jpg
   */
  protected buildDerivativeKey(
    ownerId: string,
    assetId: string,
    type: 'thumbnails' | 'previews'
  ): string {
    return `users/${ownerId}/${type}/${assetId}.jpg`;
  }

  /**
   * Convert readable stream to buffer
   */
  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
