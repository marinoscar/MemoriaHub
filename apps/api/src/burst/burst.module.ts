import { Global, Module } from '@nestjs/common';
import {
  AdminBurstController,
  BURST_OBSERVER,
  BurstController,
  BurstModule as BurstSliceModule,
} from '@marinoscar/memoriahub-api/burst';

import { AppBurstObserver } from './burst-observer.adapter';

/**
 * Binds the slice's optional `BURST_OBSERVER` (the `media.item.trashed` webhook). Global because Nest resolves
 * a token only in the module that provides it or in a global module, and the slice's own module is the
 * consumer.
 */
@Global()
@Module({
  providers: [AppBurstObserver, { provide: BURST_OBSERVER, useExisting: AppBurstObserver }],
  exports: [BURST_OBSERVER],
})
export class BurstObserverModule {}

/**
 * The web app's binding of the burst slice (RETRO-J10, #624). Burst detection (BurstUUID and dHash grouping,
 * best-shot scoring), the `burst_detection` job, the upload fan-out registration, the review queue service and
 * its review-run strategy live in `@marinoscar/memoriahub-api/burst`; this module mounts the two controllers.
 * The strategy registers itself with the review-runs slice's registry, so no module here imports the other
 * way and there is no cycle.
 */
@Module({
  imports: [BurstSliceModule.forRoot(), BurstObserverModule],
  controllers: [BurstController, AdminBurstController],
  exports: [BurstSliceModule],
})
export class BurstModule {}
