import { Module } from '@nestjs/common';
import { CredentialsModule } from '../platform/credentials/credentials.config';
import { AiSettingsService } from './ai-settings.service';
import { AiProviderRegistry } from './legacy-ai-provider.registry';
import { AiDeploymentKeySource } from './ai-deployment-key-source';
import { MemoriaHubAiFeaturesController } from './memoriahub-ai-features.controller';

// =============================================================================
// The legacy AI call path (PLATFORM-ADOPTION-SHIM(#601))
// =============================================================================
//
// Was `src/ai/ai.module.ts`. RETRO-E4 (#607) moved the admin AI surface onto the
// platform pages (`/api/admin/ai/*`, `ai_config:*`) and retired the old
// `/api/ai/{settings,credentials,test,features}` routes and their permission pair.
// What stays is what MemoriaHub's AI features still call until RETRO-E2 (#601)
// moves each of them to `AiService.forUser`:
//   - `AiSettingsService`: the feature selections (`ai.features.*`) and the key
//     resolution behind the legacy provider adapter;
//   - `AiProviderRegistry` / `AiDeploymentKeySource`: the adapter and its key
//     source (the platform deployment key first, RETRO-E3);
//   - `MemoriaHubAiFeaturesController`: the admin feature-selection routes the
//     MemoriaHub section of `/admin/settings/ai` edits (`/api/admin/memoriahub-ai/*`).
// RETRO-E2 deletes this module.
// =============================================================================

@Module({
  // CredentialsModule: `AiDeploymentKeySource` reads the platform deployment AI key
  // (purpose `ai`) before the legacy row (RETRO-E3, #605).
  imports: [CredentialsModule],
  controllers: [MemoriaHubAiFeaturesController],
  providers: [AiSettingsService, AiProviderRegistry, AiDeploymentKeySource],
  exports: [AiSettingsService, AiProviderRegistry, AiDeploymentKeySource],
})
export class LegacyAiModule {}
