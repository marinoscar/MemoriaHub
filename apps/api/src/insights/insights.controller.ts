// =============================================================================
// Insights Controller
// =============================================================================
//
// Admin-only endpoints for the Storage Insights dashboard.
// Mounted at /api/admin/insights.
// =============================================================================

import { Controller, Get, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { InsightsService, InsightsMetrics } from './insights.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

export interface InsightsSnapshotDto {
  status: 'ready' | 'empty';
  metrics: InsightsMetrics | null;
  computedAt: string | null;
  durationMs: number | null;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('Admin - Insights')
@Controller('admin/insights')
export class InsightsController {
  constructor(private readonly insightsService: InsightsService) {}

  // -------------------------------------------------------------------------
  // GET /admin/insights
  // -------------------------------------------------------------------------

  @Get()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({ summary: 'Get latest storage insights snapshot (Admin)' })
  @ApiResponse({
    status: 200,
    description: 'Latest precomputed storage metrics snapshot, or empty if none exists',
  })
  async getLatest(): Promise<InsightsSnapshotDto> {
    const snapshot = await this.insightsService.getLatest();
    if (!snapshot) {
      return { status: 'empty', metrics: null, computedAt: null, durationMs: null };
    }
    return {
      status: 'ready',
      metrics: snapshot.metrics as unknown as InsightsMetrics,
      computedAt: snapshot.computedAt ? snapshot.computedAt.toISOString() : null,
      durationMs: snapshot.durationMs,
    };
  }

  // -------------------------------------------------------------------------
  // POST /admin/insights/refresh
  // -------------------------------------------------------------------------

  @Post('refresh')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Force-recompute the storage insights snapshot (Admin)' })
  @ApiResponse({
    status: 201,
    description: 'Freshly computed storage metrics snapshot',
  })
  async refresh(): Promise<InsightsSnapshotDto> {
    const snapshot = await this.insightsService.recompute();
    return {
      status: 'ready',
      metrics: snapshot.metrics as unknown as InsightsMetrics,
      computedAt: snapshot.computedAt ? snapshot.computedAt.toISOString() : null,
      durationMs: snapshot.durationMs,
    };
  }
}
