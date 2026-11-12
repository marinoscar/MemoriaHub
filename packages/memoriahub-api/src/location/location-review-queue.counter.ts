import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { REVIEW_QUEUE_EVENT_KEYS, ReviewQueueCounterRegistry, type ReviewQueueCounter } from '../media/index.js';
import { MEMORIAHUB_PRISMA } from '../ports/index.js';
import type { LocationDb } from './data/location-db.js';

/**
 * The location-suggestion review queue's counter (RETRO-J10, #624): the pending location suggestions of a
 * library, reported as `pendingLocationSuggestions` and raised as `review.location_suggestions` while
 * `features.locationInference` is on. Registers itself with the media slice's
 * {@link ReviewQueueCounterRegistry}.
 *
 * @stability experimental
 */
@Injectable()
export class LocationReviewQueueCounter implements ReviewQueueCounter, OnModuleInit {
  readonly countKey = 'pendingLocationSuggestions' as const;
  readonly eventKey = REVIEW_QUEUE_EVENT_KEYS.locationSuggestions;

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: LocationDb,
    private readonly registry: ReviewQueueCounterRegistry,
  ) {}

  /** Registers the counter. */
  onModuleInit(): void {
    this.registry.registerReviewQueueCounter(this);
  }

  /** Location inference on. */
  isEnabled(features: Record<string, unknown> | undefined): boolean {
    return features?.['locationInference'] === true;
  }

  /** The pending suggestions of the library. */
  count(libraryId: string): Promise<number> {
    return this.prisma.locationSuggestion.count({ where: { circleId: libraryId, status: 'pending' } });
  }
}
