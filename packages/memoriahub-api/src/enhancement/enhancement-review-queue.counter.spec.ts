import { ReviewQueueCounterRegistry } from '../media/index.js';
import { EnhancementReviewQueueCounter } from './enhancement-review-queue.counter.js';

describe('EnhancementReviewQueueCounter (RETRO-J10, #624)', () => {
  afterEach(() => {
    delete process.env['PICTURE_ENHANCEMENT_ENABLED'];
  });

  it('registers as pendingEnhancements / review.enhancements', () => {
    const registry = new ReviewQueueCounterRegistry();
    const counter = new EnhancementReviewQueueCounter({} as never, registry);
    counter.onModuleInit();
    expect(registry.all()).toEqual([counter]);
    expect(counter.countKey).toBe('pendingEnhancements');
    expect(counter.eventKey).toBe('review.enhancements');
  });

  it('is on with features.pictureEnhancement unless PICTURE_ENHANCEMENT_ENABLED=false switches it off', () => {
    const counter = new EnhancementReviewQueueCounter({} as never, new ReviewQueueCounterRegistry());
    expect(counter.isEnabled({ pictureEnhancement: true })).toBe(true);
    expect(counter.isEnabled({ pictureEnhancement: false })).toBe(false);
    process.env['PICTURE_ENHANCEMENT_ENABLED'] = 'false';
    expect(counter.isEnabled({ pictureEnhancement: true })).toBe(false);
  });

  it('counts only the enhancements awaiting a decision (status ready), not the queued ones', async () => {
    const prisma = { mediaEnhancement: { count: jest.fn(async () => 9) } };
    const counter = new EnhancementReviewQueueCounter(prisma as never, new ReviewQueueCounterRegistry());
    await expect(counter.count('lib-1')).resolves.toBe(9);
    expect(prisma.mediaEnhancement.count).toHaveBeenCalledWith({ where: { circleId: 'lib-1', status: 'ready' } });
  });
});
