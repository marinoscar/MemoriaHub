// =============================================================================
// storage_insights: recompute the global storage-metrics snapshot
// =============================================================================
//
// A native platform `JobHandler` (RETRO-C8, #608). GLOBAL (no subject): the
// facade enqueues it with no media item and no circle, so the platform dedup
// keeps at most one active row (the cron at priority 100, a manual refresh at
// priority 0). `GET /api/admin/insights` reads the refresh state off the newest
// `jobs` row of this type (`InsightsService.getRefreshState`).
//
// SERVER-ONLY: no node-result pair (a set of aggregate queries over the whole
// library; nothing for a node without database access to compute).
// =============================================================================

import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, type JobExecutionProfile, type JobHandler } from '@marinoscar/platform-api/jobs';

import { InsightsService } from './insights.service';

@Injectable()
export class StorageInsightsHandler implements JobHandler, OnModuleInit {
  readonly type = 'storage_insights';

  readonly label = 'Storage insights';

  /** A handful of aggregate scans: 15 minutes, three attempts. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 900_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly insights: InsightsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(): Promise<void> {
    // metrics: RETRO-T3 (app.storage.bytes gauge source: the snapshot's totalBytes)
    await this.insights.runComputation();
  }
}
