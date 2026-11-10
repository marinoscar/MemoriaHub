import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  JobHandlerRegistry,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { resolveCircleJob, resolveMediaItemJob } from '../platform/jobs/media-item-job';
import { PrismaService } from '../prisma/prisma.service';
import { LocationInferenceService } from './location-inference.service';

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
 */
@Injectable()
export class LocationInferenceHandler implements JobHandler, OnModuleInit {
  readonly type = 'location_inference';
  readonly label = 'Location inference';
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 900_000, maxAttempts: 3 };

  private readonly logger = new Logger(LocationInferenceHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly locationInferenceService: LocationInferenceService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
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

    const circleId = await resolveCircleJob(this.prisma, job, this.logger);
    if (!circleId) return;

    const payload = (job.payload ?? null) as LocationInferenceSweepPayload | null;
    await this.locationInferenceService.sweepCircle(circleId, {
      from: payload?.from,
      to: payload?.to,
      force: payload?.force,
    });
  }
}
