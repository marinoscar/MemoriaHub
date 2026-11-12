// =============================================================================
// media.storage.recover_stuck: the storage processing recovery job (RETRO-D1b, #567)
// =============================================================================
//
// A native job handler (registered through the jobs port), a SYSTEM job (`orgId: null`, no subject):
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
// organizations on the host's cross-organization client.
// =============================================================================

import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { trace } from '@opentelemetry/api';

import {
  MEMORIAHUB_JOBS,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
} from '../../ports/index.js';

import { parseRecoverPayload } from './storage-recovery.constants.js';
import { STORAGE_RECOVER_STUCK_TYPE } from './storage-recovery-types.js';
import { StorageRecoveryService } from './storage-recovery.service.js';

/** The `media.storage.recover_stuck` job (server-only). @stability experimental */
@Injectable()
export class StorageRecoveryHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = STORAGE_RECOVER_STUCK_TYPE;

  readonly label = 'Storage processing recovery';

  /** A keyset scan and one enqueue per object: ten minutes, three attempts. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 10 * 60_000, maxAttempts: 3 };

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    private readonly recovery: StorageRecoveryService,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: MemoriahubJob): Promise<void> {
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
