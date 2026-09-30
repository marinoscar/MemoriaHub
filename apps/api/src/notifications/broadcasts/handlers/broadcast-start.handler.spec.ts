/** broadcast_start (issue #488): CAS claim, audience freeze, hand-off, resume. */
import { EnrichmentJob } from '@prisma/client';

import { EnrichmentHandler } from '../../../enrichment/enrichment-handler.interface';
import { BroadcastStartHandler } from './broadcast-start.handler';
import { BROADCAST_CHUNK_TYPE } from '../broadcast-constants';

const BID = '11111111-1111-4111-8111-111111111111';

function job(payload: unknown = { broadcastId: BID }): EnrichmentJob {
  return { id: 'job-1', type: 'broadcast_start', payload, status: 'running' } as unknown as EnrichmentJob;
}

function build(broadcast: Record<string, unknown> | null) {
  const prisma = {
    notificationBroadcast: {
      findUnique: jest.fn().mockResolvedValue(broadcast),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: { count: jest.fn().mockResolvedValue(42) },
    enrichmentJob: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'chunk-1' }) };
  const registry = { register: jest.fn() };
  const handler = new BroadcastStartHandler(prisma as never, jobs as never, registry as never);
  return { handler, prisma, jobs, registry };
}

const scheduled = { id: BID, status: 'scheduled', audienceCutoff: null, cursorUserId: null, processedCount: 0 };

describe('BroadcastStartHandler', () => {
  it('registers itself and is server-only', () => {
    const t = build(null);
    t.handler.onModuleInit();
    expect(t.registry.register).toHaveBeenCalledWith(t.handler);
    const asHandler: EnrichmentHandler = t.handler;
    expect(asHandler.nodeResultSchema).toBeUndefined();
    expect(asHandler.persistNodeResult).toBeUndefined();
  });

  it('claims scheduled → sending with ONE timestamp for startedAt and audienceCutoff, counts, enqueues the first chunk', async () => {
    const t = build(scheduled);
    await t.handler.process(job());

    const claim = t.prisma.notificationBroadcast.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: BID, status: 'scheduled' });
    expect(claim.data.status).toBe('sending');
    expect(claim.data.startedAt).toBe(claim.data.audienceCutoff);

    expect(t.prisma.user.count).toHaveBeenCalledWith({
      where: { isActive: true, createdAt: { lte: claim.data.audienceCutoff } },
    });
    expect(t.prisma.notificationBroadcast.updateMany.mock.calls[1][0]).toEqual({
      where: { id: BID, status: 'sending' },
      data: { recipientCount: 42 },
    });
    expect(t.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: BROADCAST_CHUNK_TYPE, payload: { broadcastId: BID }, skipDedup: true, mediaItemId: null }),
    );
  });

  it('is a no-op when the CAS matches nothing (lost race / cancelled)', async () => {
    const t = build(scheduled);
    t.prisma.notificationBroadcast.updateMany.mockResolvedValueOnce({ count: 0 });
    await t.handler.process(job());
    expect(t.prisma.user.count).not.toHaveBeenCalled();
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('queues no chunk when a cancel lands between claim and hand-off', async () => {
    const t = build(scheduled);
    t.prisma.notificationBroadcast.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await t.handler.process(job());
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
  });

  it.each([null, 'canceled', 'sent', 'failed'])('does nothing for a deleted or %s broadcast', async (status) => {
    const t = build(status === null ? null : { ...scheduled, status });
    t.prisma.notificationBroadcast.updateMany.mockResolvedValue({ count: 0 });
    await t.handler.process(job());
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('ignores a job with no broadcastId payload', async () => {
    const t = build(scheduled);
    await t.handler.process(job({}));
    expect(t.prisma.notificationBroadcast.findUnique).not.toHaveBeenCalled();
  });

  it('finishes an interrupted hand-off using the STORED cutoff (no re-claim)', async () => {
    const cutoff = new Date('2030-01-01T00:00:00Z');
    const t = build({ ...scheduled, status: 'sending', audienceCutoff: cutoff });
    await t.handler.process(job());
    expect(t.prisma.enrichmentJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { type: BROADCAST_CHUNK_TYPE, payload: { path: ['broadcastId'], equals: BID } } }),
    );
    expect(t.prisma.user.count).toHaveBeenCalledWith({ where: { isActive: true, createdAt: { lte: cutoff } } });
    expect(t.jobs.enqueue).toHaveBeenCalledTimes(1);
    // never re-stamps the cutoff
    for (const [arg] of t.prisma.notificationBroadcast.updateMany.mock.calls) {
      expect(arg.data).not.toHaveProperty('audienceCutoff');
    }
  });

  it('does not resume a sending broadcast that already has a chunk or progress', async () => {
    const cutoff = new Date();
    const withChunk = build({ ...scheduled, status: 'sending', audienceCutoff: cutoff });
    withChunk.prisma.enrichmentJob.findFirst.mockResolvedValue({ id: 'c' });
    await withChunk.handler.process(job());
    expect(withChunk.jobs.enqueue).not.toHaveBeenCalled();

    const progressed = build({ ...scheduled, status: 'sending', audienceCutoff: cutoff, processedCount: 3 });
    await progressed.handler.process(job());
    expect(progressed.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('propagates a database error so the queue retries', async () => {
    const t = build(scheduled);
    t.prisma.user.count.mockRejectedValue(new Error('db down'));
    await expect(t.handler.process(job())).rejects.toThrow('db down');
  });
});
