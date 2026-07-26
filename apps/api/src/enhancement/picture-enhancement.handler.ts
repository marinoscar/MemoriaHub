import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob, MediaType, MediaEnhancementStatus } from '@prisma/client';
import { Readable } from 'stream';
import sharp from 'sharp';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { RateLimitError, classifyRateLimit } from '../enrichment/rate-limit.error';
import {
  ENRICHMENT_MAX_ATTEMPTS,
  ENRICHMENT_RATELIMIT_MAX_HITS,
} from '../enrichment/enrichment-terminal.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { AiSettingsService } from '../ai/ai-settings.service';
import { AiProviderRegistry } from '../ai/providers/ai-provider.registry';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { streamToBuffer } from '../storage/processing/processors/stream-utils';
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';
import { closestSupportedSize, sizeToDims } from './enhance-prompt.builder';
import { ExifCarryoverService } from './exif-carryover.service';

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
    // Optional by TYPE only — Nest always injects it (EnhancementModule provides
    // it). Marked `?` so the metadata stamp is structurally non-essential: a
    // handler constructed without it still produces a valid enhancement, just
    // without carried-over EXIF.
    private readonly exifCarryover?: ExifCarryoverService,
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
      const rawParams = (row.params as Record<string, unknown> | null) ?? {};
      // Per-run quality override takes precedence over the system setting.
      const quality =
        (rawParams['quality'] as string | undefined) ??
        settings.pictureEnhancement?.defaultQuality ??
        'high';
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

      // The model does not always return the exact canvas we asked for, so the
      // REAL pixel dimensions come from the returned bytes; sizeToDims(size) is
      // only the fallback when they can't be read.
      const requestedDims = sizeToDims(size);
      const outputDims = (await this.readDims(enhancedBuffer)) ?? requestedDims;

      // File-level EXIF carryover + AI marker (spec §5.1/§5.4), gated on
      // pictureEnhancement.stampExif. Done HERE, once, on the staged bytes:
      // both apply paths (keep_both and replace) reuse this same staged object,
      // so a single stamp covers both. Best-effort by contract — the service
      // returns the input buffer on any failure; the extra try/catch is
      // belt-and-braces so a metadata step can never fail a good enhancement.
      const stampExif = settings.pictureEnhancement?.stampExif !== false;
      let finalBuffer: Buffer = enhancedBuffer;
      if (stampExif) {
        try {
          const stamped = await this.exifCarryover?.applyCarryover(
            originalBuffer,
            enhancedBuffer,
            {
              model: row.model,
              width: outputDims[0],
              height: outputDims[1],
              originalExtension: extensionForMime(mediaItem.storageObject.mimeType),
            },
          );
          if (stamped?.length) finalBuffer = stamped;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `picture_enhancement job ${job.id}: EXIF carryover skipped: ${msg}`,
          );
        }
      }

      // Read the persisted dims off the FINAL bytes so the recorded size always
      // describes what is actually stored (drives the downscale warning and the
      // keep_both item's width/height).
      const [enhancedWidth, enhancedHeight] =
        (await this.readDims(finalBuffer)) ?? outputDims;

      // Stage the enhanced bytes on the ACTIVE provider under a dedicated key.
      const { id: activeProviderId, provider: activeProvider } =
        await this.resolver.getActiveProvider();
      const stagingKey = `enhancements/${row.id}/result.jpg`;
      await activeProvider.upload(stagingKey, Readable.from(finalBuffer), {
        mimeType: 'image/jpeg',
        contentLength: finalBuffer.length,
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
          enhancedSize: BigInt(finalBuffer.length),
          lastError: null,
        },
      });

      this.logger.log(
        `picture_enhancement job ${job.id}: enhancement ${row.id} ready (${enhancedWidth}x${enhancedHeight}, ${finalBuffer.length} bytes)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Classify the failure the SAME way EnrichmentTerminalService will, so
      // the row's next state always agrees with the job's next state.
      // (Mirrors AutoTaggingService.embedAndStore's classify-then-rethrow.)
      const rl = err instanceof RateLimitError ? err : classifyRateLimit(err);

      // Does the queue requeue this job, or is this its last breath?
      //
      //  - Rate limit: the deferral path requeues until
      //    `rateLimitHits + 1 >= ENRICHMENT_RATELIMIT_MAX_HITS`, and it
      //    UN-CHARGES the claim-time attempt, so a deferral never consumes
      //    retry budget. `job.rateLimitHits` is the count BEFORE this hit.
      //  - Normal error: `attempts` is charged at CLAIM time (it means
      //    "attempts STARTED"), so `job.attempts` already includes the attempt
      //    that just failed — 1 on the first run. The queue retries while
      //    `job.attempts < ENRICHMENT_MAX_ATTEMPTS`, i.e. attempt 3 of 3 is
      //    terminal. Using `<` (not `<=`) here is what keeps the two in step.
      const queueWillRetry = rl
        ? job.rateLimitHits + 1 < ENRICHMENT_RATELIMIT_MAX_HITS
        : job.attempts < ENRICHMENT_MAX_ATTEMPTS;

      // A retryable failure must leave the row ACTIONABLE. process() early-returns
      // unless the row is pending/processing, so unconditionally tombstoning it as
      // `failed` here turned every retry — and every rate-limit deferral — into a
      // silent no-op that burned the job's budget without re-running the work.
      await this.prisma.mediaEnhancement.update({
        where: { id: row.id },
        data: {
          status: queueWillRetry
            ? MediaEnhancementStatus.pending
            : MediaEnhancementStatus.failed,
          // Informational while retrying (explains the current backoff), and the
          // surfaced failure reason once the queue gives up.
          lastError: msg,
        },
      });

      this.logger.error(
        `picture_enhancement job ${job.id}: enhancement ${row.id} ${
          queueWillRetry ? 'failed (will retry)' : 'failed'
        }${rl ? ' [rate-limited]' : ''}: ${msg}`,
      );

      // Rethrow the NORMALIZED RateLimitError so the queue takes its deferral
      // path (backoff + no attempt charged) rather than the retry path; any
      // other error is rethrown untouched for normal retry/backoff.
      if (rl) throw rl;
      throw err;
    }
  }

  /**
   * Read a buffer's real pixel dimensions, or `null` if it can't be decoded.
   * Never throws — the caller falls back to the requested canvas size.
   */
  private async readDims(buffer: Buffer): Promise<[number, number] | null> {
    try {
      const meta = await sharp(buffer).metadata();
      if (meta.width && meta.height) return [meta.width, meta.height];
    } catch {
      // Not decodable here (e.g. a stub buffer in tests) — fall back.
    }
    return null;
  }
}

/**
 * Extension hint for the temp copy of the ORIGINAL passed to ExifTool, so it
 * type-detects the source exactly as it would in storage. Unknown types get no
 * extension (ExifTool identifies by content anyway).
 */
function extensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/heic':
      return '.heic';
    case 'image/heif':
      return '.heif';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'image/tiff':
      return '.tif';
    default:
      return '';
  }
}
