import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { resolveMediaItemJob } from '../media/index.js';
import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
} from '../ports/index.js';
import type { BurstDb } from './data/burst-db.js';
import { BurstDetectionService } from './burst-detection.service.js';

/**
 * `burst_detection`: a native platform `JobHandler` (RETRO-C5, #594).
 *
 * SERVER-ONLY (no node pair): grouping reads the item's neighbours across the
 * circle's timeline mid-computation (temporal window, BurstUUID, hash distance)
 * and merges groups as it goes; there is no self-contained result a node could
 * compute from the original's bytes alone.
 *
 * BURST WINS: the upload path enqueues this type at priority 5, before
 * `duplicate_detection` at 10, and BurstDetectionService evicts the new burst
 * group's members from any duplicate group dedup placed them in first.
 *
 * The subject is the media item; a media item that no longer exists settles the
 * job as a no-op.
 *
 * @stability experimental
 */
@Injectable()
export class BurstDetectionHandler implements MemoriahubJobHandler, OnModuleInit {
  /** The job type. Permanent. */
  readonly type = 'burst_detection';

  /** The label in the admin job list. */
  readonly label = 'Burst detection';

  /** A timeline-window read, at most one download for a legacy hash, a few writes: minutes. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 300_000, maxAttempts: 3 };

  private readonly logger = new Logger(BurstDetectionHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: BurstDb,
    private readonly burstDetectionService: BurstDetectionService,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /** Runs one attempt on the server. */
  async process(job: MemoriahubJob): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await this.burstDetectionService.processMediaItem(context);
  }
}
