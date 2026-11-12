import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { REVIEW_QUEUE_EVENT_KEYS, ReviewQueueCounterRegistry, type ReviewQueueCounter } from '../media/index.js';
import {
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubSettingsPort,
} from '../ports/index.js';
import type { BurstDb } from './data/burst-db.js';

/** The `burst.minGroupSize` default: a group smaller than this is not surfaced for review. */
const DEFAULT_MIN_GROUP_SIZE = 3;

/**
 * The burst review queue's counter (RETRO-J10, #624): the pending burst groups of a library that reached
 * `burst.minGroupSize`, reported as `pendingBurstGroups` and raised as `review.bursts` while
 * `features.burstDetection` is on. Registers itself with the media slice's {@link ReviewQueueCounterRegistry}.
 *
 * @stability experimental
 */
@Injectable()
export class BurstReviewQueueCounter implements ReviewQueueCounter, OnModuleInit {
  readonly countKey = 'pendingBurstGroups' as const;
  readonly eventKey = REVIEW_QUEUE_EVENT_KEYS.bursts;

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: BurstDb,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly registry: ReviewQueueCounterRegistry,
  ) {}

  /** Registers the counter. */
  onModuleInit(): void {
    this.registry.registerReviewQueueCounter(this);
  }

  /** Burst detection on. */
  isEnabled(features: Record<string, unknown> | undefined): boolean {
    return features?.['burstDetection'] === true;
  }

  /** The pending groups of the library that reached the minimum size. */
  async count(libraryId: string): Promise<number> {
    const { value } = await this.settings.readSystem<{ minGroupSize?: number } | undefined>('burst');
    return this.prisma.burstGroup.count({
      where: { circleId: libraryId, status: 'pending', mediaCount: { gte: value?.minGroupSize ?? DEFAULT_MIN_GROUP_SIZE } },
    });
  }
}
