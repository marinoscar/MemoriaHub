import { Module, type DynamicModule } from '@nestjs/common';

import { InsightsRefreshTask } from './insights-refresh.task.js';
import { InsightsService } from './insights.service.js';
import { StorageInsightsHandler } from './storage-insights.handler.js';

/**
 * Options of {@link InsightsModule.forRoot}. None yet.
 *
 * @stability experimental
 */
export interface InsightsModuleOptions {
  /** Reserved. */
  readonly reserved?: never;
}

/**
 * The insights slice (RETRO-J10, #624): the global storage-metrics snapshot, the
 * `storage_insights` job handler and the hourly enqueue-only refresh task. It reaches the outside
 * only through the host ports.
 *
 * @stability experimental
 */
@Module({})
export class InsightsModule {
  private static root: DynamicModule | undefined;

  /**
   * Builds the module (cached, so every call names the same instance).
   *
   * @param _options - reserved.
   */
  static forRoot(_options: InsightsModuleOptions = {}): DynamicModule {
    InsightsModule.root ??= {
      module: InsightsModule,
      providers: [InsightsService, StorageInsightsHandler, InsightsRefreshTask],
      exports: [InsightsService],
    };
    return InsightsModule.root;
  }
}
