import { EnrichmentJob, JobStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { broadcastIdOf } from './broadcast-constants';

/**
 * Admin-delete veto shared by both broadcast handlers (issue #488).
 *
 * A pending `broadcast_start`/`broadcast_chunk` row whose broadcast is still
 * `scheduled` or `sending` is the ONLY thing that will ever advance that
 * broadcast: deleting it strands the broadcast forever in a status nothing
 * moves it out of. Refuse, and tell the operator to cancel instead (cancel
 * makes the queued job a harmless no-op). Terminal/other rows are history and
 * are always deletable.
 */
export async function broadcastJobDeleteRefusal(
  prisma: PrismaService,
  job: Pick<EnrichmentJob, 'status' | 'payload'>,
): Promise<string | null> {
  if (job.status !== JobStatus.pending) return null;
  const broadcastId = broadcastIdOf(job.payload);
  if (!broadcastId) return null;

  const broadcast = await prisma.notificationBroadcast.findUnique({
    where: { id: broadcastId },
    select: { id: true, status: true },
  });
  if (!broadcast || (broadcast.status !== 'scheduled' && broadcast.status !== 'sending')) {
    return null;
  }

  return (
    `Broadcast ${broadcast.id} is '${broadcast.status}'; deleting this job would leave it stuck ` +
    `with nothing to advance it. Cancel the broadcast (Admin → Broadcasts) instead of deleting its job.`
  );
}
