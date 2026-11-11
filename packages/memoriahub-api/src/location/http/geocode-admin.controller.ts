import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { MemoriahubAuth } from '../../core/index.js';
import { GeocodeBackfillService } from '../geo/geocode-backfill.service.js';
import { BackfillGeoDto } from './geo.dto.js';
import { LOCATION_PERMISSIONS as PERMISSIONS, LOCATION_ROLES as ROLES } from './location-permissions.js';

/**
 * The `GeocodeAdminController` routes (`POST /api/admin/geocode/backfill`); mounted by the host in its own
 * module.
 *
 * @stability experimental
 */
@ApiTags('Admin: Geocode')
@ApiBearerAuth('JWT-auth')
@Controller('admin/geocode')
export class GeocodeAdminController {
  constructor(private readonly geocodeBackfillService: GeocodeBackfillService) {}

  /** Queues a `geocode` job for every media item with coordinates. */
  @Post('backfill')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Bulk-enqueue geocode enrichment for all media items with GPS (Admin)' })
  @ApiResponse({ status: 201, description: 'Jobs enqueued' })
  async backfill(@Body() dto: BackfillGeoDto) {
    return this.geocodeBackfillService.backfill({
      from: dto.from,
      to: dto.to,
      force: dto.force,
    });
  }
}
