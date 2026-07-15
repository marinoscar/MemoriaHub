import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { JobReason, JobStatus } from '@prisma/client';
import { MediaReprocessService } from './media-reprocess.service';
import {
  StorageProcessingRecoveryService,
  StorageProcessingRecoveryResult,
} from '../storage/tasks/storage-processing-recovery.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';

const reprocessBodySchema = z.object({
  circleId: z.string().uuid().optional(),
  all: z.boolean().optional(),
});

export class ReprocessBodyDto extends createZodDto(reprocessBodySchema) {}

const reprocessStuckBodySchema = z.object({
  olderThanMinutes: z.number().int().positive().optional(),
});

export class ReprocessStuckBodyDto extends createZodDto(reprocessStuckBodySchema) {}

const reprocessFailedBodySchema = z.object({
  limit: z.number().int().positive().optional(),
});

export class ReprocessFailedBodyDto extends createZodDto(reprocessFailedBodySchema) {}

@ApiTags('Admin - Media')
@Controller('admin/media')
export class MediaReprocessController {
  constructor(
    private readonly reprocessService: MediaReprocessService,
    private readonly recoveryService: StorageProcessingRecoveryService,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('reprocess')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.STORAGE_DELETE_ANY] })
  @ApiOperation({
    summary: 'Reprocess existing media thumbnails and dimensions (Admin)',
    description:
      'Re-runs ImageDimensionsProcessor and ThumbnailProcessor for all ready/failed image and ' +
      'video StorageObjects linked to MediaItems in the given circle (circleId) or all circles ' +
      '(all:true). ImageDimensionsProcessor self-skips videos via canProcess; ThumbnailProcessor ' +
      'covers both images and videos. ' +
      'Old thumbnail blobs and StorageObject rows are deleted to prevent storage leaks.',
  })
  @ApiResponse({ status: 201, description: '{ reprocessed: number, failed: number }' })
  async reprocess(@Body() body: ReprocessBodyDto): Promise<{ reprocessed: number; failed: number }> {
    const circleId = body.circleId;
    return this.reprocessService.reprocessCircle(circleId);
  }

  @Post('reprocess-stuck')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.STORAGE_DELETE_ANY] })
  @ApiOperation({
    summary: 'Recover StorageObjects orphaned at status=processing (Admin)',
    description:
      'Finds StorageObjects stuck at status=processing (left behind when the API process was ' +
      'killed mid-pipeline — OOM, crash, or deploy) older than olderThanMinutes (default: ' +
      'STORAGE_PROCESSING_STUCK_MINUTES, currently 10) and re-runs the full processing pipeline ' +
      '(content-hash/exif/dimensions/video-probe/geocode/thumbnail/visual-hash) for each — covers ' +
      'both photos and videos. Retries are capped at STORAGE_PROCESSING_MAX_RETRIES per object; ' +
      'objects that exhaust the cap are marked status=failed instead of retried further. The same ' +
      'recovery also runs automatically every 10 minutes via StorageProcessingRecoveryTask — this ' +
      'endpoint exists to trigger it immediately without waiting for the next tick.',
  })
  @ApiResponse({ status: 201, description: '{ claimed: number, reprocessed: number, exhausted: number, errors: number }' })
  async reprocessStuck(@Body() body: ReprocessStuckBodyDto): Promise<StorageProcessingRecoveryResult> {
    return this.recoveryService.recoverStuckObjects(body.olderThanMinutes);
  }

  @Post('reprocess-failed')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.STORAGE_DELETE_ANY] })
  @ApiOperation({
    summary: 'Recover StorageObjects stuck at status=failed image objects (Admin)',
    description:
      'Finds all image StorageObjects at status=failed (most commonly HEIC/HEIF images that ' +
      'failed to decode before the ffmpeg-transcode fallback existed — issue #106) and re-runs ' +
      'the full processing pipeline for each: regenerates the thumbnail and, via ' +
      'OBJECT_PROCESSED_EVENT, re-fires face/tag/duplicate enrichment automatically. Thumbnail ' +
      "objects (under the 'thumbnails/' prefix) are excluded. Distinct from reprocess-stuck, " +
      'which targets status=processing (objects orphaned mid-pipeline by a crash) and will not ' +
      'pick these up. Optional limit bounds the batch size.',
  })
  @ApiResponse({
    status: 201,
    description: '{ claimed: number, reprocessed: number, exhausted: number, errors: number }',
  })
  async reprocessFailed(
    @Body() body: ReprocessFailedBodyDto,
  ): Promise<StorageProcessingRecoveryResult> {
    return this.recoveryService.recoverFailedImageObjects({ limit: body.limit });
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
    if (job.status === JobStatus.pending && job.priority > 0) {
      await this.prisma.enrichmentJob.update({
        where: { id: job.id },
        data: { priority: 0 },
      });
    }

    return { data: { jobId: job.id, status: job.status } };
  }
}
