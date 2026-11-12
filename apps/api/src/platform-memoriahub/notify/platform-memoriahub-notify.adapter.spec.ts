import { PlatformMemoriahubNotifyAdapter } from './platform-memoriahub-notify.adapter';

describe('PlatformMemoriahubNotifyAdapter.liveStates (RETRO-J10, #624)', () => {
  it('lists the live STATE rows of the events, in one scope when given', async () => {
    const findMany = jest.fn(async () => [{ userId: 'u1', eventKey: 'review.bursts', scopeId: 's1' }]);
    const adapter = new PlatformMemoriahubNotifyAdapter({} as never, { notification: { findMany } } as never);

    await expect(adapter.liveStates(['review.bursts', 'review.duplicates'], 's1')).resolves.toEqual([
      { userId: 'u1', eventKey: 'review.bursts', scopeId: 's1' },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { eventKey: { in: ['review.bursts', 'review.duplicates'] }, dismissedAt: null, dedupKey: { startsWith: 'state:' }, scopeId: 's1' },
      select: { userId: true, eventKey: true, scopeId: true },
    });
  });

  it('reads every scope when none is given', async () => {
    const findMany = jest.fn(async () => []);
    const adapter = new PlatformMemoriahubNotifyAdapter({} as never, { notification: { findMany } } as never);
    await adapter.liveStates(['review.bursts']);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { eventKey: { in: ['review.bursts'] }, dismissedAt: null, dedupKey: { startsWith: 'state:' } } }));
  });
});

describe('PlatformMemoriahubNotifyAdapter.hasNotified (RETRO-J10, #624)', () => {
  it('looks for a row of the user and event whose data carries every value, with NO dismissedAt predicate', async () => {
    const findFirst = jest.fn(async () => ({ id: 'n1' }));
    const adapter = new PlatformMemoriahubNotifyAdapter({} as never, { notification: { findFirst } } as never);

    await expect(adapter.hasNotified('shares.expiring', 'u1', { shareId: 'g1', notifiedFor: '2026-08-08T12:00:00.000Z' })).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        eventKey: 'shares.expiring',
        AND: [
          { data: { path: ['shareId'], equals: 'g1' } },
          { data: { path: ['notifiedFor'], equals: '2026-08-08T12:00:00.000Z' } },
        ],
      },
      select: { id: true },
    });
    expect(JSON.stringify(findFirst.mock.calls[0])).not.toContain('dismissedAt');
  });

  it('is false when no row matches', async () => {
    const adapter = new PlatformMemoriahubNotifyAdapter({} as never, { notification: { findFirst: jest.fn(async () => null) } } as never);
    await expect(adapter.hasNotified('shares.expiring', 'u1', { shareId: 'g1' })).resolves.toBe(false);
  });
});
