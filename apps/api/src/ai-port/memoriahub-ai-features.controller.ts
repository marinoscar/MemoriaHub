import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '@marinoscar/platform-api/identity';

import { PERMISSIONS } from '../common/constants/roles.constants';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiSettingsService } from './ai-settings.service';
import {
  SetEmbeddingFeatureDto,
  SetEnhanceFeatureDto,
  SetMemoriesFeatureDto,
  SetSearchFeatureDto,
  SetTaggingFeatureDto,
  SetTranscriptionFeatureDto,
  TestAiProviderDto,
  TestEmbeddingDto,
} from './dto/ai-credentials.dto';

// =============================================================================
// MemoriaHub's AI feature selections (RETRO-E4, #607)
// =============================================================================
//
// `/admin/settings/ai` is the platform's `AiConfigPage` (the kill switch, the key policy, the
// providers and their deployment keys, the limits: `/api/admin/ai/*`, `ai_config:*`). What the
// platform has no word for is WHICH provider and model serve each MemoriaHub feature
// (`ai.features.{search,tagging,embedding,enhance,memories,transcription}`, the `ai` namespace
// extension), and that is edited through these routes, from the MemoriaHub section of the same
// page (`Sections` slot).
//
// THE PREFIX IS `/api/admin/memoriahub-ai`, deliberately NOT `/api/admin/ai/*` or `/api/ai/*`:
// those belong to the platform AI slice, whose conformance suites discover every route under
// them by prefix. These routes replace MemoriaHub's old `/api/ai/{settings,test,features/*}`
// and `/api/ai/settings/models`, with the same bodies and answers; their permission pair is the
// platform's `ai_config:read|write` (the old app pair is retired).
//
// NOT BEHIND `AiEnabledGuard` (admin routes never are, AI rule 4), and the feature selections
// serve MemoriaHub's legacy call path (`AiSettingsService`, PLATFORM-ADOPTION-SHIM(#601)), which
// the platform kill switch does not govern until RETRO-E2 moves each feature to `AiService`.
// RETRO-E2 replaces these routes with the platform feature registry.
// ⚠ NO ROUTE HERE ACCEPTS OR RETURNS A KEY: keys go through
// `PUT|DELETE /api/admin/ai/providers/:provider/key`.
// =============================================================================

// The tag is the one the old /api/ai settings routes had (openapi/tags.ts).
@ApiTags('AI Settings')
@ApiBearerAuth('JWT-auth')
@Controller('admin/memoriahub-ai')
export class MemoriaHubAiFeaturesController {
  constructor(private readonly aiSettings: AiSettingsService) {}

  @Get('features')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_READ] })
  @ApiOperation({
    summary: 'Get the MemoriaHub AI feature selections and provider key status (Admin)',
    description:
      'The provider and model serving each MemoriaHub AI feature (`features.search`, `tagging`, ' +
      '`embedding`, `enhance`, `memories`, `transcription`), with each known provider\'s key ' +
      'status (`configured`, `enabled`, `last4`; never the key). Replaces `GET /api/ai/settings`.',
  })
  @ApiResponse({ status: 200, description: 'Feature selections and provider status' })
  async getFeatures() {
    return this.aiSettings.getSettings();
  }

  @Get('models')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_READ] })
  @ApiOperation({
    summary: 'List the models a provider offers for one MemoriaHub feature kind (Admin)',
    description:
      'Replaces `GET /api/ai/settings/models`. `capability`: `chat` (default), `embedding`, ' +
      '`image` (the Picture Enhancer) or `transcription`. A provider without the capability ' +
      'answers an empty list.',
  })
  @ApiQuery({ name: 'provider', required: true })
  @ApiQuery({ name: 'capability', required: false, enum: ['chat', 'embedding', 'image', 'transcription'] })
  @ApiResponse({ status: 200, description: 'Model ids' })
  async listModels(@Query('provider') provider: string, @Query('capability') capability?: string) {
    if (capability === 'embedding') return this.aiSettings.listEmbeddingModels(provider);
    if (capability === 'image') return this.aiSettings.listImageModels(provider);
    if (capability === 'transcription') return this.aiSettings.listTranscriptionModels(provider);
    return this.aiSettings.listModels(provider);
  }

  @Post('test')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @ApiOperation({
    summary: 'Test a provider and model on the MemoriaHub call path (Admin)',
    description: 'Replaces `POST /api/ai/test`. `{ ok, error? }`; spends one small provider call.',
  })
  @ApiResponse({ status: 201, description: '{ ok, error? }' })
  async testProvider(@Body() dto: TestAiProviderDto) {
    return this.aiSettings.testProvider(dto);
  }

  @Post('test/embedding')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @ApiOperation({
    summary: 'Test the embedding model semantic search uses (Admin)',
    description:
      'Replaces `POST /api/ai/test/embedding`. An empty body tests the saved `features.embedding`. ' +
      '`{ ok, provider, model, dimensions, warning? }`; `warning` when the vector is not 1536-d.',
  })
  @ApiResponse({ status: 201, description: '{ ok, provider?, model?, dimensions?, warning?, error? }' })
  async testEmbedding(@Body() dto: TestEmbeddingDto) {
    return this.aiSettings.testEmbedding(dto);
  }

  @Put('features/search')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @ApiResponse({ status: 200, description: 'The saved selection' })
  @ApiOperation({ summary: 'Set the provider and model for agentic search (Admin)' })
  async setSearch(@Body() dto: SetSearchFeatureDto, @CurrentUser('id') userId: string) {
    return this.aiSettings.setSearchFeature(dto, userId);
  }

  @Put('features/tagging')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @ApiResponse({ status: 200, description: 'The saved selection' })
  @ApiOperation({ summary: 'Set the provider and model for photo and video AI tagging (Admin)' })
  async setTagging(@Body() dto: SetTaggingFeatureDto, @CurrentUser('id') userId: string) {
    return this.aiSettings.setTaggingFeature(dto, userId);
  }

  @Put('features/embedding')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @ApiResponse({ status: 200, description: 'The saved selection' })
  @ApiOperation({ summary: 'Set the provider and model for semantic-search embeddings (Admin)' })
  async setEmbedding(@Body() dto: SetEmbeddingFeatureDto, @CurrentUser('id') userId: string) {
    return this.aiSettings.setEmbeddingFeature(dto, userId);
  }

  @Put('features/enhance')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @ApiResponse({ status: 200, description: 'The saved selection' })
  @ApiOperation({
    summary: 'Set the provider and model for the AI Picture Enhancer (Admin)',
    description: 'A null provider or model clears the selection.',
  })
  async setEnhance(@Body() dto: SetEnhanceFeatureDto, @CurrentUser('id') userId: string) {
    return this.aiSettings.setEnhanceFeature(dto, userId);
  }

  @Put('features/memories')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @ApiResponse({ status: 200, description: 'The saved selection' })
  @ApiOperation({
    summary: 'Set the provider and model for Memories titles (Admin)',
    description:
      'A null provider or model clears the selection (memories fall back to template titles). ' +
      '400 when the provider has no configured, enabled key.',
  })
  @ApiResponse({ status: 400, description: 'The provider has no configured, enabled key' })
  async setMemories(@Body() dto: SetMemoriesFeatureDto, @CurrentUser('id') userId: string) {
    return this.aiSettings.setMemoriesFeature(dto, userId);
  }

  @Put('features/transcription')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @ApiResponse({ status: 200, description: 'The saved selection' })
  @ApiOperation({
    summary: 'Set the provider and model for video speech-to-text (Admin)',
    description:
      'A null provider or model clears the selection (video tagging runs visual-only). ' +
      '400 when the provider has no configured, enabled key.',
  })
  @ApiResponse({ status: 400, description: 'The provider has no configured, enabled key' })
  async setTranscription(@Body() dto: SetTranscriptionFeatureDto, @CurrentUser('id') userId: string) {
    return this.aiSettings.setTranscriptionFeature(dto, userId);
  }
}
