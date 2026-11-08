import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  JobHandlerRegistry,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { resolveMediaItemJob } from '../platform/jobs/media-item-job';
import { PrismaService } from '../prisma/prisma.service';
import { BurstDetectionService } from './burst-detection.service';

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
 */
@Injectable()
export class BurstDetectionHandler implements JobHandler, OnModuleInit {
  readonly type = 'burst_detection';
  readonly label = 'Burst detection';
  /** A timeline-window read, at most one download for a legacy hash, a few writes: minutes. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 300_000, maxAttempts: 3 };

  private readonly logger = new Logger(BurstDetectionHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly burstDetectionService: BurstDetectionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await this.burstDetectionService.processMediaItem(context);
  }
}
