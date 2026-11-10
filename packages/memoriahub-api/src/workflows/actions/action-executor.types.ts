/**
 * Media Workflow Automation — action executor shared types (issue #140).
 *
 * These describe the executor's contract with the (Phase-2b) run engine. The
 * executor applies ONE action to ONE item and returns a structured outcome; it
 * owns no run-lifecycle state (no workflow_run_items writes, no batching).
 */

/**
 * The result of applying a single action to a single item.
 *   - `applied`  — the mutation ran and changed state.
 *   - `skipped`  — nothing to do (idempotent no-op, no pending target,
 *     dedup conflict, already-handled group, missing association, …); `reason`
 *     carries a short machine code.
 *   - `failed`   — the action threw; `detail` carries the error message.
 * `terminal: true` is set ONLY by `hard_delete` when the item was actually
 * purged, signalling the engine to skip any remaining actions for that item.
 */
export interface ActionOutcome {
  status: 'applied' | 'skipped' | 'failed';
  /** Short machine-readable code for a skip (e.g. 'no_pending_target', 'dedup_conflict'). */
  reason?: string;
  /** Human-readable detail, primarily the error message on `failed`. */
  detail?: string;
  /** Only ever true for a successful hard_delete — stop processing this item. */
  terminal?: boolean;
}

/**
 * Per-run context threaded through every action call. `actorPermissions` is the
 * actor's system permission-string list, passed straight through to the reused
 * service calls (they perform the per-circle role check and super-admin bypass).
 * `handledGroups` dedups review-queue group actions across items in one run.
 */
export interface WorkflowActionContext {
  runId: string;
  circleId: string;
  actorUserId: string;
  actorPermissions: string[];
  /** Burst/duplicate group ids already resolved/dismissed this run. */
  handledGroups: Set<string>;
}

/**
 * Minimal item handle. The executor loads any per-item state it needs
 * (capturedAt, contentHash, type, group/suggestion ids) with targeted selects.
 */
export interface WorkflowActionItem {
  id: string;
}

/**
 * A single action instance to apply: its registered `type` plus the already
 * schema-validated `params`. Defined locally (rather than reusing the
 * definition-schema's passthrough `WorkflowAction`) so `params` is a distinct,
 * parsed bag the executor reads by key.
 */
export interface WorkflowAction {
  type: string;
  params: Record<string, unknown>;
}
