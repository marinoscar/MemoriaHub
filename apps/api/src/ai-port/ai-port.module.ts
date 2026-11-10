import { Module } from '@nestjs/common';
import { CredentialsModule } from '../platform/credentials/credentials.config';
import { aiModule } from '../platform/ai/ai.config';
import { PrismaModule } from '../prisma/prisma.module';
import { AiSettingsService } from './ai-settings.service';
import { AiDeploymentKeySource } from './ai-deployment-key-source';
import { MemoriaHubAiFeaturesController } from './memoriahub-ai-features.controller';

// =============================================================================
// MemoriaHub's AI port (RETRO-E2, #601)
// =============================================================================
//
// Every MemoriaHub model call goes through the platform `AiService` (`aiModule`, the one
// configured slice `AppModule` mounts; never a second `forRoot`), with the feature -> model
// choice from `ai.features.*` (`MemoriaHubAiTargetResolver`, bound to `AI_TARGET_RESOLVER` in
// `platform/ai/ai-host.module.ts`). A feature module imports THIS module to inject `AiService`
// (re-exported) and the admin-side services:
//   - `AiSettingsService`: the feature selections, the model lists, the connectivity probes and
//     a provider's key status (the Doctor's AI checks, `/api/admin/memoriahub-ai/*`);
//   - `AiDeploymentKeySource`: a provider's key status (the onboarding readiness fact, the
//     enhancer status, the settings summary); no model call reads a key through it;
//   - `MemoriaHubAiFeaturesController`: the admin feature-selection routes the MemoriaHub
//     section of `/admin/settings/ai` edits (`/api/admin/memoriahub-ai/*`).
// The legacy provider adapter this module used to serve (RETRO-E1's shim) is gone.
// =============================================================================

@Module({
  // CredentialsModule: `AiDeploymentKeySource` reads the platform deployment AI key
  // (purpose `ai`) before the legacy row (RETRO-E3, #605).
  imports: [aiModule, CredentialsModule, PrismaModule],
  controllers: [MemoriaHubAiFeaturesController],
  providers: [AiSettingsService, AiDeploymentKeySource],
  exports: [aiModule, AiSettingsService, AiDeploymentKeySource],
})
export class AiPortModule {}
