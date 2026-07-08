import { Controller, Post, Param, NotFoundException, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { CircleRole } from '@prisma/client';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { StorageProcessingRecoveryService } from '../storage/tasks/storage-processing-recovery.service';

/**
 * POST /api/media/:id/thumbnail/rerun
 *
 * User-facing "Retry thumbnail" action, mirroring the existing
 * POST /api/media/:id/metadata/rerun pattern (MetadataController). Runs
 * synchronously (like MediaReprocessService.reprocessImageObject) rather than
 * via the enrichment_jobs queue, since thumbnail generation is a few seconds
 * at most and there is no existing job type for it. Bypasses the stuck-
 * threshold/retry-cap that gates the automatic recovery cron — an explicit
 * user request should always get a fresh attempt.
 */
@ApiTags('Media')
@ApiBearerAuth('JWT-auth')
@Controller()
export class MediaThumbnailRerunController {
  private readonly logger = new Logger(MediaThumbnailRerunController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembershipService: CircleMembershipService,
    private readonly recoveryService: StorageProcessingRecoveryService,
  ) {}

  @Post('media/:id/thumbnail/rerun')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Re-run thumbnail generation for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 201, description: '{ status: "ready" | "failed" }' })
  async rerunThumbnail(
    @Param('id') mediaItemId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<{ data: { status: string } }> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, deletedAt: true, storageObject: true },
    });

    if (!mediaItem || mediaItem.deletedAt || !mediaItem.storageObject) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    await this.circleMembershipService.assertCircleAccess(
      user.id,
      mediaItem.circleId,
      user.permissions,
      'collaborator' as CircleRole,
    );

    await this.recoveryService.reprocessObjectNow(mediaItem.storageObject);

    this.logger.log(`Thumbnail rerun triggered for MediaItem ${mediaItemId} by user ${user.id}`);

    const refreshed = await this.prisma.storageObject.findUnique({
      where: { id: mediaItem.storageObject.id },
      select: { status: true },
    });

    return { data: { status: refreshed?.status ?? 'unknown' } };
  }
}
