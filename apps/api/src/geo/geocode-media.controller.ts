import {
  Controller,
  Post,
  Get,
  Param,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Auth, RequestUser } from '@marinoscar/platform-api/identity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { PrismaService } from '../prisma/prisma.service';
import { OwnerAccessService, type OwnerRole } from '../platform/sharing/owner-scope';
import { GeocodeBackfillService } from './geocode-backfill.service';

@ApiTags('Media')
@ApiBearerAuth('JWT-auth')
@Controller('media')
export class GeocodeMediaController {
  private readonly logger = new Logger(GeocodeMediaController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembershipService: OwnerAccessService,
    private readonly geocodeBackfillService: GeocodeBackfillService,
  ) {}

  @Post(':id/geocode/rerun')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Re-run geocoding for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 201, description: 'Geocode job queued' })
  async rerunGeocode(
    @Param('id') mediaItemId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertMediaItemAccess(mediaItemId, user, 'editor');
    const result = await this.geocodeBackfillService.enqueueRerun(mediaItemId, user.id);
    return { data: result };
  }

  @Get(':id/geocode/status')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get geocode status for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 200, description: 'Geocode status' })
  async getGeocodeStatus(
    @Param('id') mediaItemId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertMediaItemAccess(mediaItemId, user, 'viewer');
    const status = await this.geocodeBackfillService.getStatus(mediaItemId);
    return { data: status };
  }

  private async assertMediaItemAccess(
    mediaItemId: string,
    user: RequestUser,
    requiredRole: OwnerRole = 'viewer',
  ): Promise<{ id: string; circleId: string }> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, deletedAt: true },
    });

    if (!mediaItem || mediaItem.deletedAt) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    await this.circleMembershipService.requireOwnerRole(
      user.id,
      mediaItem.circleId,
      user.permissions,
      requiredRole,
    );

    return { id: mediaItem.id, circleId: mediaItem.circleId };
  }
}
