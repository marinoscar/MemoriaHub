// =============================================================================
// Vocabularies and row shapes of the workflows slice (RETRO-J9, #622)
// =============================================================================
//
// The strings equal the `WorkflowSubject`, `WorkflowTrigger`, `WorkflowRunStatus` and `WorkflowRunItemStatus`
// enums of the schema fragment (`@marinoscar/memoriahub-db`); the slice holds them as constants because it
// imports no generated client. The trigger and run-status tuples are the contract's (`WORKFLOW_TRIGGERS`,
// `WORKFLOW_RUN_STATUSES`), pinned to the database enums by the web app's `contract-enums.spec.ts`.
// =============================================================================

/**
 * The Subjects a workflow can be about (`WorkflowSubject`).
 *
 * @stability experimental
 */
export const WORKFLOW_SUBJECT = { media_item: 'media_item' } as const;

/**
 * A workflow Subject.
 *
 * @stability experimental
 */
export type WorkflowSubjectKey = (typeof WORKFLOW_SUBJECT)[keyof typeof WORKFLOW_SUBJECT];

/**
 * The triggers of a workflow (`WorkflowTrigger`).
 *
 * @stability experimental
 */
export const WORKFLOW_TRIGGER = {
  manual: 'manual',
  on_media_enriched: 'on_media_enriched',
  scheduled: 'scheduled',
} as const;

/**
 * A workflow trigger.
 *
 * @stability experimental
 */
export type WorkflowTriggerKey = (typeof WORKFLOW_TRIGGER)[keyof typeof WORKFLOW_TRIGGER];

/**
 * The statuses of a workflow run (`WorkflowRunStatus`).
 *
 * @stability experimental
 */
export const WORKFLOW_RUN_STATUS = {
  evaluating: 'evaluating',
  awaiting_approval: 'awaiting_approval',
  running: 'running',
  completed: 'completed',
  completed_with_errors: 'completed_with_errors',
  failed: 'failed',
  cancelled: 'cancelled',
  expired: 'expired',
} as const;

/**
 * A workflow run status.
 *
 * @stability experimental
 */
export type WorkflowRunStatusKey = (typeof WORKFLOW_RUN_STATUS)[keyof typeof WORKFLOW_RUN_STATUS];

/**
 * The statuses of a workflow run item (`WorkflowRunItemStatus`).
 *
 * @stability experimental
 */
export const WORKFLOW_RUN_ITEM_STATUS = {
  matched: 'matched',
  excluded: 'excluded',
  applied: 'applied',
  partially_applied: 'partially_applied',
  failed: 'failed',
  skipped: 'skipped',
} as const;

/**
 * A workflow run item status.
 *
 * @stability experimental
 */
export type WorkflowRunItemStatusKey = (typeof WORKFLOW_RUN_ITEM_STATUS)[keyof typeof WORKFLOW_RUN_ITEM_STATUS];

/**
 * A `workflows` row as the slice reads it.
 *
 * @stability experimental
 */
export interface WorkflowRow {
  id: string;
  circleId: string;
  name: string;
  description: string | null;
  subjectType: WorkflowSubjectKey;
  enabled: boolean;
  trigger: WorkflowTriggerKey;
  cronExpression: string | null;
  nextRunAt: Date | null;
  definition: unknown;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A `workflow_runs` row as the slice reads it.
 *
 * @stability experimental
 */
export interface WorkflowRunRow {
  id: string;
  workflowId: string;
  circleId: string;
  status: WorkflowRunStatusKey;
  triggerType: WorkflowTriggerKey;
  definitionSnapshot: unknown;
  matchedCount: number;
  truncated: boolean;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  startedById: string | null;
  approvedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  approvedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastError: string | null;
}

/**
 * The permission strings and role the workflow routes declare. They equal the host catalog's: a permission
 * is data the identity port checks.
 *
 * @stability experimental
 */
export const WORKFLOW_PERMISSIONS = {
  /** Read media in a circle the caller belongs to. */
  MEDIA_READ: 'media:read',
  /** Write media. */
  MEDIA_WRITE: 'media:write',
  /** Read system settings (admin oversight). */
  SYSTEM_SETTINGS_READ: 'system_settings:read',
  /** Write system settings (admin override). */
  SYSTEM_SETTINGS_WRITE: 'system_settings:write',
  /** Read the job queue (admin run list). */
  JOBS_READ: 'jobs:read',
  /** Write the job queue (admin run cancel). */
  JOBS_WRITE: 'jobs:write',
} as const;

/**
 * The system role the admin oversight routes require.
 *
 * @stability experimental
 */
export const WORKFLOW_ADMIN_ROLE = 'admin' as const;
