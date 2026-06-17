import { Module } from '@nestjs/common';
import { FaceSettingsController } from './face-settings.controller';
import { FaceSettingsService } from './face-settings.service';
import { FaceProviderRegistry } from './providers/face-provider.registry';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [SettingsModule],
  controllers: [FaceSettingsController],
  providers: [FaceSettingsService, FaceProviderRegistry],
  exports: [FaceSettingsService, FaceProviderRegistry],
})
export class FaceModule {}
