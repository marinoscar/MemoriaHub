import { Injectable, Logger } from '@nestjs/common';
import { JobReason, MediaFaceStatusType, MediaType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { whereDateRange } from '../search/media-where.builder';

@Injectable()
export class FaceBackfillService {
  private readonly logger = new Logger(FaceBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  /**
   * Backfill face detection for all eligible photos in a single circle.
   * No per-circle opt-in gate — the global toggle is the only gate (checked in the controller).
   * No membership check — intended for admin/internal usage.
   */
  async backfillCircle(circleId: string, opts: { from?: string; to?: string; force?: boolean }): Promise<number> {
    const { force = false } = opts;

    const from = opts.from ? new Date(opts.from) : undefined;
    const to = opts.to ? new Date(opts.to) : undefined;
    const dateWhere = whereDateRange(from, to);

    const mediaItems = await this.prisma.mediaItem.findMany({
      where: {
        circleId,
        type: { in: [MediaType.photo, MediaType.video] },
        deletedAt: null,
        // Exclude videos flagged as social-media re-uploads. Photos never carry
        // a socialMediaSource, so this predicate leaves the photo set untouched.
        socialMediaSource: null,
        ...dateWhere,
        ...(force
          ? {}
          : {
              OR: [
                { faceStatus: null },
                {
                  faceStatus: {
                    status: {
                      notIn: [
                        MediaFaceStatusType.processed,
                        MediaFaceStatusType.no_faces,
                      ],
                    },
                  },
                },
              ],
            }),
      },
      select: { id: true, circleId: true, type: true },
    });

    let enqueued = 0;
    for (const item of mediaItems) {
      const jobType = item.type === MediaType.video ? 'video_face_detection' : 'face_detection';
      await this.enrichmentJobService.enqueue({
        type: jobType,
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: JobReason.backfill,
        priority: 100,
      });

      await this.prisma.mediaFaceStatus.upsert({
        where: { mediaItemId: item.id },
        create: {
          mediaItemId: item.id,
          status: MediaFaceStatusType.pending,
          faceCount: 0,
        },
        update: {
          status: MediaFaceStatusType.pending,
        },
      });

      enqueued++;
    }

    this.logger.log(
      `Backfill: queued ${enqueued} face detection job(s) for circle ${circleId}`,
    );

    return enqueued;
  }

  /**
   * Backfill face detection across ALL circles.
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
      const count = await this.backfillCircle(circle.id, { from: opts.from, to: opts.to, force: opts.force });
      totalEnqueued += count;
    }

    this.logger.log(
      `Global face backfill complete: ${totalEnqueued} job(s) enqueued across ${circleCount} circle(s)`,
    );

    return { enqueued: totalEnqueued, circles: circleCount };
  }
}
