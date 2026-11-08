/** BroadcastFailureListener (issue #488; on the platform JOB_SETTLED_EVENT since RETRO-C8, #608). */
import { JobSettledEvent } from '@marinoscar/platform-api/jobs';

import { BroadcastFailureListener } from './broadcast-failure.listener';
import { systemJob } from '../../../test/helpers/platform-job';

const BID = '11111111-1111-4111-8111-111111111111';

function build() {
  const prisma = {
    mhLegacyNotificationBroadcast: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  return { listener: new BroadcastFailureListener(prisma as never), prisma };
}

/** The settled event the platform emits: it carries the terminal row itself. */
const ev = (row: Record<string, unknown>, status: 'failed' | 'succeeded' = 'failed') =>
  new JobSettledEvent(systemJob(String(row['type']), { ...row, status } as never));

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
    const t = build();
    await t.listener.handleJobSettled(ev(failedChunk));
    expect(t.prisma.mhLegacyNotificationBroadcast.updateMany).toHaveBeenCalledWith({
      where: { id: BID, status: { in: ['scheduled', 'sending'] } },
      data: {
        status: 'failed',
        lastError: 'Chunk job job-1 failed permanently after 3 attempt(s): boom',
        finishedAt: new Date(0),
      },
    });
  });

  it('ignores successes and non-broadcast types without touching the DB', async () => {
    const t = build();
    await t.listener.handleJobSettled(ev(failedChunk, 'succeeded'));
    await t.listener.handleJobSettled(ev({ ...failedChunk, type: 'face_detection' }));
    expect(t.prisma.mhLegacyNotificationBroadcast.updateMany).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const t = build();
    t.prisma.mhLegacyNotificationBroadcast.updateMany.mockRejectedValue(new Error('db'));
    await expect(
      t.listener.handleJobSettled(ev({ ...failedChunk, type: 'broadcast_start' })),
    ).resolves.toBeUndefined();
  });

  it('does nothing for a job without a broadcastId', async () => {
    const t = build();
    await t.listener.handleJobSettled(ev({ ...failedChunk, payload: null }));
    expect(t.prisma.mhLegacyNotificationBroadcast.updateMany).not.toHaveBeenCalled();
  });
});
