import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { Auth } from '@marinoscar/platform-api/identity';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { FEATURE_KEYS } from '../settings/feature-gates';
import { BurstService } from './burst.service';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';
import { adminBurstBackfillSchema } from '@marinoscar/memoriahub-contract/burst';

class AdminBurstBackfillDto extends createZodDto(adminBurstBackfillSchema) {}

@ApiTags('Admin: Bursts')
@ApiBearerAuth('JWT-auth')
@Controller('admin/bursts')
export class AdminBurstController {
  private readonly logger = new Logger(AdminBurstController.name);

  constructor(
    private readonly burstService: BurstService,
    private readonly systemSettingsService: AppSystemSettingsService,
  ) {}

  @Post('backfill')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Backfill burst detection across ALL circles (Admin)' })
  @ApiResponse({ status: 201, description: 'Backfill jobs enqueued' })
  @ApiResponse({ status: 400, description: 'Burst detection is disabled globally' })
  async backfillAllCircles(@Body() dto: AdminBurstBackfillDto) {
    const enabled = await this.systemSettingsService.isFeatureEnabled(FEATURE_KEYS.BURST_DETECTION);
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
