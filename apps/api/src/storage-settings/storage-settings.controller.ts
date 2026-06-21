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
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { StorageSettingsService } from './storage-settings.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { KNOWN_STORAGE_PROVIDERS } from './providers/storage-provider.registry';
import { UpsertStorageCredentialsDto } from './dto/storage-credentials.dto';
import { TestStorageProviderDto } from './dto/test-storage-provider.dto';
import { SetActiveStorageProviderDto } from './dto/set-active-provider.dto';
import { TriggerMigrationDto } from './dto/trigger-migration.dto';

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

  // ---------------------------------------------------------------------------
  // POST /storage-settings/migrate
  // ---------------------------------------------------------------------------

  @Post('migrate')
  @Auth({
    roles: [ROLES.ADMIN],
    permissions: [PERMISSIONS.STORAGE_SETTINGS_WRITE],
  })
  @ApiOperation({
    summary: 'Trigger a copy-only storage migration (Admin)',
    description:
      'Copies all ready objects from sourceProvider to targetProvider via the ' +
      'enrichment queue. Source files are never deleted. Only one migration can ' +
      'run at a time. Returns { runId, totalCount } immediately; poll ' +
      'GET /storage-settings/migrate/:runId for progress.',
  })
  @ApiResponse({
    status: 201,
    description: '{ runId: string; totalCount: number }',
  })
  async triggerMigration(
    @Body() dto: TriggerMigrationDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.storageSettingsService.triggerMigration(dto, userId);
  }

  // ---------------------------------------------------------------------------
  // GET /storage-settings/migrate
  // ---------------------------------------------------------------------------

  @Get('migrate')
  @Auth({
    roles: [ROLES.ADMIN],
    permissions: [PERMISSIONS.STORAGE_SETTINGS_READ],
  })
  @ApiOperation({ summary: 'List migration runs (Admin, paginated, newest first)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: '{ items: MigrationRun[]; meta: { total, page, pageSize, totalPages } }',
  })
  async listMigrationRuns(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.storageSettingsService.listMigrationRuns({
      page: page ? parseInt(page, 10) : 1,
      pageSize: pageSize ? parseInt(pageSize, 10) : 20,
    });
  }

  // ---------------------------------------------------------------------------
  // GET /storage-settings/migrate/:runId
  // ---------------------------------------------------------------------------

  @Get('migrate/:runId')
  @Auth({
    roles: [ROLES.ADMIN],
    permissions: [PERMISSIONS.STORAGE_SETTINGS_READ],
  })
  @ApiOperation({
    summary: 'Get migration run detail (Admin)',
    description:
      'Returns run metadata plus counts recomputed from item rows (more ' +
      'accurate than the denormalized counters on the run row).',
  })
  @ApiParam({ name: 'runId', description: 'Migration run UUID' })
  @ApiResponse({ status: 200, description: 'Migration run with recomputed counts' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async getMigrationRun(@Param('runId') runId: string) {
    return this.storageSettingsService.getMigrationRun(runId);
  }

  // ---------------------------------------------------------------------------
  // POST /storage-settings/migrate/:runId/cancel
  // ---------------------------------------------------------------------------

  @Post('migrate/:runId/cancel')
  @Auth({
    roles: [ROLES.ADMIN],
    permissions: [PERMISSIONS.STORAGE_SETTINGS_WRITE],
  })
  @ApiOperation({
    summary: 'Cancel a pending or running migration (Admin)',
    description:
      'Marks the run as cancelled and deletes still-pending enrichment jobs. ' +
      'Items that are already copying will complete their current attempt then ' +
      'be skipped on the next retry check.',
  })
  @ApiParam({ name: 'runId', description: 'Migration run UUID' })
  @ApiResponse({ status: 200, description: 'Run cancelled' })
  @ApiResponse({ status: 400, description: 'Run is not in a cancellable state' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async cancelMigration(@Param('runId') runId: string) {
    return this.storageSettingsService.cancelMigration(runId);
  }
}
