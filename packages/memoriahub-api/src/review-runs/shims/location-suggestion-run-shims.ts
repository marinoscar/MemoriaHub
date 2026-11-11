import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import {
  MEMORIAHUB_JOBS,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
} from '../../ports/index.js';
import { ReviewRunEvaluateHandler } from '../review-run-evaluate.handler.js';
import { ReviewRunExecuteBatchHandler } from '../review-run-execute-batch.handler.js';

// =============================================================================
// DEPRECATED shims of the retired `location_suggestion_run_*` job types (issue #190, RETRO-J9 #622)
// =============================================================================
//
// Location-suggestion bulk accept/reject runs on the shared review-run engine. These two handlers exist ONLY
// so jobs already queued under the old type strings still execute instead of stranding as unhandled: the
// run rows themselves migrated into `review_runs` preserving their UUIDs, so the payload is unchanged and the
// generic handler resolves it directly. THE TYPE STRINGS ARE PERMANENT while rows of them may exist (the
// job-type snapshot pins both); they are SERVER-ONLY by omission exactly like the handlers they delegate to.
// =============================================================================

/** Legacy payload shape: subject ids were named `suggestionIds`. */
interface LegacyExecuteBatchPayload {
  runId?: string;
  suggestionIds?: string[];
  subjectIds?: string[];
}

/**
 * Drains a queued `location_suggestion_run_evaluate` job through the shared review-run engine.
 *
 * @stability deprecated
 */
@Injectable()
export class LocationSuggestionRunEvaluateHandler implements MemoriahubJobHandler, OnModuleInit {
  /** The retired job type. Permanent. */
  readonly type = 'location_suggestion_run_evaluate';

  /** The label in the admin job list. */
  readonly label = 'Location suggestion run evaluate';

  /** Same budget as the handler it delegates to. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 900_000, maxAttempts: 3 };

  private readonly logger = new Logger(LocationSuggestionRunEvaluateHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    private readonly delegate: ReviewRunEvaluateHandler,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /**
   * Delegates the job.
   *
   * @param job - the legacy job.
   */
  async process(job: MemoriahubJob): Promise<void> {
    this.logger.log(`Draining deprecated ${this.type} job ${job.id} through the shared review-run engine`);
    await this.delegate.process(job);
  }
}

/**
 * Drains a queued `location_suggestion_run_execute_batch` job through the shared review-run engine,
 * renaming the legacy `suggestionIds` payload field to the generic `subjectIds`.
 *
 * @stability deprecated
 */
@Injectable()
export class LocationSuggestionRunExecuteBatchHandler implements MemoriahubJobHandler, OnModuleInit {
  /** The retired job type. Permanent. */
  readonly type = 'location_suggestion_run_execute_batch';

  /** The label in the admin job list. */
  readonly label = 'Location suggestion run execute batch';

  /** Same budget as the handler it delegates to. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 600_000, maxAttempts: 3 };

  private readonly logger = new Logger(LocationSuggestionRunExecuteBatchHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    private readonly delegate: ReviewRunExecuteBatchHandler,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /**
   * Delegates the job.
   *
   * @param job - the legacy job.
   */
  async process(job: MemoriahubJob): Promise<void> {
    const payload = job.payload as unknown as LegacyExecuteBatchPayload | null;
    const subjectIds = payload?.subjectIds ?? payload?.suggestionIds;
    if (!payload?.runId || !Array.isArray(subjectIds)) {
      this.logger.warn(`${this.type} job ${job.id} missing payload; skipping`);
      return;
    }
    this.logger.log(`Draining deprecated ${this.type} job ${job.id} through the shared review-run engine`);
    await this.delegate.executeBatch({ runId: payload.runId, subjectIds });
  }
}
