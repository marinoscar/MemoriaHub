// =============================================================================
// Storage Settings Controller
// =============================================================================
//
// Admin-only endpoints for managing storage provider credentials and the active
// provider configuration.  Mirrors AiSettingsController / FaceSettingsController.
// =============================================================================

import {
  Controller,
  Get,
  Put,
  Delete,
  Post,
  Body,
  Param,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { StorageSettingsService } from './storage-settings.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { KNOWN_STORAGE_PROVIDERS } from './providers/storage-provider.registry';
import { UpsertStorageCredentialsDto } from './dto/storage-credentials.dto';
import { TestStorageProviderDto } from './dto/test-storage-provider.dto';
import { SetActiveStorageProviderDto } from './dto/set-active-provider.dto';

@ApiTags('Storage Settings')
@Controller('storage-settings')
export class StorageSettingsController {
  constructor(
    private readonly storageSettingsService: StorageSettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /storage-settings
  // ---------------------------------------------------------------------------

  @Get()
  @Auth({
    roles: [ROLES.ADMIN],
    permissions: [PERMISSIONS.STORAGE_SETTINGS_READ],
  })
  @ApiOperation({
    summary:
      'Get storage provider settings and active provider configuration (Admin)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Storage settings summary: configured providers (masked), known providers, and active provider',
  })
  async getSettings() {
    return this.storageSettingsService.getSettings();
  }

  // ---------------------------------------------------------------------------
  // GET /storage-settings/providers
  // ---------------------------------------------------------------------------

  @Get('providers')
  @Auth({
    roles: [ROLES.ADMIN],
    permissions: [PERMISSIONS.STORAGE_SETTINGS_READ],
  })
  @ApiOperation({
    summary: 'List all known storage provider descriptors (Admin)',
  })
  @ApiResponse({
    status: 200,
    description: 'Static list of known storage providers with their field requirements',
  })
  getKnownProviders() {
    return { providers: KNOWN_STORAGE_PROVIDERS };
  }

  // ---------------------------------------------------------------------------
  // PUT /storage-settings/credentials/:provider
  // ---------------------------------------------------------------------------

  @Put('credentials/:provider')
  @Auth({
    roles: [ROLES.ADMIN],
    permissions: [PERMISSIONS.STORAGE_SETTINGS_WRITE],
  })
  @ApiOperation({
    summary: 'Configure storage provider credentials (Admin)',
  })
  @ApiParam({
    name: 'provider',
    description: 'Provider key: s3 | r2',
    example: 's3',
  })
  @ApiResponse({
    status: 200,
    description: 'Credential saved (masked, no plaintext secret returned)',
  })
  async upsertCredentials(
    @Param('provider') provider: string,
    @Body() dto: UpsertStorageCredentialsDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.storageSettingsService.upsertCredential(provider, dto, userId);
  }

  // ---------------------------------------------------------------------------
  // DELETE /storage-settings/credentials/:provider
  // ---------------------------------------------------------------------------

  @Delete('credentials/:provider')
  @Auth({
    roles: [ROLES.ADMIN],
    permissions: [PERMISSIONS.STORAGE_SETTINGS_WRITE],
  })
  @ApiOperation({
    summary: 'Remove storage provider credentials (Admin)',
    description:
      'Blocks deletion when the provider is currently active. Switch the active provider first.',
  })
  @ApiParam({ name: 'provider', description: 'Provider key' })
  @ApiResponse({ status: 200, description: 'Credential removed' })
  async deleteCredentials(@Param('provider') provider: string) {
    await this.storageSettingsService.deleteCredential(provider);
    return { deleted: true, provider };
  }

  // ---------------------------------------------------------------------------
  // POST /storage-settings/test
  // ---------------------------------------------------------------------------

  @Post('test')
  @Auth({
    roles: [ROLES.ADMIN],
    permissions: [PERMISSIONS.STORAGE_SETTINGS_READ],
  })
  @ApiOperation({
    summary: 'Test storage provider connectivity (Admin)',
    description:
      'Performs a write → read → delete round-trip using a sentinel key. ' +
      'Supply override fields to test credentials before saving them. ' +
      'Never returns plaintext secrets.',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ ok: true, provider, bucket?, region?, endpoint? } on success; ' +
      '{ ok: false, provider, error } on failure.',
  })
  async testConnection(@Body() dto: TestStorageProviderDto) {
    return this.storageSettingsService.testConnection(dto);
  }

  // ---------------------------------------------------------------------------
  // PUT /storage-settings/active
  // ---------------------------------------------------------------------------

  @Put('active')
  @Auth({
    roles: [ROLES.ADMIN],
    permissions: [PERMISSIONS.STORAGE_SETTINGS_WRITE],
  })
  @ApiOperation({
    summary: 'Set the active storage provider (Admin)',
    description:
      'Updates system settings so all new uploads are directed to this provider. ' +
      'Existing objects are not migrated.',
  })
  @ApiResponse({
    status: 200,
    description: 'Active provider updated; returns { activeProvider: string }',
  })
  async setActiveProvider(
    @Body() dto: SetActiveStorageProviderDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.storageSettingsService.setActiveProvider(dto, userId);
  }
}
