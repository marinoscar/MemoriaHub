import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { SystemSettingsService } from './system-settings/system-settings.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { FeaturesResponseDto } from './dto/features-response.dto';

/**
 * Client-visible feature flags for ANY authenticated user.
 *
 * GET /api/system-settings requires the Admin-only `system_settings:read`
 * permission, so non-admin members could not read `features.pictureEnhancement`
 * and the UI never rendered gated affordances for them. This controller is the
 * least-privilege carrier for exactly the flags a client needs — nothing else
 * from the settings document is exposed.
 */
@ApiTags('Features')
@Controller('features')
export class FeaturesController {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  @Get()
  @Auth()
  @ApiOperation({
    summary: 'Get client-visible feature flags (any authenticated user)',
  })
  @ApiResponse({
    status: 200,
    description: 'Feature flags and picture-enhancement client configuration',
    type: FeaturesResponseDto,
  })
  async getFeatures(): Promise<FeaturesResponseDto> {
    return this.systemSettingsService.getPublicFeatures();
  }
}
