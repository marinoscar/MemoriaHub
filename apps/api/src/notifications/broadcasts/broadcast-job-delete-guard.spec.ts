/** Admin job-delete veto for broadcast jobs (issue #488). */
import { broadcastJobDeleteRefusal } from './broadcast-job-delete-guard';

const BID = '11111111-1111-4111-8111-111111111111';

function prisma(status: string | null) {
  return {
    notificationBroadcast: {
      findUnique: jest.fn().mockResolvedValue(status ? { id: BID, status } : null),
    },
  } as never;
}

describe('broadcastJobDeleteRefusal', () => {
  it.each(['scheduled', 'sending'])('refuses a pending job whose broadcast is %s', async (status) => {
    await expect(
      broadcastJobDeleteRefusal(prisma(status), { status: 'pending', payload: { broadcastId: BID } }),
    ).resolves.toMatch(/Cancel the broadcast/);
  });

  it.each(['sent', 'canceled', 'failed', null])('allows when the broadcast is %s', async (status) => {
    await expect(
      broadcastJobDeleteRefusal(prisma(status), { status: 'pending', payload: { broadcastId: BID } }),
    ).resolves.toBeNull();
  });

  it('always allows a terminal job row', async () => {
    const p = prisma('sending');
    await expect(
      broadcastJobDeleteRefusal(p, { status: 'failed', payload: { broadcastId: BID } }),
    ).resolves.toBeNull();
  });
});
