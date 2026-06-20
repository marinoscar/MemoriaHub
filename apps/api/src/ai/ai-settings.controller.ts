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
import { AiSettingsService } from './ai-settings.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import {
  UpsertAiCredentialsDto,
  TestAiProviderDto,
  SetSearchFeatureDto,
  SetTaggingFeatureDto,
  SetEmbeddingFeatureDto,
} from './dto/ai-credentials.dto';

@ApiTags('AI Settings')
@Controller('ai')
export class AiSettingsController {
  constructor(private readonly aiSettingsService: AiSettingsService) {}

  @Get('settings')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Get AI provider settings and feature configuration (Admin)',
  })
  @ApiResponse({ status: 200, description: 'AI settings summary' })
  async getSettings() {
    return this.aiSettingsService.getSettings();
  }

  @Put('credentials/:provider')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Configure AI provider credentials (Admin)' })
  @ApiParam({ name: 'provider', description: 'Provider key: anthropic | openai' })
  @ApiResponse({ status: 200, description: 'Credential saved (masked)' })
  async upsertCredentials(
    @Param('provider') provider: string,
    @Body() dto: UpsertAiCredentialsDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.aiSettingsService.upsertCredential(provider, dto, userId);
  }

  @Delete('credentials/:provider')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Remove AI provider credentials (Admin)' })
  @ApiParam({ name: 'provider', description: 'Provider key' })
  @ApiResponse({ status: 200, description: 'Credential removed' })
  async deleteCredentials(
    @Param('provider') provider: string,
    @CurrentUser('id') userId: string,
  ) {
    await this.aiSettingsService.deleteCredential(provider, userId);
    return { deleted: true, provider };
  }

  @Post('test')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_READ] })
  @ApiOperation({ summary: 'Test AI provider connectivity (Admin)' })
  @ApiResponse({ status: 200, description: 'Test result' })
  async testProvider(@Body() dto: TestAiProviderDto) {
    return this.aiSettingsService.testProvider(dto);
  }

  @Get('models')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_READ] })
  @ApiOperation({ summary: 'List available models for a provider (Admin)' })
  @ApiQuery({ name: 'provider', required: true, description: 'Provider key' })
  @ApiResponse({ status: 200, description: 'List of model IDs' })
  async listModels(@Query('provider') provider: string) {
    return this.aiSettingsService.listModels(provider);
  }

  @Put('features/search')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Set active provider and model for AI search feature (Admin)',
  })
  @ApiResponse({ status: 200, description: 'Search feature config updated' })
  async setSearchFeature(
    @Body() dto: SetSearchFeatureDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.aiSettingsService.setSearchFeature(dto, userId);
  }

  @Put('features/tagging')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Set active provider and model for AI tagging feature (Admin)',
  })
  @ApiResponse({ status: 200, description: 'Tagging feature config updated' })
  async setTaggingFeature(
    @Body() dto: SetTaggingFeatureDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.aiSettingsService.setTaggingFeature(dto, userId);
  }

  @Put('features/embedding')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Set active provider and model for AI embedding feature (Admin)',
  })
  @ApiResponse({ status: 200, description: 'Embedding feature config updated' })
  async setEmbeddingFeature(
    @Body() dto: SetEmbeddingFeatureDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.aiSettingsService.setEmbeddingFeature(dto, userId);
  }
}
