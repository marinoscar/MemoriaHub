import { ReviewQueueCounterRegistry } from '../media/index.js';
import { LocationReviewQueueCounter } from './location-review-queue.counter.js';

describe('LocationReviewQueueCounter (RETRO-J10, #624)', () => {
  it('registers as pendingLocationSuggestions / review.location_suggestions, on with features.locationInference', () => {
    const registry = new ReviewQueueCounterRegistry();
    const counter = new LocationReviewQueueCounter({} as never, registry);
    counter.onModuleInit();
    expect(registry.all()).toEqual([counter]);
    expect(counter.countKey).toBe('pendingLocationSuggestions');
    expect(counter.eventKey).toBe('review.location_suggestions');
    expect(counter.isEnabled({ locationInference: true })).toBe(true);
    expect(counter.isEnabled({})).toBe(false);
  });

  it('counts the pending suggestions of the library', async () => {
    const prisma = { locationSuggestion: { count: jest.fn(async () => 4) } };
    const counter = new LocationReviewQueueCounter(prisma as never, new ReviewQueueCounterRegistry());
    await expect(counter.count('lib-1')).resolves.toBe(4);
    expect(prisma.locationSuggestion.count).toHaveBeenCalledWith({ where: { circleId: 'lib-1', status: 'pending' } });
  });
});
