import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { ReviewRunEvaluateHandler } from '../../review-runs/review-run-evaluate.handler';

/**
 * DEPRECATED shim for the retired `location_suggestion_run_evaluate` job type
 * (issue #190).
 *
 * Location-suggestion bulk accept/reject now runs on the shared review-run
 * engine (`review_run_evaluate`). This class exists ONLY so jobs already queued
 * under the old type at deploy time still execute instead of stranding as
 * unhandled — the run rows themselves migrated into `review_runs` preserving
 * their UUIDs, so the payload (`{ runId }`) is unchanged and the generic handler
 * resolves it directly.
 *
 * Remove one release after deploy, once no `location_suggestion_run_evaluate`
 * rows remain pending.
 *
 * SERVER-ONLY by omission, exactly like the handler it delegates to.
 */
@Injectable()
export class LocationSuggestionRunEvaluateHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'location_suggestion_run_evaluate';

  private readonly logger = new Logger(LocationSuggestionRunEvaluateHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly delegate: ReviewRunEvaluateHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    this.logger.log(
      `Draining deprecated ${this.type} job ${job.id} through the shared review-run engine`,
    );
    await this.delegate.process(job);
  }
}
