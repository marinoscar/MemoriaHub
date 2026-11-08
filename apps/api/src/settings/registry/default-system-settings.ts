// The composed default system settings, for specs, scripts and fixtures. Production code reads a
// namespace through `SystemSettingsService.getNamespace(key)`. Importing this file registers the
// namespaces. A COPY, so a caller that mutates it cannot corrupt the declarations.
import { composeDefaultSystemSettings } from '@marinoscar/platform-api/settings';

import type { AppSystemSettingsDocument } from '../app-settings.types';
import './index';

// Typed with the app's own document type, not the platform's namespace map (see app-settings.types.ts).
export const DEFAULT_SYSTEM_SETTINGS: AppSystemSettingsDocument = structuredClone(
  composeDefaultSystemSettings(),
) as unknown as AppSystemSettingsDocument;
