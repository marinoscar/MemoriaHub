// =============================================================================
// Face Settings Controller
// =============================================================================
//
// Admin-only endpoints for managing face provider credentials and detection
// feature configuration. Mirrors AiSettingsController patterns.
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
import { MemoriahubAuth, MemoriahubCurrentUser } from '../../core/index.js';
import { FaceSettingsService } from '../face-settings.service.js';
import { FACE_PERMISSIONS as PERMISSIONS, FACE_ROLES as ROLES } from '../host/face-permissions.js';
import {
  UpsertFaceCredentialsDto,
  TestFaceProviderDto,
  SetDetectionFeatureDto,
} from './face-credentials.dto.js';

/**
 * The `/face` settings routes (Admin): provider settings, credentials, connection test, models and the detection feature. Mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Face Settings')
@Controller('face')
export class FaceSettingsController {
  constructor(private readonly faceSettingsService: FaceSettingsService) {}

  // ---------------------------------------------------------------------------
  // GET face/settings
  // ---------------------------------------------------------------------------

  /** Get face provider settings and detection feature configuration (Admin). */
  @Get('settings')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.FACE_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Get face provider settings and detection feature configuration (Admin)',
  })
  @ApiResponse({
    status: 200,
    description: 'Face settings summary including configured providers and detection feature config',
  })
  async getSettings() {
    return this.faceSettingsService.getSettings();
  }

  // ---------------------------------------------------------------------------
  // PUT face/credentials/:provider
  // ---------------------------------------------------------------------------

  /** Configure face provider credentials (Admin). */
  @Put('credentials/:provider')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.FACE_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Configure face provider credentials (Admin)' })
  @ApiParam({
    name: 'provider',
    description: 'Provider key: compreface',
    example: 'compreface',
  })
  @ApiResponse({ status: 200, description: 'Credential saved (masked, no plaintext key returned)' })
  async upsertCredentials(
    @Param('provider') provider: string,
    @Body() dto: UpsertFaceCredentialsDto,
    @MemoriahubCurrentUser('id') userId: string,
  ) {
    return this.faceSettingsService.upsertCredential(provider, dto, userId);
  }

  // ---------------------------------------------------------------------------
  // DELETE face/credentials/:provider
  // ---------------------------------------------------------------------------

  /** Remove face provider credentials (Admin). */
  @Delete('credentials/:provider')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.FACE_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Remove face provider credentials (Admin)' })
  @ApiParam({ name: 'provider', description: 'Provider key' })
  @ApiResponse({ status: 200, description: 'Credential removed' })
  async deleteCredentials(
    @Param('provider') provider: string,
    @MemoriahubCurrentUser('id') userId: string,
  ) {
    await this.faceSettingsService.deleteCredential(provider, userId);
    return { deleted: true, provider };
  }

  // ---------------------------------------------------------------------------
  // POST face/test
  // ---------------------------------------------------------------------------

  /** Test face provider connectivity (Admin). */
  @Post('test')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.FACE_SETTINGS_READ] })
  @ApiOperation({ summary: 'Test face provider connectivity (Admin)' })
  @ApiResponse({
    status: 200,
    description: 'Test result with ok flag and optional error message',
  })
  async testProvider(@Body() dto: TestFaceProviderDto) {
    return this.faceSettingsService.testProvider(dto);
  }

  // ---------------------------------------------------------------------------
  // GET face/models
  // ---------------------------------------------------------------------------

  /** List available model versions for a face provider (Admin). */
  @Get('models')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.FACE_SETTINGS_READ] })
  @ApiOperation({ summary: 'List available model versions for a face provider (Admin)' })
  @ApiQuery({
    name: 'provider',
    required: true,
    description: 'Provider key (compreface)',
  })
  @ApiResponse({ status: 200, description: 'List of model version strings' })
  async listModels(@Query('provider') provider: string) {
    return this.faceSettingsService.listModels(provider);
  }

  // ---------------------------------------------------------------------------
  // PUT face/features/detection
  // ---------------------------------------------------------------------------

  /** Set active provider and model for the face detection feature (Admin). */
  @Put('features/detection')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.FACE_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Set active provider and model for the face detection feature (Admin)',
  })
  @ApiResponse({ status: 200, description: 'Detection feature config updated' })
  async setDetectionFeature(
    @Body() dto: SetDetectionFeatureDto,
    @MemoriahubCurrentUser('id') userId: string,
  ) {
    return this.faceSettingsService.setDetectionFeature(dto, userId);
  }
}
