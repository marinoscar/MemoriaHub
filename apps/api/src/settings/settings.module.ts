import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { UserSettingsController } from './user-settings/user-settings.controller';
import { UserSettingsService } from './user-settings/user-settings.service';
import { UserTimeZoneService } from './user-settings/user-timezone.service';
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
  providers: [UserSettingsService, SystemSettingsService, UserTimeZoneService],
  // UserTimeZoneService is exported for #445's date grouping and any other
  // server-side consumer that needs a concrete zone for a user — it is the one
  // place the 'UTC' fallback lives, so nobody should re-derive it.
  exports: [UserSettingsService, SystemSettingsService, UserTimeZoneService],
})
export class SettingsModule {}
