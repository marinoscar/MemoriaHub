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
