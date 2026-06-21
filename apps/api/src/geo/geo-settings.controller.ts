import {
  Controller,
  Get,
  Put,
  Delete,
  Post,
  Body,
  Param,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { GeoSettingsService } from './geo-settings.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { UpsertGeoCredentialDto } from './dto/geo-credential.dto';
import { TestGeoProviderDto } from './dto/geo-test.dto';
import { SetGeoReverseProviderDto } from './dto/geo-feature.dto';

@ApiTags('Geo Settings')
@ApiBearerAuth('JWT-auth')
@Controller('geo')
export class GeoSettingsController {
  constructor(private readonly geoSettingsService: GeoSettingsService) {}

  @Get('settings')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_READ] })
  @ApiOperation({ summary: 'Get geo provider settings (Admin)' })
  @ApiResponse({ status: 200, description: 'Geo settings summary' })
  async getSettings() {
    return this.geoSettingsService.getSettings();
  }

  @Put('credentials/:provider')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Configure geo provider credentials (Admin)' })
  @ApiParam({ name: 'provider', description: 'Provider key: google' })
  @ApiResponse({ status: 200, description: 'Credential saved (masked)' })
  async upsertCredentials(
    @Param('provider') provider: string,
    @Body() dto: UpsertGeoCredentialDto,
    @CurrentUser('id') userId: string,
  ) {
    if (provider !== 'google') {
      throw new BadRequestException(`Unsupported provider: ${provider}`);
    }
    return this.geoSettingsService.upsertCredential(provider, dto, userId);
  }

  @Delete('credentials/:provider')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Remove geo provider credentials (Admin)' })
  @ApiParam({ name: 'provider', description: 'Provider key' })
  @ApiResponse({ status: 200, description: 'Credential removed' })
  async deleteCredentials(
    @Param('provider') provider: string,
    @CurrentUser('id') userId: string,
  ) {
    await this.geoSettingsService.deleteCredential(provider, userId);
    return { deleted: true, provider };
  }

  @Put('features/reverse')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Set active reverse geocoding provider (Admin)' })
  @ApiResponse({ status: 200, description: 'Active reverse provider updated' })
  async setReverseProvider(
    @Body() dto: SetGeoReverseProviderDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.geoSettingsService.setActiveReverseProvider(dto.provider, userId);
  }

  @Post('test')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_READ] })
  @ApiOperation({ summary: 'Test geo provider connectivity (Admin)' })
  @ApiResponse({ status: 200, description: 'Test result' })
  async testProvider(@Body() dto: TestGeoProviderDto) {
    return this.geoSettingsService.testProvider(dto);
  }
}
