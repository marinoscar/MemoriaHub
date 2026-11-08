// =============================================================================
// The settings slice's host ports (RETRO-B3, #614)
// =============================================================================
//
//   SETTINGS_DATA            -> a transaction that opens with set_config(..., true)
//   SETTINGS_PROFILE_IMAGES  -> the profile-image helpers (see the adapter)
//
// and the providers the two app subclasses of the platform services need
// (`AppSystemSettingsService`, `AppUserSettingsService`): the notification
// services (dismiss-on-disable, policy cache) and the time-zone cache.
// NotificationsModule imports nothing, so this edge closes no cycle.
// =============================================================================

import { Global, Module } from '@nestjs/common';
import { SETTINGS_DATA, SETTINGS_PROFILE_IMAGES } from '@marinoscar/platform-api/settings';

import { NotificationsModule } from '../../notifications/notifications.module';
import { UserTimeZoneService } from '../../settings/user-timezone.service';
import { SettingsDataAdapter } from './settings-data.adapter';
import { SettingsProfileImagesAdapter } from './settings-profile-images.adapter';

@Global()
@Module({
  imports: [NotificationsModule],
  providers: [
    { provide: SETTINGS_DATA, useClass: SettingsDataAdapter },
    { provide: SETTINGS_PROFILE_IMAGES, useClass: SettingsProfileImagesAdapter },
    UserTimeZoneService,
  ],
  // NotificationsModule is re-exported: SettingsModule (which imports this module) injects
  // NotificationsService and NotificationPolicyService into the two app subclasses.
  exports: [SETTINGS_DATA, SETTINGS_PROFILE_IMAGES, UserTimeZoneService, NotificationsModule],
})
export class SettingsHostModule {}
