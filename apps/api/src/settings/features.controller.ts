import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { Auth } from '@marinoscar/platform-api/identity';
import { FeaturesResponseDto } from './dto/features-response.dto';
import { buildPublicFeatures } from './public-features';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

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
  constructor(private readonly systemSettingsService: AppSystemSettingsService) {}

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
    // Reads through the cached getSettings() (5 s TTL), like every other caller.
    return buildPublicFeatures(await this.systemSettingsService.getSettings());
  }
}
