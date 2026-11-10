import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { Auth } from '@marinoscar/platform-api/identity';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { GeocodeBackfillService } from './geocode-backfill.service';
import { backfillGeoSchema } from '@marinoscar/memoriahub-contract/location';


class BackfillGeoDto extends createZodDto(backfillGeoSchema) {}

@ApiTags('Admin: Geocode')
@ApiBearerAuth('JWT-auth')
@Controller('admin/geocode')
export class GeocodeAdminController {
  constructor(private readonly geocodeBackfillService: GeocodeBackfillService) {}

  @Post('backfill')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_WRITE] })
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
