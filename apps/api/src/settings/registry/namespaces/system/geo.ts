import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const schema = z.object({
  reverseProvider: z.enum(['offline', 'nominatim', 'google']),
  forwardSearchEnabled: z.boolean(),
});
export type GeoSettingsValue = z.infer<typeof schema>;

export const GEO_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'geo',
  description: 'The active reverse-geocoding provider and whether forward search is on.',
  schema,
  defaults: {
    reverseProvider: process.env['GEO_PROVIDER'] === 'nominatim' ? 'nominatim' : 'offline',
    forwardSearchEnabled: process.env['GEO_FORWARD_SEARCH_ENABLED'] === 'true',
  },
});
