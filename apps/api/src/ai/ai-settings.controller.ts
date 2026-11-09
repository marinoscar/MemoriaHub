import {
  Controller,
  Get,
  Put,
  Delete,
  Post,
  Body,
  Param,
  Query,
  GoneException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { AiSettingsService } from './ai-settings.service';
import { Auth } from '@marinoscar/platform-api/identity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import {
  TestAiProviderDto,
  SetSearchFeatureDto,
  SetTaggingFeatureDto,
  SetEmbeddingFeatureDto,
  SetEnhanceFeatureDto,
  SetMemoriesFeatureDto,
  SetTranscriptionFeatureDto,
  TestEmbeddingDto,
} from './dto/ai-credentials.dto';

/** `details.reason` of the 410 the two retired key-write routes answer (RETRO-E3, #605). */
export const AI_LEGACY_KEY_WRITES_GONE = 'AI_LEGACY_KEY_WRITES_GONE';

function legacyKeyWritesGone(provider: string): GoneException {
  return new GoneException({
    message:
      'AI provider keys are stored in the platform credential store. Use ' +
      `PUT or DELETE /api/admin/ai/providers/${provider}/key (Admin AI settings, /admin/settings/ai).`,
    details: {
      reason: AI_LEGACY_KEY_WRITES_GONE,
      provider,
      route: `/api/admin/ai/providers/${provider}/key`,
      page: '/admin/settings/ai',
    },
  });
}

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

  // RETRO-E3 (#605), release N: the legacy key table is read-only. A key is set or removed in the
  // platform credential store (`PUT|DELETE /api/admin/ai/providers/:provider/key`, `ai_config:write`),
  // so no new `ai_provider_credentials` row can appear before release N+1 drops the table.
  @Put('credentials/:provider')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Gone: AI provider keys are set through PUT /api/admin/ai/providers/{provider}/key (Admin)',
    deprecated: true,
  })
  @ApiParam({ name: 'provider', description: 'Provider key: anthropic | openai' })
  @ApiResponse({ status: 410, description: 'Legacy key writes are retired; use the platform admin AI key route' })
  upsertCredentials(@Param('provider') provider: string): never {
    throw legacyKeyWritesGone(provider);
  }

  @Delete('credentials/:provider')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Gone: AI provider keys are removed through DELETE /api/admin/ai/providers/{provider}/key (Admin)',
    deprecated: true,
  })
  @ApiParam({ name: 'provider', description: 'Provider key' })
  @ApiResponse({ status: 410, description: 'Legacy key writes are retired; use the platform admin AI key route' })
  deleteCredentials(@Param('provider') provider: string): never {
    throw legacyKeyWritesGone(provider);
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

  // RETRO-E1 (#595): was `GET /api/ai/models`. The platform AI slice owns that path (a user's
  // usable models, `UserAiKeysController`), and two handlers on one route fail at boot, so the
  // legacy admin listing moved under `settings/`. Same query, same answer. Retired with the old
  // admin page by RETRO-E4.
  @Get('settings/models')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_READ] })
  @ApiOperation({
    summary: 'List available models for a provider (Admin)',
    description:
      'Moved from GET /api/ai/models (RETRO-E1), which is now the platform AI slice\'s route. ' +
      'When capability=embedding, returns embedding model IDs instead of chat model IDs. ' +
      'When capability=image, returns image-edit (enhancement) model IDs. ' +
      'When capability=transcription, returns speech-to-text model IDs. ' +
      'Providers that do not support the requested capability return an empty array.',
  })
  @ApiQuery({ name: 'provider', required: true, description: 'Provider key' })
  @ApiQuery({
    name: 'capability',
    required: false,
    description:
      'Model capability filter: "chat" (default) | "embedding" | "image" | "transcription"',
  })
  @ApiResponse({ status: 200, description: 'List of model IDs' })
  async listModels(
    @Query('provider') provider: string,
    @Query('capability') capability?: string,
  ) {
    if (capability === 'embedding') {
      return this.aiSettingsService.listEmbeddingModels(provider);
    }
    if (capability === 'image') {
      return this.aiSettingsService.listImageModels(provider);
    }
    if (capability === 'transcription') {
      return this.aiSettingsService.listTranscriptionModels(provider);
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

  @Put('features/enhance')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Set active provider and model for AI picture enhancement (Admin)',
  })
  @ApiResponse({ status: 200, description: 'Enhance feature config updated' })
  async setEnhanceFeature(
    @Body() dto: SetEnhanceFeatureDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.aiSettingsService.setEnhanceFeature(dto, userId);
  }

  @Put('features/memories')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_WRITE] })
  @ApiOperation({
    summary:
      'Set active provider and model for Memories title generation (Admin)',
    description:
      'Chat-capable provider/model used to write memory titles, subtitles and ' +
      'narratives (epic #300). List candidates with GET /api/ai/models?capability=chat. ' +
      'Passing a null provider or model clears the selection, in which case ' +
      'memories fall back to deterministic template titles. Returns 400 when the ' +
      'selected provider has no configured, enabled credential.',
  })
  @ApiResponse({ status: 200, description: 'Memories feature config updated' })
  @ApiResponse({
    status: 400,
    description: 'Provider is not configured or is disabled',
  })
  async setMemoriesFeature(
    @Body() dto: SetMemoriesFeatureDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.aiSettingsService.setMemoriesFeature(dto, userId);
  }

  @Put('features/transcription')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.AI_SETTINGS_WRITE] })
  @ApiOperation({
    summary:
      'Set active provider and model for video audio transcription (Admin)',
    description:
      'Speech-to-text provider/model used by video auto-tagging to transcribe the ' +
      'opening seconds of a video (epic #452). List candidates with ' +
      'GET /api/ai/models?capability=transcription — OpenAI-only in v1. Passing a ' +
      'null provider or model clears the selection, in which case video tagging ' +
      'runs visual-only. Returns 400 when the selected provider has no configured, ' +
      'enabled credential.',
  })
  @ApiResponse({ status: 200, description: 'Transcription feature config updated' })
  @ApiResponse({
    status: 400,
    description: 'Provider is not configured or is disabled',
  })
  async setTranscriptionFeature(
    @Body() dto: SetTranscriptionFeatureDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.aiSettingsService.setTranscriptionFeature(dto, userId);
  }
}
