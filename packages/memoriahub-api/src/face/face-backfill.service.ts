import { Inject, Injectable, Logger } from '@nestjs/common';
import { MEMORIAHUB_ACCESS, MEMORIAHUB_PRISMA, type MemoriahubAccessPort } from '../ports/index.js';
import { whereCapturedAtRange } from './host/captured-at-range.js';
import type { FaceDb } from './host/face-db.js';
import { JobReason, MediaFaceStatusType, MediaType } from './host/face-enums.js';
import { FaceJobs } from './host/face-jobs.js';

/**
 * The admin backfills: detection for the photos and videos of one or every circle, and the auto-archive sweep for every circle that has archived faces.
 *
 * @stability experimental
 */
@Injectable()
export class FaceBackfillService {
  private readonly logger = new Logger(FaceBackfillService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: FaceDb,
    private readonly enrichmentJobService: FaceJobs,
    @Inject(MEMORIAHUB_ACCESS) private readonly access: MemoriahubAccessPort,
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
    const dateWhere = whereCapturedAtRange(from, to);

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
    // Every shared library (a platform group) plus every personal library (RETRO-N29).
    const allCircles = (await this.access.allScopeIds()).map((id) => ({ id }));

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

  /**
   * Enqueue ONE `face_auto_archive_sweep` job per circle that has at least one
   * archived (hidden) unassigned face, to backfill the live unassigned-face
   * backlog against the archived reference set.
   *
   * Sweep jobs use `skipDedup: true` (many distinct global jobs share the same
   * type with a null mediaItemId), so THIS service is solely responsible for
   * preventing duplicate concurrent sweeps of the SAME circle — the default
   * EnrichmentJobService.enqueue dedup only filters by (type, mediaItemId IS
   * NULL), not by circleId, mirroring LocationInferenceBackfillService.
   *
   * No global-toggle gate here — the controller checks `features.faceAutoArchive`.
   */
  async autoArchiveBackfillAllCircles(): Promise<{ enqueued: number; circles: number }> {
    const groups = await this.prisma.face.groupBy({
      by: ['circleId'],
      where: {
        personId: null,
        hiddenAt: { not: null },
        embedding: { isEmpty: false },
      },
      _count: true,
    });

    const eligibleCircles = groups.filter((g) => g._count > 0);
    let enqueued = 0;

    // Per-circle guard: skip a circle whose sweep is already pending/running.
    const busy = await this.enrichmentJobService.circlesWithActive(
      'face_auto_archive_sweep',
      eligibleCircles.map((g) => g.circleId as string),
    );

    for (const group of eligibleCircles) {
      if (busy.has(group.circleId)) {
        this.logger.debug(
          `Skipping face-auto-archive sweep for circle ${group.circleId}: a sweep is already pending or running`,
        );
        continue;
      }

      await this.enrichmentJobService.enqueue({
        type: 'face_auto_archive_sweep',
        mediaItemId: null,
        circleId: group.circleId,
        reason: JobReason.backfill,
        priority: 100,
        skipDedup: true,
      });
      enqueued++;
    }

    this.logger.log(
      `Global face-auto-archive backfill: ${enqueued} sweep job(s) enqueued across ${eligibleCircles.length} eligible circle(s)`,
    );

    // `enqueued` = jobs actually created (circles that passed the pending/running
    // guard); `circles` = circles that HAD archived unassigned faces at all.
    return { enqueued, circles: eligibleCircles.length };
  }
}
