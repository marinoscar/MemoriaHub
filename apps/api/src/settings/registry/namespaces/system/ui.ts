import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const schema = z.object({ allowUserThemeOverride: z.boolean() });
export type UiSettingsValue = z.infer<typeof schema>;

export const UI_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'ui',
  description: 'Whether users may override the deployment theme.',
  schema,
  defaults: { allowUserThemeOverride: true },
});
