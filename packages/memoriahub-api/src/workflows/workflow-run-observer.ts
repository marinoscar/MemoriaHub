// =============================================================================
// The workflow run observer (RETRO-J9, #622)
// =============================================================================
//
// What happens AFTER a run's terminal or approval write commits: the webhook events
// (`workflows.run.completed`, `workflows.run.awaiting_approval`) and the `workflow_run_completed` notification.
// Their payloads and recipients are the host's (the platform webhook and notification slices), so the engine
// reaches them through this one optional port: a host that wants neither binds nothing. Every method is called
// outside any transaction and must never throw (a side channel never fails a job).
// =============================================================================

/**
 * Injection token of the {@link WorkflowRunObserver}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const WORKFLOW_RUN_OBSERVER = Symbol.for('@marinoscar/memoriahub/WORKFLOW_RUN_OBSERVER');

/**
 * Side channels of a run's lifecycle.
 *
 * @extensionPoint interface
 * @stability experimental
 */
export interface WorkflowRunObserver {
  /**
   * A run reached a terminal status (the caller won the finalize).
   *
   * @param runId - the run.
   */
  runFinished(runId: string): Promise<void> | void;

  /**
   * A run is waiting for approval.
   *
   * @param runId - the run.
   */
  runAwaitingApproval(runId: string): Promise<void> | void;

  /**
   * Fire-and-forget notification of a run's terminal outcome; never rejects.
   *
   * @param runId - the run.
   */
  notifyRunFinishedAsync(runId: string): void;
}
