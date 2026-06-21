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
import { z } from 'zod';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { FEATURE_KEYS } from '../common/types/settings.types';
import { BurstService } from './burst.service';

const adminBurstBackfillSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  force: z.boolean().optional().default(false),
});
class AdminBurstBackfillDto extends createZodDto(adminBurstBackfillSchema) {}

@ApiTags('Admin — Bursts')
@ApiBearerAuth('JWT-auth')
@Controller('admin/bursts')
export class AdminBurstController {
  private readonly logger = new Logger(AdminBurstController.name);

  constructor(
    private readonly burstService: BurstService,
    private readonly systemSettingsService: SystemSettingsService,
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
