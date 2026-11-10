// =============================================================================
// Insights Controller
// =============================================================================
//
// Admin-only endpoints for the Storage Insights dashboard.
// Mounted at /api/admin/insights.
// =============================================================================

import { Controller, Get, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MemoriahubAuth } from '../core/index.js';
import { InsightsService, type InsightsMetrics, type RefreshState } from './insights.service.js';

const ADMIN_ROLE = 'admin';
const SYSTEM_SETTINGS_READ = 'system_settings:read';
const SYSTEM_SETTINGS_WRITE = 'system_settings:write';

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/**
 * The `GET /api/admin/insights` response.
 *
 * @stability experimental
 */
export interface InsightsSnapshotDto {
  status: 'ready' | 'empty';
  metrics: InsightsMetrics | null;
  computedAt: string | null;
  durationMs: number | null;
  refresh: RefreshState;
}

/**
 * The `POST /api/admin/insights/refresh` response.
 *
 * @stability experimental
 */
export interface InsightsRefreshDto {
  jobId: string;
  state: string;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Admin storage insights, mounted at `/api/admin/insights` by the host (it is not registered by `forRoot()`).
 *
 * @stability experimental
 */
@ApiTags('Admin: Storage Insights')
@Controller('admin/insights')
export class InsightsController {
  constructor(private readonly insightsService: InsightsService) {}

  // -------------------------------------------------------------------------
  // GET /admin/insights
  // -------------------------------------------------------------------------

  /** The latest snapshot (or an empty one) with the refresh job state. */
  @Get()
  @MemoriahubAuth({ roles: [ADMIN_ROLE], permissions: [SYSTEM_SETTINGS_READ] })
  @ApiOperation({ summary: 'Get latest storage insights snapshot with refresh state (Admin)' })
  @ApiResponse({
    status: 200,
    description:
      'Latest precomputed storage metrics snapshot (or empty if none exists), plus current refresh job state',
  })
  async getLatest(): Promise<InsightsSnapshotDto> {
    const [snapshot, refresh] = await Promise.all([
      this.insightsService.getLatest(),
      this.insightsService.getRefreshState(),
    ]);

    if (!snapshot) {
      return { status: 'empty', metrics: null, computedAt: null, durationMs: null, refresh };
    }

    return {
      status: 'ready',
      metrics: snapshot.metrics as unknown as InsightsMetrics,
      computedAt: snapshot.computedAt ? snapshot.computedAt.toISOString() : null,
      durationMs: snapshot.durationMs,
      refresh,
    };
  }

  // -------------------------------------------------------------------------
  // POST /admin/insights/refresh
  // -------------------------------------------------------------------------

  /** Enqueues an immediate refresh at priority 0. */
  @Post('refresh')
  @MemoriahubAuth({ roles: [ADMIN_ROLE], permissions: [SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Enqueue an immediate storage insights refresh (Admin)' })
  @ApiResponse({
    status: 201,
    description:
      'Job enqueued at highest priority (0). Returns jobId and state (pending or running if a job was already in flight).',
  })
  async refresh(): Promise<InsightsRefreshDto> {
    // Priority 0 = highest priority; pre-empts scheduled (priority 100) jobs
    const job = await this.insightsService.enqueueRefresh('rerun', 0);
    return { jobId: job.id, state: job.status };
  }
}
