// The composed default system settings, for specs, scripts and fixtures. Production code reads a
// namespace through `SystemSettingsService.getNamespace(key)`. Importing this file registers the
// namespaces. A COPY, so a caller that mutates it cannot corrupt the declarations.
import { composeDefaultSystemSettings, type SystemSettingsValue } from '@marinoscar/platform-api/settings';

import './index';

export const DEFAULT_SYSTEM_SETTINGS: SystemSettingsValue = structuredClone(composeDefaultSystemSettings());
