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
  TestEmbeddingDto,
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

  @Post('test/embedding')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Test embedding provider connectivity (Admin)',
    description:
      'Sends a probe text to the configured (or specified) embedding model and returns the ' +
      'resulting vector length. If the model returns a dimension other than 1536 a warning ' +
      'is included in the response — the test is still considered OK for connectivity purposes.',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ ok: true, provider, model, dimensions, warning? } on success; ' +
      '{ ok: false, provider?, model?, error } on failure.',
  })
  async testEmbedding(@Body() dto: TestEmbeddingDto) {
    return this.aiSettingsService.testEmbedding(dto);
  }

  @Get('models')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_READ] })
  @ApiOperation({
    summary: 'List available models for a provider (Admin)',
    description:
      'When capability=embedding, returns embedding model IDs instead of chat model IDs. ' +
      'Providers that do not support the requested capability return an empty array.',
  })
  @ApiQuery({ name: 'provider', required: true, description: 'Provider key' })
  @ApiQuery({
    name: 'capability',
    required: false,
    description: 'Model capability filter: "chat" (default) | "embedding"',
  })
  @ApiResponse({ status: 200, description: 'List of model IDs' })
  async listModels(
    @Query('provider') provider: string,
    @Query('capability') capability?: string,
  ) {
    if (capability === 'embedding') {
      return this.aiSettingsService.listEmbeddingModels(provider);
    }
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
