import type { RetentionPolicyDefinition } from '@marinoscar/platform-api/jobs';

// =============================================================================
// Review and empty-trash run history: a platform retention policy (RETRO-C7, #604)
// =============================================================================
//
// `retention.reviewRuns` replaces `reviewRuns.runHistoryRetentionDays` as the
// window that keeps finished `review_runs` AND `trash_empty_runs` (one setting
// retired both histories before, and still does). The platform's 01:00
// `RetentionPurgeTask` enqueues the purge while the policy is enabled.
//
// THE PURGE KEEPS ITS PERMANENT TYPE STRING, `review_run_history_purge` (rows of
// it exist). Handler: `review-runs-retention.handler.ts`, which also keeps the
// stale-run sweep (a run stuck non-terminal for over 24 hours is failed, so the
// per-circle concurrency guard is not locked for ever).
//
// Defaults reproduce the old behaviour: 30 days, ON. A pure module (types only)
// so `app-registrations/jobs.ts` can register it at import time.
// =============================================================================

/** The `retention` key. PERMANENT: renaming it orphans the operator's setting. */
export const REVIEW_RUNS_RETENTION_KEY = 'reviewRuns';

/** The purge's job type: the old nightly purge's string, kept (rows of it exist). */
export const REVIEW_RUNS_PURGE_TYPE = 'review_run_history_purge';

/** The policy registered with `registerRetentionPolicy`. */
export const REVIEW_RUNS_RETENTION_POLICY: RetentionPolicyDefinition = {
  key: REVIEW_RUNS_RETENTION_KEY,
  label: 'Review and empty-trash run history',
  defaultDays: 30,
  defaultEnabled: true,
  minDays: 1,
  maxDays: 365,
  purge: { type: REVIEW_RUNS_PURGE_TYPE, what: 'review run history purge' },
};
