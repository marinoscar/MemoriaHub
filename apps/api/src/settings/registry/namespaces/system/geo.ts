import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const schema = z.object({
  reverseProvider: z.enum(['offline', 'nominatim', 'google']),
  forwardSearchEnabled: z.boolean(),
  // Non-secret half of the Google provider (RETRO-B4, #617); the API key is the credential
  // `geo_provider/google`. Absent key means "not configured" whatever `enabled` says.
  google: z.object({
    enabled: z.boolean(),
    baseUrl: z.string().nullable(),
  }),
});
export type GeoSettingsValue = z.infer<typeof schema>;

export const GEO_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'geo',
  description: 'The active reverse-geocoding provider and whether forward search is on.',
  schema,
  defaults: {
    reverseProvider: process.env['GEO_PROVIDER'] === 'nominatim' ? 'nominatim' : 'offline',
    forwardSearchEnabled: process.env['GEO_FORWARD_SEARCH_ENABLED'] === 'true',
    google: { enabled: true, baseUrl: null },
  },
});
