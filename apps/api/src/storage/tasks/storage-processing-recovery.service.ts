import { Injectable, Logger } from '@nestjs/common';
import { Prisma, StorageObject } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ObjectProcessingService } from '../processing/object-processing.service';
import { ObjectUploadedEvent } from '../processing/events/object-uploaded.event';

export interface StorageProcessingRecoveryResult {
  claimed: number;
  reprocessed: number;
  exhausted: number;
  errors: number;
}

const DEFAULT_STUCK_MINUTES = 10;
const DEFAULT_MAX_RETRIES = 3;

/**
 * Recovers StorageObjects orphaned at status='processing' — the state left
 * behind when the API process is killed (OOM, crash, deploy) mid-pipeline,
 * between the initial 'processing' write and the final markReady/markFailed
 * call in ObjectProcessingService. Nothing else in the codebase watches this
 * status: the enrichment stuck-reset cron only touches enrichment_jobs, the
 * storage cleanup cron only touches pending/uploading, and the existing
 * MediaReprocessService requires status ready/failed and image/video mimeType.
 */
@Injectable()
export class StorageProcessingRecoveryService {
  private readonly logger = new Logger(StorageProcessingRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly objectProcessingService: ObjectProcessingService,
  ) {}

  async recoverStuckObjects(olderThanMinutes?: number): Promise<StorageProcessingRecoveryResult> {
    const thresholdMinutes =
      olderThanMinutes ??
      parseInt(process.env['STORAGE_PROCESSING_STUCK_MINUTES'] ?? String(DEFAULT_STUCK_MINUTES), 10);
    const maxRetries = parseInt(
      process.env['STORAGE_PROCESSING_MAX_RETRIES'] ?? String(DEFAULT_MAX_RETRIES),
      10,
    );

    const cutoff = new Date(Date.now() - thresholdMinutes * 60_000);

    const candidates = await this.prisma.storageObject.findMany({
      where: { status: 'processing', updatedAt: { lt: cutoff } },
    });

    const result: StorageProcessingRecoveryResult = {
      claimed: candidates.length,
      reprocessed: 0,
      exhausted: 0,
      errors: 0,
    };

    if (candidates.length === 0) {
      return result;
    }

    this.logger.log(`recoverStuckObjects: ${candidates.length} object(s) stuck past ${thresholdMinutes}m`);

    // Sequential, not Promise.all: this pipeline runs sharp/ffmpeg, which is
    // memory-heavy — the exact workload that caused the original OOM. Don't
    // add concurrent memory pressure while recovering from a memory incident.
    for (const object of candidates) {
      try {
        await this.recoverOne(object, maxRetries, result);
      } catch (err) {
        result.errors++;
        this.logger.error(
          `recoverStuckObjects: unexpected error recovering object ${object.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return result;
  }

  private async recoverOne(
    object: StorageObject,
    maxRetries: number,
    result: StorageProcessingRecoveryResult,
  ): Promise<void> {
    const existingMeta = (object.metadata as Record<string, unknown> | null) ?? {};
    const retryCount =
      typeof existingMeta['_processingRetryCount'] === 'number'
        ? (existingMeta['_processingRetryCount'] as number)
        : 0;

    if (retryCount >= maxRetries) {
      await this.prisma.storageObject.update({
        where: { id: object.id },
        data: {
          status: 'failed',
          metadata: {
            ...existingMeta,
            _processingRetryExhausted: true,
          } as Prisma.InputJsonValue,
        },
      });
      result.exhausted++;
      this.logger.warn(
        `recoverStuckObjects: object ${object.id} exhausted ${retryCount} retries — marked failed, will not retry again`,
      );
      return;
    }

    // Persist the incremented counter BEFORE invoking the pipeline. If this
    // recovery attempt itself gets killed mid-flight, the counter must have
    // already advanced — otherwise the object would be reclaimed and retried
    // forever every cycle without ever reaching maxRetries, reproducing the
    // exact bug this service exists to fix. This write also bumps `updatedAt`
    // (Prisma @updatedAt), which as a side effect keeps the object off the
    // next scan's candidate list until another full threshold window passes
    // — a natural lease, even when an attempt hangs rather than crashing.
    const claimed = await this.prisma.storageObject.update({
      where: { id: object.id },
      data: {
        metadata: {
          ...existingMeta,
          _processingRetryCount: retryCount + 1,
        } as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `recoverStuckObjects: reprocessing object ${object.id} (attempt ${retryCount + 1}/${maxRetries})`,
    );

    await this.objectProcessingService.handleObjectUploaded(new ObjectUploadedEvent(claimed));
    result.reprocessed++;
  }

  /**
   * Re-run the full processing pipeline for a single object right now,
   * regardless of its current status or retry history — used by the
   * user-facing "Retry thumbnail" action (an explicit request should always
   * get a fresh attempt, unlike the automatic cron which respects the retry
   * cap). Clears any prior retry bookkeeping and resets status to
   * 'processing' before invoking, mirroring the original upload flow.
   */
  async reprocessObjectNow(object: StorageObject): Promise<void> {
    const existingMeta = (object.metadata as Record<string, unknown> | null) ?? {};
    const { _processingRetryCount, _processingRetryExhausted, ...restMeta } = existingMeta;

    const reset = await this.prisma.storageObject.update({
      where: { id: object.id },
      data: {
        status: 'processing',
        metadata: restMeta as Prisma.InputJsonValue,
      },
    });

    this.logger.log(`reprocessObjectNow: manual retry triggered for object ${object.id}`);

    await this.objectProcessingService.handleObjectUploaded(new ObjectUploadedEvent(reset));
  }
}
