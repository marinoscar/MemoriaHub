import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProcessingRecoveryService } from '../storage/tasks/storage-processing-recovery.service';

/**
 * ThumbnailRegenHandler
 *
 * Worker-side (asynchronous) counterpart to the synchronous per-item
 * `POST /api/media/:id/thumbnail/rerun` endpoint (MediaThumbnailRerunController).
 *
 * Bulk thumbnail reruns must NOT loop the synchronous reprocess path (each call
 * re-runs the full processing pipeline in-request), so instead each item enqueues
 * a `thumbnail_regen` enrichment job whose handler performs the exact same work
 * the single-item endpoint does — resolve the MediaItem's StorageObject and call
 * StorageProcessingRecoveryService.reprocessObjectNow — just inside the worker.
 *
 * Graceful skip (missing/deleted item, no storageObject) mirrors
 * MetadataExtractionService: log a warning and return so the job succeeds rather
 * than retrying forever on a permanently-invalid target.
 */
@Injectable()
export class ThumbnailRegenHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'thumbnail_regen';

  private readonly logger = new Logger(ThumbnailRegenHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly recoveryService: StorageProcessingRecoveryService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    if (!job.mediaItemId) {
      throw new Error(`thumbnail_regen job ${job.id} is missing mediaItemId`);
    }

    const mediaItemId = job.mediaItemId;

    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, deletedAt: true, storageObject: true },
    });

    if (!mediaItem || mediaItem.deletedAt || !mediaItem.storageObject) {
      this.logger.warn(
        `thumbnail_regen job ${job.id}: MediaItem ${mediaItemId} is missing, deleted, or has no storageObject — skipping`,
      );
      return;
    }

    await this.recoveryService.reprocessObjectNow(mediaItem.storageObject);

    this.logger.log(
      `thumbnail_regen job ${job.id}: reprocessed StorageObject ${mediaItem.storageObject.id} for MediaItem ${mediaItemId}`,
    );
  }
}
