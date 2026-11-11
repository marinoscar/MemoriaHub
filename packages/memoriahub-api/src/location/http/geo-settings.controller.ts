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
import { MemoriahubAuth, MemoriahubCurrentUser } from '../../core/index.js';
import { GeoSettingsService } from '../geo/geo-settings.service.js';
import { SetGeoReverseProviderDto, TestGeoProviderDto, UpsertGeoCredentialDto } from './geo.dto.js';
import { LOCATION_PERMISSIONS as PERMISSIONS, LOCATION_ROLES as ROLES } from './location-permissions.js';

/**
 * The `GeoSettingsController` routes (`/api/geo/*`: the provider summary, the Google key, the active reverse
 * provider and the connectivity test); mounted by the host in its own module. The key is write-only: no route
 * returns it.
 *
 * @stability experimental
 */
@ApiTags('Geo Settings')
@ApiBearerAuth('JWT-auth')
@Controller('geo')
export class GeoSettingsController {
  constructor(private readonly geoSettingsService: GeoSettingsService) {}

  @Get('settings')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_READ] })
  @ApiOperation({ summary: 'Get geo provider settings (Admin)' })
  @ApiResponse({ status: 200, description: 'Geo settings summary' })
  async getSettings() {
    return this.geoSettingsService.getSettings();
  }

  @Put('credentials/:provider')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Configure geo provider credentials (Admin)' })
  @ApiParam({ name: 'provider', description: 'Provider key: google' })
  @ApiResponse({ status: 200, description: 'Credential saved (masked)' })
  async upsertCredentials(
    @Param('provider') provider: string,
    @Body() dto: UpsertGeoCredentialDto,
    @MemoriahubCurrentUser('id') userId: string,
  ) {
    if (provider !== 'google') {
      throw new BadRequestException(`Unsupported provider: ${provider}`);
    }
    return this.geoSettingsService.upsertCredential(provider, dto, userId);
  }

  @Delete('credentials/:provider')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Remove geo provider credentials (Admin)' })
  @ApiParam({ name: 'provider', description: 'Provider key' })
  @ApiResponse({ status: 200, description: 'Credential removed' })
  async deleteCredentials(
    @Param('provider') provider: string,
    @MemoriahubCurrentUser('id') userId: string,
  ) {
    await this.geoSettingsService.deleteCredential(provider, userId);
    return { deleted: true, provider };
  }

  @Put('features/reverse')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Set active reverse geocoding provider (Admin)' })
  @ApiResponse({ status: 200, description: 'Active reverse provider updated' })
  async setReverseProvider(
    @Body() dto: SetGeoReverseProviderDto,
    @MemoriahubCurrentUser('id') userId: string,
  ) {
    return this.geoSettingsService.setActiveReverseProvider(dto.provider, userId);
  }

  @Post('test')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_READ] })
  @ApiOperation({ summary: 'Test geo provider connectivity (Admin)' })
  @ApiResponse({ status: 200, description: 'Test result' })
  async testProvider(@Body() dto: TestGeoProviderDto) {
    return this.geoSettingsService.testProvider(dto);
  }
}
