import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { JOB_SETTLED_EVENT, type JobSettledEvent } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../../prisma/prisma.service';
import { BROADCAST_JOB_TYPES, BROADCAST_START_TYPE, broadcastIdOf } from './broadcast-constants';

const MAX_QUOTED_ERROR_LENGTH = 500;

// =============================================================================
// BroadcastFailureListener — a permanently failed fan-out job fails its
// broadcast (epic #481, issue #488)
// =============================================================================
//
// Without this, a start/chunk job that exhausts its retries leaves the
// broadcast reading `sending` forever with nothing advancing it. The platform's
// JOB_SETTLED_EVENT fires only on the TERMINAL transition, so an intermediate
// retry or a rate-limit deferral never flips anything (RETRO-C8, #608: the
// listener subscribes natively; the event carries the settled row, so no
// re-read is needed).
//
// RETRO-D3: deleted with the broadcast handlers when the platform
// notifications slice owns broadcasts.
//
// The flip is a CONDITIONAL write (`where status in (scheduled, sending)`) so it races a
// concurrent cancel in the database and never overwrites `canceled`/`sent`.
// Resume (POST /api/admin/broadcasts/:id/resume) continues from the cursor.
//
// `async: true`: off the emitter's
// synchronous path so the worker's next claim is never delayed. Never throws.
// =============================================================================
@Injectable()
export class BroadcastFailureListener {
  private readonly logger = new Logger(BroadcastFailureListener.name);

  constructor(private readonly prisma: PrismaService) {}

  @OnEvent(JOB_SETTLED_EVENT, { async: true })
  async handleJobSettled(event: JobSettledEvent): Promise<void> {
    if (event.status !== 'failed' || !BROADCAST_JOB_TYPES.has(event.type)) return;

    try {
      const job = event.job;
      const broadcastId = broadcastIdOf(job.payload);
      if (!broadcastId) return;

      const kind = job.type === BROADCAST_START_TYPE ? 'Start' : 'Chunk';
      const cause = truncate(job.lastError ?? 'no error recorded', MAX_QUOTED_ERROR_LENGTH);
      const result = await this.prisma.mhLegacyNotificationBroadcast.updateMany({
        // `scheduled` too: a start job that failed BEFORE its claim leaves the
        // broadcast scheduled with nothing left to start it.
        where: { id: broadcastId, status: { in: ['scheduled', 'sending'] } },
        data: {
          status: 'failed',
          lastError: `${kind} job ${job.id} failed permanently after ${job.attempts} attempt(s): ${cause}`,
          finishedAt: job.finishedAt ?? new Date(),
        },
      });

      if (result.count > 0) {
        this.logger.warn(`Broadcast ${broadcastId} marked 'failed' after ${job.type} job ${job.id} gave up`);
      }
    } catch (err) {
      this.logger.error(
        `Could not mark the broadcast of failed job ${event.jobId} as failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
