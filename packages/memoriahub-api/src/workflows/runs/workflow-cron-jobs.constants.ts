// =============================================================================
// Workflow cron jobs: permanent job types (RETRO-C9, #612)
// =============================================================================
//
// The two every-minute workflow crons only decide and enqueue (root rule: every
// long-running activity is a queue job; `cron-enqueue-only` conformance suite).
// The work runs in these two GLOBAL, SERVER-ONLY job types:
//
//   workflows.schedule_tick       starts the unattended runs of due `scheduled`
//                                 workflows and rolls their `nextRunAt` forward
//                                 (WorkflowScheduleTickHandler);
//   workflows.micro_run_finalize  dispatches the `on_media_enriched` micro-runs
//                                 whose collection window closed
//                                 (WorkflowMicroRunFinalizeHandler).
//
// THE TYPE STRINGS ARE PERMANENT once jobs of them exist
// (`test/jobs/job-type-snapshot.spec.ts` pins them).
// =============================================================================

/**
 * `WorkflowScheduleTickHandler`'s permanent job type.
 *
 * @stability experimental
 */
export const WORKFLOW_SCHEDULE_TICK_TYPE = 'workflows.schedule_tick';

/**
 * `WorkflowMicroRunFinalizeHandler`'s permanent job type.
 *
 * @stability experimental
 */
export const WORKFLOW_MICRO_RUN_FINALIZE_TYPE = 'workflows.micro_run_finalize';

/**
 * The queue priority of both ticks. NOT the housekeeping priority (100, the
 * lowest): a scheduled workflow must start within about a minute of its fire
 * time even while a bulk import keeps the queue busy, so the ticks take the
 * priority of the run's own `workflow_evaluate` job (20), still behind upload
 * enrichment and reruns. Ascending is more urgent.
 *
 * @stability experimental
 */
export const WORKFLOW_TICK_PRIORITY = 20;
