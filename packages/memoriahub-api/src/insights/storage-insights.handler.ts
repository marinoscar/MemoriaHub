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

import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import {
  MEMORIAHUB_JOBS,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
} from '../ports/index.js';
import { InsightsService } from './insights.service.js';

/**
 * Recomputes the global storage-metrics snapshot.
 *
 * @stability experimental
 */
@Injectable()
export class StorageInsightsHandler implements MemoriahubJobHandler, OnModuleInit {
  /** The job type. Permanent. */
  readonly type = 'storage_insights';

  /** The label in the admin job list. */
  readonly label = 'Storage insights';

  /** A handful of aggregate scans: 15 minutes, three attempts. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 900_000, maxAttempts: 3 };

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    private readonly insights: InsightsService,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /** Runs one attempt. */
  async process(): Promise<void> {
    // The snapshot is the source of the `app.storage.bytes` / `app.storage.trash.bytes` gauges (RETRO-T3).
    await this.insights.runComputation();
  }
}
