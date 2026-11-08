// =============================================================================
// This app's job registrations (RETRO-C1, #575)
// =============================================================================
//
// What this app adds to the platform's jobs slice through its registries:
//
//   * the display label of each of its job types. A native `JobHandler` declares
//     its own `label`; the handlers still on the legacy adapter do not, so the
//     label lives here (it is the table `enrichment/job-type-labels.ts` held);
//     a type converted to a native handler leaves this table (RETRO-C3..C8);
//   * enqueue reasons beyond the built-in `upload`, `rerun` and `backfill`: none;
//   * retention policies beyond the platform's four: `workflowRuns` and
//     `reviewRuns` (RETRO-C7), whose purges keep the permanent type strings
//     `workflow_history_purge` and `review_run_history_purge`;
//   * the labels of RETIRED job types, so an old row still renders with a name in
//     the admin Jobs list after its handler is gone.
//
// A label registered here is the fallback: a handler's own `label` wins.
//
// IMPORTED BY `platform/jobs/jobs.config.ts`, so it runs before the application
// is created (the registries freeze when it bootstraps). Registering a label
// twice with the same text is harmless.
// =============================================================================

import {
  registerJobReason,
  registerJobTypeLabel,
  registerRetentionPolicy,
  type JobReasonDefinition,
  type RetentionPolicyDefinition,
} from '@marinoscar/platform-api/jobs';

import { REVIEW_RUNS_RETENTION_POLICY } from '../review-runs/review-runs.retention';
import { WORKFLOW_RUNS_RETENTION_POLICY } from '../workflows/runs/workflow-runs.retention';

/**
 * The job types the legacy handlers serve, and the label each shows. A native
 * handler declares its own `label` and is not listed (RETRO-C3: the six
 * media/face types).
 */
export const APP_JOB_TYPE_LABELS: Readonly<Record<string, string>> = {
  // Media enrichment (per-item compute)
  auto_tagging: 'Auto-tagging',
  video_auto_tagging: 'Video auto-tagging',
  geocode: 'Geocoding',
  duplicate_detection: 'Duplicate detection',
  duplicate_detection_batch: 'Duplicate detection (batch)',
  duplicate_confidence_backfill: 'Duplicate confidence backfill',
  social_media_detection: 'Social media detection',
  location_inference: 'Location inference',
  // Deprecated aliases kept so already-queued rows still render a friendly label;
  // superseded by review_run_* below (issue #190).
  location_suggestion_run_evaluate: 'Location suggestion run evaluate',
  location_suggestion_run_execute_batch: 'Location suggestion run execute batch',
  burst_detection: 'Burst detection',
  picture_enhancement: 'AI picture enhancer',
  picture_enhancement_purge: 'AI picture enhancer purge',
  // Storage / system
  storage_insights: 'Storage insights',
  storage_migration: 'Storage migration',
  trash_purge: 'Trash purge',
  trash_empty_evaluate: 'Empty trash evaluate',
  trash_empty_execute_batch: 'Empty trash execute batch',
  notification_purge: 'Notification purge',
  // Admin notification broadcasts (issue #488), server-only fan-out
  broadcast_start: 'Broadcast start',
  broadcast_chunk: 'Broadcast delivery',
  // Review-queue runs: bursts / duplicates / location suggestions (issue #190)
  review_run_evaluate: 'Review run evaluate',
  review_run_execute_batch: 'Review run execute batch',
  review_run_history_purge: 'Review run history purge',
  // Media Workflow Automation (issue #143)
  workflow_evaluate: 'Workflow evaluate',
  workflow_evaluate_item: 'Workflow evaluate (item)',
  workflow_execute_batch: 'Workflow execute batch',
  workflow_history_purge: 'Workflow history purge',
  // Memories (epic #300)
  memory_generation: 'Memory generation',
  memory_digest: 'Memory email digest',
  // Location Grouping (issue #373)
  location_group_rebuild: 'Location Group Rebuild',
};

/**
 * Types whose handler is gone but whose rows remain in `jobs` (history and, for a
 * pending one, until it drains). The strings are permanent.
 *
 *   job_history_purge: replaced by the platform's `job.history.purge`
 *   (`JobHistoryPurgeHandler`, nightly, same retention settings). The type still
 *   dispatches to `RetiredJobTypeHandler` (platform/jobs/retired-job-types.ts),
 *   which succeeds without doing anything, so a row queued before the cutover
 *   drains instead of sitting `pending` for ever.
 */
export const RETIRED_JOB_TYPE_LABELS: Readonly<Record<string, string>> = {
  job_history_purge: 'Job history purge (retired)',
};

/** Extra enqueue reasons. Empty: `upload`, `rerun` and `backfill` are built in. */
export const APP_JOB_REASONS: readonly JobReasonDefinition[] = [];

/** Retention policies this app adds to the platform's. */
export const APP_RETENTION_POLICIES: readonly RetentionPolicyDefinition[] = [
  WORKFLOW_RUNS_RETENTION_POLICY,
  REVIEW_RUNS_RETENTION_POLICY,
];

let registered = false;

if (!registered) {
  registered = true;
  APP_JOB_REASONS.forEach(registerJobReason);
  APP_RETENTION_POLICIES.forEach(registerRetentionPolicy);
  for (const [type, label] of Object.entries({ ...APP_JOB_TYPE_LABELS, ...RETIRED_JOB_TYPE_LABELS })) {
    registerJobTypeLabel(type, label);
  }
}
