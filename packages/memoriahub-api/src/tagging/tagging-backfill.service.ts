import { Inject, Injectable, Logger } from '@nestjs/common';

import { whereDateRange } from '../media/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubAccessPort,
  type MemoriahubJobsPort,
} from '../ports/index.js';
import { JOB_REASON, MEDIA_TYPE, TAG_STATUS, TAGGING_JOB_TYPES } from './constants.js';
import type { TaggingDb } from './data/tagging-db.js';

/**
 * Backfills AI tagging across the libraries (the admin backfill route).
 *
 * @stability experimental
 */
@Injectable()
export class TaggingBackfillService {
  private readonly logger = new Logger(TaggingBackfillService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: TaggingDb,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_ACCESS) private readonly access: MemoriahubAccessPort,
  ) {}

  /**
   * Backfill AI tagging for all eligible items in a single circle.
   * No per-circle opt-in gate — the global toggle is the only gate (checked in the controller).
   * No membership check — intended for admin/internal usage.
   *
   * `mediaTypes` is OPT-IN for videos (defaults to photos only, epic #452,
   * issue #458). An admin who has been running photo backfills would
   * otherwise, on their first run after upgrading, dispatch an AI call for
   * EVERY video in the library — a large, unexpected bill from a command
   * whose behavior they thought they understood. Videos are included by
   * passing `mediaTypes: ['photo','video']` explicitly.
   */
  async backfillCircle(
    circleId: string,
    opts: { from?: string; to?: string; force?: boolean; mediaTypes?: string[] },
  ): Promise<number> {
    const { force = false } = opts;
    const mediaTypes =
      opts.mediaTypes && opts.mediaTypes.length > 0 ? opts.mediaTypes : [MEDIA_TYPE.photo];

    const from = opts.from ? new Date(opts.from) : undefined;
    const to = opts.to ? new Date(opts.to) : undefined;
    const dateWhere = whereDateRange(from, to);

    const mediaItems = await this.prisma.mediaItem.findMany({
      where: {
        circleId,
        type: { in: mediaTypes },
        deletedAt: null,
        ...dateWhere,
        ...(force
          ? {}
          : {
              OR: [
                { tagStatus: null },
                {
                  tagStatus: {
                    status: { notIn: [TAG_STATUS.processed] },
                  },
                },
              ],
            }),
      },
      select: { id: true, circleId: true, type: true },
    });

    let enqueued = 0;
    for (const item of mediaItems) {
      await this.jobs.enqueue({
        // Route by type, the same rule every other enqueue path follows.
        type: item.type === MEDIA_TYPE.video ? TAGGING_JOB_TYPES.videoAutoTagging : TAGGING_JOB_TYPES.autoTagging,
        reason: JOB_REASON.backfill,
        subjectType: 'media_item',
        subjectId: item.id,
        payload: { circleId: item.circleId },
        priority: 100,
      });

      await this.prisma.mediaTagStatus.upsert({
        where: { mediaItemId: item.id },
        create: {
          mediaItemId: item.id,
          circleId: item.circleId,
          status: TAG_STATUS.pending,
          tagCount: 0,
        },
        update: {
          status: TAG_STATUS.pending,
        },
      });

      enqueued++;
    }

    this.logger.log(
      `Backfill: queued ${enqueued} AI tagging job(s) for circle ${circleId} (types: ${mediaTypes.join(', ')})`,
    );

    return enqueued;
  }

  /**
   * Backfill AI tagging across ALL circles.
   * No per-circle opt-in gate — the global toggle is the only gate (checked in the controller).
   * Returns the total number of enqueued jobs and the number of circles processed.
   *
   * See `backfillCircle` for why `mediaTypes` defaults to photos only.
   */
  async backfillAllCircles(opts: {
    from?: string;
    to?: string;
    force?: boolean;
    mediaTypes?: string[];
  }): Promise<{ enqueued: number; circles: number }> {
    // Every shared library (a platform group) plus every personal library (RETRO-N29).
    const allCircles = (await this.access.allScopeIds()).map((id) => ({ id }));

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
