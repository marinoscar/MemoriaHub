import { Module } from '@nestjs/common';
import { UserSettingsController } from './user-settings/user-settings.controller';
import { UserSettingsService } from './user-settings/user-settings.service';
import { SystemSettingsController } from './system-settings/system-settings.controller';
import { SystemSettingsService } from './system-settings/system-settings.service';
import { FeaturesController } from './features.controller';

@Module({
  controllers: [UserSettingsController, SystemSettingsController, FeaturesController],
  providers: [UserSettingsService, SystemSettingsService],
  exports: [UserSettingsService, SystemSettingsService],
})
export class SettingsModule {}
