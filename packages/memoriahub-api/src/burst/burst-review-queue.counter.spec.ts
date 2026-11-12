import { ReviewQueueCounterRegistry } from '../media/index.js';
import { BurstReviewQueueCounter } from './burst-review-queue.counter.js';

function build(minGroupSize: number | undefined | 'no-config') {
  const prisma = { burstGroup: { count: jest.fn(async () => 4) } };
  const settings = { readSystem: jest.fn(async () => ({ value: minGroupSize === 'no-config' ? undefined : { minGroupSize }, version: 1 })) };
  const registry = new ReviewQueueCounterRegistry();
  const counter = new BurstReviewQueueCounter(prisma as never, settings as never, registry);
  return { prisma, settings, registry, counter };
}

describe('BurstReviewQueueCounter (RETRO-J10, #624)', () => {
  it('registers as pendingBurstGroups / review.bursts, on with features.burstDetection', () => {
    const { counter, registry } = build(3);
    counter.onModuleInit();
    expect(registry.all()).toEqual([counter]);
    expect(counter.countKey).toBe('pendingBurstGroups');
    expect(counter.eventKey).toBe('review.bursts');
    expect(counter.isEnabled({ burstDetection: true })).toBe(true);
    expect(counter.isEnabled({ burstDetection: false })).toBe(false);
    expect(counter.isEnabled(undefined)).toBe(false);
  });

  it('counts the pending groups that reached burst.minGroupSize', async () => {
    const { counter, prisma, settings } = build(7);
    await expect(counter.count('lib-1')).resolves.toBe(4);
    expect(settings.readSystem).toHaveBeenCalledWith('burst');
    expect(prisma.burstGroup.count).toHaveBeenCalledWith({ where: { circleId: 'lib-1', status: 'pending', mediaCount: { gte: 7 } } });
  });

  it.each([[undefined], ['no-config' as const]])('defaults burst.minGroupSize to 3 (%s)', async (setting) => {
    const { counter, prisma } = build(setting);
    await counter.count('lib-1');
    expect(prisma.burstGroup.count).toHaveBeenCalledWith({ where: { circleId: 'lib-1', status: 'pending', mediaCount: { gte: 3 } } });
  });
});
