import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

// Retention for review_runs AND trash_empty_runs: one setting retires both histories through the
// single nightly review_run_history_purge job (issue #190).
const schema = z.object({ runHistoryRetentionDays: z.number().int().min(1).max(365) });
export type ReviewRunsSettingsValue = z.infer<typeof schema>;

export const REVIEW_RUNS_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'reviewRuns',
  description: 'How long finished review and empty-trash runs are kept.',
  schema,
  defaults: { runHistoryRetentionDays: 30 },
});
