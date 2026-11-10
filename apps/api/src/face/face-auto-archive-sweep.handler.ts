import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  JobHandlerRegistry,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { resolveCircleJob } from '../platform/jobs/media-item-job';
import { OwnerScopeSweepService } from '../platform/sharing/owner-scope-sweep.service';
import { PrismaService } from '../prisma/prisma.service';
import { FaceMatchingService } from './face-matching.service';
import { MediaTouchService } from '../media/media-touch.service';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

/**
 * FaceAutoArchiveSweepHandler: a native platform `JobHandler` (RETRO-C3, #585).
 *
 * SERVER-ONLY sweep handler (implements ONLY `process()` — no nodeResultSchema /
 * persistNodeResult, so it is never node-claimable; the CLI's NODE_JOB_TYPES
 * deliberately omits `face_auto_archive_sweep`): it is a whole-circle KNN pass
 * over `faces.embedding_vec`, all database, with no per-item unit of work to
 * hand a node. One job per circle (`subjectType: 'circle'`, `subjectId` = the
 * circle; enqueued with `skipDedup`, priority 100); a circle deleted since the
 * job was queued settles it as a no-op.
 *
 * Backfills the existing unassigned-face backlog against the circle's already-
 * archived unassigned faces: any LIVE unassigned face that closely matches a
 * previously-archived (hidden) unassigned face is hidden too — the same
 * retroactive sweep FaceDetectionCore / PeopleService.hideFaces perform on new
 * detections and manual archives, applied here to the whole live pool at once.
 */
@Injectable()
export class FaceAutoArchiveSweepHandler implements JobHandler, OnModuleInit {
  readonly type = 'face_auto_archive_sweep';
  readonly label = 'Face auto-archive sweep';
  /** Pages the whole live unassigned pool of one circle against its archived set. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 600_000, maxAttempts: 3 };
  private readonly logger = new Logger(FaceAutoArchiveSweepHandler.name);

  /** Live unassigned faces scanned per DB page (bounds memory). */
  private static readonly LIVE_BATCH_SIZE = 500;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly scopes: OwnerScopeSweepService,
    private readonly matchingService: FaceMatchingService,
    private readonly systemSettings: AppSystemSettingsService,
    private readonly mediaTouch: MediaTouchService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const circleId = await resolveCircleJob(this.scopes, job, this.logger);
    if (!circleId) return;

    // Defensive guard — the admin endpoint also gates on this feature, but a job
    // may have been enqueued before the toggle was flipped off.
    const settings = await this.systemSettings.getSettings();
    const autoArchiveOn =
      settings.features?.faceAutoArchive === true &&
      (process.env.FACE_AUTO_ARCHIVE ?? 'true') !== 'false';
    if (!autoArchiveOn) {
      this.logger.log(`face_auto_archive_sweep: feature disabled; no-op for circle ${circleId}`);
      return;
    }

    // Load the archived reference set once (bounded by archiveMaxCandidates).
    const archivedCandidates = await this.prisma.face.findMany({
      where: {
        circleId,
        personId: null,
        hiddenAt: { not: null },
        embedding: { isEmpty: false },
      },
      select: { id: true, embedding: true },
      orderBy: { hiddenAt: 'desc' },
      take: this.matchingService.archiveMaxCandidates,
    });

    if (archivedCandidates.length === 0) {
      this.logger.log(`face_auto_archive_sweep: no archived reference faces in circle ${circleId}; hidden=0`);
      return;
    }

    const threshold = settings.face?.autoArchive?.matchThreshold;

    // Stream the LIVE unassigned pool in id-ordered pages. Cursor (not offset)
    // pagination is required because hiding matched faces removes them from the
    // `hiddenAt: null` set mid-sweep — an offset would then skip rows.
    let cursor: string | undefined;
    let scanned = 0;
    let hidden = 0;

    for (;;) {
      const batch = await this.prisma.face.findMany({
        where: {
          circleId,
          personId: null,
          hiddenAt: null,
          embedding: { isEmpty: false },
        },
        select: { id: true, embedding: true },
        orderBy: { id: 'asc' },
        take: FaceAutoArchiveSweepHandler.LIVE_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      if (batch.length === 0) break;
      scanned += batch.length;
      cursor = batch[batch.length - 1].id;

      const matchedIds = await this.matchingService.findLiveMatchesAgainstArchived(circleId, {
        archivedCandidates,
        liveBatch: batch,
        threshold,
      });

      if (matchedIds.length > 0) {
        const { count } = await this.prisma.face.updateMany({
          where: {
            id: { in: matchedIds },
            circleId,
            personId: null,
            hiddenAt: null,
          },
          data: { hiddenAt: new Date(), hiddenReason: 'auto_archive_match' },
        });
        hidden += count;

        // Backup change feed: Face.hiddenAt is a Face-row-only write (issue #310)
        const parents = await this.prisma.face.findMany({
          where: { id: { in: matchedIds }, circleId },
          select: { mediaItemId: true },
          distinct: ['mediaItemId'],
        });
        await this.mediaTouch.touchMediaItems(parents.map((f) => f.mediaItemId));
      }

      if (batch.length < FaceAutoArchiveSweepHandler.LIVE_BATCH_SIZE) break;
    }

    this.logger.log(
      `face_auto_archive_sweep complete for circle ${circleId}: scanned=${scanned} hidden=${hidden} (refs=${archivedCandidates.length})`,
    );
  }
}
