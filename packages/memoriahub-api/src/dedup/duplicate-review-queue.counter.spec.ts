import { ReviewQueueCounterRegistry } from '../media/index.js';
import { DuplicateReviewQueueCounter } from './duplicate-review-queue.counter.js';

describe('DuplicateReviewQueueCounter (RETRO-J10, #624)', () => {
  it('registers as pendingDuplicateGroups / review.duplicates, on with features.duplicateDetection', () => {
    const registry = new ReviewQueueCounterRegistry();
    const counter = new DuplicateReviewQueueCounter({} as never, registry);
    counter.onModuleInit();
    expect(registry.all()).toEqual([counter]);
    expect(counter.countKey).toBe('pendingDuplicateGroups');
    expect(counter.eventKey).toBe('review.duplicates');
    expect(counter.isEnabled({ duplicateDetection: true })).toBe(true);
    expect(counter.isEnabled({ duplicateDetection: false })).toBe(false);
  });

  it('counts every pending group of the library (no minimum size)', async () => {
    const prisma = { duplicateGroup: { count: jest.fn(async () => 929) } };
    const counter = new DuplicateReviewQueueCounter(prisma as never, new ReviewQueueCounterRegistry());
    await expect(counter.count('lib-1')).resolves.toBe(929);
    expect(prisma.duplicateGroup.count).toHaveBeenCalledWith({ where: { circleId: 'lib-1', status: 'pending' } });
  });
});
