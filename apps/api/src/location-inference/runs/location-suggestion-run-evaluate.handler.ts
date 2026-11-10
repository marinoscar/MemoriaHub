import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  JobHandlerRegistry,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
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
 * A native platform `JobHandler` since RETRO-C6 (#600), SERVER-ONLY by omission exactly like the handler it
 * delegates to. Retained (not deleted) because pending rows of the old types cannot be ruled out from the
 * code: see `docs/platform-adoption/local-exceptions.md`. The labels stay registered either way.
 */
@Injectable()
export class LocationSuggestionRunEvaluateHandler implements JobHandler, OnModuleInit {
  readonly type = 'location_suggestion_run_evaluate';

  readonly label = 'Location suggestion run evaluate';
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 900_000, maxAttempts: 3 };

  private readonly logger = new Logger(LocationSuggestionRunEvaluateHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly delegate: ReviewRunEvaluateHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    this.logger.log(
      `Draining deprecated ${this.type} job ${job.id} through the shared review-run engine`,
    );
    await this.delegate.process(job);
  }
}
