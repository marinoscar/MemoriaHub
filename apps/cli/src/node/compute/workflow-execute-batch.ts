/**
 * node/compute/workflow-execute-batch.ts — Media Workflow Automation batch compute.
 *
 * Unlike every other node compute module (which loads a native lib and runs a
 * numeric model over downloaded media bytes), a workflow batch is DB-bound: it
 * has no media bytes (inputUrl is null) and no CPU-heavy compute to offload. The
 * node's ONLY job is to declare, per item, which actions it intends to apply —
 * derived purely from the frozen action list carried in the claim `params`.
 *
 * The API's `persistNodeResult` re-does ALL authoritative work server-side (the
 * per-item idempotent claim, drift re-validation, action execution,
 * move_to_circle cross-circle checks, counters, and run finalization) from the
 * TRUSTED job payload — it does not act on the outcomes declared here. So this
 * module is intentionally a pure, dependency-free pass: it never touches the
 * database and never mutates anything. Node eligibility exists for posture
 * completeness (an ENRICHMENT_WORKER_MODE=off fleet-only deployment must still
 * be able to execute workflows), not for compute offload.
 *
 * The result payload matches the server's zod DTO
 * (`workflowExecuteBatchResultSchema`) for
 * `POST /api/nodes/:id/jobs/:jobId/result` with `type: 'workflow_execute_batch'`:
 * `{ runId: string, items: [{ mediaItemId, actionResults?: [{ type, status }] }] }`.
 */

import { CapabilityUnavailableError, type ComputeFn } from '../capabilities.js';

interface FrozenAction {
  type?: unknown;
}

const computeWorkflowExecuteBatch: ComputeFn = async (_inputPath, params) => {
  const runId = params['runId'];
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new CapabilityUnavailableError(
      'workflow_execute_batch job payload is missing runId',
      'workflow_execute_batch',
    );
  }

  const rawItemIds = params['itemIds'];
  const itemIds = Array.isArray(rawItemIds)
    ? rawItemIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];

  // Frozen action list (types only matter here) supplied by the API's claim
  // params via NodesService.resolveJobParams; absent on older/edge job rows.
  const rawActions = params['actions'];
  const actionTypes = Array.isArray(rawActions)
    ? (rawActions as FrozenAction[])
        .map((a) => (a && typeof a.type === 'string' ? a.type : null))
        .filter((t): t is string => t !== null)
    : [];

  const items = itemIds.map((mediaItemId) => ({
    mediaItemId,
    // Declared intent only — the server recomputes the true per-action status.
    actionResults: actionTypes.map((type) => ({ type, status: 'pending' as const })),
  }));

  return { runId, items };
};

export default computeWorkflowExecuteBatch;
