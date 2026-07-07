import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { OBJECT_PROCESSED_EVENT, ObjectProcessedEvent } from '../storage/processing/events/object-processed.event';
import { ThumbnailProcessor } from '../storage/processing/processors/thumbnail.processor';
import { ImageDimensionsProcessor } from '../storage/processing/processors/image-dimensions.processor';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';

@Injectable()
export class MediaReprocessService {
  private readonly logger = new Logger(MediaReprocessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly thumbnailProcessor: ThumbnailProcessor,
    private readonly dimensionsProcessor: ImageDimensionsProcessor,
    private readonly resolver: StorageProviderResolver,
  ) {}

  /**
   * Reprocess a single image OR video StorageObject:
   * 1. Skip if the object is not thumbnail-processable, is not in a processable
   *    state, or is itself a thumbnail (recursion guard)
   * 2. Re-run ImageDimensionsProcessor + ThumbnailProcessor in priority order
   *    (dimensions self-guards to image/* via its own canProcess, so video
   *    objects simply skip dimensions and still get a first-frame thumbnail)
   * 3. Merge results into metadata._processing, persist as 'ready', emit OBJECT_PROCESSED_EVENT
   *
   * No thumbnail deletion is needed: ThumbnailProcessor uses a deterministic
   * storageKey (`thumbnails/<objectId>.jpg`) and upserts, so the same row is
   * reused on every reprocess run — there is nothing to orphan.
   *
   * @remarks
   * Processable statuses are 'ready', 'failed', AND 'processing'. The
   * 'processing' case recovers OOM-orphaned objects: when the API container is
   * OOM-killed during in-process thumbnail generation, the object is left in
   * 'processing' forever, OBJECT_PROCESSED_EVENT never fires, and the UI spins
   * on a missing thumbnail. Re-running here heals them. Video objects are also
   * covered — ThumbnailProcessor extracts a first-frame thumbnail for video/*.
   */
  async reprocessImageObject(objectId: string): Promise<void> {
    const object = await this.prisma.storageObject.findUnique({ where: { id: objectId } });

    if (!object) {
      this.logger.warn(`reprocessImageObject: object ${objectId} not found`);
      return;
    }

    // Skip objects the thumbnail processor can't handle, objects not in a
    // processable state, and thumbnail objects (recursion guard).
    // Allow 'ready', 'failed', and 'processing':
    //  - 'failed'     — e.g. the original was in R2 while the processor used the wrong provider
    //  - 'processing' — OOM-orphaned objects whose in-process processing never completed
    // thumbnailProcessor.canProcess accepts image/* and video/* (and rejects
    // thumbnails/ itself); we keep the explicit thumbnails/ guard for clarity.
    const processableStatus =
      object.status === 'ready' || object.status === 'failed' || object.status === 'processing';
    if (!this.thumbnailProcessor.canProcess(object) || !processableStatus || object.storageKey.startsWith('thumbnails/')) {
      this.logger.debug(`reprocessImageObject: skipping object ${objectId} (mimeType=${object.mimeType}, status=${object.status}, key=${object.storageKey})`);
      return;
    }

    const existingMeta = (object.metadata as Record<string, any>) ?? {};
    const existingProcessing = (existingMeta._processing ?? {}) as Record<string, any>;

    this.logger.log(`reprocessImageObject: reprocessing object ${objectId}`);

    // Run processors in priority order: dimensions (25), thumbnail (40)
    const processors = [this.dimensionsProcessor, this.thumbnailProcessor];
    const allMetadata: Record<string, unknown> = {};

    for (const processor of processors) {
      if (!processor.canProcess(object)) continue;
      try {
        const result = await processor.process(
          object,
          async () => {
            const provider = await this.resolver.getProviderFor(
              object.storageProvider,
              object.bucket,
            );
            return provider.download(object.storageKey);
          },
        );
        if (result.success && result.metadata) {
          allMetadata[processor.name] = result.metadata;
        } else if (!result.success) {
          this.logger.warn(`reprocessImageObject: processor ${processor.name} failed for ${objectId}: ${result.error}`);
          allMetadata[`${processor.name}_error`] = result.error;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`reprocessImageObject: processor ${processor.name} threw for ${objectId}: ${msg}`);
        allMetadata[`${processor.name}_error`] = msg;
      }
    }

    // Persist merged metadata, keep non-_processing fields
    const mergedMetadata = {
      ...existingMeta,
      _processing: {
        ...existingProcessing,
        ...allMetadata,
      },
      _processedAt: new Date().toISOString(),
    };

    await this.prisma.storageObject.update({
      where: { id: objectId },
      data: { metadata: mergedMetadata, status: 'ready' },
    });

    // Emit so MediaMetadataSyncService picks up new dims + thumbnail
    this.eventEmitter.emit(OBJECT_PROCESSED_EVENT, new ObjectProcessedEvent(objectId));
  }

  /**
   * Bulk reprocess all ready image StorageObjects linked to MediaItems in the given circle,
   * or ALL if circleId is not provided.
   * Returns { reprocessed, failed }.
   */
  async reprocessCircle(circleId?: string): Promise<{ reprocessed: number; failed: number }> {
    // Find StorageObjects linked to MediaItems via the storage_object_id FK
    const whereClause = circleId ? { circleId } : {};
    const mediaItems = await this.prisma.mediaItem.findMany({
      where: { ...whereClause, deletedAt: null },
      select: { storageObjectId: true },
    });

    const objectIds = [...new Set(mediaItems.map(m => m.storageObjectId).filter(Boolean))] as string[];
    this.logger.log(`reprocessCircle: ${objectIds.length} objects to reprocess (circleId=${circleId ?? 'all'})`);

    let reprocessed = 0;
    let failed = 0;

    for (const objectId of objectIds) {
      try {
        await this.reprocessImageObject(objectId);
        reprocessed++;
        if (reprocessed % 50 === 0) {
          this.logger.log(`reprocessCircle: progress ${reprocessed}/${objectIds.length}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`reprocessCircle: failed for object ${objectId}: ${msg}`);
        failed++;
      }
    }

    this.logger.log(`reprocessCircle: done — reprocessed=${reprocessed}, failed=${failed}`);
    return { reprocessed, failed };
  }
}
