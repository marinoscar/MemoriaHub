import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { LocationSuggestionService } from './location-suggestion.service';

interface LocationBulkAcceptPayload {
  minConfidence: number;
  requestedById: string;
}

/**
 * LocationBulkAcceptHandler
 *
 * SERVER-ONLY handler (implements ONLY the in-process `process()` half — no
 * nodeResultSchema / persistNodeResult, so it is never node-claimable; the CLI's
 * NODE_JOB_TYPES deliberately omits `location_bulk_accept`). Mirrors the
 * LocationInferenceHandler / FaceAutoArchiveSweepHandler sweep shape: one global
 * job per bulk-accept request, keyed by job.circleId, mediaItemId is null.
 *
 * Drains the circle's pending location-suggestion review queue at/above a
 * confidence floor in bounded batches, applying each suggestion's coordinates
 * (reverse-geocode + column write) asynchronously so a 10k backlog no longer
 * blocks the request past the nginx proxy timeout (issue #125).
 */
@Injectable()
export class LocationBulkAcceptHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'location_bulk_accept';
  private readonly logger = new Logger(LocationBulkAcceptHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly locationSuggestionService: LocationSuggestionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    if (!job.circleId) {
      this.logger.warn(`location_bulk_accept job ${job.id} has no circleId; skipping`);
      return;
    }

    const payload = job.payload as LocationBulkAcceptPayload | null;
    if (!payload || typeof payload.minConfidence !== 'number' || !payload.requestedById) {
      this.logger.warn(`location_bulk_accept job ${job.id} has an invalid payload; skipping`);
      return;
    }

    await this.locationSuggestionService.processBulkAccept(
      job.circleId,
      payload.minConfidence,
      payload.requestedById,
    );
  }
}
