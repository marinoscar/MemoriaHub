import { Module } from '@nestjs/common';
import { AiSettingsController } from './ai-settings.controller';
import { AiSettingsService } from './ai-settings.service';
import { AiProviderRegistry } from './providers/ai-provider.registry';

@Module({
  imports: [],
  controllers: [AiSettingsController],
  providers: [AiSettingsService, AiProviderRegistry],
  exports: [AiSettingsService, AiProviderRegistry],
})
export class AiModule {}
