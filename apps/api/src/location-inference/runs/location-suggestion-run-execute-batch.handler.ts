import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  JobHandlerRegistry,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { ReviewRunExecuteBatchHandler } from '../../review-runs/review-run-execute-batch.handler';

/** Legacy payload shape: subject ids were named `suggestionIds`. */
interface LegacyExecuteBatchPayload {
  runId?: string;
  suggestionIds?: string[];
  subjectIds?: string[];
}

/**
 * DEPRECATED shim for the retired `location_suggestion_run_execute_batch` job
 * type (issue #190).
 *
 * Delegates to the shared `review_run_execute_batch` engine, renaming the
 * legacy `suggestionIds` payload field to the generic `subjectIds`. Exists ONLY
 * so batch jobs already queued under the old type at deploy time still execute
 * — their run rows migrated into `review_runs` preserving their UUIDs, and the
 * suggestion ids are unchanged.
 *
 * Remove one release after deploy, once no `location_suggestion_run_execute_batch`
 * rows remain pending.
 *
 * A native platform `JobHandler` since RETRO-C6 (#600), SERVER-ONLY by omission exactly like the handler it
 * delegates to. Retained (not deleted) because pending rows of the old types cannot be ruled out from the
 * code: see `docs/platform-adoption/local-exceptions.md`. The labels stay registered either way.
 */
@Injectable()
export class LocationSuggestionRunExecuteBatchHandler implements JobHandler, OnModuleInit {
  readonly type = 'location_suggestion_run_execute_batch';

  readonly label = 'Location suggestion run execute batch';
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 600_000, maxAttempts: 3 };

  private readonly logger = new Logger(LocationSuggestionRunExecuteBatchHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly delegate: ReviewRunExecuteBatchHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const payload = job.payload as unknown as LegacyExecuteBatchPayload | null;
    const subjectIds = payload?.subjectIds ?? payload?.suggestionIds;
    if (!payload?.runId || !Array.isArray(subjectIds)) {
      this.logger.warn(`${this.type} job ${job.id} missing payload; skipping`);
      return;
    }
    this.logger.log(
      `Draining deprecated ${this.type} job ${job.id} through the shared review-run engine`,
    );
    await this.delegate.executeBatch({ runId: payload.runId, subjectIds });
  }
}
