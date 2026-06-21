import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { GeocodeBackfillService } from './geocode-backfill.service';

const flexibleDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Invalid date' });

const backfillGeoSchema = z.object({
  from: flexibleDate.optional(),
  to: flexibleDate.optional(),
  force: z.boolean().optional().default(false),
});
class BackfillGeoDto extends createZodDto(backfillGeoSchema) {}

@ApiTags('Admin - Geocode')
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
