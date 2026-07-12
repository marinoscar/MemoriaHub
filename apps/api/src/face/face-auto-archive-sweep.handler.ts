import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { FaceMatchingService } from './face-matching.service';

/**
 * FaceAutoArchiveSweepHandler
 *
 * SERVER-ONLY sweep handler (implements ONLY the in-process `process()` half —
 * no nodeResultSchema / persistNodeResult, so it is never node-claimable; the
 * CLI's NODE_JOB_TYPES deliberately omits `face_auto_archive_sweep`). Mirrors
 * LocationInferenceHandler's sweep-mode shape: one job per circle, keyed by
 * job.circleId, mediaItemId is null.
 *
 * Backfills the existing unassigned-face backlog against the circle's already-
 * archived unassigned faces: any LIVE unassigned face that closely matches a
 * previously-archived (hidden) unassigned face is hidden too — the same
 * retroactive sweep FaceDetectionCore / PeopleService.hideFaces perform on new
 * detections and manual archives, applied here to the whole live pool at once.
 */
@Injectable()
export class FaceAutoArchiveSweepHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'face_auto_archive_sweep';
  private readonly logger = new Logger(FaceAutoArchiveSweepHandler.name);

  /** Live unassigned faces scanned per DB page (bounds memory). */
  private static readonly LIVE_BATCH_SIZE = 500;

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly matchingService: FaceMatchingService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    if (!job.circleId) {
      this.logger.warn(`face_auto_archive_sweep job ${job.id} has no circleId; skipping`);
      return;
    }
    const circleId = job.circleId;

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
      }

      if (batch.length < FaceAutoArchiveSweepHandler.LIVE_BATCH_SIZE) break;
    }

    this.logger.log(
      `face_auto_archive_sweep complete for circle ${circleId}: scanned=${scanned} hidden=${hidden} (refs=${archivedCandidates.length})`,
    );
  }
}
