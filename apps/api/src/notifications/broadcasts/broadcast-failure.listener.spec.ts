/** BroadcastFailureListener (issue #488). */
import { EnrichmentJobSettledEvent } from '../../enrichment/events/enrichment-job-settled.event';
import { BroadcastFailureListener } from './broadcast-failure.listener';

const BID = '11111111-1111-4111-8111-111111111111';

function build(job: Record<string, unknown> | null) {
  const prisma = {
    enrichmentJob: { findUnique: jest.fn().mockResolvedValue(job) },
    notificationBroadcast: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  return { listener: new BroadcastFailureListener(prisma as never), prisma };
}

const ev = (type: string, outcome: 'failed' | 'succeeded' = 'failed') =>
  new EnrichmentJobSettledEvent('job-1', type, 'backfill', null, null, outcome);

describe('BroadcastFailureListener', () => {
  const failedChunk = {
    id: 'job-1',
    type: 'broadcast_chunk',
    payload: { broadcastId: BID },
    attempts: 3,
    lastError: 'boom',
    finishedAt: new Date(0),
  };

  it('flips a scheduled/sending broadcast to failed with the cause', async () => {
    const t = build(failedChunk);
    await t.listener.handleJobSettled(ev('broadcast_chunk'));
    expect(t.prisma.notificationBroadcast.updateMany).toHaveBeenCalledWith({
      where: { id: BID, status: { in: ['scheduled', 'sending'] } },
      data: {
        status: 'failed',
        lastError: 'Chunk job job-1 failed permanently after 3 attempt(s): boom',
        finishedAt: new Date(0),
      },
    });
  });

  it('ignores successes and non-broadcast types without touching the DB', async () => {
    const t = build(failedChunk);
    await t.listener.handleJobSettled(ev('broadcast_chunk', 'succeeded'));
    await t.listener.handleJobSettled(ev('face_detection'));
    expect(t.prisma.enrichmentJob.findUnique).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const t = build(failedChunk);
    t.prisma.notificationBroadcast.updateMany.mockRejectedValue(new Error('db'));
    await expect(t.listener.handleJobSettled(ev('broadcast_start'))).resolves.toBeUndefined();
  });

  it('does nothing for a job without a broadcastId', async () => {
    const t = build({ ...failedChunk, payload: null });
    await t.listener.handleJobSettled(ev('broadcast_chunk'));
    expect(t.prisma.notificationBroadcast.updateMany).not.toHaveBeenCalled();
  });
});
