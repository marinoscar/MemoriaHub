import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { UserSettingsController } from './user-settings/user-settings.controller';
import { UserSettingsService } from './user-settings/user-settings.service';
import { SystemSettingsController } from './system-settings/system-settings.controller';
import { SystemSettingsService } from './system-settings/system-settings.service';
import { FeaturesController } from './features.controller';

/**
 * NotificationsModule is imported for #251: UserSettingsService dismisses a
 * user's live rows of any notification type they just disabled, in the SAME
 * transaction as the settings write.
 *
 * This edge is safe because NotificationsModule imports NOTHING (see its
 * header) — every other producer edge points INTO it, and this one does too, so
 * no cycle is closed. NotificationsReconcileModule -> SettingsModule ->
 * NotificationsModule likewise stays acyclic.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [UserSettingsController, SystemSettingsController, FeaturesController],
  providers: [UserSettingsService, SystemSettingsService],
  exports: [UserSettingsService, SystemSettingsService],
})
export class SettingsModule {}
