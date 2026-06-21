import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EnrichmentJob, MediaMetadataStatusType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_PROVIDER, StorageProvider } from '../storage/providers/storage-provider.interface';
import { OBJECT_PROCESSOR, ObjectProcessor } from '../storage/processing/object-processor.interface';
import { MediaMetadataSyncService } from '../media/sync/media-metadata-sync.service';

/**
 * Only these processor names are allowed to run during a metadata re-extraction.
 * Excludes content-hash (immutable), thumbnail (separate pipeline), and visual-hash
 * (handled by burst detection backfill).
 */
const METADATA_PROCESSOR_ALLOWLIST = ['exif', 'dimensions', 'geocode', 'video-probe'];

@Injectable()
export class MetadataExtractionService {
  private readonly logger = new Logger(MetadataExtractionService.name);
  private readonly processors: ObjectProcessor[];

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storageProvider: StorageProvider,
    @Optional() @Inject(OBJECT_PROCESSOR) rawProcessors: ObjectProcessor | ObjectProcessor[] | undefined,
    private readonly mediaMetadataSyncService: MediaMetadataSyncService,
  ) {
    this.processors = Array.isArray(rawProcessors)
      ? rawProcessors
      : rawProcessors
        ? [rawProcessors]
        : [];
  }

  async processMediaItem(job: EnrichmentJob): Promise<void> {
    // Guard: mediaItemId must be present
    if (!job.mediaItemId) {
      throw new Error(`metadata_extraction job ${job.id} is missing mediaItemId`);
    }

    const mediaItemId = job.mediaItemId;

    // Load MediaItem with minimal fields + storageObject reference
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        circleId: true,
        deletedAt: true,
        storageObjectId: true,
        storageObject: {
          select: { id: true, storageKey: true, mimeType: true },
        },
      },
    });

    // Graceful skip: missing, deleted, or no storage object
    if (!mediaItem || mediaItem.deletedAt || !mediaItem.storageObject) {
      this.logger.warn(
        `metadata_extraction job ${job.id}: MediaItem ${mediaItemId} is missing, deleted, or has no storageObject — skipping`,
      );
      await this.markFailed(mediaItemId, job.circleId ?? mediaItem?.circleId ?? '', 'MediaItem missing or deleted');
      return;
    }

    const circleId = mediaItem.circleId;

    // Mark as processing
    await this.prisma.mediaMetadataStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId,
        status: MediaMetadataStatusType.processing,
      },
      update: {
        status: MediaMetadataStatusType.processing,
        lastError: null,
      },
    });

    try {
      // Reload full StorageObject for processing
      const storageObject = await this.prisma.storageObject.findUnique({
        where: { id: mediaItem.storageObject.id },
        select: { id: true, mimeType: true, metadata: true, storageKey: true },
      });

      if (!storageObject) {
        throw new Error(`StorageObject ${mediaItem.storageObject.id} not found`);
      }

      // Run only allowlisted processors, in priority order
      const allowlistedProcessors = this.processors
        .filter((p) => METADATA_PROCESSOR_ALLOWLIST.includes(p.name))
        .sort((a, b) => a.priority - b.priority);

      this.logger.debug(
        `metadata_extraction job ${job.id}: running ${allowlistedProcessors.length} processor(s): ${allowlistedProcessors.map((p) => p.name).join(', ')}`,
      );

      const allMetadata: Record<string, unknown> = {};

      for (const processor of allowlistedProcessors) {
        if (!processor.canProcess(storageObject as any)) {
          continue;
        }

        try {
          const result = await processor.process(
            storageObject as any,
            () => this.storageProvider.download(storageObject.storageKey),
          );

          if (result.success && result.metadata) {
            allMetadata[processor.name] = result.metadata;
            this.logger.debug(`Processor ${processor.name} succeeded for MediaItem ${mediaItemId}`);
          } else if (!result.success) {
            allMetadata[`${processor.name}_error`] = result.error;
            this.logger.warn(
              `Processor ${processor.name} failed for MediaItem ${mediaItemId}: ${result.error}`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          allMetadata[`${processor.name}_error`] = msg;
          this.logger.error(
            `Processor ${processor.name} threw for MediaItem ${mediaItemId}: ${msg}`,
          );
        }
      }

      // Merge into storageObject.metadata._processing, preserving existing keys
      const existingMeta = (storageObject.metadata as Record<string, unknown> | null) ?? {};
      const existingProcessing =
        (existingMeta['_processing'] as Record<string, unknown> | undefined) ?? {};

      const mergedMetadata: Record<string, unknown> = {
        ...existingMeta,
        _processing: {
          ...existingProcessing,
          ...allMetadata,
        },
        _processedAt: new Date().toISOString(),
      };

      await this.prisma.storageObject.update({
        where: { id: storageObject.id },
        data: { metadata: mergedMetadata as Prisma.InputJsonValue },
      });

      // Sync typed columns into MediaItem directly — do NOT emit OBJECT_PROCESSED_EVENT
      await this.mediaMetadataSyncService.syncFromStorageObject(storageObject.id);

      // Mark as processed
      await this.prisma.mediaMetadataStatus.upsert({
        where: { mediaItemId },
        create: {
          mediaItemId,
          circleId,
          status: MediaMetadataStatusType.processed,
          processedAt: new Date(),
        },
        update: {
          status: MediaMetadataStatusType.processed,
          processedAt: new Date(),
          lastError: null,
        },
      });

      this.logger.log(`metadata_extraction job ${job.id}: completed for MediaItem ${mediaItemId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.markFailed(mediaItemId, circleId, msg);
      throw err; // Re-throw so worker can retry
    }
  }

  private async markFailed(mediaItemId: string, circleId: string, error: string): Promise<void> {
    await this.prisma.mediaMetadataStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId,
        status: MediaMetadataStatusType.failed,
        lastError: error,
      },
      update: {
        status: MediaMetadataStatusType.failed,
        lastError: error,
      },
    });
  }
}
