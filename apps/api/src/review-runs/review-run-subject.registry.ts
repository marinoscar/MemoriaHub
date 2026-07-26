import { Injectable } from '@nestjs/common';
import { ReviewRunSubject } from '@prisma/client';
import { ReviewRunSubjectStrategy } from './review-run-subject.strategy';
import { BurstGroupReviewStrategy } from './strategies/burst-group.strategy';
import { DuplicateGroupReviewStrategy } from './strategies/duplicate-group.strategy';
import { LocationSuggestionReviewStrategy } from './strategies/location-suggestion.strategy';

/**
 * Registry of per-subject review-run strategies, keyed by `ReviewRunSubject`.
 *
 * Deliberately constructor-injected rather than self-registering (the
 * `EnrichmentHandlerRegistry` pattern): the set of review queues is fixed by the
 * `ReviewRunSubject` enum and its exclusive-arc columns, so an exhaustive map
 * built up front means `get()` can never miss.
 */
@Injectable()
export class ReviewRunSubjectRegistry {
  private readonly strategies: Record<ReviewRunSubject, ReviewRunSubjectStrategy>;

  constructor(
    burst: BurstGroupReviewStrategy,
    duplicate: DuplicateGroupReviewStrategy,
    location: LocationSuggestionReviewStrategy,
  ) {
    this.strategies = {
      [ReviewRunSubject.burst_group]: burst,
      [ReviewRunSubject.duplicate_group]: duplicate,
      [ReviewRunSubject.location_suggestion]: location,
    };
  }

  get(subject: ReviewRunSubject): ReviewRunSubjectStrategy {
    return this.strategies[subject];
  }

  all(): ReviewRunSubjectStrategy[] {
    return Object.values(this.strategies);
  }
}
