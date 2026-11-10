import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { resolveCircleJob, resolveMediaItemJob } from '../../media/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubAccessPort,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
} from '../../ports/index.js';
import type { LocationDb } from '../data/location-db.js';
import { LocationInferenceService } from './location-inference.service.js';

interface LocationInferenceSweepPayload {
  mode?: 'sweep';
  from?: string;
  to?: string;
  force?: boolean;
}

/**
 * `location_inference`: a native, SERVER-ONLY platform `JobHandler` (RETRO-C6, #600).
 *
 * Two shapes share the one (permanent) type, dispatched on the job's subject:
 *   - `media_item` subject -> per-item mode -> `LocationInferenceService.inferForItem`
 *   - `circle` subject     -> sweep mode    -> `LocationInferenceService.sweepCircle`
 *     (`payload: { mode: 'sweep', from?, to?, force? }`; the circle is the subject, NOT the payload)
 *
 * The profile is sized for the dearer shape: a sweep loads a whole circle's timeline into memory and writes
 * in 500-item chunks (15 minutes); per-item is far cheaper but shares the type. No node pair: pure DB read
 * plus in-memory compute, nothing a node could do. It writes no organization (row-level-security) table,
 * so it needs no `JobScope`. A subject that no longer exists settles the job as a no-op.
 *
 * @stability experimental
 */
@Injectable()
export class LocationInferenceHandler implements MemoriahubJobHandler, OnModuleInit {
  /** The job type. Permanent. */
  readonly type = 'location_inference';

  /** The label in the admin job list. */
  readonly label = 'Location inference';

  /** The dearer shape (a circle sweep): 15 minutes, three attempts. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 900_000, maxAttempts: 3 };

  private readonly logger = new Logger(LocationInferenceHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: LocationDb,
    @Inject(MEMORIAHUB_ACCESS) private readonly scopes: MemoriahubAccessPort,
    private readonly locationInferenceService: LocationInferenceService,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /** Runs one attempt: a per-item inference or a circle sweep, by the job's subject. */
  async process(job: MemoriahubJob): Promise<void> {
    if (job.subjectType === 'media_item') {
      const context = await resolveMediaItemJob(this.prisma, job, this.logger);
      if (!context) return;
      // 'rerun'-reason jobs (from the explicit per-item rerun endpoint, or an
      // admin-triggered retry of one) force a fresh inference that bypasses
      // the rejected-suggestion skip rule; 'upload'-reason jobs do not.
      const forceRerun = job.reason === 'rerun';
      await this.locationInferenceService.inferForItem(context.mediaItemId, forceRerun);
      return;
    }

    if (job.subjectType !== 'circle' || !job.subjectId) {
      this.logger.warn(`location_inference sweep job ${job.id} has no circle subject; skipping`);
      return;
    }

    const circleId = await resolveCircleJob(this.scopes, job, this.logger);
    if (!circleId) return;

    const payload = (job.payload ?? null) as LocationInferenceSweepPayload | null;
    await this.locationInferenceService.sweepCircle(circleId, {
      from: payload?.from,
      to: payload?.to,
      force: payload?.force,
    });
  }
}
