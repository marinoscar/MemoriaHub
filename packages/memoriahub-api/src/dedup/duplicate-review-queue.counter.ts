import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { REVIEW_QUEUE_EVENT_KEYS, ReviewQueueCounterRegistry, type ReviewQueueCounter } from '../media/index.js';
import { MEMORIAHUB_PRISMA } from '../ports/index.js';
import type { DedupDb } from './data/dedup-db.js';

/**
 * The near-duplicate review queue's counter (RETRO-J10, #624): the pending duplicate groups of a library
 * (no minimum size: a group only ever exists with two members), reported as `pendingDuplicateGroups` and
 * raised as `review.duplicates` while `features.duplicateDetection` is on. Registers itself with the media
 * slice's {@link ReviewQueueCounterRegistry}.
 *
 * @stability experimental
 */
@Injectable()
export class DuplicateReviewQueueCounter implements ReviewQueueCounter, OnModuleInit {
  readonly countKey = 'pendingDuplicateGroups' as const;
  readonly eventKey = REVIEW_QUEUE_EVENT_KEYS.duplicates;

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: DedupDb,
    private readonly registry: ReviewQueueCounterRegistry,
  ) {}

  /** Registers the counter. */
  onModuleInit(): void {
    this.registry.registerReviewQueueCounter(this);
  }

  /** Duplicate detection on. */
  isEnabled(features: Record<string, unknown> | undefined): boolean {
    return features?.['duplicateDetection'] === true;
  }

  /** The pending groups of the library. */
  count(libraryId: string): Promise<number> {
    return this.prisma.duplicateGroup.count({ where: { circleId: libraryId, status: 'pending' } });
  }
}
