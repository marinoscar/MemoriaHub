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
//   * the span attributes a node executor relays (`registerNodeSpanAttribute`, RETRO-C2, #581):
//     `frames` and `faces` (int), emitted as `job.app.<key>`;
//   * the labels of RETIRED job types, so an old row still renders with a name in
//     the admin Jobs list after its handler is gone.
//
// A label registered here is the fallback: a handler's own `label` wins.
//
// IMPORTED BY `platform/jobs/jobs.config.ts`, so it runs before the application
// is created (the registries freeze when it bootstraps). Registering a label
// twice with the same text is harmless.
// =============================================================================

import { registerNodeSpanAttribute } from '@marinoscar/platform-api/nodes';
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
 * The AI-bound job types (RETRO-C4, #590). SERVER-ONLY, permanently (EAB AI rule 3):
 * an AI provider key is resolved on the API and never brokered to a worker node,
 * so none of these may carry the node pair (`nodeResultSchema` +
 * `persistNodeResult`). Pinned by `test/jobs/ai-bound.conformance.spec.ts`. The
 * strings are permanent and deliberately not `ai.`-prefixed (queued rows).
 */
export const MEMORIAHUB_AI_JOB_TYPES: readonly string[] = [
  'auto_tagging',
  'video_auto_tagging',
  'picture_enhancement',
  'picture_enhancement_purge',
];

/**
 * The job types the legacy handlers serve, and the label each shows. A native
 * handler declares its own `label` and is not listed (RETRO-C3: the six
 * media/face types; RETRO-C5: the five dedup/burst/social types; RETRO-C4: the four AI-bound types; RETRO-C6:
 * geocode, location_inference, location_group_rebuild; RETRO-C8:
 * memory_generation, memory_digest and storage_insights; RETRO-D3 retired
 * broadcast_start, broadcast_chunk and notification_purge, listed below).
 */
export const APP_JOB_TYPE_LABELS: Readonly<Record<string, string>> = {
  // Storage / system
  storage_migration: 'Storage migration',
  trash_purge: 'Trash purge',
  trash_empty_evaluate: 'Empty trash evaluate',
  trash_empty_execute_batch: 'Empty trash execute batch',
  // Review-queue runs: bursts / duplicates / location suggestions (issue #190)
  review_run_evaluate: 'Review run evaluate',
  review_run_execute_batch: 'Review run execute batch',
  review_run_history_purge: 'Review run history purge',
  // Media Workflow Automation (issue #143)
  workflow_evaluate: 'Workflow evaluate',
  workflow_evaluate_item: 'Workflow evaluate (item)',
  workflow_execute_batch: 'Workflow execute batch',
  workflow_history_purge: 'Workflow history purge',
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
 *
 *   notification_purge, broadcast_start, broadcast_chunk (RETRO-D3): the platform
 *   notifications slice's purges and broadcast jobs replace them; same no-op rule.
 */
export const RETIRED_JOB_TYPE_LABELS: Readonly<Record<string, string>> = {
  // RETRO-C6 (#600): superseded by review_run_* (issue #190). Native shim handlers still drain pending
  // rows (see docs/platform-adoption/local-exceptions.md); the labels are kept for the admin list.
  location_suggestion_run_evaluate: 'Location suggestion run evaluate',
  location_suggestion_run_execute_batch: 'Location suggestion run execute batch',
  job_history_purge: 'Job history purge (retired)',
  // RETRO-D3 (#576): replaced by the notifications slice's retention purges and its
  // `admin.broadcast.start` / `admin.broadcast.chunk`; no-op handlers in
  // platform/notifications/retired-notification-job-types.ts.
  notification_purge: 'Notification purge (retired)',
  broadcast_start: 'Broadcast start (retired)',
  broadcast_chunk: 'Broadcast delivery (retired)',
};

/** Extra enqueue reasons. Empty: `upload`, `rerun` and `backfill` are built in. */
export const APP_JOB_REASONS: readonly JobReasonDefinition[] = [];

/** Retention policies this app adds to the platform's. */
export const APP_RETENTION_POLICIES: readonly RetentionPolicyDefinition[] = [
  WORKFLOW_RUNS_RETENTION_POLICY,
  REVIEW_RUNS_RETENTION_POLICY,
  // RETRO-C8's `appNotifications` policy is gone since RETRO-D3 (#576): the
  // platform's `retention.notifications` / `retention.notificationDeliveries`
  // purge the platform inbox and delivery log.
];

/**
 * The attributes a MemoriaHub node executor relays on its spans (RETRO-C2, #581): how many frames a
 * video job sampled and how many faces a detection found. Integers only; the platform drops an
 * unregistered key, or a value of the wrong type, from the span.
 */
export const APP_NODE_SPAN_ATTRIBUTES = [
  { key: 'frames', type: 'int' },
  { key: 'faces', type: 'int' },
] as const;

let registered = false;

if (!registered) {
  registered = true;
  APP_NODE_SPAN_ATTRIBUTES.forEach((attribute) => registerNodeSpanAttribute({ ...attribute }));
  APP_JOB_REASONS.forEach(registerJobReason);
  APP_RETENTION_POLICIES.forEach(registerRetentionPolicy);
  for (const [type, label] of Object.entries({ ...APP_JOB_TYPE_LABELS, ...RETIRED_JOB_TYPE_LABELS })) {
    registerJobTypeLabel(type, label);
  }
}
