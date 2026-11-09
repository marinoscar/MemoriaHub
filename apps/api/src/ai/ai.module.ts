import { Module } from '@nestjs/common';
import { CredentialsModule } from '../platform/credentials/credentials.config';
import { AiSettingsController } from './ai-settings.controller';
import { AiSettingsService } from './ai-settings.service';
import { AiProviderRegistry } from '../ai-port/legacy-ai-provider.registry';
import { AiDeploymentKeySource } from '../ai-port/ai-deployment-key-source';

@Module({
  // CredentialsModule: `AiDeploymentKeySource` reads the platform deployment AI key
  // (purpose `ai`) before the legacy row (RETRO-E3, #605).
  imports: [CredentialsModule],
  controllers: [AiSettingsController],
  providers: [AiSettingsService, AiProviderRegistry, AiDeploymentKeySource],
  exports: [AiSettingsService, AiProviderRegistry, AiDeploymentKeySource],
})
export class AiModule {}
