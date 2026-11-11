import { Module, type DynamicModule } from '@nestjs/common';

import { MediaModule } from '../media/index.js';
import { ReviewRunsModule } from '../review-runs/index.js';
import { DedupUploadEnrichment } from './dedup-upload-enrichment.js';
import { DuplicateBackfillService } from './duplicate-backfill.service.js';
import { DuplicateConfidenceBackfillHandler } from './duplicate-confidence-backfill.handler.js';
import { DuplicateDetectionBatchHandler } from './duplicate-detection-batch.handler.js';
import { DuplicateDetectionHandler } from './duplicate-detection.handler.js';
import { DuplicateDetectionService } from './duplicate-detection.service.js';
import { DuplicateGroupReviewStrategy } from './duplicate-group.strategy.js';
import { DuplicateService } from './duplicate.service.js';
import { ReviewInsightsService } from './review-insights.service.js';
import { VisualEmbeddingService } from './visual-embedding.service.js';

/**
 * Options of {@link DedupModule.forRoot}. None yet: the CLIP model directory is `MODELS_DIR` and the
 * thresholds are the `dedup` settings namespace, both read at run time.
 *
 * @stability experimental
 */
export interface DedupModuleOptions {
  /** Reserved. */
  readonly reserved?: never;
}

/**
 * The dedup slice (RETRO-J10, #624): the CLIP visual embeddings and dHash, the two-tier near-duplicate
 * matching and union-find grouping, the `duplicate_detection`, `duplicate_detection_batch` and
 * `duplicate_confidence_backfill` jobs, the admin backfill, the upload fan-out registration, the burst and
 * duplicate review insights, and the duplicate review queue (`DuplicateService`: list with read-time kind and
 * best-copy scoring, detail, resolve, dismiss, bulk and threshold runs, per-item rerun) with the review
 * strategy it registers with the review-run engine. It reaches the outside only through the host ports.
 *
 * Import it ONCE in the host (the handlers, the registration and the strategy are singletons). The optional
 * `DUPLICATE_OBSERVER` binding (the `media.item.trashed` webhook) must come from a global module of the host.
 *
 * @stability experimental
 */
@Module({})
export class DedupModule {
  private static root: DynamicModule | undefined;

  /**
   * Builds the module (cached, so every call names the same instance).
   *
   * @param _options - reserved.
   */
  static forRoot(_options: DedupModuleOptions = {}): DynamicModule {
    DedupModule.root ??= {
      module: DedupModule,
      imports: [MediaModule.forRoot(), ReviewRunsModule.forRoot()],
      providers: [
        VisualEmbeddingService,
        DuplicateDetectionService,
        DuplicateDetectionHandler,
        DuplicateDetectionBatchHandler,
        DuplicateConfidenceBackfillHandler,
        DuplicateBackfillService,
        DedupUploadEnrichment,
        ReviewInsightsService,
        DuplicateService,
        DuplicateGroupReviewStrategy,
      ],
      exports: [
        VisualEmbeddingService,
        DuplicateDetectionService,
        DuplicateBackfillService,
        ReviewInsightsService,
        DuplicateService,
      ],
    };
    return DedupModule.root;
  }
}
