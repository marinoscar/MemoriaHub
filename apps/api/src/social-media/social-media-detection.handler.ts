// =============================================================================
// SocialMediaDetectionHandler  (type = 'social_media_detection')
// =============================================================================
//
// Enrichment handler that classifies whether a VIDEO media item was downloaded/
// re-shared from a social-media platform (TikTok/Instagram/Facebook/other).
//
// Pipeline:
//   1. Load the MediaItem (+ storageObject metadata). Skip non-video/deleted/missing.
//   2. Feature gate: features.socialMediaDetection + SOCIAL_MEDIA_DETECTION_ENABLED.
//   3. Mark MediaSocialStatus → processing.
//   4. Build VideoDetectionInput from persisted ffprobe metadata; re-probe legacy
//      items (no formatTags) by downloading + ffprobe.
//   5. Tier-1 (metadata/filename) detection.
//   6. Tier-2 OCR fallback when Tier-1 is inconclusive but suspicious.
//   7a. Detected → apply tags ("Social Media" + platform), write status + source.
//   7b. Clean → status(isSocialMedia:false); if it was previously flagged, strip
//       the system tags + clear source; then fan out downstream video enrichment
//       (video_face_detection) that was withheld while classification was pending.
//   8. On error: mark failed + rethrow so the worker retries.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob, MediaSocialStatusType, MediaTagSource, MediaType } from '@prisma/client';
import { tmpdir } from 'os';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { MediaEnrichmentService } from '../media/enrichment/media-enrichment.service';
import { streamToTempFile } from '../storage/processing/processors/stream-utils';
import { probeVideoFile, extractContainerMetadata } from '../storage/processing/processors/ffprobe.util';
import {
  SocialMediaDetectorService,
  VideoDetectionInput,
  DetectionResult,
  SocialPlatform,
} from './social-media-detector.service';
import { SocialMediaOcrService } from './social-media-ocr.service';

/** The canonical "umbrella" tag applied to every detected social-media item. */
const SOCIAL_TAG = 'Social Media';

/** Platform → display tag name. `other` gets no platform-specific tag. */
const PLATFORM_TAG: Record<SocialPlatform, string | null> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
  other: null,
};

/** Every tag name this handler may apply — used to strip on a rerun-gone-clean. */
const ALL_SOCIAL_TAG_NAMES = [SOCIAL_TAG, 'TikTok', 'Instagram', 'Facebook'];

@Injectable()
export class SocialMediaDetectionHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'social_media_detection';

  private readonly logger = new Logger(SocialMediaDetectionHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly detector: SocialMediaDetectorService,
    private readonly ocr: SocialMediaOcrService,
    private readonly resolver: StorageProviderResolver,
    private readonly mediaEnrichment: MediaEnrichmentService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  // ---------------------------------------------------------------------------
  // process
  // ---------------------------------------------------------------------------

  async process(job: EnrichmentJob): Promise<void> {
    if (!job.mediaItemId) {
      throw new Error('social_media_detection job missing mediaItemId');
    }
    const mediaItemId = job.mediaItemId;

    // --- 1. Load MediaItem ---
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        circleId: true,
        type: true,
        deletedAt: true,
        addedById: true,
        originalFilename: true,
        durationMs: true,
        width: true,
        height: true,
        socialMediaSource: true,
        storageObject: {
          select: {
            storageKey: true,
            storageProvider: true,
            bucket: true,
            name: true,
            metadata: true,
          },
        },
      },
    });

    if (
      !mediaItem ||
      mediaItem.deletedAt ||
      mediaItem.type !== MediaType.video ||
      !mediaItem.storageObject
    ) {
      this.logger.debug(
        `social_media_detection job ${job.id}: MediaItem ${mediaItemId} not an active video (or missing storageObject); skipping`,
      );
      await this.upsertStatus(mediaItemId, {
        status: MediaSocialStatusType.not_processed,
      });
      return;
    }

    // Lazily-downloaded video, streamed directly to a temp file (constant
    // memory) and shared between legacy re-probe and OCR. Memoized at this
    // outer scope (not inside the try below) so the finally block can clean
    // it up exactly once, after every use is done, regardless of outcome.
    let downloadedVideoPath: string | null = null;

    try {
      // --- 2. Feature gate ---
      const settings = await this.systemSettings.getSettings();
      const featureOn = settings.features?.['socialMediaDetection'] === true;
      const killed = process.env['SOCIAL_MEDIA_DETECTION_ENABLED'] === 'false';

      if (!featureOn || killed) {
        this.logger.debug(
          `social_media_detection job ${job.id}: feature disabled; marking not_processed`,
        );
        await this.upsertStatus(mediaItemId, {
          status: MediaSocialStatusType.not_processed,
        });
        return;
      }

      const minConfidence = settings.socialMedia?.minConfidence ?? 0.8;

      // --- 3. Status → processing ---
      await this.upsertStatus(mediaItemId, {
        status: MediaSocialStatusType.processing,
      });

      // --- 4. Build VideoDetectionInput ---
      const filename = mediaItem.originalFilename || mediaItem.storageObject.name || null;
      const fileExt =
        extname(mediaItem.storageObject.name || mediaItem.originalFilename || '') || '.mp4';

      const probe = readPersistedProbe(mediaItem.storageObject.metadata);

      // Memoizes the temp file PATH (not a buffer) so repeated calls reuse
      // the same download.
      const downloadVideo = async (): Promise<string> => {
        if (downloadedVideoPath) return downloadedVideoPath;
        const provider = await this.resolver.getProviderFor(
          mediaItem.storageObject!.storageProvider,
          mediaItem.storageObject!.bucket,
        );
        const stream = await provider.download(mediaItem.storageObject!.storageKey);
        const tmpPath = join(tmpdir(), `memoriaHub-social-dl-${randomUUID()}${fileExt}`);
        await streamToTempFile(stream, tmpPath);
        downloadedVideoPath = tmpPath;
        return downloadedVideoPath;
      };

      let input: VideoDetectionInput;
      let durationMs: number | undefined;

      if (probe && probe.formatTags) {
        input = {
          kind: 'video',
          filename,
          formatTags: probe.formatTags,
          streamTags: probe.streamTags,
          formatName: probe.formatName,
          durationMs: probe.durationMs ?? mediaItem.durationMs ?? undefined,
          width: probe.width ?? mediaItem.width ?? undefined,
          height: probe.height ?? mediaItem.height ?? undefined,
        };
        durationMs = probe.durationMs ?? mediaItem.durationMs ?? undefined;
      } else {
        // Legacy item probed before this feature existed → re-probe on the fly.
        const videoPath = await downloadVideo();
        const container = await this.reprobe(videoPath);
        input = {
          kind: 'video',
          filename,
          formatTags: container.formatTags,
          streamTags: container.streamTags,
          formatName: container.formatName,
          durationMs: container.durationMs ?? mediaItem.durationMs ?? undefined,
          width: container.width ?? mediaItem.width ?? undefined,
          height: container.height ?? mediaItem.height ?? undefined,
        };
        durationMs = container.durationMs ?? mediaItem.durationMs ?? undefined;
      }

      // --- 5. Tier-1 detection ---
      const { result: tier1Result, recommendTier2 } = this.detector.detectTier1(
        input,
        minConfidence,
      );

      let result: DetectionResult | null = tier1Result;

      // --- 6. Tier-2 OCR fallback ---
      const ocrEnabled = settings.socialMedia?.ocrEnabled !== false;
      if (!result && recommendTier2 && ocrEnabled) {
        const videoPath = await downloadVideo();
        const { texts } = await this.ocr.recognizeVideo(videoPath, {
          durationMs,
          fileExtension: fileExt,
          maxFrames: settings.socialMedia?.ocrMaxFrames ?? 4,
          languages: settings.socialMedia?.ocrLanguages ?? ['eng'],
          timeoutMs: (settings.socialMedia?.ocrTimeoutSeconds ?? 60) * 1000,
        });
        const ocrResult = this.detector.detectFromOcr(texts, input, minConfidence);
        if (ocrResult) {
          result = ocrResult;
        }
      }

      // --- 7. Apply result ---
      if (result) {
        await this.applyDetected(mediaItem.id, mediaItem.circleId, mediaItem.addedById, result);
        this.logger.log(
          `social_media_detection job ${job.id}: MediaItem ${mediaItemId} flagged ${result.platform} ` +
            `(method=${result.method}, rule=${result.matchedRule}, confidence=${result.confidence})`,
        );
        // Detected items do NOT fan out to further video enrichment.
        return;
      }

      // --- 7b. Clean ---
      await this.applyClean(mediaItem.id, mediaItem.socialMediaSource);
      this.logger.log(
        `social_media_detection job ${job.id}: MediaItem ${mediaItemId} clean` +
          (mediaItem.socialMediaSource ? ' (was previously flagged — tags cleared)' : ''),
      );

      // Fan out the downstream video enrichment that was withheld while
      // classification was pending.
      await this.mediaEnrichment.enqueueVideoPostDetectionEnrichment(
        {
          id: mediaItem.id,
          type: mediaItem.type,
          circleId: mediaItem.circleId,
          deletedAt: mediaItem.deletedAt,
        },
        job.reason,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`social_media_detection job ${job.id}: ${errMsg}`);
      await this.upsertStatus(mediaItemId, {
        status: MediaSocialStatusType.failed,
        lastError: errMsg,
      }).catch(() => {});
      throw err;
    } finally {
      // Clean up the downloaded temp file exactly once, after every use
      // (legacy re-probe and/or OCR) is done — regardless of outcome.
      if (downloadedVideoPath) {
        await fs.unlink(downloadedVideoPath).catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Result application
  // ---------------------------------------------------------------------------

  /** Detected: apply tags, write status + denormalized source column. */
  private async applyDetected(
    mediaItemId: string,
    circleId: string,
    addedById: string,
    result: DetectionResult,
  ): Promise<void> {
    const tagNames = [SOCIAL_TAG];
    const platformTag = PLATFORM_TAG[result.platform];
    if (platformTag) tagNames.push(platformTag);

    await this.prisma.$transaction(async (tx) => {
      for (const name of tagNames) {
        const tag = await tx.tag.upsert({
          where: { circleId_name: { circleId, name } },
          create: { addedById, circleId, name },
          update: {},
        });
        // Create the join as a system tag; never downgrade an existing manual row.
        await tx.mediaTag.upsert({
          where: { tagId_mediaItemId: { tagId: tag.id, mediaItemId } },
          create: { tagId: tag.id, mediaItemId, source: MediaTagSource.system },
          update: {},
        });
        // Promote an existing AI-applied row (but not manual) to system so the
        // system provenance wins for these labels.
        await tx.mediaTag.updateMany({
          where: { tagId: tag.id, mediaItemId, source: MediaTagSource.ai },
          data: { source: MediaTagSource.system },
        });
      }

      await tx.mediaSocialStatus.upsert({
        where: { mediaItemId },
        create: {
          mediaItemId,
          status: MediaSocialStatusType.processed,
          isSocialMedia: true,
          platform: result.platform,
          detectionMethod: result.method,
          confidence: result.confidence,
          matchedRule: result.matchedRule,
          processedAt: new Date(),
          lastError: null,
        },
        update: {
          status: MediaSocialStatusType.processed,
          isSocialMedia: true,
          platform: result.platform,
          detectionMethod: result.method,
          confidence: result.confidence,
          matchedRule: result.matchedRule,
          processedAt: new Date(),
          lastError: null,
        },
      });

      await tx.mediaItem.update({
        where: { id: mediaItemId },
        data: { socialMediaSource: result.platform },
      });
    });
  }

  /** Clean: write status; if previously flagged, strip system tags + clear source. */
  private async applyClean(
    mediaItemId: string,
    previousSource: string | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.mediaSocialStatus.upsert({
        where: { mediaItemId },
        create: {
          mediaItemId,
          status: MediaSocialStatusType.processed,
          isSocialMedia: false,
          platform: null,
          detectionMethod: null,
          confidence: null,
          matchedRule: null,
          processedAt: new Date(),
          lastError: null,
        },
        update: {
          status: MediaSocialStatusType.processed,
          isSocialMedia: false,
          platform: null,
          detectionMethod: null,
          confidence: null,
          matchedRule: null,
          processedAt: new Date(),
          lastError: null,
        },
      });

      if (previousSource) {
        // Remove the system-applied social tags left over from the prior flag.
        await tx.mediaTag.deleteMany({
          where: {
            mediaItemId,
            source: MediaTagSource.system,
            tag: { name: { in: ALL_SOCIAL_TAG_NAMES } },
          },
        });
        await tx.mediaItem.update({
          where: { id: mediaItemId },
          data: { socialMediaSource: null },
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async upsertStatus(
    mediaItemId: string,
    data: {
      status: MediaSocialStatusType;
      lastError?: string | null;
    },
  ): Promise<void> {
    await this.prisma.mediaSocialStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        status: data.status,
        lastError: data.lastError ?? null,
      },
      update: {
        status: data.status,
        ...(data.lastError !== undefined ? { lastError: data.lastError } : {}),
      },
    });
  }

  /** Run ffprobe → ContainerMetadata against an already-downloaded temp file. */
  private async reprobe(videoPath: string) {
    const data = await probeVideoFile(videoPath);
    return extractContainerMetadata(data);
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

interface PersistedProbe {
  formatTags?: Record<string, string>;
  streamTags?: Array<Record<string, string>>;
  formatName?: string;
  durationMs?: number;
  width?: number;
  height?: number;
}

/**
 * Read the persisted `video-probe` block from StorageObject.metadata._processing.
 * Returns null when absent or malformed.
 */
function readPersistedProbe(metadata: unknown): PersistedProbe | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const processing = (metadata as Record<string, unknown>)['_processing'];
  if (!processing || typeof processing !== 'object') return null;
  const probe = (processing as Record<string, unknown>)['video-probe'];
  if (!probe || typeof probe !== 'object') return null;

  const p = probe as Record<string, unknown>;
  const formatTags =
    p['formatTags'] && typeof p['formatTags'] === 'object'
      ? (p['formatTags'] as Record<string, string>)
      : undefined;
  const streamTags = Array.isArray(p['streamTags'])
    ? (p['streamTags'] as Array<Record<string, string>>)
    : undefined;

  return {
    formatTags,
    streamTags,
    formatName: typeof p['formatName'] === 'string' ? (p['formatName'] as string) : undefined,
    durationMs: typeof p['durationMs'] === 'number' ? (p['durationMs'] as number) : undefined,
    width: typeof p['width'] === 'number' ? (p['width'] as number) : undefined,
    height: typeof p['height'] === 'number' ? (p['height'] as number) : undefined,
  };
}
