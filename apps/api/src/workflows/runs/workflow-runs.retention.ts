import type { RetentionPolicyDefinition } from '@marinoscar/platform-api/jobs';

// =============================================================================
// Workflow run history: a platform retention policy (RETRO-C7, #604)
// =============================================================================
//
// `retention.workflowRuns` (the platform key pattern is camelCase letters and
// digits, so it is not `workflow_runs`) replaces `workflows.runHistoryRetentionDays`
// as the window that keeps finished workflow runs. The platform's 01:00
// `RetentionPurgeTask` enqueues the purge while the policy is enabled, and the
// operator edits it beside the platform's own windows.
//
// THE PURGE KEEPS ITS PERMANENT TYPE STRING, `workflow_history_purge`: rows of it
// exist (history, and maybe one pending at the cutover), so the retention purge
// is mounted under the same string rather than a new one with a retired-type
// shim. Handler: `workflow-runs-retention.handler.ts`.
//
// Defaults reproduce the old behaviour: 30 days, ON (the old nightly purge ran
// unconditionally). `scripts/migrate-run-retention-settings.ts` carries an
// operator's old `runHistoryRetentionDays` over.
//
// A pure module (types only) so `app-registrations/jobs.ts` can register it at
// import time without pulling in Nest providers.
// =============================================================================

/** The `retention` key. PERMANENT: renaming it orphans the operator's setting. */
export const WORKFLOW_RUNS_RETENTION_KEY = 'workflowRuns';

/** The purge's job type: the old nightly purge's string, kept (rows of it exist). */
export const WORKFLOW_RUNS_PURGE_TYPE = 'workflow_history_purge';

/** The policy registered with `registerRetentionPolicy`. */
export const WORKFLOW_RUNS_RETENTION_POLICY: RetentionPolicyDefinition = {
  key: WORKFLOW_RUNS_RETENTION_KEY,
  label: 'Workflow run history',
  defaultDays: 30,
  defaultEnabled: true,
  minDays: 1,
  maxDays: 365,
  purge: { type: WORKFLOW_RUNS_PURGE_TYPE, what: 'workflow run history purge' },
};
