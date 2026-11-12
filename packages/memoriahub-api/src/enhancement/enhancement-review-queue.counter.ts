import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { REVIEW_QUEUE_EVENT_KEYS, ReviewQueueCounterRegistry, type ReviewQueueCounter } from '../media/index.js';
import { MEMORIAHUB_PRISMA } from '../ports/index.js';
import type { EnhancementDb } from './data/enhancement-db.js';

/**
 * The AI enhancement review queue's counter (RETRO-J10, #624): the enhancements of a library that are
 * STAGED and awaiting a human keep-both, replace or discard decision (`ready`: `pending` means "queued for
 * the model" and is not user-actionable), reported as `pendingEnhancements` and raised as
 * `review.enhancements`. The one queue with an environment kill switch, folded into `isEnabled` so the
 * reconcile can never advertise a queue the enhance endpoints would reject. Registers itself with the media
 * slice's {@link ReviewQueueCounterRegistry}.
 *
 * @stability experimental
 */
@Injectable()
export class EnhancementReviewQueueCounter implements ReviewQueueCounter, OnModuleInit {
  readonly countKey = 'pendingEnhancements' as const;
  readonly eventKey = REVIEW_QUEUE_EVENT_KEYS.enhancements;

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: EnhancementDb,
    private readonly registry: ReviewQueueCounterRegistry,
  ) {}

  /** Registers the counter. */
  onModuleInit(): void {
    this.registry.registerReviewQueueCounter(this);
  }

  /** The picture enhancer on, and not switched off by `PICTURE_ENHANCEMENT_ENABLED=false`. */
  isEnabled(features: Record<string, unknown> | undefined): boolean {
    return features?.['pictureEnhancement'] === true && process.env['PICTURE_ENHANCEMENT_ENABLED'] !== 'false';
  }

  /** The staged enhancements of the library awaiting a decision. Served by `@@index([circleId, status])`. */
  count(libraryId: string): Promise<number> {
    return this.prisma.mediaEnhancement.count({ where: { circleId: libraryId, status: 'ready' } });
  }
}
