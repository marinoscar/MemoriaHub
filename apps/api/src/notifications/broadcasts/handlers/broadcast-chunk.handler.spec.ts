/** broadcast_chunk (issue #488): paging, per-group CAS cursor, cancel, finish, successor. */
import { EnrichmentJob } from '@prisma/client';

import { BroadcastChunkHandler } from './broadcast-chunk.handler';
import {
  BROADCAST_CHUNK_SIZE,
  BROADCAST_CHUNK_TYPE,
  BROADCAST_STATUS_RECHECK_INTERVAL,
} from '../broadcast-constants';

const BID = '11111111-1111-4111-8111-111111111111';
const CUTOFF = new Date('2030-01-01T00:00:00Z');

function job(): EnrichmentJob {
  return { id: 'job-c', type: BROADCAST_CHUNK_TYPE, payload: { broadcastId: BID } } as unknown as EnrichmentJob;
}

function users(n: number, from = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `u-${String(from + i).padStart(4, '0')}`,
    email: `u${from + i}@x.test`,
  }));
}

function build(opts: { broadcast?: Record<string, unknown> | null; page?: ReturnType<typeof users> } = {}) {
  const broadcast =
    opts.broadcast === undefined
      ? {
          id: BID,
          status: 'sending',
          audienceCutoff: CUTOFF,
          cursorUserId: null,
          title: 't',
          body: 'b',
          link: null,
          ctaLabel: null,
          critical: false,
          channels: ['inbox', 'email'],
        }
      : opts.broadcast;
  const prisma = {
    notificationBroadcast: {
      findUnique: jest.fn().mockImplementation(({ select }: { select?: unknown }) =>
        Promise.resolve(select ? { status: 'sending' } : broadcast),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findMany: jest.fn().mockResolvedValue(opts.page ?? users(3)) },
  };
  const jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'next' }) };
  const registry = { register: jest.fn() };
  const delivery = { deliver: jest.fn().mockResolvedValue({ email: { success: true } }) };
  const handler = new BroadcastChunkHandler(prisma as never, jobs as never, registry as never, delivery as never);
  return { handler, prisma, jobs, delivery };
}

describe('BroadcastChunkHandler', () => {
  it('pages the frozen audience after the cursor, in id order', async () => {
    const t = build({
      broadcast: {
        id: BID, status: 'sending', audienceCutoff: CUTOFF, cursorUserId: 'u-0100', channels: ['inbox'], critical: false,
        title: 't', body: 'b', link: null, ctaLabel: null,
      },
    });
    await t.handler.process(job());
    expect(t.prisma.user.findMany).toHaveBeenCalledWith({
      where: { isActive: true, createdAt: { lte: CUTOFF }, id: { gt: 'u-0100' } },
      select: { id: true, email: true },
      orderBy: { id: 'asc' },
      take: BROADCAST_CHUNK_SIZE,
    });
  });

  it('delivers everyone on a short page, commits the cursor, and finishes the broadcast', async () => {
    const t = build({ page: users(3) });
    await t.handler.process(job());

    expect(t.delivery.deliver).toHaveBeenCalledTimes(3);
    expect(t.delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: BID }), { id: 'u-0000', email: 'u0@x.test' });
    expect(t.prisma.notificationBroadcast.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: BID, status: 'sending', cursorUserId: null },
      data: { cursorUserId: 'u-0002', processedCount: { increment: 3 } },
    });
    expect(t.prisma.notificationBroadcast.updateMany).toHaveBeenLastCalledWith({
      where: { id: BID, status: 'sending' },
      data: { status: 'sent', finishedAt: expect.any(Date) },
    });
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('commits the cursor per group, chaining the CAS, and enqueues a successor on a full page', async () => {
    const t = build({ page: users(BROADCAST_CHUNK_SIZE) });
    await t.handler.process(job());

    const commits = t.prisma.notificationBroadcast.updateMany.mock.calls.map(([a]) => a);
    expect(commits).toHaveLength(BROADCAST_CHUNK_SIZE / BROADCAST_STATUS_RECHECK_INTERVAL);
    expect(commits[0].where.cursorUserId).toBeNull();
    expect(commits[1].where.cursorUserId).toBe(commits[0].data.cursorUserId);
    expect(t.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: BROADCAST_CHUNK_TYPE, payload: { broadcastId: BID }, skipDedup: true }),
    );
  });

  it('stops without a successor when the cursor CAS loses (another execution moved it)', async () => {
    const t = build({ page: users(BROADCAST_CHUNK_SIZE) });
    t.prisma.notificationBroadcast.updateMany.mockResolvedValueOnce({ count: 0 });
    await t.handler.process(job());
    expect(t.delivery.deliver).toHaveBeenCalledTimes(BROADCAST_STATUS_RECHECK_INTERVAL);
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('stops mid-page within one group when the broadcast is cancelled', async () => {
    const t = build({ page: users(BROADCAST_CHUNK_SIZE) });
    t.prisma.notificationBroadcast.findUnique.mockImplementation(({ select }: { select?: unknown }) =>
      Promise.resolve(select ? { status: 'canceled' } : {
        id: BID, status: 'sending', audienceCutoff: CUTOFF, cursorUserId: null, channels: ['inbox'], critical: false,
        title: 't', body: 'b', link: null, ctaLabel: null,
      }),
    );
    await t.handler.process(job());
    expect(t.delivery.deliver).toHaveBeenCalledTimes(BROADCAST_STATUS_RECHECK_INTERVAL);
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('finishes immediately on an empty page', async () => {
    const t = build({ page: [] });
    await t.handler.process(job());
    expect(t.delivery.deliver).not.toHaveBeenCalled();
    expect(t.prisma.notificationBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'sent' }) }),
    );
  });

  it.each([
    ['deleted', null],
    ['not sending', { id: BID, status: 'canceled', audienceCutoff: CUTOFF }],
    ['no cutoff', { id: BID, status: 'sending', audienceCutoff: null }],
  ])('sends nothing when the broadcast is %s', async (_l, broadcast) => {
    const t = build({ broadcast });
    await t.handler.process(job());
    expect(t.prisma.user.findMany).not.toHaveBeenCalled();
    expect(t.delivery.deliver).not.toHaveBeenCalled();
  });

  it('keeps going when emails fail (delivery never throws) but propagates a DB error', async () => {
    const t = build({ page: users(2) });
    t.delivery.deliver.mockResolvedValue({ email: { success: false, error: 'smtp down' } });
    await expect(t.handler.process(job())).resolves.toBeUndefined();
    expect(t.delivery.deliver).toHaveBeenCalledTimes(2);

    const u = build({ page: users(2) });
    u.prisma.notificationBroadcast.updateMany.mockRejectedValue(new Error('db down'));
    await expect(u.handler.process(job())).rejects.toThrow('db down');
  });

  it('delivers with bounded concurrency (at most 5 in flight)', async () => {
    const t = build({ page: users(BROADCAST_STATUS_RECHECK_INTERVAL) });
    let inFlight = 0;
    let peak = 0;
    t.delivery.deliver.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      return { email: null };
    });
    await t.handler.process(job());
    expect(peak).toBe(5);
  });
});
