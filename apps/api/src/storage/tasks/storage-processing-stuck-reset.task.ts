// =============================================================================
// Storage Processing Stuck Reset Scheduled Task
// =============================================================================
//
// Every 10 minutes, recover StorageObjects that are stuck in "processing" state
// past a configurable threshold. Objects get stuck when the API container is
// OOM-killed (or restarted) mid-flight during the in-process thumbnail/dimensions
// step: the row is left with status='processing' forever, OBJECT_PROCESSED_EVENT
// never fires, MediaItem.metadata.thumbnailStorageKey is never written, and the
// UI spins on a permanently-missing thumbnail.
//
// Recovery re-runs the SAME heavy full-file-buffer processing that caused the
// original OOM, so it MUST be bounded. Each tick processes at most
// STORAGE_PROCESSING_STUCK_BATCH objects (default 10), oldest first, and re-runs
// them SEQUENTIALLY (one decoded image in memory at a time) via
// MediaReprocessService.reprocessImageObject — the tested recovery path, which
// now accepts 'processing' status and re-emits OBJECT_PROCESSED_EVENT.
//
// Threshold defaults to 15 minutes (STORAGE_PROCESSING_STUCK_MINUTES) — it must
// exceed the longest expected single-object processing runtime so legitimately
// in-flight objects are never reset. Gated behind STORAGE_PROCESSING_STUCK_RESET_ENABLED
// (set to 'false' to disable on non-worker / read-only instances).
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaReprocessService } from '../../media/media-reprocess.service';

@Injectable()
export class StorageProcessingStuckResetTask {
  private readonly logger = new Logger(StorageProcessingStuckResetTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reprocessService: MediaReprocessService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleStuckReset(): Promise<void> {
    // Env kill-switch: allow disabling on non-worker instances that should not
    // run the heavy recovery path (e.g. web-only pods, read replicas).
    if (process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'] === 'false') {
      return;
    }

    const minutes = parseInt(process.env['STORAGE_PROCESSING_STUCK_MINUTES'] ?? '15', 10);
    const batch = parseInt(process.env['STORAGE_PROCESSING_STUCK_BATCH'] ?? '10', 10);

    const cutoff = new Date(Date.now() - minutes * 60_000);

    try {
      // Oldest first, bounded batch: recovery buffers the whole file per object,
      // so we cap concurrency to one object at a time (sequential loop below).
      const stuck = await this.prisma.storageObject.findMany({
        where: {
          status: 'processing',
          updatedAt: { lt: cutoff },
        },
        orderBy: { updatedAt: 'asc' },
        take: batch,
        select: { id: true },
      });

      if (stuck.length === 0) {
        return;
      }

      let recovered = 0;
      let failed = 0;

      // Sequential re-run — NOT a parallel fan-out. reprocessImageObject buffers
      // the full file + sharp-decodes it; awaiting each before the next keeps
      // peak memory to a single object and avoids re-triggering the OOM.
      for (const object of stuck) {
        try {
          await this.reprocessService.reprocessImageObject(object.id);
          recovered++;
        } catch (err) {
          failed++;
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`Failed to recover stuck storage object ${object.id}: ${msg}`);
        }
      }

      this.logger.log(
        `Storage processing stuck reset: found ${stuck.length}, recovered ${recovered}, failed ${failed}`,
      );
    } catch (err) {
      this.logger.error('Failed to recover stuck processing storage objects', err as Error);
    }
  }
}
