// =============================================================================
// media.storage.recover_stuck: the storage processing recovery job (RETRO-D1b, #567)
// =============================================================================
//
// A native platform `JobHandler`, a SYSTEM job (`orgId: null`, no subject):
//
//   * mode `stuck` (the 10-minute `StorageRecoveryTask`, which only enqueues, and
//     `POST /api/admin/media/reprocess-stuck`): objects orphaned at `processing`
//     past `STORAGE_PROCESSING_STUCK_MINUTES` are re-queued for processing, capped
//     at `STORAGE_PROCESSING_MAX_RETRIES` per object, then marked `failed`;
//   * mode `failed` (`POST /api/admin/media/reprocess-failed`): image objects
//     that ended `failed` are reset and re-queued.
//
// It never runs a processor: per object it queues the platform's
// `storage.object.process` job (see `StorageRecoveryService`).
//
// SERVER-ONLY: no node-result pair. It reads and writes `storage_objects` across
// organizations on the system client (reason `storage-processing-recovery`).
// =============================================================================

import { Injectable, OnModuleInit } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import {
  JobHandlerRegistry,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';

import { STORAGE_RECOVER_STUCK_TYPE, parseRecoverPayload } from './storage-recovery.constants';
import { StorageRecoveryService } from './storage-recovery.service';

@Injectable()
export class StorageRecoveryHandler implements JobHandler, OnModuleInit {
  readonly type = STORAGE_RECOVER_STUCK_TYPE;

  readonly label = 'Storage processing recovery';

  /** A keyset scan and one enqueue per object: ten minutes, three attempts. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 10 * 60_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly recovery: StorageRecoveryService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const payload = parseRecoverPayload(job.payload);
    const result =
      payload.mode === 'failed'
        ? await this.recovery.recoverFailedImageObjects({ limit: payload.limit })
        : await this.recovery.recoverStuckObjects(payload.olderThanMinutes);
    // Counts on the platform's `job.process` span; never an org id, never a metric label.
    trace.getActiveSpan()?.setAttributes({
      'media.storage.recover_stuck.mode': payload.mode,
      'media.storage.recover_stuck.claimed': result.claimed,
      'media.storage.recover_stuck.reprocessed': result.reprocessed,
      'media.storage.recover_stuck.exhausted': result.exhausted,
      'media.storage.recover_stuck.errors': result.errors,
    });
  }
}
