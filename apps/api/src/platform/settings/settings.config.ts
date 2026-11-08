// =============================================================================
// The settings slice's composition (RETRO-B3, #614)
// =============================================================================
//
// `SettingsModule.forRoot` serves `GET|PUT|PATCH /api/system-settings`,
// `GET|PUT|PATCH /api/user-settings` and `/api/org-settings` (unused in single-organization mode),
// and provides `SystemSettingsService`, `UserSettingsService`, `SettingsResolver` and
// `SystemSettingsRowStore` globally. It replaces this app's hand-written SettingsModule.
//
// IT MUST RUN AFTER THE NAMESPACE MANIFESTS: the request bodies and the OpenAPI document are
// composed from the registries when `forRoot` runs, so the registry import comes first.
// `systemRowKey` stays `'global'` (the row this app has always used) and `orgLayer` is `'auto'`:
// in single-organization mode an organization layer applies only when its row exists, which here
// it never does.
//
// TWO PROVIDERS ARE THE APP'S OWN SUBCLASSES of the platform services, bound to the platform
// tokens (see the two files): the 5 s settings cache, and the notification side effects of a write.
// =============================================================================

import type { DynamicModule, Provider } from '@nestjs/common';
import { SettingsModule, SystemSettingsService, UserSettingsService } from '@marinoscar/platform-api/settings';

import '../../settings/registry';
import { AppSystemSettingsService } from './app-system-settings.service';
import { AppUserSettingsService } from './app-user-settings.service';
import { SettingsHostModule } from './settings-host.module';

const platformSettings = SettingsModule.forRoot({
  systemRowKey: 'global',
  orgLayer: 'auto',
  imports: [SettingsHostModule],
});

const bind = (provider: Provider): Provider => {
  if (provider === SystemSettingsService) {
    return { provide: SystemSettingsService, useClass: AppSystemSettingsService };
  }
  if (provider === UserSettingsService) {
    return { provide: UserSettingsService, useClass: AppUserSettingsService };
  }
  return provider;
};

export const settingsModule: DynamicModule = {
  ...platformSettings,
  providers: [
    ...(platformSettings.providers ?? []).map(bind),
    // The same instance under the subclass's own token, for the call sites that use its two helpers.
    { provide: AppSystemSettingsService, useExisting: SystemSettingsService },
  ],
  exports: [...(platformSettings.exports ?? []), AppSystemSettingsService],
};
