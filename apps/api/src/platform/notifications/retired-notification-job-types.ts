import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

// =============================================================================
// Retired notification job types (RETRO-D3, #576)
// =============================================================================
//
// A job `type` string is permanent once rows of it exist. MemoriaHub's own
// notifications slice ran three types the platform slice replaces:
//
//   notification_purge  -> the platform retention purges `notifications.inbox.purge`
//                          and `notifications.deliveries.purge` (`retention.notifications`,
//                          `retention.notificationDeliveries`)
//   broadcast_start     -> `admin.broadcast.start`
//   broadcast_chunk     -> `admin.broadcast.chunk`
//
// Each still dispatches here, so a row of it never sits `pending` unclaimable:
// it settles as a no-op. A purge row loses nothing (the platform purge runs on
// its own schedule). A broadcast row SHOULD NOT exist at the cutover (the
// runbook drains or cancels legacy broadcasts first, and the carry-over refuses
// while one is scheduled or sending); one that does is logged as a warning
// naming its payload's broadcast id. Server-only (no node pair). They go when
// the history of the types is purged.
// =============================================================================

export const RETIRED_NOTIFICATION_PURGE_TYPE = 'notification_purge';
export const RETIRED_BROADCAST_START_TYPE = 'broadcast_start';
export const RETIRED_BROADCAST_CHUNK_TYPE = 'broadcast_chunk';

export const RETIRED_NOTIFICATION_JOB_TYPES = [
  RETIRED_NOTIFICATION_PURGE_TYPE,
  RETIRED_BROADCAST_START_TYPE,
  RETIRED_BROADCAST_CHUNK_TYPE,
] as const;

/** One no-op handler for a retired type. */
export class RetiredNotificationJobHandler implements JobHandler {
  private readonly logger = new Logger(RetiredNotificationJobHandler.name);

  constructor(readonly type: string) {}

  async process(job: Job): Promise<void> {
    if (this.type === RETIRED_NOTIFICATION_PURGE_TYPE) {
      this.logger.log(
        `Job ${job.id} of the retired type "${this.type}" settles without work: the platform retention purges run now`,
      );
      return;
    }
    const broadcastId = (job.payload as { broadcastId?: unknown } | null)?.broadcastId;
    this.logger.warn(
      `Job ${job.id} of the retired type "${this.type}" (broadcast ${String(broadcastId ?? 'unknown')}) ` +
        'settles without sending: broadcasts are the platform slice\'s since RETRO-D3. Re-send it from ' +
        '/admin/settings/broadcasts if it never finished.',
    );
  }
}

/** Registers the three retired types with the platform job registry. */
@Injectable()
export class RetiredNotificationJobTypes implements OnModuleInit {
  constructor(private readonly registry: JobHandlerRegistry) {}

  onModuleInit(): void {
    for (const type of RETIRED_NOTIFICATION_JOB_TYPES) {
      if (!this.registry.get(type)) this.registry.register(new RetiredNotificationJobHandler(type));
    }
  }
}
