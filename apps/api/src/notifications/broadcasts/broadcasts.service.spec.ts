/** BroadcastsService (issue #488): create/enqueue order, cancel/resume CAS, delete, test send. */
import { ConflictException, NotFoundException } from '@nestjs/common';

import { BroadcastsService } from './broadcasts.service';
import { BROADCAST_CHUNK_TYPE, BROADCAST_START_TYPE } from './broadcast-constants';

const BID = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';

function row(over: Record<string, unknown> = {}) {
  const t = new Date('2030-01-01T00:00:00Z');
  return {
    id: BID,
    title: 'Hi',
    body: 'Body',
    link: null,
    ctaLabel: null,
    critical: false,
    channels: ['inbox'],
    status: 'scheduled',
    scheduledFor: null,
    audienceCutoff: null,
    recipientCount: null,
    cursorUserId: null,
    processedCount: 0,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    createdById: ADMIN,
    canceledById: null,
    canceledAt: null,
    createdAt: t,
    updatedAt: t,
    createdBy: { id: ADMIN, email: 'a@x.test', displayName: 'Admin' },
    canceledBy: null,
    ...over,
  };
}

function build() {
  const order: string[] = [];
  const prisma = {
    notificationBroadcast: {
      create: jest.fn().mockImplementation(async () => {
        order.push('create');
        return row();
      }),
      findUnique: jest.fn().mockResolvedValue(row()),
      findMany: jest.fn().mockResolvedValue([row()]),
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn().mockResolvedValue(row()),
    },
    user: {
      count: jest.fn().mockResolvedValue(7),
      findUnique: jest.fn().mockResolvedValue({ id: ADMIN, email: 'a@x.test' }),
    },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const jobs = {
    enqueue: jest.fn().mockImplementation(async () => {
      order.push('enqueue');
      return { id: 'job-1' };
    }),
  };
  const delivery = { deliver: jest.fn().mockResolvedValue({ email: null }) };
  const service = new BroadcastsService(prisma as never, jobs as never, delivery as never);
  return { service, prisma, jobs, delivery, order };
}

describe('BroadcastsService', () => {
  it('audience counts active users as of now', async () => {
    const t = build();
    await expect(t.service.audience()).resolves.toEqual({ activeUsers: 7 });
    expect(t.prisma.user.count.mock.calls[0][0].where).toEqual({
      isActive: true,
      createdAt: { lte: expect.any(Date) },
    });
  });

  it('list returns items + pagination meta, newest first', async () => {
    const t = build();
    const res = await t.service.list({ page: 2, pageSize: 10, status: 'sent' });
    expect(t.prisma.notificationBroadcast.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'sent' }, skip: 10, take: 10, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    );
    expect(res.meta).toEqual({ page: 2, pageSize: 10, totalItems: 1, totalPages: 1 });
    expect(res.items[0]).toMatchObject({ id: BID, createdAt: '2030-01-01T00:00:00.000Z', createdBy: { id: ADMIN } });
  });

  it('create writes the row BEFORE enqueuing the start job, with scheduledFor and skipDedup', async () => {
    const t = build();
    const when = new Date(Date.now() + 60_000);
    const res = await t.service.create(
      { title: 'Hi', body: 'Body', channels: ['inbox', 'push'], critical: true, scheduledFor: when },
      ADMIN,
    );
    expect(t.order).toEqual(['create', 'enqueue']);
    expect(t.prisma.notificationBroadcast.create.mock.calls[0][0].data).toMatchObject({
      status: 'scheduled',
      critical: true,
      channels: ['inbox', 'push'],
      scheduledFor: when,
      createdById: ADMIN,
    });
    expect(t.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: BROADCAST_START_TYPE, payload: { broadcastId: BID }, skipDedup: true, scheduledFor: when }),
    );
    expect(t.prisma.auditEvent.create.mock.calls[0][0].data.meta).not.toHaveProperty('body');
    expect(res.id).toBe(BID);
  });

  it('an immediate create enqueues with no scheduledFor', async () => {
    const t = build();
    await t.service.create({ title: 'Hi', body: 'B', channels: ['inbox'], critical: false }, ADMIN);
    expect(t.jobs.enqueue.mock.calls[0][0]).not.toHaveProperty('scheduledFor');
  });

  it('cancel is a conditional write and records who cancelled', async () => {
    const t = build();
    await t.service.cancel(BID, ADMIN);
    expect(t.prisma.notificationBroadcast.updateMany).toHaveBeenCalledWith({
      where: { id: BID, status: { in: ['scheduled', 'sending', 'failed'] } },
      data: { status: 'canceled', canceledAt: expect.any(Date), canceledById: ADMIN },
    });
  });

  it('cancel distinguishes 404 from 409', async () => {
    const t = build();
    t.prisma.notificationBroadcast.updateMany.mockResolvedValue({ count: 0 });
    t.prisma.notificationBroadcast.findUnique.mockResolvedValueOnce(row({ status: 'sent' }));
    await expect(t.service.cancel(BID, ADMIN)).rejects.toBeInstanceOf(ConflictException);
    t.prisma.notificationBroadcast.findUnique.mockResolvedValueOnce(null);
    await expect(t.service.cancel(BID, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resume of a claimed failed broadcast flips to sending and queues a chunk from the cursor', async () => {
    const t = build();
    t.prisma.notificationBroadcast.findUnique.mockResolvedValue(
      row({ status: 'failed', audienceCutoff: new Date(), cursorUserId: 'u-9' }),
    );
    await t.service.resume(BID, ADMIN);
    expect(t.prisma.notificationBroadcast.updateMany).toHaveBeenCalledWith({
      where: { id: BID, status: 'failed' },
      data: { status: 'sending', finishedAt: null, lastError: null },
    });
    expect(t.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: BROADCAST_CHUNK_TYPE, skipDedup: true, payload: { broadcastId: BID } }),
    );
  });

  it('resume of a never-claimed failed broadcast goes back to scheduled and re-queues the start', async () => {
    const t = build();
    t.prisma.notificationBroadcast.findUnique.mockResolvedValue(row({ status: 'failed', audienceCutoff: null }));
    await t.service.resume(BID, ADMIN);
    expect(t.prisma.notificationBroadcast.updateMany.mock.calls[0][0].data.status).toBe('scheduled');
    expect(t.jobs.enqueue.mock.calls[0][0].type).toBe(BROADCAST_START_TYPE);
  });

  it('resume refuses a non-failed broadcast and compensates an enqueue failure', async () => {
    const t = build();
    t.prisma.notificationBroadcast.findUnique.mockResolvedValue(row({ status: 'sent' }));
    await expect(t.service.resume(BID, ADMIN)).rejects.toBeInstanceOf(ConflictException);

    const u = build();
    u.prisma.notificationBroadcast.findUnique.mockResolvedValue(row({ status: 'failed', audienceCutoff: new Date() }));
    u.jobs.enqueue.mockRejectedValue(new Error('queue down'));
    await expect(u.service.resume(BID, ADMIN)).rejects.toThrow('queue down');
    expect(u.prisma.notificationBroadcast.updateMany).toHaveBeenLastCalledWith({
      where: { id: BID, status: 'sending' },
      data: expect.objectContaining({ status: 'failed', lastError: expect.stringMatching(/queue down/) }),
    });
  });

  it('remove refuses a sending broadcast and deletes otherwise', async () => {
    const t = build();
    t.prisma.notificationBroadcast.findUnique.mockResolvedValueOnce(row({ status: 'sending' }));
    await expect(t.service.remove(BID, ADMIN)).rejects.toBeInstanceOf(ConflictException);
    expect(t.prisma.notificationBroadcast.delete).not.toHaveBeenCalled();

    await t.service.remove(BID, ADMIN);
    expect(t.prisma.notificationBroadcast.delete).toHaveBeenCalledWith({ where: { id: BID } });
  });

  it('sendTest delivers to the CALLER only, writes no broadcast and queues no job', async () => {
    const t = build();
    t.delivery.deliver.mockResolvedValue({ email: { success: false, error: 'email_disabled' } });
    const res = await t.service.sendTest(
      { title: 'Hi', body: 'B', channels: ['inbox', 'email'], critical: true },
      ADMIN,
    );
    expect(t.delivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ id: null, critical: true, channels: ['inbox', 'email'] }),
      { id: ADMIN, email: 'a@x.test' },
    );
    expect(t.prisma.notificationBroadcast.create).not.toHaveBeenCalled();
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
    expect(res).toEqual({
      notificationType: 'admin_broadcast_critical',
      channels: ['inbox', 'email'],
      sentToUserId: ADMIN,
      email: { success: false, error: 'email_disabled' },
    });
  });
});
