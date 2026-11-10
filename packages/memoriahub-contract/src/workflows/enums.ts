import { z } from 'zod';

/**
 * Triggers of a workflow, in the order of the `WorkflowTrigger` database enum.
 *
 * @stability stable
 */
export const WORKFLOW_TRIGGERS = ['manual', 'on_media_enriched', 'scheduled'] as const;

/**
 * Zod schema of {@link WORKFLOW_TRIGGERS}.
 *
 * @stability stable
 */
export const workflowTriggerSchema = z.enum(WORKFLOW_TRIGGERS);

/**
 * Lifecycle states of a workflow run, in the order of the `WorkflowRunStatus` database enum.
 *
 * @stability stable
 */
export const WORKFLOW_RUN_STATUSES = [
  'evaluating',
  'awaiting_approval',
  'running',
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
  'expired',
] as const;

/**
 * Zod schema of {@link WORKFLOW_RUN_STATUSES}.
 *
 * @stability stable
 */
export const workflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUSES);
