import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

// Location Grouping (issue #373). `features.locationGrouping` (+ LOCATION_GROUPING_ENABLED) is the master switch.
const schema = z.object({
  radiusCaptureEnabled: z.boolean(),
  maxRadiusKm: z.number().min(0.5).max(200),
  suggestionMinItems: z.number().int().min(1).max(1000),
});
export type LocationGroupingSettingsValue = z.infer<typeof schema>;

export const LOCATION_GROUPING_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'locationGrouping',
  description: 'Location Grouping tuning: radius capture, the radius ceiling and the suggestion floor.',
  schema,
  defaults: { radiusCaptureEnabled: true, maxRadiusKm: 50, suggestionMinItems: 1 },
});
