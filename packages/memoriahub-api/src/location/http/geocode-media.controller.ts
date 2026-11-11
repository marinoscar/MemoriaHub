import {
  Controller,
  Post,
  Get,
  Param,
  NotFoundException,
  Logger,
  Inject,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { MemoriahubAuth, MemoriahubCurrentUser, type MemoriahubRequestUser } from '../../core/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_PRISMA,
  type MemoriahubAccessPort,
  type MemoriahubScopeRole,
} from '../../ports/index.js';
import type { LocationDb } from '../data/location-db.js';
import { GeocodeBackfillService } from '../geo/geocode-backfill.service.js';
import { LOCATION_PERMISSIONS as PERMISSIONS } from './location-permissions.js';

/**
 * The `GeocodeMediaController` routes (`POST /api/media/:id/geocode/rerun`, `GET /api/media/:id/geocode/status`);
 * mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Media')
@ApiBearerAuth('JWT-auth')
@Controller('media')
export class GeocodeMediaController {
  private readonly logger = new Logger(GeocodeMediaController.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: LocationDb,
    @Inject(MEMORIAHUB_ACCESS) private readonly circleMembershipService: MemoriahubAccessPort,
    private readonly geocodeBackfillService: GeocodeBackfillService,
  ) {}

  /** Queues a geocode rerun for one item (collaborator role). */
  @Post(':id/geocode/rerun')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Re-run geocoding for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 201, description: 'Geocode job queued' })
  async rerunGeocode(
    @Param('id') mediaItemId: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    await this.assertMediaItemAccess(mediaItemId, user, 'editor');
    const result = await this.geocodeBackfillService.enqueueRerun(mediaItemId, user.id);
    return { data: result };
  }

  /** Reads the geocode status of one item (viewer role). */
  @Get(':id/geocode/status')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get geocode status for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 200, description: 'Geocode status' })
  async getGeocodeStatus(
    @Param('id') mediaItemId: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    await this.assertMediaItemAccess(mediaItemId, user, 'viewer');
    const status = await this.geocodeBackfillService.getStatus(mediaItemId);
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

    await this.circleMembershipService.requireOwnerRole(
      user.id,
      mediaItem.circleId,
      user.permissions,
      requiredRole,
    );

    return { id: mediaItem.id, circleId: mediaItem.circleId };
  }
}
