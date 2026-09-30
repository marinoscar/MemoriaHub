/** PushSubscriptionService (epic #481, issue #483). */
import { ConflictException, NotFoundException } from '@nestjs/common';

import { PushSubscriptionService } from './push-subscription.service';

const DTO = {
  endpoint: 'https://push.example.com/ep',
  keys: { p256dh: 'p', auth: 'a' },
  expirationTime: 1_700_000_000_000,
};

function build(active = true) {
  const prisma = {
    pushSubscription: {
      upsert: jest.fn(async ({ create }: any) => ({
        id: 'sub-1',
        endpoint: create.endpoint,
        createdAt: new Date(0),
      })),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const pushConfig = {
    resolveActiveVapidConfig: jest
      .fn()
      .mockResolvedValue(active ? { publicKey: 'P', privateKey: 'K', subject: 's' } : null),
  };
  return { service: new PushSubscriptionService(prisma as any, pushConfig as any), prisma };
}

describe('PushSubscriptionService', () => {
  it('409s when push is not active, writing nothing', async () => {
    const { service, prisma } = build(false);
    await expect(service.subscribe('u1', DTO, 'ua')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.pushSubscription.upsert).not.toHaveBeenCalled();
  });

  it('upserts by endpoint and reassigns the owner, resetting failureCount', async () => {
    const { service, prisma } = build();
    const res = await service.subscribe('u2', DTO, 'agent');
    expect(res).toEqual({ id: 'sub-1', endpoint: DTO.endpoint, createdAt: new Date(0).toISOString() });
    const arg = prisma.pushSubscription.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ endpoint: DTO.endpoint });
    expect(arg.update).toMatchObject({ userId: 'u2', failureCount: 0, userAgent: 'agent' });
    expect(arg.create).toMatchObject({ userId: 'u2', p256dh: 'p', auth: 'a' });
    expect(arg.create.expirationTime).toEqual(new Date(DTO.expirationTime));
  });

  it('stores null expiration and user agent when absent', async () => {
    const { service, prisma } = build();
    await service.subscribe('u1', { ...DTO, expirationTime: null }, undefined);
    const arg = prisma.pushSubscription.upsert.mock.calls[0][0];
    expect(arg.create.expirationTime).toBeNull();
    expect(arg.create.userAgent).toBeNull();
  });

  it('unsubscribe is scoped to the caller and 404s on no match', async () => {
    const { service, prisma } = build();
    await service.unsubscribe('u1', DTO.endpoint);
    expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', endpoint: DTO.endpoint },
    });
    prisma.pushSubscription.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.unsubscribe('u1', DTO.endpoint)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hasActivePushSubscription reflects the row count', async () => {
    const { service, prisma } = build();
    await expect(service.hasActivePushSubscription('u1')).resolves.toBe(false);
    prisma.pushSubscription.count.mockResolvedValueOnce(2);
    await expect(service.hasActivePushSubscription('u1')).resolves.toBe(true);
  });
});
