// ---------------------------------------------------------------------------
// Workflows — domain types (Phase 3)
//
// Mirrors the backend Phase 1/2 shapes exactly. All date-ish fields are typed
// as `string` because JSON transports ISO 8601 strings.
// ---------------------------------------------------------------------------

import type { WORKFLOW_RUN_STATUSES, WORKFLOW_TRIGGERS } from '@marinoscar/memoriahub-contract/workflows';

// ---------------------------------------------------------------------------
// Workflow definition + condition/action model
// ---------------------------------------------------------------------------

/**
 * Workflow Subject Type.
 *
 * @stability experimental
 */
export type WorkflowSubjectType = 'media_item';

/**
 * Workflow Trigger Type.
 *
 * @stability experimental
 */
export type WorkflowTriggerType = (typeof WORKFLOW_TRIGGERS)[number];

/**
 * Workflow Match.
 *
 * @stability experimental
 */
export type WorkflowMatch = 'all' | 'any';

/**
 * Workflow Leaf Condition.
 *
 * @stability experimental
 */
export interface WorkflowLeafCondition {
  /** The `field`. */
  field: string;
  /** The `op`. */
  op: string;
  /** The `value`. */
  value?: unknown;
}

/**
 * Workflow Group Condition.
 *
 * @stability experimental
 */
export interface WorkflowGroupCondition {
  /** The `match`. */
  match: WorkflowMatch;
  /** The `conditions`. */
  conditions: WorkflowLeafCondition[];
}

/**
 * Workflow Top Condition.
 *
 * @stability experimental
 */
export type WorkflowTopCondition = WorkflowLeafCondition | WorkflowGroupCondition;

/**
 * Narrow a top-level condition to a group (nested match + conditions[]) vs. a
 * leaf (field/op/value). True only when both `match` and `conditions` keys are
 * present.
 *
 * @stability experimental
 */
export function isWorkflowGroupCondition(
  c: WorkflowTopCondition,
): c is WorkflowGroupCondition {
  return (
    typeof c === 'object' &&
    c !== null &&
    'match' in c &&
    'conditions' in c
  );
}

/**
 * A single action instance. IMPORTANT: action params are TOP-LEVEL siblings of
 * `type`, not nested under a `params` key — e.g.
 *   { type: 'add_to_album', createAlbumNamed: 'Italy 2025' }
 *   { type: 'resolve_duplicate_group', action: 'trash' }
 *
 * @stability experimental
 */
export interface WorkflowActionInstance {
  /** The `type`. */
  type: string;
  [param: string]: unknown;
}

/**
 * Workflow Definition.
 *
 * @stability experimental
 */
export interface WorkflowDefinition {
  /** The `version`. */
  version: 1;
  /** The `subject`. */
  subject: WorkflowSubjectType;
  /** The `match`. */
  match: WorkflowMatch;
  /** The `conditions`. */
  conditions: WorkflowTopCondition[];
  /** The `actions`. */
  actions: WorkflowActionInstance[];
  /** The `options`. */
  options?: {
    maxItems?: number;
    requirePreview?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Subject registry (GET /api/workflows/subjects)
// ---------------------------------------------------------------------------

/**
 * Workflow Field Group.
 *
 * @stability experimental
 */
export type WorkflowFieldGroup =
  | 'File'
  | 'Dates'
  | 'Location'
  | 'Tags'
  | 'People'
  | 'Media'
  | 'Organization'
  | 'Review';

/**
 * Workflow Field Type.
 *
 * @stability experimental
 */
export type WorkflowFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'date'
  | 'geo-radius'
  | 'tag-set'
  | 'person-set'
  | 'uuid';

/**
 * Workflow Value Type.
 *
 * @stability experimental
 */
export type WorkflowValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'iso-date'
  | 'date-range'
  | 'positive-int'
  | 'string-list'
  | 'person-set'
  | 'geo-radius'
  | 'uuid'
  | 'none';

/**
 * Workflow Operator.
 *
 * @stability experimental
 */
export type WorkflowOperator =
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'equals'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'between'
  | 'before'
  | 'after'
  | 'older_than_days'
  | 'within_last_days'
  | 'is'
  | 'is_set'
  | 'has_any'
  | 'has_all'
  | 'has_none'
  | 'has_person'
  | 'not_has_person'
  | 'in_album'
  | 'not_in_album'
  | 'near';

/**
 * Workflow Dependency.
 *
 * @stability experimental
 */
export type WorkflowDependency =
  | 'metadata'
  | 'tags'
  | 'faces'
  | 'bursts'
  | 'duplicates'
  | 'locationSuggestions';

/**
 * Workflow Field Descriptor.
 *
 * @stability experimental
 */
export interface WorkflowFieldDescriptor {
  /** The `key`. */
  key: string;
  /** The `label`. */
  label: string;
  /** The `group`. */
  group: WorkflowFieldGroup;
  /** The `type`. */
  type: WorkflowFieldType;
  /** The `operators`. */
  operators: WorkflowOperator[];
  /** The `valueType`. */
  valueType: WorkflowValueType;
  /** The `enumValues`. */
  enumValues?: string[];
  /** The `dependency`. */
  dependency: WorkflowDependency;
  /** The `readTimeRefinement`. */
  readTimeRefinement?: boolean;
}

/**
 * Workflow Action Descriptor.
 *
 * @stability experimental
 */
export interface WorkflowActionDescriptor {
  /** The `type`. */
  type: string;
  /** The `label`. */
  label: string;
  /** The `destructive`. */
  destructive?: boolean;
  /** A deprecated alias (`move_to_circle`): still valid, never offered for a new action. */
  deprecated?: boolean;
}

/**
 * Subject Registry Entry.
 *
 * @stability experimental
 */
export interface SubjectRegistryEntry {
  /** The `subject`. */
  subject: WorkflowSubjectType;
  /** The `label`. */
  label: string;
  /** The `triggers`. */
  triggers: WorkflowTriggerType[];
  /** The `fields`. */
  fields: WorkflowFieldDescriptor[];
  /** The `actions`. */
  actions: WorkflowActionDescriptor[];
}

/**
 * Workflow Subjects Response.
 *
 * @stability experimental
 */
export interface WorkflowSubjectsResponse {
  /** The `subjects`. */
  subjects: SubjectRegistryEntry[];
}

// ---------------------------------------------------------------------------
// Workflow entity + list
// ---------------------------------------------------------------------------

/**
 * Workflow Run Summary.
 *
 * @stability experimental
 */
export interface WorkflowRunSummary {
  /** The `id`. */
  id: string;
  /** The `status`. */
  status: WorkflowRunStatus;
  /** The `matchedCount`. */
  matchedCount: number;
  /** The `succeededCount`. */
  succeededCount: number;
  /** The `failedCount`. */
  failedCount: number;
  /** The `skippedCount`. */
  skippedCount: number;
  /** The `finishedAt`. */
  finishedAt: string | null;
  /** The `createdAt`. */
  createdAt: string;
}

/**
 * Workflow.
 *
 * @stability experimental
 */
export interface Workflow {
  /** The `id`. */
  id: string;
  /** The `circleId`. */
  circleId: string;
  /** The `name`. */
  name: string;
  /** The `description`. */
  description: string | null;
  /** The `subjectType`. */
  subjectType: WorkflowSubjectType;
  /** The `enabled`. */
  enabled: boolean;
  /** The `trigger`. */
  trigger: WorkflowTriggerType;
  /** The `cronExpression`. */
  cronExpression: string | null;
  /** The `nextRunAt`. */
  nextRunAt: string | null;
  /** The `definition`. */
  definition: WorkflowDefinition;
  /** The `dependencies`. */
  dependencies: string[];
  /** The `createdById`. */
  createdById: string | null;
  /** The `createdAt`. */
  createdAt: string;
  /** The `updatedAt`. */
  updatedAt: string;
  /**
   * NOTE: not currently returned by the list/get API (Phase 1/2 `serialize`
   * omits it); typed optional for forward-compat and defensive UI rendering.
   */
  lastRun?: WorkflowRunSummary | null;
}

/**
 * Workflow List Meta.
 *
 * @stability experimental
 */
export interface WorkflowListMeta {
  /** The `page`. */
  page: number;
  /** The `pageSize`. */
  pageSize: number;
  /** The `totalItems`. */
  totalItems: number;
  /** The `totalPages`. */
  totalPages: number;
}

/**
 * Workflow List Response.
 *
 * @stability experimental
 */
export interface WorkflowListResponse {
  /** The `items`. */
  items: Workflow[];
  /** The `meta`. */
  meta: WorkflowListMeta;
}

// ---------------------------------------------------------------------------
// Preview (POST /api/workflows/preview)
// ---------------------------------------------------------------------------

/**
 * Workflow Preview Request.
 *
 * @stability experimental
 */
export interface WorkflowPreviewRequest {
  /** The `circleId`. */
  circleId: string;
  /** The `definition`. */
  definition: WorkflowDefinition;
}

/**
 * Workflow Preview Sample Item.
 *
 * @stability experimental
 */
export interface WorkflowPreviewSampleItem {
  /** The `id`. */
  id: string;
  /** The `type`. */
  type: string;
  /** The `capturedAt`. */
  capturedAt: string | null;
  /** The `filename`. */
  filename: string | null;
  /** The `width`. */
  width: number | null;
  /** The `height`. */
  height: number | null;
  /** The `thumbnailUrl`. */
  thumbnailUrl: string | null;
}

/**
 * Workflow Preview Response.
 *
 * @stability experimental
 */
export interface WorkflowPreviewResponse {
  /** The `matchedCount`. */
  matchedCount: number;
  /** The `capped`. */
  capped: boolean;
  /** The `sample`. */
  sample: WorkflowPreviewSampleItem[];
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * Workflow Run Status.
 *
 * @stability experimental
 */
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/**
 * Workflow Run Item Status.
 *
 * @stability experimental
 */
export type WorkflowRunItemStatus =
  | 'matched'
  | 'excluded'
  | 'applied'
  | 'partially_applied'
  | 'failed'
  | 'skipped';

/**
 * Workflow Run.
 *
 * @stability experimental
 */
export interface WorkflowRun {
  /** The `id`. */
  id: string;
  /** The `workflowId`. */
  workflowId: string;
  /** The `circleId`. */
  circleId: string;
  /** The `status`. */
  status: WorkflowRunStatus;
  /** The `triggerType`. */
  triggerType: WorkflowTriggerType;
  /** The `matchedCount`. */
  matchedCount: number;
  /** The `truncated`. */
  truncated: boolean;
  /** The `processedCount`. */
  processedCount: number;
  /** The `succeededCount`. */
  succeededCount: number;
  /** The `failedCount`. */
  failedCount: number;
  /** The `skippedCount`. */
  skippedCount: number;
  /** The `startedById`. */
  startedById: string | null;
  /** The `approvedById`. */
  approvedById: string | null;
  /** The `createdAt`. */
  createdAt: string;
  /** The `updatedAt`. */
  updatedAt: string;
  /** The `approvedAt`. */
  approvedAt: string | null;
  /** The `startedAt`. */
  startedAt: string | null;
  /** The `finishedAt`. */
  finishedAt: string | null;
  /** The `lastError`. */
  lastError: string | null;
}

/**
 * Workflow Run Action Summary.
 *
 * @stability experimental
 */
export interface WorkflowRunActionSummary {
  /** The `scanned`. */
  scanned: number;
  /** The `partial`. */
  partial: boolean;
  /** The `byActionType`. */
  byActionType: Record<string, { applied: number; failed: number; skipped: number }>;
}

/**
 * Workflow Run Detail.
 *
 * @stability experimental
 */
export interface WorkflowRunDetail extends WorkflowRun {
  /** The `definitionSnapshot`. */
  definitionSnapshot: WorkflowDefinition;
  /** The `itemStatusCounts`. */
  itemStatusCounts: Record<string, number>;
  /** The `actionSummary`. */
  actionSummary: WorkflowRunActionSummary;
}

/**
 * Workflow Run List Response.
 *
 * @stability experimental
 */
export interface WorkflowRunListResponse {
  /** The `items`. */
  items: WorkflowRun[];
  /** The `meta`. */
  meta: WorkflowListMeta;
}

/**
 * Workflow Run Item.
 *
 * @stability experimental
 */
export interface WorkflowRunItem {
  /** The `id`. */
  id: string;
  /** The `mediaItemId`. */
  mediaItemId: string;
  /** The `status`. */
  status: WorkflowRunItemStatus;
  /** The `actionResults`. */
  actionResults: unknown;
  /** The `error`. */
  error: string | null;
  /** The `updatedAt`. */
  updatedAt: string;
  /** The `media`. */
  media: {
    type: string;
    capturedAt: string | null;
    filename: string | null;
    width: number | null;
    height: number | null;
  } | null;
  /** The `thumbnailUrl`. */
  thumbnailUrl: string | null;
}

/**
 * Workflow Run Items Response.
 *
 * @stability experimental
 */
export interface WorkflowRunItemsResponse {
  /** The `items`. */
  items: WorkflowRunItem[];
  /** The `meta`. */
  meta: WorkflowListMeta;
}

// ---------------------------------------------------------------------------
// DTOs / query params
// ---------------------------------------------------------------------------

/**
 * Create Workflow Dto.
 *
 * @stability experimental
 */
export interface CreateWorkflowDto {
  /** The `circleId`. */
  circleId: string;
  /** The `name`. */
  name: string;
  /** The `description`. */
  description?: string | null;
  /** The `enabled`. */
  enabled?: boolean;
  /** The `trigger`. */
  trigger?: WorkflowTriggerType;
  /** The `cronExpression`. */
  cronExpression?: string | null;
  /** The `definition`. */
  definition: WorkflowDefinition;
}

/**
 * Update Workflow Dto.
 *
 * @stability experimental
 */
export interface UpdateWorkflowDto {
  /** The `name`. */
  name?: string;
  /** The `description`. */
  description?: string | null;
  /** The `enabled`. */
  enabled?: boolean;
  /** The `trigger`. */
  trigger?: WorkflowTriggerType;
  /** The `cronExpression`. */
  cronExpression?: string | null;
  /** The `definition`. */
  definition?: WorkflowDefinition;
}

/**
 * Create Run Dto.
 *
 * @stability experimental
 */
export interface CreateRunDto {
  /** The `maxItems`. */
  maxItems?: number;
}

/**
 * Approve Run Dto.
 *
 * @stability experimental
 */
export interface ApproveRunDto {
  /** The `excludedItemIds`. */
  excludedItemIds?: string[];
  /** The `confirmation`. */
  confirmation?: string;
}

/**
 * Workflows Query Params.
 *
 * @stability experimental
 */
export interface WorkflowsQueryParams {
  /** The `circleId`. */
  circleId: string;
  /** The `page`. */
  page?: number;
  /** The `pageSize`. */
  pageSize?: number;
}

/**
 * Runs Query Params.
 *
 * @stability experimental
 */
export interface RunsQueryParams {
  /** The `page`. */
  page?: number;
  /** The `pageSize`. */
  pageSize?: number;
}

/**
 * Run Items Query Params.
 *
 * @stability experimental
 */
export interface RunItemsQueryParams {
  /** The `status`. */
  status?: WorkflowRunItemStatus;
  /** The `page`. */
  page?: number;
  /** The `pageSize`. */
  pageSize?: number;
}
