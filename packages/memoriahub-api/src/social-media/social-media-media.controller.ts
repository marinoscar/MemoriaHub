import {
  BadRequestException,
  Controller,
  Get,
  Inject,
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

import { MemoriahubAuth, MemoriahubCurrentUser, isFeatureEnabled, type MemoriahubRequestUser } from '../core/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubAccessPort,
  type MemoriahubScopeRole,
  type MemoriahubSettingsPort,
} from '../ports/index.js';
import { SOCIAL_MEDIA_PERMISSIONS as PERMISSIONS } from './constants.js';
import type { SocialMediaDb } from './data/social-media-db.js';
import { SocialMediaBackfillService } from './social-media-backfill.service.js';

/**
 * `POST /api/media/:id/social-media/rerun` and `GET /api/media/:id/social-media/status`; mounted by the
 * host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Media')
@ApiBearerAuth('JWT-auth')
@Controller('media')
export class SocialMediaMediaController {
  private readonly logger = new Logger(SocialMediaMediaController.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: SocialMediaDb,
    @Inject(MEMORIAHUB_ACCESS) private readonly access: MemoriahubAccessPort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly socialMediaBackfillService: SocialMediaBackfillService,
  ) {}

  /**
   * Re-runs social-media detection for one media item (priority 0).
   *
   * @param mediaItemId - the item.
   * @param user - the caller.
   * @returns the queued job.
   */
  @Post(':id/social-media/rerun')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Re-run social-media detection for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 201, description: 'Social-media detection job queued' })
  @ApiResponse({ status: 400, description: 'Social-media detection is disabled globally' })
  async rerunSocialMedia(
    @Param('id') mediaItemId: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    const enabled = await isFeatureEnabled(this.settings, 'socialMediaDetection');
    if (!enabled) {
      throw new BadRequestException('Social-media detection is disabled globally');
    }

    await this.assertMediaItemAccess(mediaItemId, user, 'editor');
    const result = await this.socialMediaBackfillService.enqueueRerun(
      mediaItemId,
      user.id,
    );
    return { data: result };
  }

  /**
   * Reads one media item's detection status.
   *
   * @param mediaItemId - the item.
   * @param user - the caller.
   * @returns the status.
   */
  @Get(':id/social-media/status')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get social-media detection status for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 200, description: 'Social-media detection status' })
  async getSocialMediaStatus(
    @Param('id') mediaItemId: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    await this.assertMediaItemAccess(mediaItemId, user, 'viewer');
    const status = await this.socialMediaBackfillService.getStatus(mediaItemId);
    return { data: status };
  }

  private async assertMediaItemAccess(
    mediaItemId: string,
    user: MemoriahubRequestUser,
    requiredRole: MemoriahubScopeRole = 'viewer',
  ): Promise<{ id: string; circleId: string }> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, deletedAt: true },
    });

    if (!mediaItem || mediaItem.deletedAt) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    await this.access.requireOwnerRole(
      user.id,
      mediaItem.circleId,
      user.permissions,
      requiredRole,
    );

    return { id: mediaItem.id, circleId: mediaItem.circleId };
  }
}
