import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MediaReprocessService } from './media-reprocess.service';
import {
  StorageProcessingRecoveryService,
  StorageProcessingRecoveryResult,
} from '../storage/tasks/storage-processing-recovery.service';
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

@ApiTags('Admin - Media')
@Controller('admin/media')
export class MediaReprocessController {
  constructor(
    private readonly reprocessService: MediaReprocessService,
    private readonly recoveryService: StorageProcessingRecoveryService,
  ) {}

  @Post('reprocess')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.STORAGE_DELETE_ANY] })
  @ApiOperation({
    summary: 'Reprocess existing media thumbnails and dimensions (Admin)',
    description:
      'Re-runs ImageDimensionsProcessor and ThumbnailProcessor for all ready image StorageObjects ' +
      'linked to MediaItems in the given circle (circleId) or all circles (all:true). ' +
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
}
