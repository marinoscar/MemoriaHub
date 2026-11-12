import { ReviewQueueCounterRegistry, REVIEW_QUEUE_COUNT_KEYS, type ReviewQueueCounter } from './review-queue-counter.registry.js';

const counter = (countKey: ReviewQueueCounter['countKey'], n: number, over: Partial<ReviewQueueCounter> = {}): ReviewQueueCounter => ({
  countKey,
  eventKey: `review.${countKey}`,
  isEnabled: () => true,
  count: jest.fn(async () => n),
  ...over,
});

describe('ReviewQueueCounterRegistry (RETRO-J10, #624)', () => {
  it('keeps the four permanent wire keys', () => {
    expect([...REVIEW_QUEUE_COUNT_KEYS]).toEqual([
      'pendingBurstGroups',
      'pendingDuplicateGroups',
      'pendingLocationSuggestions',
      'pendingEnhancements',
    ]);
  });

  it('reports every queue as 0 when no slice registered a counter', async () => {
    await expect(new ReviewQueueCounterRegistry().countAll('lib-1')).resolves.toEqual({
      pendingBurstGroups: 0,
      pendingDuplicateGroups: 0,
      pendingLocationSuggestions: 0,
      pendingEnhancements: 0,
    });
  });

  it('counts each registered queue of the library, an absent slice stays 0', async () => {
    const registry = new ReviewQueueCounterRegistry();
    const burst = counter('pendingBurstGroups', 2);
    registry.registerReviewQueueCounter(burst);
    registry.registerReviewQueueCounter(counter('pendingEnhancements', 5));
    await expect(registry.countAll('lib-1')).resolves.toEqual({
      pendingBurstGroups: 2,
      pendingDuplicateGroups: 0,
      pendingLocationSuggestions: 0,
      pendingEnhancements: 5,
    });
    expect(burst.count).toHaveBeenCalledWith('lib-1');
  });

  it('lists the counters in wire-key order whatever the registration order', () => {
    const registry = new ReviewQueueCounterRegistry();
    registry.registerReviewQueueCounter(counter('pendingEnhancements', 1));
    registry.registerReviewQueueCounter(counter('pendingBurstGroups', 1));
    expect(registry.all().map((c) => c.countKey)).toEqual(['pendingBurstGroups', 'pendingEnhancements']);
  });

  it('registering a key again replaces the earlier counter', async () => {
    const registry = new ReviewQueueCounterRegistry();
    registry.registerReviewQueueCounter(counter('pendingBurstGroups', 1));
    registry.registerReviewQueueCounter(counter('pendingBurstGroups', 9));
    expect((await registry.countAll('lib-1')).pendingBurstGroups).toBe(9);
    expect(registry.all()).toHaveLength(1);
  });

  it('a counter that fails fails the count (the caller decides)', async () => {
    const registry = new ReviewQueueCounterRegistry();
    registry.registerReviewQueueCounter(counter('pendingBurstGroups', 0, { count: async () => { throw new Error('db down'); } }));
    await expect(registry.countAll('lib-1')).rejects.toThrow('db down');
  });
});
