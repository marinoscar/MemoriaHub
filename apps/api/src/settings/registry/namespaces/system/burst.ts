import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const schema = z.object({
  timeGapSeconds: z.number().int().min(1).max(300),
  hashDistance: z.number().int().min(0).max(32),
  minGroupSize: z.number().int().min(2).max(20),
  autoResolveThreshold: z.number().int().min(0).max(100),
});
export type BurstSettingsValue = z.infer<typeof schema>;

export const BURST_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'burst',
  description: 'Burst photo detection: time gap, hash distance, minimum group size and the auto-resolve threshold.',
  schema,
  defaults: { timeGapSeconds: 10, hashDistance: 10, minGroupSize: 3, autoResolveThreshold: 60 },
});
