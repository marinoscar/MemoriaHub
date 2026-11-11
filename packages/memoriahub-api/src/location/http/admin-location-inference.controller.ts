import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { adminLocationInferenceBackfillSchema } from '@marinoscar/memoriahub-contract/location';

import { MemoriahubAuth, isFeatureEnabled } from '../../core/index.js';
import { MEMORIAHUB_SETTINGS, type MemoriahubSettingsPort } from '../../ports/index.js';
import { LocationInferenceBackfillService } from '../inference/location-inference-backfill.service.js';
import { LOCATION_PERMISSIONS as PERMISSIONS, LOCATION_ROLES as ROLES } from './location-permissions.js';

class AdminLocationInferenceBackfillDto extends createZodDto(adminLocationInferenceBackfillSchema) {}

/**
 * The `AdminLocationInferenceController` routes (`POST /api/admin/location-inference/backfill`); mounted by
 * the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Admin: Location Inference')
@ApiBearerAuth('JWT-auth')
@Controller('admin/location-inference')
export class AdminLocationInferenceController {
  constructor(
    private readonly locationInferenceBackfillService: LocationInferenceBackfillService,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
  ) {}

  /** Backfills location inference across every circle (Admin). */
  @Post('backfill')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Backfill location inference across ALL circles (Admin)' })
  @ApiResponse({ status: 201, description: 'Backfill sweep jobs enqueued' })
  @ApiResponse({ status: 400, description: 'Location inference is disabled globally' })
  async backfillAllCircles(@Body() dto: AdminLocationInferenceBackfillDto) {
    const enabled = await isFeatureEnabled(this.settings, 'locationInference');
    if (!enabled) {
      throw new BadRequestException('Location inference is disabled globally');
    }
    const result = await this.locationInferenceBackfillService.backfillAllCircles({
      from: dto.from,
      to: dto.to,
      force: dto.force,
    });
    return { data: result };
  }
}
