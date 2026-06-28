import { Injectable, Logger } from '@nestjs/common';
import { EnrichmentJob, JobReason, MediaSocialStatusType, MediaType } from '@prisma/client';
import { Readable } from 'stream';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { VideoProbeProcessor } from '../storage/processing/processors/video-probe.processor';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { SocialOcrService } from './social-ocr.service';
import { detectSocial, SocialSignals, ALL_SYSTEM_TAG_NAMES } from './social-detectors';
import { MediaEnrichmentService } from '../media/enrichment/media-enrichment.service';

@Injectable()
export class SocialDetectionService {
  private readonly logger = new Logger(SocialDetectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: StorageProviderResolver,
    private readonly videoProbeProcessor: VideoProbeProcessor,
    private readonly systemSettings: SystemSettingsService,
    private readonly socialOcrService: SocialOcrService,
    private readonly mediaEnrichmentService: MediaEnrichmentService,
  ) {}

  async processMediaItem(job: EnrichmentJob): Promise<void> {
    // Guard: mediaItemId must be present
    if (!job.mediaItemId) {
      throw new Error(`social_media_detection job ${job.id} is missing mediaItemId`);
    }

    const mediaItemId = job.mediaItemId;

    // Load MediaItem with storageObject fields needed for detection
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        circleId: true,
        deletedAt: true,
        type: true,
        originalFilename: true,
        addedById: true,
        cameraMake: true,
        cameraModel: true,
        takenLat: true,
        takenLng: true,
        width: true,
        height: true,
        durationMs: true,
        storageObject: {
          select: {
            id: true,
            storageKey: true,
            storageProvider: true,
            bucket: true,
            name: true,
            mimeType: true,
            metadata: true,
          },
        },
      },
    });

    // Graceful skip: missing, deleted, or no storage object
    if (!mediaItem || mediaItem.deletedAt || !mediaItem.storageObject) {
      this.logger.warn(
        `social_media_detection job ${job.id}: MediaItem ${mediaItemId} is missing, deleted, or has no storageObject — marking failed`,
      );
      await this.markFailed(mediaItemId, job.circleId ?? mediaItem?.circleId ?? '', 'MediaItem missing or deleted');
      return;
    }

    const circleId = mediaItem.circleId;

    // Skip non-video MIME types
    if (!mediaItem.storageObject.mimeType.startsWith('video/')) {
      this.logger.log(
        `social_media_detection job ${job.id}: MediaItem ${mediaItemId} is not a video (${mediaItem.storageObject.mimeType}) — marking processed with detected=false`,
      );
      await this.prisma.mediaSocialStatus.upsert({
        where: { mediaItemId },
        create: {
          mediaItemId,
          circleId,
          status: MediaSocialStatusType.processed,
          detected: false,
          processedAt: new Date(),
        },
        update: {
          status: MediaSocialStatusType.processed,
          detected: false,
          processedAt: new Date(),
          lastError: null,
        },
      });
      return;
    }

    // Mark as processing
    await this.prisma.mediaSocialStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId,
        status: MediaSocialStatusType.processing,
        detected: false,
      },
      update: {
        status: MediaSocialStatusType.processing,
        lastError: null,
      },
    });

    try {
      // Read video probe data from storageObject.metadata._processing['video-probe']
      const storageMeta = (mediaItem.storageObject.metadata as Record<string, unknown> | null) ?? {};
      const processing = (storageMeta['_processing'] as Record<string, unknown> | undefined) ?? {};
      let videoProbeData = processing['video-probe'] as Record<string, unknown> | undefined;

      // LEGACY FALLBACK: if containerTags absent, re-probe the video
      if (!videoProbeData || !videoProbeData['containerTags']) {
        this.logger.log(
          `social_media_detection job ${job.id}: containerTags absent; re-probing video for MediaItem ${mediaItemId}`,
        );
        try {
          const objectProvider = await this.resolver.getProviderFor(
            mediaItem.storageObject.storageProvider,
            mediaItem.storageObject.bucket,
          );
          const result = await this.videoProbeProcessor.process(
            mediaItem.storageObject as any,
            () => objectProvider.download(mediaItem.storageObject!.storageKey) as Promise<Readable>,
          );
          if (result.success && result.metadata) {
            videoProbeData = result.metadata as Record<string, unknown>;
          }
        } catch (probeErr) {
          const msg = probeErr instanceof Error ? probeErr.message : String(probeErr);
          this.logger.warn(`social_media_detection job ${job.id}: re-probe failed — ${msg}`);
        }
      }

      // Build SocialSignals
      const containerTags =
        (videoProbeData?.['containerTags'] as Record<string, string> | undefined) ?? {};
      const hasContainerCreationTime =
        (videoProbeData?.['hasContainerCreationTime'] as boolean | undefined) ?? false;

      const filename = mediaItem.originalFilename ?? mediaItem.storageObject.name ?? '';
      const storageName = mediaItem.storageObject.name ?? '';

      const signals: SocialSignals = {
        filename,
        storageName,
        containerTags,
        codec: videoProbeData?.['codec'] as string | undefined,
        width: (mediaItem.width ?? videoProbeData?.['width']) as number | undefined,
        height: (mediaItem.height ?? videoProbeData?.['height']) as number | undefined,
        durationMs: (mediaItem.durationMs ?? videoProbeData?.['durationMs']) as number | undefined,
        hasCameraMake: !!mediaItem.cameraMake,
        hasCameraModel: !!mediaItem.cameraModel,
        hasGps: mediaItem.takenLat != null && mediaItem.takenLng != null,
        hasContainerCreationTime,
      };

      // First-pass detection (no OCR yet)
      let result = detectSocial(signals);

      // Tiered OCR: if no confident platform detected, check system setting for OCR
      if (!result.platform) {
        const settings = await this.systemSettings.getSettings();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const socialSettings = (settings as any).social as
          | { ocr?: { enabled?: boolean; frameCount?: number } }
          | undefined;
        const ocrEnabled = socialSettings?.ocr?.enabled !== false; // default true if not explicitly false

        if (ocrEnabled) {
          const frameCount = socialSettings?.ocr?.frameCount ?? 3;
          this.logger.log(
            `social_media_detection job ${job.id}: running OCR (${frameCount} frame(s)) on MediaItem ${mediaItemId}`,
          );
          try {
            const objectProvider = await this.resolver.getProviderFor(
              mediaItem.storageObject.storageProvider,
              mediaItem.storageObject.bucket,
            );
            const storageKey = mediaItem.storageObject.storageKey;
            const ocrText = await this.socialOcrService.extractOcrText(
              () => objectProvider.download(storageKey) as Promise<Readable>,
              {
                durationMs: signals.durationMs,
                frameCount,
              },
            );

            if (ocrText) {
              signals.ocrText = ocrText;
              // Re-run detection with OCR text
              result = detectSocial(signals);
            }
          } catch (ocrErr) {
            const msg = ocrErr instanceof Error ? ocrErr.message : String(ocrErr);
            this.logger.warn(`social_media_detection job ${job.id}: OCR failed — ${msg}`);
          }
        }
      }

      // Persist tags and status in a transaction
      await this.prisma.$transaction(async (tx) => {
        if (result.detected && result.tagNames.length > 0) {
          // Upsert system Tags and MediaTags
          for (const tagName of result.tagNames) {
            const tag = await tx.tag.upsert({
              where: { circleId_name: { circleId, name: tagName } },
              create: {
                circleId,
                name: tagName,
                addedById: mediaItem.addedById, // attribute system tags to the item's uploader
                isSystem: true,
              },
              update: { isSystem: true },
            });

            await tx.mediaTag.upsert({
              where: { tagId_mediaItemId: { tagId: tag.id, mediaItemId } },
              create: { tagId: tag.id, mediaItemId, source: 'system' as const },
              update: { source: 'system' as const },
            });
          }
        } else {
          // Not detected: remove any system-sourced tags for this item
          await tx.mediaTag.deleteMany({
            where: {
              mediaItemId,
              source: 'system' as const,
            },
          });
        }
      });

      // Upsert final status
      await this.prisma.mediaSocialStatus.upsert({
        where: { mediaItemId },
        create: {
          mediaItemId,
          circleId,
          status: MediaSocialStatusType.processed,
          detected: result.detected,
          platform: result.platform,
          score: result.score,
          processedAt: new Date(),
        },
        update: {
          status: MediaSocialStatusType.processed,
          detected: result.detected,
          platform: result.platform,
          score: result.score,
          processedAt: new Date(),
          lastError: null,
        },
      });

      this.logger.log(
        `social_media_detection job ${job.id}: completed — detected=${result.detected} platform=${result.platform ?? 'none'} score=${result.score} for MediaItem ${mediaItemId}`,
      );

      // Social gate: if this was an upload job and the item was NOT flagged as
      // social media, release the gate and enqueue video_face_detection now.
      if (job.reason === JobReason.upload && !result.detected) {
        try {
          await this.mediaEnrichmentService.enqueueVideoFaceIfEligible({
            id: mediaItem.id,
            circleId: mediaItem.circleId,
            type: mediaItem.type as MediaType,
            deletedAt: mediaItem.deletedAt ?? null,
          });
        } catch (chainErr) {
          const chainMsg = chainErr instanceof Error ? chainErr.message : String(chainErr);
          this.logger.warn(
            `social_media_detection job ${job.id}: failed to chain video_face_detection for MediaItem ${mediaItemId} — ${chainMsg}`,
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.markFailed(mediaItemId, circleId, msg);
      throw err; // Re-throw so worker can retry
    }
  }

  private async markFailed(mediaItemId: string, circleId: string, error: string): Promise<void> {
    await this.prisma.mediaSocialStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId,
        status: MediaSocialStatusType.failed,
        detected: false,
        lastError: error,
      },
      update: {
        status: MediaSocialStatusType.failed,
        lastError: error,
      },
    });
  }

  /** Expose ALL_SYSTEM_TAG_NAMES for admin listing endpoint. */
  getSupportedTagNames(): string[] {
    return [...ALL_SYSTEM_TAG_NAMES];
  }
}
