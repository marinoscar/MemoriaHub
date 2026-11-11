import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { MemoriahubAuth, isFeatureEnabled } from '../core/index.js';
import { MEDIA_PERMISSIONS as PERMISSIONS, MEDIA_ROLES as ROLES } from '../media/index.js';
import { MEMORIAHUB_SETTINGS, type MemoriahubSettingsPort } from '../ports/index.js';
import { BurstService } from './burst.service.js';
import { AdminBurstBackfillDto } from './burst.dto.js';

/**
 * The `AdminBurstController` routes (`POST /api/admin/bursts/backfill`); mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Admin: Bursts')
@ApiBearerAuth('JWT-auth')
@Controller('admin/bursts')
export class AdminBurstController {
  constructor(
    private readonly burstService: BurstService,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
  ) {}

  /** Backfills burst detection across every circle (Admin). */
  @Post('backfill')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Backfill burst detection across ALL circles (Admin)' })
  @ApiResponse({ status: 201, description: 'Backfill jobs enqueued' })
  @ApiResponse({ status: 400, description: 'Burst detection is disabled globally' })
  async backfillAllCircles(@Body() dto: AdminBurstBackfillDto) {
    const enabled = await isFeatureEnabled(this.settings, 'burstDetection');
    if (!enabled) {
      throw new BadRequestException('Burst detection is disabled globally');
    }
    const result = await this.burstService.backfillAllCircles({
      from: dto.from,
      to: dto.to,
      force: dto.force,
    });
    return { data: result };
  }
}
