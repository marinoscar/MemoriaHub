import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob, MediaType, MediaEnhancementStatus } from '@prisma/client';
import { Readable } from 'stream';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { AiSettingsService } from '../ai/ai-settings.service';
import { AiProviderRegistry } from '../ai/providers/ai-provider.registry';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { streamToBuffer } from '../storage/processing/processors/stream-utils';
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';
import { closestSupportedSize, sizeToDims } from './enhance-prompt.builder';

interface PictureEnhancementPayload {
  enhancementId?: string;
}

/**
 * PictureEnhancementHandler
 *
 * Server-only (no nodeResultSchema/persistNodeResult — mirrors
 * LocationInferenceHandler): it needs the OpenAI credential and writes a staging
 * object, so it never runs on a distributed worker node.
 *
 * The row is created ahead of time (status=pending, params + compiled prompt
 * already stored) by MediaEnhancementService.startEnhance; this handler resolves
 * the row from job.payload.enhancementId, calls the provider's images.edit, and
 * stages the enhanced bytes for human review.
 */
@Injectable()
export class PictureEnhancementHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'picture_enhancement';
  private readonly logger = new Logger(PictureEnhancementHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly resolver: StorageProviderResolver,
    private readonly aiSettings: AiSettingsService,
    private readonly aiProviderRegistry: AiProviderRegistry,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    const payload = job.payload as PictureEnhancementPayload | null;
    const enhancementId = payload?.enhancementId;
    if (!enhancementId) {
      this.logger.warn(`picture_enhancement job ${job.id} has no enhancementId; skipping`);
      return;
    }

    const row = await this.prisma.mediaEnhancement.findUnique({
      where: { id: enhancementId },
    });
    if (!row) {
      this.logger.warn(
        `picture_enhancement job ${job.id}: enhancement ${enhancementId} not found; skipping`,
      );
      return;
    }

    // Only pending/processing rows are actionable (a superseded row is discarded).
    if (
      row.status !== MediaEnhancementStatus.pending &&
      row.status !== MediaEnhancementStatus.processing
    ) {
      this.logger.log(
        `picture_enhancement job ${job.id}: enhancement ${enhancementId} is ${row.status}; skipping`,
      );
      return;
    }

    await this.prisma.mediaEnhancement.update({
      where: { id: row.id },
      data: { status: MediaEnhancementStatus.processing, lastError: null },
    });

    try {
      const mediaItem = await this.prisma.mediaItem.findUnique({
        where: { id: row.mediaItemId },
        select: {
          id: true,
          type: true,
          deletedAt: true,
          width: true,
          height: true,
          storageObject: {
            select: { storageKey: true, storageProvider: true, bucket: true, mimeType: true },
          },
        },
      });

      if (
        !mediaItem ||
        mediaItem.deletedAt ||
        !mediaItem.storageObject ||
        mediaItem.type !== MediaType.photo ||
        !mediaItem.storageObject.mimeType.startsWith('image/')
      ) {
        throw new Error(
          `MediaItem ${row.mediaItemId} is not an eligible photo for enhancement`,
        );
      }

      const provider = this.aiProviderRegistry.get(row.provider);
      if (typeof provider.enhanceImage !== 'function') {
        throw new Error(`Provider "${row.provider}" does not support image enhancement`);
      }
      const creds = await this.aiSettings.resolveCredentials(row.provider);

      // Download original bytes, then auto-orient (deterministic pre-pass).
      const objectProvider = await this.resolver.getProviderFor(
        mediaItem.storageObject.storageProvider,
        mediaItem.storageObject.bucket,
      );
      const originalBuffer = await streamToBuffer(
        await objectProvider.download(mediaItem.storageObject.storageKey),
      );

      const prepared = await prepareImageForProcessing(originalBuffer, { maxDim: 2048 });
      const inputBuffer = prepared.width > 0 ? prepared.buffer : originalBuffer;
      const inputMime = prepared.width > 0 ? 'image/jpeg' : mediaItem.storageObject.mimeType;

      // Resolve OpenAI call params (spec §4.2).
      const settings = await this.systemSettings.getSettings();
      const quality = settings.pictureEnhancement?.defaultQuality ?? 'high';
      const rawParams = (row.params as Record<string, unknown> | null) ?? {};
      const preserveFaces = rawParams['preserveFaces'] !== false; // default true
      const strength =
        (rawParams['strength'] as string | undefined) ??
        settings.pictureEnhancement?.defaultStrength ??
        'balanced';
      const inputFidelity: 'low' | 'high' =
        preserveFaces || strength !== 'strong' ? 'high' : 'low';
      const size = closestSupportedSize(mediaItem.width, mediaItem.height);

      const result = await provider.enhanceImage(creds, {
        model: row.model,
        imageBase64: inputBuffer.toString('base64'),
        mimeType: inputMime,
        prompt: row.prompt ?? '',
        size,
        quality: quality as 'low' | 'medium' | 'high',
        inputFidelity,
        outputFormat: 'jpeg',
        outputCompression: 90,
      });

      const enhancedBuffer = Buffer.from(result.imageBase64, 'base64');
      const [enhancedWidth, enhancedHeight] = sizeToDims(size);

      // Stage the enhanced bytes on the ACTIVE provider under a dedicated key.
      const { id: activeProviderId, provider: activeProvider } =
        await this.resolver.getActiveProvider();
      const stagingKey = `enhancements/${row.id}/result.jpg`;
      await activeProvider.upload(stagingKey, Readable.from(enhancedBuffer), {
        mimeType: 'image/jpeg',
        contentLength: enhancedBuffer.length,
      });

      await this.prisma.mediaEnhancement.update({
        where: { id: row.id },
        data: {
          status: MediaEnhancementStatus.ready,
          stagingStorageKey: stagingKey,
          stagingProvider: activeProviderId,
          stagingBucket: activeProvider.getBucket(),
          originalWidth: mediaItem.width,
          originalHeight: mediaItem.height,
          enhancedWidth,
          enhancedHeight,
          enhancedSize: BigInt(enhancedBuffer.length),
          lastError: null,
        },
      });

      this.logger.log(
        `picture_enhancement job ${job.id}: enhancement ${row.id} ready (${enhancedWidth}x${enhancedHeight}, ${enhancedBuffer.length} bytes)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.prisma.mediaEnhancement.update({
        where: { id: row.id },
        data: { status: MediaEnhancementStatus.failed, lastError: msg },
      });
      this.logger.error(
        `picture_enhancement job ${job.id}: enhancement ${row.id} failed: ${msg}`,
      );
      // Rethrow so the queue applies its normal retry/backoff.
      throw err;
    }
  }
}
