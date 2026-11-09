import { Controller, Post, Param, NotFoundException, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Auth, RequestUser } from '@marinoscar/platform-api/identity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { PrismaService } from '../prisma/prisma.service';
import { OwnerAccessService } from '../platform/sharing/owner-scope';
import { ObjectReprocessService } from '../media-processing/recovery/object-reprocess.service';

/**
 * POST /api/media/:id/thumbnail/rerun
 *
 * User-facing "Retry thumbnail" action, mirroring the existing
 * POST /api/media/:id/metadata/rerun pattern (MetadataController). Runs
 * synchronously, one object inside the request, through
 * ObjectReprocessService.reprocessNow (the platform's run-processors-now API,
 * RETRO-D1b #567 open decision 1), since thumbnail generation is a few seconds
 * at most and the response reports the outcome. Bypasses the stuck-
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
    private readonly circleMembershipService: OwnerAccessService,
    private readonly recoveryService: ObjectReprocessService,
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

    await this.circleMembershipService.requireOwnerRole(
      user.id,
      mediaItem.circleId,
      user.permissions,
      'editor',
    );

    await this.recoveryService.reprocessNow(mediaItem.storageObject);

    this.logger.log(`Thumbnail rerun triggered for MediaItem ${mediaItemId} by user ${user.id}`);

    const refreshed = await this.prisma.storageObject.findUnique({
      where: { id: mediaItem.storageObject.id },
      select: { status: true },
    });

    return { data: { status: refreshed?.status ?? 'unknown' } };
  }
}
