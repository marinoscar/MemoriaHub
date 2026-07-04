import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CircleRole } from '@prisma/client';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { FEATURE_KEYS } from '../common/types/settings.types';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { SocialMediaBackfillService } from './social-media-backfill.service';

@ApiTags('Media')
@ApiBearerAuth('JWT-auth')
@Controller('media')
export class SocialMediaMediaController {
  private readonly logger = new Logger(SocialMediaMediaController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembershipService: CircleMembershipService,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly socialMediaBackfillService: SocialMediaBackfillService,
  ) {}

  @Post(':id/social-media/rerun')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Re-run social-media detection for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 201, description: 'Social-media detection job queued' })
  @ApiResponse({ status: 400, description: 'Social-media detection is disabled globally' })
  async rerunSocialMedia(
    @Param('id') mediaItemId: string,
    @CurrentUser() user: RequestUser,
  ) {
    const enabled = await this.systemSettingsService.isFeatureEnabled(
      FEATURE_KEYS.SOCIAL_MEDIA_DETECTION,
    );
    if (!enabled) {
      throw new BadRequestException('Social-media detection is disabled globally');
    }

    await this.assertMediaItemAccess(mediaItemId, user, CircleRole.collaborator);
    const result = await this.socialMediaBackfillService.enqueueRerun(
      mediaItemId,
      user.id,
    );
    return { data: result };
  }

  @Get(':id/social-media/status')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get social-media detection status for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 200, description: 'Social-media detection status' })
  async getSocialMediaStatus(
    @Param('id') mediaItemId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertMediaItemAccess(mediaItemId, user, CircleRole.viewer);
    const status = await this.socialMediaBackfillService.getStatus(mediaItemId);
    return { data: status };
  }

  private async assertMediaItemAccess(
    mediaItemId: string,
    user: RequestUser,
    requiredRole: CircleRole = CircleRole.viewer,
  ): Promise<{ id: string; circleId: string }> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, deletedAt: true },
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

    return { id: mediaItem.id, circleId: mediaItem.circleId };
  }
}
