import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { enqueueEnrichmentJob, whereDateRange } from '../media/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubAccessPort,
  type MemoriahubJobsPort,
} from '../ports/index.js';
import { SOCIAL_JOB_REASON, SOCIAL_MEDIA_JOB_TYPE, SOCIAL_MEDIA_TYPE, SOCIAL_STATUS } from './constants.js';
import type { SocialMediaDb } from './data/social-media-db.js';

/**
 * SocialMediaBackfillService
 *
 * Companion service for the `social_media_detection` enrichment job type,
 * mirroring GeocodeBackfillService / FaceBackfillService:
 *   - per-item rerun (priority 0, reason=rerun) + status read for the media API
 *   - per-circle and global backfill (priority 100, reason=backfill) for admins
 *
 * Detection only targets videos — photos are never social-media re-uploads.
 *
 * @stability experimental
 */
@Injectable()
export class SocialMediaBackfillService {
  private readonly logger = new Logger(SocialMediaBackfillService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: SocialMediaDb,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_ACCESS) private readonly access: MemoriahubAccessPort,
  ) {}

  /**
   * Backfill social-media detection for all eligible videos in a single circle.
   * No per-circle opt-in gate — the global toggle is the only gate (checked in
   * the controller). No membership check — intended for admin/internal usage.
   */
  async backfillCircle(
    circleId: string,
    opts: { from?: string; to?: string; force?: boolean },
  ): Promise<number> {
    const { force = false } = opts;

    const from = opts.from ? new Date(opts.from) : undefined;
    const to = opts.to ? new Date(opts.to) : undefined;
    const dateWhere = whereDateRange(from, to);

    const mediaItems = await this.prisma.mediaItem.findMany({
      where: {
        circleId,
        type: SOCIAL_MEDIA_TYPE.video,
        deletedAt: null,
        ...dateWhere,
        ...(force
          ? {}
          : {
              OR: [
                { socialStatus: null },
                {
                  socialStatus: {
                    status: { not: SOCIAL_STATUS.processed },
                  },
                },
              ],
            }),
      },
      select: { id: true, circleId: true },
    });

    let enqueued = 0;
    for (const item of mediaItems) {
      await enqueueEnrichmentJob(this.jobs, {
        type: SOCIAL_MEDIA_JOB_TYPE,
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: SOCIAL_JOB_REASON.backfill,
        priority: 100,
      });

      await this.prisma.mediaSocialStatus.upsert({
        where: { mediaItemId: item.id },
        create: {
          mediaItemId: item.id,
          status: SOCIAL_STATUS.pending,
        },
        update: {
          status: SOCIAL_STATUS.pending,
        },
      });

      enqueued++;
    }

    this.logger.log(
      `Backfill: queued ${enqueued} social-media detection job(s) for circle ${circleId}`,
    );

    return enqueued;
  }

  /**
   * Backfill social-media detection across ALL circles.
   * Returns the total number of enqueued jobs and the number of circles processed.
   */
  async backfillAllCircles(opts: {
    from?: string;
    to?: string;
    force?: boolean;
  }): Promise<{ enqueued: number; circles: number }> {
    // Every shared library (a platform group) plus every personal library (RETRO-N29).
    const allCircles = (await this.access.allScopeIds()).map((id) => ({ id }));

    let totalEnqueued = 0;
    const circleCount = allCircles.length;

    for (const circle of allCircles) {
      const count = await this.backfillCircle(circle.id, {
        from: opts.from,
        to: opts.to,
        force: opts.force,
      });
      totalEnqueued += count;
    }

    this.logger.log(
      `Global social-media backfill complete: ${totalEnqueued} job(s) enqueued across ${circleCount} circle(s)`,
    );

    return { enqueued: totalEnqueued, circles: circleCount };
  }

  /**
   * Enqueue a single-item detection rerun at priority 0 and upsert the per-item
   * status to `pending`. Mirrors GeocodeBackfillService.enqueueRerun.
   */
  async enqueueRerun(
    mediaItemId: string,
    userId: string,
  ): Promise<{ jobId: string; status: string }> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, deletedAt: true },
    });

    if (!mediaItem || mediaItem.deletedAt) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    const job = await enqueueEnrichmentJob(this.jobs, {
      type: SOCIAL_MEDIA_JOB_TYPE,
      mediaItemId,
      circleId: mediaItem.circleId,
      reason: SOCIAL_JOB_REASON.rerun,
      priority: 0,
    });

    await this.prisma.mediaSocialStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        status: SOCIAL_STATUS.pending,
      },
      update: { status: SOCIAL_STATUS.pending },
    });

    this.logger.log(
      `Social-media rerun job ${job.id} enqueued for MediaItem ${mediaItemId} by user ${userId}`,
    );
    // A freshly queued job is `pending`; the queue facade reported the row's status the same way.
    return { jobId: job.id, status: 'pending' };
  }

  /**
   * Return the per-item social-media detection status, or a synthetic
   * not_processed record when no status row exists yet.
   */
  async getStatus(mediaItemId: string) {
    const status = await this.prisma.mediaSocialStatus.findUnique({
      where: { mediaItemId },
    });

    if (!status) {
      return {
        status: 'not_processed',
        isSocialMedia: false,
        platform: null,
        detectionMethod: null,
        confidence: null,
        matchedRule: null,
        processedAt: null,
        lastError: null,
      };
    }

    return {
      status: status.status,
      isSocialMedia: status.isSocialMedia,
      platform: status.platform,
      detectionMethod: status.detectionMethod,
      confidence: status.confidence,
      matchedRule: status.matchedRule,
      processedAt: status.processedAt,
      lastError: status.lastError,
    };
  }
}
