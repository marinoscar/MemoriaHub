// =============================================================================
// Enrichment Admin Controller
// =============================================================================
//
// Admin-only endpoints for the enrichment job queue dashboard.
// Mounted at /api/admin/jobs.
// =============================================================================

import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { JobStatus } from '@prisma/client';
import { EnrichmentAdminService } from './enrichment-admin.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';

// ---------------------------------------------------------------------------
// DTOs (Zod — matches project convention from conversations controller)
// ---------------------------------------------------------------------------

const listJobsQuerySchema = z.object({
  status: z
    .enum([JobStatus.pending, JobStatus.running, JobStatus.succeeded, JobStatus.failed])
    .optional(),
  type: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  // Parse the string 'true' → boolean true; absent or any other value → undefined
  scheduled: z
    .string()
    .optional()
    .transform((v) => (v === 'true' ? true : undefined)),
  processedWithin: z.enum(['4h', '24h', '7d', '30d', 'all']).optional(),
});

export class ListJobsQueryDto extends createZodDto(listJobsQuerySchema) {}

const jobInsightsQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(90).default(7),
});

export class JobInsightsQueryDto extends createZodDto(jobInsightsQuerySchema) {}

const retryAllFailedSchema = z.object({
  type: z.string().min(1).optional(),
});

export class RetryAllFailedDto extends createZodDto(retryAllFailedSchema) {}

// olderThanMinutes deliberately has NO default: an empty body lets the service
// resolve the jobs.stuckThresholdMinutes system setting (default 3 minutes).
const resetStuckSchema = z.object({
  olderThanMinutes: z.number().int().min(1).optional(),
});

export class ResetStuckDto extends createZodDto(resetStuckSchema) {}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('Admin - Jobs')
@Controller('admin/jobs')
export class EnrichmentAdminController {
  constructor(private readonly adminService: EnrichmentAdminService) {}

  // -------------------------------------------------------------------------
  // GET /admin/jobs/stats
  // -------------------------------------------------------------------------

  @Get('stats')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_READ] })
  @ApiOperation({ summary: 'Get enrichment job queue statistics (Admin)' })
  @ApiResponse({
    status: 200,
    description:
      'Stats including total, byStatus breakdown, byType breakdown, stuck-running count (with the ' +
      'effective stuckThresholdMinutes used), and scheduled (deferred/backed-off) count',
  })
  async getStats() {
    return this.adminService.getStats();
  }

  // -------------------------------------------------------------------------
  // GET /admin/jobs/insights  (before :id to avoid route conflicts)
  // -------------------------------------------------------------------------

  @Get('insights')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_READ] })
  @ApiOperation({
    summary: 'Get job queue insights + ETA (Admin)',
    description:
      'On-demand, read-only aggregate: live counts, per-type and overall ' +
      'duration history (avg/p50/p95 over a rolling window), throughput, and an ' +
      'estimated time to completion (ETC) for the current backlog. Computed only ' +
      'when requested — no polling. Queries take only ACCESS SHARE locks and do ' +
      'not block the worker.',
  })
  @ApiQuery({
    name: 'windowDays',
    required: false,
    description: 'Rolling window (days) for the duration-history aggregate (default 7, max 90)',
  })
  @ApiResponse({ status: 200, description: 'Job insights snapshot incl. overall + per-type ETC and avg duration' })
  async getInsights(@Query() query: JobInsightsQueryDto) {
    return this.adminService.getInsights(query.windowDays);
  }

  // -------------------------------------------------------------------------
  // POST /admin/jobs/insights/reset-history  (before :id to avoid route conflicts)
  // -------------------------------------------------------------------------

  @Post('insights/reset-history')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({
    summary: 'Reset lifetime job history analytics (Admin)',
    description:
      'Clears the JobStatsRollup table (the all-time aggregate of purged job rows). ' +
      'Live job rows are unaffected. Use to start lifetime analytics fresh.',
  })
  @ApiResponse({ status: 201, description: 'Number of per-type rollup rows cleared' })
  async resetHistory() {
    return this.adminService.resetHistory();
  }

  // -------------------------------------------------------------------------
  // POST /admin/jobs/retry-failed  (before :id to avoid route conflicts)
  // -------------------------------------------------------------------------

  @Post('retry-failed')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({
    summary: 'Bulk-retry all failed enrichment jobs (Admin)',
    description: 'Resets ALL failed jobs to pending. Optionally filter by type.',
  })
  @ApiResponse({ status: 201, description: 'Number of jobs reset to pending' })
  async retryAllFailed(@Body() dto: RetryAllFailedDto) {
    return this.adminService.retryAllFailed(dto.type);
  }

  // -------------------------------------------------------------------------
  // POST /admin/jobs/reset-stuck  (before :id to avoid route conflicts)
  // -------------------------------------------------------------------------

  @Post('reset-stuck')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({
    summary: 'Reset stuck running enrichment jobs back to pending (Admin)',
    description:
      'Finds running jobs stuck past olderThanMinutes (including zombie rows that were never ' +
      'stamped with startedAt, aged by createdAt) and resets them to pending. When ' +
      'olderThanMinutes is omitted, the jobs.stuckThresholdMinutes system setting is used ' +
      '(default 3 minutes).',
  })
  @ApiResponse({ status: 201, description: 'Number of jobs reset' })
  async resetStuck(@Body() dto: ResetStuckDto) {
    return this.adminService.resetStuck(dto.olderThanMinutes);
  }

  // -------------------------------------------------------------------------
  // GET /admin/jobs
  // -------------------------------------------------------------------------

  @Get()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_READ] })
  @ApiOperation({ summary: 'List enrichment jobs with optional filters (Admin)' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [JobStatus.pending, JobStatus.running, JobStatus.succeeded, JobStatus.failed],
    description: 'Filter by job status',
  })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by job type string' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number (default 1)' })
  @ApiQuery({ name: 'pageSize', required: false, description: 'Page size 1–100 (default 20)' })
  @ApiQuery({
    name: 'scheduled',
    required: false,
    type: String,
    enum: ['true'],
    description:
      'When "true", return only pending jobs currently deferred via backoff (scheduledFor > now). ' +
      'Forces status=pending; the status filter is ignored when this param is set.',
  })
  @ApiQuery({
    name: 'processedWithin',
    required: false,
    enum: ['4h', '24h', '7d', '30d', 'all'],
    description:
      'Filter jobs by activity time: COALESCE(finishedAt, createdAt) >= now - window. ' +
      '"all" (or omitted) applies no time filter.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of enrichment jobs' })
  async listJobs(@Query() query: ListJobsQueryDto) {
    return this.adminService.listJobs({
      status: query.status,
      type: query.type,
      page: query.page,
      pageSize: query.pageSize,
      scheduled: query.scheduled,
      processedWithin: query.processedWithin,
    });
  }

  // -------------------------------------------------------------------------
  // POST /admin/jobs/:id/retry
  // -------------------------------------------------------------------------

  @Post(':id/retry')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({ summary: 'Retry a single failed or succeeded enrichment job (Admin)' })
  @ApiParam({ name: 'id', description: 'Enrichment job UUID' })
  @ApiResponse({ status: 201, description: 'Job reset to pending' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  @ApiResponse({ status: 400, description: 'Job is currently running' })
  async retryJob(@Param('id') id: string) {
    return this.adminService.retryJob(id);
  }

  // -------------------------------------------------------------------------
  // DELETE /admin/jobs/:id
  // -------------------------------------------------------------------------

  @Delete(':id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({ summary: 'Delete an enrichment job row (Admin)' })
  @ApiParam({ name: 'id', description: 'Enrichment job UUID' })
  @ApiResponse({ status: 200, description: 'Job deleted' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  @ApiResponse({ status: 400, description: 'Job is currently running' })
  async deleteJob(@Param('id') id: string) {
    return this.adminService.deleteJob(id);
  }
}
