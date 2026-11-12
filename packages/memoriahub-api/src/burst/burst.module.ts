import { Module, type DynamicModule } from '@nestjs/common';

import { DedupModule } from '../dedup/index.js';
import { MediaModule } from '../media/index.js';
import { ReviewRunsModule } from '../review-runs/index.js';
import { BurstDetectionHandler } from './burst-detection.handler.js';
import { BurstDetectionService } from './burst-detection.service.js';
import { BurstGroupReviewStrategy } from './burst-group.strategy.js';
import { BurstUploadEnrichment } from './burst-upload-enrichment.js';
import { BurstService } from './burst.service.js';
import { BurstReviewQueueCounter } from './burst-review-queue.counter.js';
import { BurstConfigDoctorCheck } from './doctor/burst-config.doctor-check.js';

/**
 * Options of {@link BurstModule.forRoot}. None yet: the thresholds are the `burst` settings namespace, read
 * at run time, and the optional `BURST_OBSERVER` binding is the host's.
 *
 * @stability experimental
 */
export interface BurstModuleOptions {
  /** Reserved. */
  readonly reserved?: never;
}

/**
 * The burst slice (RETRO-J10, #624): burst photo detection (Apple BurstUUID, same-device temporal proximity
 * and dHash distance, union-find grouping, best-shot scoring, group cohesion confidence), the
 * `burst_detection` job, the upload fan-out registration (priority 5, ahead of duplicate detection so burst
 * wins), the review queue service (list, detail, resolve, dismiss, bulk and threshold runs, the admin
 * backfill) and the burst review strategy it registers with the review-run engine. It reaches the outside
 * only through the host ports.
 *
 * The two controllers (`BurstController`, `AdminBurstController`) are exported classes, not mounted by
 * `forRoot()`: the host lists them in the `controllers` of the module where its routes belong.
 *
 * Import it ONCE in the host (the handler, the registration and the strategy are singletons). The host
 * binds `BURST_OBSERVER` from a global module (Nest resolves a token only in the module that
 * provides it, or in a global one).
 *
 * @stability experimental
 */
@Module({})
export class BurstModule {
  private static root: DynamicModule | undefined;

  /**
   * Builds the module (cached, so every call names the same instance).
   *
   * @param _options - reserved.
   */
  static forRoot(_options: BurstModuleOptions = {}): DynamicModule {
    BurstModule.root ??= {
      module: BurstModule,
      imports: [MediaModule.forRoot(), DedupModule.forRoot(), ReviewRunsModule.forRoot()],
      providers: [
        BurstUploadEnrichment,
        BurstService,
        BurstDetectionService,
        BurstDetectionHandler,
        BurstGroupReviewStrategy,
        BurstConfigDoctorCheck,
        BurstReviewQueueCounter,
      ],
      exports: [BurstService, BurstDetectionService],
    };
    return BurstModule.root;
  }
}
