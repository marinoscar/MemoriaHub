// PLATFORM-ADOPTION-SHIM(RETRO-C1): the jobs slice swaps this for JOBS_SYSTEM_SETTINGS.
import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const schema = z.object({
  history: z.object({
    retentionDays: z.number().int().min(1).max(365),
    purgeEnabled: z.boolean(),
  }),
  // Must exceed the longest legitimate single-job runtime.
  stuckThresholdMinutes: z.number().int().min(1).max(120),
});
export type JobsSettingsValue = z.infer<typeof schema>;

/**
 * Default for jobs.stuckThresholdMinutes: the legacy ENRICHMENT_STUCK_MINUTES env var when set to
 * a valid positive integer (clamped to the 1-120 setting bounds), else 3 minutes.
 */
export function defaultStuckThresholdMinutes(): number {
  const raw = process.env['ENRICHMENT_STUCK_MINUTES'];
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return Math.min(parsed, 120);
  }
  return 3;
}

export const JOBS_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'jobs',
  description: 'Job-queue policy: history retention and purge, and when a running job counts as stuck.',
  schema,
  defaults: {
    history: { retentionDays: 30, purgeEnabled: true },
    stuckThresholdMinutes: defaultStuckThresholdMinutes(),
  },
});
