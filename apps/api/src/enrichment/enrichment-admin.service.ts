// =============================================================================
// Enrichment Admin Service
// =============================================================================
//
// Admin-only service for inspecting and managing the enrichment job queue.
// Provides stats, paginated listing, retry/reset operations, and deletion.
// =============================================================================

import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { Prisma, JobStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const STUCK_RUNNING_MINUTES = 10;

// ---------------------------------------------------------------------------
// Return shape interfaces
// ---------------------------------------------------------------------------

export interface JobStatsByType {
  type: string;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  total: number;
}

export interface JobStats {
  total: number;
  byStatus: {
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
  };
  byType: JobStatsByType[];
  stuckRunning: number;
  /** Number of pending jobs currently deferred (scheduledFor > now). */
  scheduled: number;
}

export interface JobListItem {
  id: string;
  type: string;
  status: JobStatus;
  reason: string;
  priority: number;
  mediaItemId: string | null;
  circleId: string | null;
  attempts: number;
  lastError: string | null;
  providerKey: string | null;
  modelVersion: string | null;
  payload: Prisma.JsonValue | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface JobListResult {
  items: JobListItem[];
  meta: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export interface ListJobsFilter {
  status?: JobStatus;
  type?: string;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class EnrichmentAdminService {
  private readonly logger = new Logger(EnrichmentAdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // getStats
  // -------------------------------------------------------------------------

  async getStats(): Promise<JobStats> {
    const stuckThreshold = new Date(Date.now() - STUCK_RUNNING_MINUTES * 60 * 1000);

    const now = new Date();

    const [statusGroups, typeStatusGroups, stuckCount, scheduledCount] = await Promise.all([
      // Count per status
      this.prisma.enrichmentJob.groupBy({
        by: ['status'],
        _count: { id: true },
      }),
      // Count per (type, status)
      this.prisma.enrichmentJob.groupBy({
        by: ['type', 'status'],
        _count: { id: true },
      }),
      // Count stuck running jobs
      this.prisma.enrichmentJob.count({
        where: {
          status: JobStatus.running,
          startedAt: { lt: stuckThreshold },
        },
      }),
      // Count pending jobs that are backed off (scheduledFor in the future)
      this.prisma.enrichmentJob.count({
        where: {
          status: JobStatus.pending,
          scheduledFor: { gt: now },
        },
      }),
    ]);

    // Build byStatus map
    const byStatus = {
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
    };
    let total = 0;

    for (const row of statusGroups) {
      const count = row._count.id;
      total += count;
      if (row.status === JobStatus.pending) byStatus.pending = count;
      else if (row.status === JobStatus.running) byStatus.running = count;
      else if (row.status === JobStatus.succeeded) byStatus.succeeded = count;
      else if (row.status === JobStatus.failed) byStatus.failed = count;
    }

    // Build byType array — collect all types first
    const typeMap = new Map<string, JobStatsByType>();
    for (const row of typeStatusGroups) {
      const { type, status } = row;
      const count = row._count.id;

      if (!typeMap.has(type)) {
        typeMap.set(type, { type, pending: 0, running: 0, succeeded: 0, failed: 0, total: 0 });
      }

      const entry = typeMap.get(type)!;
      entry.total += count;
      if (status === JobStatus.pending) entry.pending = count;
      else if (status === JobStatus.running) entry.running = count;
      else if (status === JobStatus.succeeded) entry.succeeded = count;
      else if (status === JobStatus.failed) entry.failed = count;
    }

    const byType = Array.from(typeMap.values()).sort((a, b) => a.type.localeCompare(b.type));

    return { total, byStatus, byType, stuckRunning: stuckCount, scheduled: scheduledCount };
  }

  // -------------------------------------------------------------------------
  // listJobs
  // -------------------------------------------------------------------------

  async listJobs(filter: ListJobsFilter): Promise<JobListResult> {
    const { status, type, page, pageSize } = filter;
    const skip = (page - 1) * pageSize;

    const where = {
      ...(status !== undefined ? { status } : {}),
      ...(type !== undefined ? { type } : {}),
    };

    const [items, totalItems] = await Promise.all([
      this.prisma.enrichmentJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          type: true,
          status: true,
          reason: true,
          priority: true,
          mediaItemId: true,
          circleId: true,
          attempts: true,
          lastError: true,
          providerKey: true,
          modelVersion: true,
          payload: true,
          createdAt: true,
          startedAt: true,
          finishedAt: true,
        },
      }),
      this.prisma.enrichmentJob.count({ where }),
    ]);

    return {
      items,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  // -------------------------------------------------------------------------
  // retryJob
  // -------------------------------------------------------------------------

  async retryJob(id: string): Promise<JobListItem> {
    const job = await this.prisma.enrichmentJob.findUnique({ where: { id } });

    if (!job) {
      throw new NotFoundException(`EnrichmentJob ${id} not found`);
    }

    if (job.status === JobStatus.running) {
      throw new BadRequestException(
        `EnrichmentJob ${id} is currently running and cannot be retried`,
      );
    }

    const updated = await this.prisma.enrichmentJob.update({
      where: { id },
      data: {
        status: JobStatus.pending,
        attempts: 0,
        lastError: null,
        startedAt: null,
        finishedAt: null,
        scheduledFor: null,
        rateLimitHits: 0,
      },
      select: {
        id: true,
        type: true,
        status: true,
        reason: true,
        priority: true,
        mediaItemId: true,
        circleId: true,
        attempts: true,
        lastError: true,
        providerKey: true,
        modelVersion: true,
        payload: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
      },
    });

    this.logger.log(`EnrichmentJob ${id} reset to pending by admin`);
    return updated;
  }

  // -------------------------------------------------------------------------
  // retryAllFailed
  // -------------------------------------------------------------------------

  async retryAllFailed(type?: string): Promise<{ retried: number }> {
    const where = {
      status: JobStatus.failed,
      ...(type !== undefined ? { type } : {}),
    };

    const result = await this.prisma.enrichmentJob.updateMany({
      where,
      data: {
        status: JobStatus.pending,
        attempts: 0,
        lastError: null,
        startedAt: null,
        finishedAt: null,
        scheduledFor: null,
        rateLimitHits: 0,
      },
    });

    this.logger.log(
      `Admin bulk-retried ${result.count} failed enrichment jobs${type ? ` of type="${type}"` : ''}`,
    );

    return { retried: result.count };
  }

  // -------------------------------------------------------------------------
  // resetStuck
  // -------------------------------------------------------------------------

  async resetStuck(olderThanMinutes = STUCK_RUNNING_MINUTES): Promise<{ reset: number }> {
    const threshold = new Date(Date.now() - olderThanMinutes * 60 * 1000);

    const result = await this.prisma.enrichmentJob.updateMany({
      where: {
        status: JobStatus.running,
        startedAt: { lt: threshold },
      },
      data: {
        status: JobStatus.pending,
        startedAt: null,
        scheduledFor: null,
      },
    });

    this.logger.log(
      `Admin reset ${result.count} stuck enrichment jobs (older than ${olderThanMinutes} minutes)`,
    );

    return { reset: result.count };
  }

  // -------------------------------------------------------------------------
  // deleteJob
  // -------------------------------------------------------------------------

  async deleteJob(id: string): Promise<{ deleted: true }> {
    const job = await this.prisma.enrichmentJob.findUnique({ where: { id } });

    if (!job) {
      throw new NotFoundException(`EnrichmentJob ${id} not found`);
    }

    if (job.status === JobStatus.running) {
      throw new BadRequestException(
        `EnrichmentJob ${id} is currently running and cannot be deleted`,
      );
    }

    await this.prisma.enrichmentJob.delete({ where: { id } });

    this.logger.log(`EnrichmentJob ${id} deleted by admin`);
    return { deleted: true };
  }
}
