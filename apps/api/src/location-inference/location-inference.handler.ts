import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob, JobReason } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { LocationInferenceService } from './location-inference.service';

interface LocationInferenceSweepPayload {
  mode: 'sweep';
  from?: string;
  to?: string;
  force?: boolean;
}

/**
 * LocationInferenceHandler
 *
 * Dual-mode dispatch on job.mediaItemId (mirrors the storage_migration /
 * storage_insights split used elsewhere for per-item vs. global jobs):
 *   - mediaItemId set   -> per-item mode -> LocationInferenceService.inferForItem
 *   - mediaItemId null  -> sweep mode    -> LocationInferenceService.sweepCircle
 *     (payload.mode is always 'sweep' for this job type when mediaItemId is null;
 *     circleId is read from job.circleId, NOT from the payload)
 */
@Injectable()
export class LocationInferenceHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'location_inference';
  private readonly logger = new Logger(LocationInferenceHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly locationInferenceService: LocationInferenceService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    if (job.mediaItemId) {
      // 'rerun'-reason jobs (from the explicit per-item rerun endpoint, or an
      // admin-triggered retry of one) force a fresh inference that bypasses
      // the rejected-suggestion skip rule; 'upload'-reason jobs do not.
      const forceRerun = job.reason === JobReason.rerun;
      await this.locationInferenceService.inferForItem(job.mediaItemId, forceRerun);
      return;
    }

    if (!job.circleId) {
      this.logger.warn(`location_inference sweep job ${job.id} has no circleId; skipping`);
      return;
    }

    const payload = job.payload as LocationInferenceSweepPayload | null;
    await this.locationInferenceService.sweepCircle(job.circleId, {
      from: payload?.from,
      to: payload?.to,
      force: payload?.force,
    });
  }
}
