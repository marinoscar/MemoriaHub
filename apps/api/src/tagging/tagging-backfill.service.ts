import { Injectable, Logger } from '@nestjs/common';
import { JobReason, MediaTagStatusType, MediaType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { whereDateRange } from '../search/media-where.builder';

@Injectable()
export class TaggingBackfillService {
  private readonly logger = new Logger(TaggingBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  /**
   * Backfill auto-tagging for all eligible photos in a single circle.
   * No per-circle opt-in gate — the global toggle is the only gate (checked in the controller).
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
        type: MediaType.photo,
        deletedAt: null,
        ...dateWhere,
        ...(force
          ? {}
          : {
              OR: [
                { tagStatus: null },
                {
                  tagStatus: {
                    status: { notIn: [MediaTagStatusType.processed] },
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
        type: 'auto_tagging',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: JobReason.backfill,
        priority: 100,
      });

      await this.prisma.mediaTagStatus.upsert({
        where: { mediaItemId: item.id },
        create: {
          mediaItemId: item.id,
          circleId: item.circleId,
          status: MediaTagStatusType.pending,
          tagCount: 0,
        },
        update: {
          status: MediaTagStatusType.pending,
        },
      });

      enqueued++;
    }

    this.logger.log(
      `Backfill: queued ${enqueued} auto-tagging job(s) for circle ${circleId}`,
    );

    return enqueued;
  }

  /**
   * Backfill auto-tagging across ALL circles.
   * No per-circle opt-in gate — the global toggle is the only gate (checked in the controller).
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
      const count = await this.backfillCircle(circle.id, opts);
      totalEnqueued += count;
    }

    this.logger.log(
      `Global tagging backfill complete: ${totalEnqueued} job(s) enqueued across ${circleCount} circle(s)`,
    );

    return { enqueued: totalEnqueued, circles: circleCount };
  }
}
