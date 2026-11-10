import { Module, type DynamicModule } from '@nestjs/common';

import { MediaModule } from '../media/index.js';
import { ReviewRunEvaluateHandler } from './review-run-evaluate.handler.js';
import { ReviewRunExecuteBatchHandler } from './review-run-execute-batch.handler.js';
import { ReviewRunSubjectRegistry } from './review-run-subject.registry.js';
import { ReviewRunService } from './review-run.service.js';
import {
  LocationSuggestionRunEvaluateHandler,
  LocationSuggestionRunExecuteBatchHandler,
} from './shims/location-suggestion-run-shims.js';

/**
 * Options of {@link ReviewRunsModule.forRoot}. None yet: the engine is configured through the strategies the
 * review-queue owners register with {@link ReviewRunSubjectRegistry}.
 *
 * @stability experimental
 */
export interface ReviewRunsModuleOptions {
  /** Reserved. */
  readonly reserved?: never;
}

/**
 * The review-runs slice (RETRO-J9, #622): the shared async run engine behind every bulk review-queue action
 * (issue #190). It owns the run lifecycle service, the `review_run_evaluate` and `review_run_execute_batch`
 * handlers, the two deprecated `location_suggestion_run_*` shim handlers (their type strings are permanent
 * while queued rows may exist) and the strategy registry. It reaches the outside only through the host ports.
 *
 * The slice knows no review queue: the owner of each queue registers its strategy with
 * {@link ReviewRunSubjectRegistry} (`registerReviewRunStrategy`), so this slice imports neither the burst,
 * the duplicate nor the location code. `ReviewRunsController` is an exported class, not mounted by
 * `forRoot()`: the host lists it in the `controllers` of the module where its routes belong. The nightly
 * `review_run_history_purge` stays in the host, because it is bound to the platform's retention policy.
 *
 * Import it ONCE in the host (the registry and the handlers are singletons).
 *
 * @stability experimental
 */
@Module({})
export class ReviewRunsModule {
  private static root: DynamicModule | undefined;

  /**
   * Builds the module (cached, so every call names the same instance).
   *
   * @param _options - reserved.
   */
  static forRoot(_options: ReviewRunsModuleOptions = {}): DynamicModule {
    ReviewRunsModule.root ??= {
      module: ReviewRunsModule,
      imports: [MediaModule.forRoot()],
      providers: [
        ReviewRunSubjectRegistry,
        ReviewRunService,
        ReviewRunEvaluateHandler,
        ReviewRunExecuteBatchHandler,
        LocationSuggestionRunEvaluateHandler,
        LocationSuggestionRunExecuteBatchHandler,
      ],
      exports: [ReviewRunSubjectRegistry, ReviewRunService, ReviewRunEvaluateHandler, ReviewRunExecuteBatchHandler],
    };
    return ReviewRunsModule.root;
  }
}
