// =============================================================================
// media.storage.reprocess: the admin bulk reprocess job (RETRO-D1b, #567)
// =============================================================================
//
// `POST /api/admin/media/reprocess` queues one of these (per circle, or one for
// every circle). The handler walks the live media items in scope and queues the
// platform's `storage.object.process` job for each ready/failed image or video
// object behind them, at background priority. It never runs a processor itself:
// before RETRO-D1b the endpoint re-rendered every thumbnail inside the HTTP
// request, which on a large library outlived any proxy timeout.
//
// SERVER-ONLY: no node-result pair (reads `storage_objects` across organizations
// on the system client, reason `storage-processing-recovery`).
// =============================================================================

import { Injectable, OnModuleInit } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import {
  JobHandlerRegistry,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';

import { STORAGE_REPROCESS_TYPE, parseReprocessPayload } from './storage-recovery.constants';
import { StorageRecoveryService } from './storage-recovery.service';

@Injectable()
export class StorageReprocessHandler implements JobHandler, OnModuleInit {
  readonly type = STORAGE_REPROCESS_TYPE;

  readonly label = 'Media reprocess (bulk)';

  /** One enqueue per object of a whole library: thirty minutes, three attempts (re-queuing is idempotent). */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 30 * 60_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly recovery: StorageRecoveryService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const { circleId } = parseReprocessPayload(job.payload);
    const result = await this.recovery.reprocessMediaObjects(circleId);
    trace.getActiveSpan()?.setAttributes({
      'media.storage.reprocess.reprocessed': result.reprocessed,
      'media.storage.reprocess.failed': result.failed,
    });
  }
}
