import { Injectable } from '@nestjs/common';
import type { ReviewRunSubject } from '@marinoscar/memoriahub-contract/review-runs';

import type { ReviewRunSubjectStrategy } from './review-run-subject.strategy.js';

/**
 * The registry of per-subject review-run strategies, keyed by subject. Provided by
 * {@link ReviewRunsModule}; the slice that owns a review queue injects it and calls
 * {@link ReviewRunSubjectRegistry.register} when it starts (the burst and duplicate strategies from the
 * host while their review services live there, the location strategy from the location slice).
 *
 * A registration after the engine started is fine: the handlers look a strategy up per call. A run for a
 * subject with no registered strategy is refused at creation (400), and a handler that meets one throws
 * so the job fails visibly instead of silently skipping.
 *
 * @extensionPoint registry
 * @stability experimental
 */
@Injectable()
export class ReviewRunSubjectRegistry {
  private readonly strategies = new Map<ReviewRunSubject, ReviewRunSubjectStrategy>();

  /**
   * Registers the strategy of one review queue. Idempotent per subject: a second call replaces the first
   * (a test module restarting a slice must not double it).
   *
   * @param strategy - the strategy.
   */
  register(strategy: ReviewRunSubjectStrategy): void {
    this.strategies.set(strategy.subject, strategy);
  }

  /**
   * The strategy of a subject.
   *
   * @param subject - the subject.
   * @returns the strategy, or undefined when none is registered.
   */
  find(subject: ReviewRunSubject): ReviewRunSubjectStrategy | undefined {
    return this.strategies.get(subject);
  }

  /**
   * The strategy of a subject.
   *
   * @param subject - the subject.
   * @throws Error when none is registered.
   */
  get(subject: ReviewRunSubject): ReviewRunSubjectStrategy {
    const strategy = this.strategies.get(subject);
    if (!strategy) throw new Error(`No review-run strategy is registered for subject ${subject}`);
    return strategy;
  }

  /** Every registered strategy. */
  all(): ReviewRunSubjectStrategy[] {
    return [...this.strategies.values()];
  }
}

/**
 * Registers a strategy; the function form of {@link ReviewRunSubjectRegistry.register}, callable from a
 * unit test without a Nest module.
 *
 * @param registry - the registry.
 * @param strategy - the strategy.
 * @stability experimental
 */
export function registerReviewRunStrategy(registry: ReviewRunSubjectRegistry, strategy: ReviewRunSubjectStrategy): void {
  registry.register(strategy);
}
