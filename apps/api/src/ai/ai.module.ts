import { Module } from '@nestjs/common';
import { AiSettingsController } from './ai-settings.controller';
import { AiSettingsService } from './ai-settings.service';
import { AiProviderRegistry } from './providers/ai-provider.registry';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [SettingsModule],
  controllers: [AiSettingsController],
  providers: [AiSettingsService, AiProviderRegistry],
  exports: [AiSettingsService, AiProviderRegistry],
})
export class AiModule {}
