import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const schema = z.object({
  maxGapMinutes: z.number().int().min(1).max(1440),
  maxExtrapolationGapMinutes: z.number().int().min(1).max(240),
  autoApplyMaxGapMinutes: z.number().int().min(0).max(60),
  requireSameDevice: z.boolean(),
  maxAnchorDistanceKm: z.number().min(0.1).max(100),
  maxImpliedSpeedKmh: z.number().min(10).max(1000),
  bulkAcceptThreshold: z.number().int().min(0).max(100),
});
export type LocationInferenceSettingsValue = z.infer<typeof schema>;

export const LOCATION_INFERENCE_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'locationInference',
  description: 'GPS-from-timeline inference: gap limits, auto-apply gate, anchor distance and speed ceiling.',
  schema,
  defaults: {
    maxGapMinutes: 30,
    maxExtrapolationGapMinutes: 10,
    autoApplyMaxGapMinutes: 5,
    requireSameDevice: true,
    maxAnchorDistanceKm: 2,
    maxImpliedSpeedKmh: 150,
    bulkAcceptThreshold: 80,
  },
});
