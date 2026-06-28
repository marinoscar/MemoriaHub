import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { JobReason, MediaSocialStatusType, MediaType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { whereDateRange } from '../search/media-where.builder';

@Injectable()
export class SocialBackfillService {
  private readonly logger = new Logger(SocialBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  /**
   * Backfill social media detection for all eligible video media in a single circle.
   * Checks the features.socialMediaDetection global flag.
   * No membership check — intended for admin/internal usage.
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
        deletedAt: null,
        type: MediaType.video,
        ...dateWhere,
        ...(force
          ? {}
          : {
              OR: [
                { socialStatus: null },
                {
                  socialStatus: {
                    status: { notIn: [MediaSocialStatusType.processed] },
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
          circleId: item.circleId,
          status: MediaSocialStatusType.pending,
          detected: false,
        },
        update: {
          status: MediaSocialStatusType.pending,
        },
      });

      enqueued++;
    }

    this.logger.log(
      `Backfill: queued ${enqueued} social media detection job(s) for circle ${circleId}`,
    );

    return enqueued;
  }

  /**
   * Backfill social media detection across ALL circles.
   * Returns the total number of enqueued jobs and the number of circles processed.
   * Throws BadRequestException if features.socialMediaDetection is not enabled.
   */
  async backfillAllCircles(opts: {
    from?: string;
    to?: string;
    force?: boolean;
  }): Promise<{ enqueued: number; circles: number }> {
    const settings = await this.systemSettings.getSettings();
    const featureOn = settings.features?.['socialMediaDetection'] === true;

    if (!featureOn) {
      throw new BadRequestException(
        'Social media detection is not enabled. Enable features.socialMediaDetection in system settings first.',
      );
    }

    const allCircles = await this.prisma.circle.findMany({
      select: { id: true },
    });

    let totalEnqueued = 0;
    const circleCount = allCircles.length;

    for (const circle of allCircles) {
      const count = await this.backfillCircle(circle.id, opts);
      totalEnqueued += count;
    }

    this.logger.log(
      `Global social media detection backfill complete: ${totalEnqueued} job(s) enqueued across ${circleCount} circle(s)`,
    );

    return { enqueued: totalEnqueued, circles: circleCount };
  }
}
