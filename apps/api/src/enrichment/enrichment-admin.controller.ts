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
});

export class ListJobsQueryDto extends createZodDto(listJobsQuerySchema) {}

const retryAllFailedSchema = z.object({
  type: z.string().min(1).optional(),
});

export class RetryAllFailedDto extends createZodDto(retryAllFailedSchema) {}

const resetStuckSchema = z.object({
  olderThanMinutes: z.number().int().min(1).default(10).optional(),
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
      'Stats including total, byStatus breakdown, byType breakdown, stuck-running count, and scheduled (deferred/backed-off) count',
  })
  async getStats() {
    return this.adminService.getStats();
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
      'Finds running jobs whose startedAt is older than olderThanMinutes (default 10) and resets them to pending.',
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
  @ApiResponse({ status: 200, description: 'Paginated list of enrichment jobs' })
  async listJobs(@Query() query: ListJobsQueryDto) {
    return this.adminService.listJobs({
      status: query.status,
      type: query.type,
      page: query.page,
      pageSize: query.pageSize,
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
