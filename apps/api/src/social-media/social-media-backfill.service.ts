import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JobReason, MediaSocialStatusType, MediaType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { whereDateRange } from '../search/media-where.builder';

/**
 * SocialMediaBackfillService
 *
 * Companion service for the `social_media_detection` enrichment job type,
 * mirroring GeocodeBackfillService / FaceBackfillService:
 *   - per-item rerun (priority 0, reason=rerun) + status read for the media API
 *   - per-circle and global backfill (priority 100, reason=backfill) for admins
 *
 * Detection only targets videos — photos are never social-media re-uploads.
 */
@Injectable()
export class SocialMediaBackfillService {
  private readonly logger = new Logger(SocialMediaBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
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
        type: MediaType.video,
        deletedAt: null,
        ...dateWhere,
        ...(force
          ? {}
          : {
              OR: [
                { socialStatus: null },
                {
                  socialStatus: {
                    status: { not: MediaSocialStatusType.processed },
                  },
                },
              ],
            }),
      },
      select: { id: true, circleId: true },
    });

    let enqueued = 0;
    for (const item of mediaItems) {
      await this.enrichmentJobService.enqueue({
        type: 'social_media_detection',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: JobReason.backfill,
        priority: 100,
      });

      await this.prisma.mediaSocialStatus.upsert({
        where: { mediaItemId: item.id },
        create: {
          mediaItemId: item.id,
          status: MediaSocialStatusType.pending,
        },
        update: {
          status: MediaSocialStatusType.pending,
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
    const allCircles = await this.prisma.circle.findMany({
      select: { id: true },
    });

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

    const job = await this.enrichmentJobService.enqueue({
      type: 'social_media_detection',
      mediaItemId,
      circleId: mediaItem.circleId,
      reason: JobReason.rerun,
      priority: 0,
    });

    await this.prisma.mediaSocialStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        status: MediaSocialStatusType.pending,
      },
      update: { status: MediaSocialStatusType.pending },
    });

    this.logger.log(
      `Social-media rerun job ${job.id} enqueued for MediaItem ${mediaItemId} by user ${userId}`,
    );
    return { jobId: job.id, status: job.status };
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
