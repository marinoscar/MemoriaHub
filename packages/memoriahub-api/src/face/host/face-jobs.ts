import { Inject, Injectable } from '@nestjs/common';

import { MEMORIAHUB_JOBS, type MemoriahubJobsPort } from '../../ports/index.js';

// =============================================================================
// FaceJobs: the face slice's enqueue facade over MEMORIAHUB_JOBS
// =============================================================================
//
// A media-item job is about one media item (`subjectType: 'media_item'`) and keeps its
// circle in `payload.circleId`; a circle sweep is about the circle. This is the shape the
// queue and the admin job list have always seen, so the slice builds it once here.
// =============================================================================

/**
 * What the slice enqueues.
 *
 * @stability experimental
 */
export interface FaceEnqueueInput {
  /** The job type string (permanent). */
  type: string;
  /** The media item a per-item job is about. */
  mediaItemId?: string | null;
  /** The circle (owner scope) of the item, or the circle a sweep is about. */
  circleId?: string | null;
  /** Why the job exists: `upload`, `rerun` or `backfill`. */
  reason: string;
  /** Claim priority; lower claims first. */
  priority?: number;
  /** Extra payload. */
  payload?: Record<string, unknown>;
  /** Skips the dedup against an identical pending or running job. */
  skipDedup?: boolean;
  /** Earliest start. */
  scheduledFor?: Date;
}

/**
 * Enqueues the slice's jobs and records the model a job ran on.
 *
 * @stability experimental
 */
@Injectable()
export class FaceJobs {
  constructor(@Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort) {}

  /**
   * Enqueues one job.
   *
   * @param input - the job.
   * @returns the queued (or the already queued, when deduplicated) job id.
   */
  async enqueue(input: FaceEnqueueInput): Promise<{ id: string }> {
    const { type, mediaItemId = null, circleId = null, reason, priority, payload, skipDedup = false, scheduledFor } = input;
    const subjectType = mediaItemId ? 'media_item' : circleId ? 'circle' : undefined;
    const subjectId = mediaItemId ?? circleId ?? undefined;
    const stored = mediaItemId && circleId ? { ...(payload ?? {}), circleId } : (payload ?? {});

    const queued = await this.jobs.enqueue({
      type,
      reason,
      ...(subjectType !== undefined ? { subjectType } : {}),
      ...(subjectId !== undefined ? { subjectId } : {}),
      payload: stored,
      ...(priority !== undefined ? { priority } : {}),
      ...(scheduledFor !== undefined ? { scheduledFor } : {}),
      skipDedup,
    });
    return { id: queued.id };
  }

  /**
   * Finds the active (pending or running) jobs of a type about the given circles.
   *
   * @param type - the job type.
   * @param circleIds - the circles.
   * @returns the circle ids that already have one.
   */
  async circlesWithActive(type: string, circleIds: readonly string[]): Promise<Set<string>> {
    if (circleIds.length === 0) return new Set();
    const active = await this.jobs.findActive({ types: [type], subjectType: 'circle', subjectIds: circleIds });
    return new Set(active.map((row) => row.subjectId).filter((id): id is string => id !== null));
  }

  /**
   * Records the provider and model a job ran on.
   *
   * @param jobId - the job.
   * @param provider - the provider key.
   * @param model - the model version.
   */
  async recordModel(jobId: string, provider: string | null, model: string | null): Promise<void> {
    await this.jobs.recordProvider?.(jobId, provider, model);
  }
}
