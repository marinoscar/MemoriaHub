import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Logger, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { Auth } from '@marinoscar/platform-api/identity';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { FEATURE_KEYS } from '../settings/feature-gates';
import { LocationInferenceBackfillService } from './location-inference-backfill.service';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';
import { adminLocationInferenceBackfillSchema } from '@marinoscar/memoriahub-contract/location';

class AdminLocationInferenceBackfillDto extends createZodDto(adminLocationInferenceBackfillSchema) {}

@ApiTags('Admin: Location Inference')
@ApiBearerAuth('JWT-auth')
@Controller('admin/location-inference')
export class AdminLocationInferenceController {
  private readonly logger = new Logger(AdminLocationInferenceController.name);

  constructor(
    private readonly locationInferenceBackfillService: LocationInferenceBackfillService,
    private readonly systemSettingsService: AppSystemSettingsService,
  ) {}

  @Post('backfill')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Backfill location inference across ALL circles (Admin)' })
  @ApiResponse({ status: 201, description: 'Backfill sweep jobs enqueued' })
  @ApiResponse({ status: 400, description: 'Location inference is disabled globally' })
  async backfillAllCircles(@Body() dto: AdminLocationInferenceBackfillDto) {
    const enabled = await this.systemSettingsService.isFeatureEnabled(FEATURE_KEYS.LOCATION_INFERENCE);
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
