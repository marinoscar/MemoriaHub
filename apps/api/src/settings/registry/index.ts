// =============================================================================
// Settings registry entry point (RETRO-B3, #614)
// =============================================================================
//
// IMPORTING THIS FILE REGISTERS EVERY SETTINGS NAMESPACE. The platform's request and response
// DTOs, the composed schemas and the OpenAPI document are composed FROM THE REGISTRIES when
// `SettingsModule.forRoot()` runs (and `PlatformHostCoreModule.forRoot()` would otherwise register
// `maintenance` first), so every entry point (`app.module.ts`, `main.ts`, `test/setup.ts`,
// `scripts/*`) reaches this file before them.
// =============================================================================

import { registerMemoriaHubSystemSettings } from './system-settings.manifest';
import { registerMemoriaHubUserSettings } from './user-settings.manifest';

registerMemoriaHubSystemSettings();
registerMemoriaHubUserSettings();

export {
  PLATFORM_SYSTEM_SETTINGS_NAMESPACES,
  assembleMemoriaHubSystemNamespaces,
} from './system-settings.manifest';
export {
  PLATFORM_USER_SETTINGS_NAMESPACES,
  assembleMemoriaHubUserNamespaces,
} from './user-settings.manifest';
