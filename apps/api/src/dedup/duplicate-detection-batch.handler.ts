import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { DuplicateDetectionService } from './duplicate-detection.service';

interface DuplicateDetectionBatchPayload {
  mediaItemIds?: string[];
}

/**
 * DuplicateDetectionBatchHandler
 *
 * Backfill uses this batch job type instead of one job per item so a large
 * circle-wide backfill doesn't flood the enrichment_jobs table with tens of
 * thousands of single-item rows. Each batch job processes a chunk of media
 * item IDs sequentially, collecting per-item failures rather than aborting
 * on the first error. If any item in the chunk failed, the job throws at
 * the end so the worker retries the whole chunk — this is safe because
 * DuplicateDetectionService.processMediaItem (via VisualEmbeddingService's
 * existence check and the union-find grouping logic) is idempotent, so
 * re-processing already-succeeded items in a retried chunk is a no-op.
 */
@Injectable()
export class DuplicateDetectionBatchHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'duplicate_detection_batch';
  private readonly logger = new Logger(DuplicateDetectionBatchHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly duplicateDetectionService: DuplicateDetectionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    const payload = job.payload as DuplicateDetectionBatchPayload | null;
    const mediaItemIds = payload?.mediaItemIds ?? [];

    if (mediaItemIds.length === 0) {
      this.logger.warn(`duplicate_detection_batch job ${job.id} has no mediaItemIds; skipping`);
      return;
    }

    let processed = 0;
    const failures: Array<{ id: string; error: string }> = [];

    for (const mediaItemId of mediaItemIds) {
      try {
        await this.duplicateDetectionService.processMediaItem(mediaItemId);
        processed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ id: mediaItemId, error: message });
        this.logger.warn(`duplicate_detection_batch job ${job.id}: item ${mediaItemId} failed: ${message}`);
      }
    }

    this.logger.log(
      `duplicate_detection_batch job ${job.id}: processed=${processed} failed=${failures.length} (chunk size ${mediaItemIds.length})`,
    );

    if (failures.length > 0) {
      throw new Error(
        `duplicate_detection_batch job ${job.id}: ${failures.length}/${mediaItemIds.length} item(s) failed: ` +
          failures.map((f) => `${f.id} (${f.error})`).join('; '),
      );
    }
  }
}
