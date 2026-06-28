import {
  Controller,
  Post,
  Get,
  Param,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CircleRole, JobReason, MediaSocialStatusType, MediaType } from '@prisma/client';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';

@ApiTags('Social Media Detection')
@ApiBearerAuth('JWT-auth')
@Controller()
export class SocialController {
  private readonly logger = new Logger(SocialController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembershipService: CircleMembershipService,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  // --------------------------------------------------------------------------
  // POST /api/media/:id/social/rerun
  // --------------------------------------------------------------------------

  @Post('media/:id/social/rerun')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Re-run social media detection for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 201, description: 'Social media detection job queued' })
  async rerunSocialDetection(
    @Param('id') mediaItemId: string,
    @CurrentUser() user: RequestUser,
  ) {
    const mediaItem = await this.assertMediaItemAccess(
      mediaItemId,
      user,
      'collaborator' as CircleRole,
    );

    // Social media detection only applies to videos — never enqueue for photos.
    if (mediaItem.type !== MediaType.video) {
      throw new BadRequestException(
        'Social media detection only applies to videos',
      );
    }

    const job = await this.enrichmentJobService.enqueue({
      type: 'social_media_detection',
      mediaItemId,
      circleId: mediaItem.circleId,
      reason: JobReason.rerun,
      priority: 0,
    });

    await this.prisma.mediaSocialStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId: mediaItem.circleId,
        status: MediaSocialStatusType.pending,
        detected: false,
      },
      update: {
        status: MediaSocialStatusType.pending,
      },
    });

    this.logger.log(
      `Rerun social media detection job ${job.id} enqueued for MediaItem ${mediaItemId} by user ${user.id}`,
    );

    return { data: { jobId: job.id, status: job.status } };
  }

  // --------------------------------------------------------------------------
  // GET /api/media/:id/social/status
  // --------------------------------------------------------------------------

  @Get('media/:id/social/status')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get social media detection status for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 200, description: 'Social media detection status' })
  async getSocialStatus(
    @Param('id') mediaItemId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertMediaItemAccess(mediaItemId, user, 'viewer' as CircleRole);

    const status = await this.prisma.mediaSocialStatus.findUnique({
      where: { mediaItemId },
    });

    if (!status) {
      return {
        data: {
          status: MediaSocialStatusType.not_processed,
          detected: false,
          platform: null,
          processedAt: null,
          lastError: null,
        },
      };
    }

    return {
      data: {
        status: status.status,
        detected: status.detected,
        platform: status.platform,
        processedAt: status.processedAt,
        lastError: status.lastError,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async assertMediaItemAccess(
    mediaItemId: string,
    user: RequestUser,
    requiredRole: CircleRole = 'viewer' as CircleRole,
  ): Promise<{ id: string; circleId: string; type: MediaType }> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, type: true, deletedAt: true },
    });

    if (!mediaItem || mediaItem.deletedAt) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    await this.circleMembershipService.assertCircleAccess(
      user.id,
      mediaItem.circleId,
      user.permissions,
      requiredRole,
    );

    return { id: mediaItem.id, circleId: mediaItem.circleId, type: mediaItem.type };
  }
}
