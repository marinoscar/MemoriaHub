import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { JobReason, MhLegacyJobStatus } from '@prisma/client';
import { JobsService, type Job } from '@marinoscar/platform-api/jobs';
import {
  STORAGE_RECOVER_STUCK_TYPE,
  STORAGE_REPROCESS_TYPE,
} from '../media-processing/recovery/storage-recovery.constants';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';
import { Auth } from '@marinoscar/platform-api/identity';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { reprocessBodySchema, reprocessStuckBodySchema, reprocessFailedBodySchema } from '@marinoscar/memoriahub-contract/media';

// .default({}) on all three so a bodyless POST parses as {} — see issue #289
// (app.module.ts).

export class ReprocessBodyDto extends createZodDto(reprocessBodySchema) {}


export class ReprocessStuckBodyDto extends createZodDto(reprocessStuckBodySchema) {}


export class ReprocessFailedBodyDto extends createZodDto(reprocessFailedBodySchema) {}

@ApiTags('Admin: Media Recovery')
@Controller('admin/media')
export class MediaReprocessController {
  constructor(
    private readonly jobs: JobsService,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('reprocess')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.STORAGE_DELETE_ANY] })
  @ApiOperation({
    summary: 'Queue reprocessing of existing media objects (Admin)',
    description:
      'Enqueues a media.storage.reprocess job (RETRO-D1b) and returns at once. The job queues the ' +
      'platform storage.object.process job, at background priority, for every ready/failed image ' +
      'and video StorageObject behind the live MediaItems of the given circle (circleId) or of every ' +
      'circle (all:true or no circleId): the full pipeline re-runs, regenerating thumbnails and ' +
      'dimensions. One job per circle (and one for all) is in flight at a time; a repeat request ' +
      "returns that job's id. Follow it in /admin/settings/jobs.",
  })
  @ApiResponse({ status: 201, description: '{ data: { jobId: string, status: string } }' })
  async reprocess(@Body() body: ReprocessBodyDto): Promise<{ data: { jobId: string; status: string } }> {
    const circleId = body.circleId;
    const job = await this.jobs.enqueue({
      type: STORAGE_REPROCESS_TYPE,
      reason: 'rerun',
      // One in flight per circle, and one for the whole library.
      ...(circleId ? { subjectType: 'circle', subjectId: circleId } : {}),
      payload: circleId ? { circleId } : {},
      orgId: null,
      priority: 0,
    });
    return { data: { jobId: job.id, status: job.status } };
  }

  @Post('reprocess-stuck')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.STORAGE_DELETE_ANY] })
  @ApiOperation({
    summary: 'Recover StorageObjects orphaned at status=processing (Admin)',
    description:
      'Enqueues the media.storage.recover_stuck job (mode stuck) at priority 0 and returns at once ' +
      '(RETRO-D1b). The job finds StorageObjects stuck at status=processing (left behind when a ' +
      'process was killed mid-pipeline) older than olderThanMinutes (default: ' +
      'STORAGE_PROCESSING_STUCK_MINUTES, 10) that have no live storage.object.process job, and ' +
      're-queues that job for each. Retries are capped at STORAGE_PROCESSING_MAX_RETRIES per object; ' +
      'objects that exhaust the cap are marked status=failed. The same job runs every 10 minutes ' +
      '(StorageRecoveryTask); when one is already pending or running its id is returned instead ' +
      '(a pending one is promoted to priority 0, and keeps its own olderThanMinutes).',
  })
  @ApiResponse({ status: 201, description: '{ data: { jobId: string, status: string } }' })
  async reprocessStuck(
    @Body() body: ReprocessStuckBodyDto,
  ): Promise<{ data: { jobId: string; status: string } }> {
    // No subject: collapses onto the cron's in-flight job of the same type.
    const job = await this.jobs.enqueue({
      type: STORAGE_RECOVER_STUCK_TYPE,
      reason: 'rerun',
      payload: { mode: 'stuck', ...(body.olderThanMinutes ? { olderThanMinutes: body.olderThanMinutes } : {}) },
      orgId: null,
      priority: 0,
    });
    await this.promoteIfWaiting(job);
    return { data: { jobId: job.id, status: job.status } };
  }

  @Post('reprocess-failed')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.STORAGE_DELETE_ANY] })
  @ApiOperation({
    summary: 'Recover image StorageObjects stuck at status=failed (Admin)',
    description:
      'Enqueues the media.storage.recover_stuck job (mode failed) and returns at once (RETRO-D1b). ' +
      'The job finds image StorageObjects at status=failed (most commonly HEIC/HEIF images that ' +
      'failed to decode before the ffmpeg-transcode fallback existed, issue #106), resets each to ' +
      'processing and queues the platform storage.object.process job: the thumbnail regenerates and, ' +
      'via OBJECT_PROCESSED_EVENT, face/tag/duplicate enrichment re-fires. Thumbnail objects ' +
      "(under 'thumbnails/') are excluded. Distinct from reprocess-stuck (status=processing). " +
      'Optional limit bounds how many objects one job re-queues.',
  })
  @ApiResponse({ status: 201, description: '{ data: { jobId: string, status: string } }' })
  async reprocessFailed(
    @Body() body: ReprocessFailedBodyDto,
  ): Promise<{ data: { jobId: string; status: string } }> {
    const job = await this.jobs.enqueue({
      type: STORAGE_RECOVER_STUCK_TYPE,
      reason: 'rerun',
      // Its own dedup slot: a failed-mode request never collapses onto a stuck-mode job.
      subjectType: 'system',
      subjectId: 'failed',
      payload: { mode: 'failed', ...(body.limit ? { limit: body.limit } : {}) },
      orgId: null,
      priority: 0,
    });
    return { data: { jobId: job.id, status: job.status } };
  }

  @Post('thumbnails/repair')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.STORAGE_DELETE_ANY] })
  @ApiOperation({
    summary: 'Trigger a thumbnail repair sweep now (Admin)',
    description:
      'Enqueues a thumbnail_repair enrichment job at priority 0 (highest — an explicit admin ' +
      'request to drain the missing-thumbnail backlog now, pre-empting the hourly ' +
      'ThumbnailRepairTask cron which enqueues at priority 100). The sweep finds media items ' +
      'whose thumbnail never landed even though their StorageObject reached ready/failed, and ' +
      'repairs them via cheap metadata resync or a full pipeline reprocess (see ' +
      'ThumbnailRepairHandler). If a thumbnail_repair job is already pending or running, that ' +
      "existing job's id is returned instead of enqueueing a duplicate; a pending job waiting at " +
      'a lower priority is promoted to priority 0 (running jobs are left untouched).',
  })
  @ApiResponse({ status: 201, description: '{ data: { jobId: string, status: string } }' })
  async repairThumbnails(): Promise<{ data: { jobId: string; status: string } }> {
    // Dedup is handled inside EnrichmentJobService.enqueue: for global jobs
    // (mediaItemId: null) it returns the existing pending/running job of the
    // same type instead of creating a duplicate row.
    const job = await this.enrichmentJobService.enqueue({
      type: 'thumbnail_repair',
      mediaItemId: null,
      circleId: null,
      reason: JobReason.rerun,
      priority: 0, // highest — explicit admin request
    });

    // If dedup returned an existing job still waiting in the queue at a lower
    // priority (e.g. the hourly cron enqueues at 100), promote it to 0 — an
    // explicit admin request should pre-empt the queue. Running jobs are left
    // untouched (they are already being worked on).
    if (job.status === MhLegacyJobStatus.pending && job.priority > 0) {
      await this.prisma.job.update({
        where: { id: job.id },
        data: { priority: 0 },
      });
    }

    return { data: { jobId: job.id, status: job.status } };
  }

  /**
   * A dedup hit returns the job already in flight. A pending one waiting at a
   * lower priority (the cron's 100) is promoted to 0: an explicit admin request
   * pre-empts the queue. A running one is left alone.
   */
  private async promoteIfWaiting(job: Job): Promise<void> {
    if (job.status === 'pending' && job.priority > 0) {
      await this.prisma.job.update({ where: { id: job.id }, data: { priority: 0 } });
    }
  }
}
