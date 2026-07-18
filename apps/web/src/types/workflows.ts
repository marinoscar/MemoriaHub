// ---------------------------------------------------------------------------
// Workflows — domain types (Phase 3)
//
// Mirrors the backend Phase 1/2 shapes exactly. All date-ish fields are typed
// as `string` because JSON transports ISO 8601 strings.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Workflow definition + condition/action model
// ---------------------------------------------------------------------------

export type WorkflowSubjectType = 'media_item';

export type WorkflowTriggerType = 'manual' | 'on_media_enriched' | 'scheduled';

export type WorkflowMatch = 'all' | 'any';

export interface WorkflowLeafCondition {
  field: string;
  op: string;
  value?: unknown;
}

export interface WorkflowGroupCondition {
  match: WorkflowMatch;
  conditions: WorkflowLeafCondition[];
}

export type WorkflowTopCondition = WorkflowLeafCondition | WorkflowGroupCondition;

/**
 * Narrow a top-level condition to a group (nested match + conditions[]) vs. a
 * leaf (field/op/value). True only when both `match` and `conditions` keys are
 * present.
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
 */
export interface WorkflowActionInstance {
  type: string;
  [param: string]: unknown;
}

export interface WorkflowDefinition {
  version: 1;
  subject: WorkflowSubjectType;
  match: WorkflowMatch;
  conditions: WorkflowTopCondition[];
  actions: WorkflowActionInstance[];
  options?: {
    maxItems?: number;
    requirePreview?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Subject registry (GET /api/workflows/subjects)
// ---------------------------------------------------------------------------

export type WorkflowFieldGroup =
  | 'File'
  | 'Dates'
  | 'Location'
  | 'Tags'
  | 'People'
  | 'Media'
  | 'Organization'
  | 'Review';

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

export type WorkflowDependency =
  | 'metadata'
  | 'tags'
  | 'faces'
  | 'bursts'
  | 'duplicates'
  | 'locationSuggestions';

export interface WorkflowFieldDescriptor {
  key: string;
  label: string;
  group: WorkflowFieldGroup;
  type: WorkflowFieldType;
  operators: WorkflowOperator[];
  valueType: WorkflowValueType;
  enumValues?: string[];
  dependency: WorkflowDependency;
  readTimeRefinement?: boolean;
}

export interface WorkflowActionDescriptor {
  type: string;
  label: string;
  destructive?: boolean;
}

export interface SubjectRegistryEntry {
  subject: WorkflowSubjectType;
  label: string;
  triggers: WorkflowTriggerType[];
  fields: WorkflowFieldDescriptor[];
  actions: WorkflowActionDescriptor[];
}

export interface WorkflowSubjectsResponse {
  subjects: SubjectRegistryEntry[];
}

// ---------------------------------------------------------------------------
// Workflow entity + list
// ---------------------------------------------------------------------------

export interface WorkflowRunSummary {
  id: string;
  status: WorkflowRunStatus;
  matchedCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  finishedAt: string | null;
  createdAt: string;
}

export interface Workflow {
  id: string;
  circleId: string;
  name: string;
  description: string | null;
  subjectType: WorkflowSubjectType;
  enabled: boolean;
  trigger: WorkflowTriggerType;
  cronExpression: string | null;
  nextRunAt: string | null;
  definition: WorkflowDefinition;
  dependencies: string[];
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * NOTE: not currently returned by the list/get API (Phase 1/2 `serialize`
   * omits it); typed optional for forward-compat and defensive UI rendering.
   */
  lastRun?: WorkflowRunSummary | null;
}

export interface WorkflowListMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface WorkflowListResponse {
  items: Workflow[];
  meta: WorkflowListMeta;
}

// ---------------------------------------------------------------------------
// Preview (POST /api/workflows/preview)
// ---------------------------------------------------------------------------

export interface WorkflowPreviewRequest {
  circleId: string;
  definition: WorkflowDefinition;
}

export interface WorkflowPreviewSampleItem {
  id: string;
  type: string;
  capturedAt: string | null;
  filename: string | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
}

export interface WorkflowPreviewResponse {
  matchedCount: number;
  capped: boolean;
  sample: WorkflowPreviewSampleItem[];
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type WorkflowRunStatus =
  | 'evaluating'
  | 'awaiting_approval'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type WorkflowRunItemStatus =
  | 'matched'
  | 'excluded'
  | 'applied'
  | 'partially_applied'
  | 'failed'
  | 'skipped';

export interface WorkflowRun {
  id: string;
  workflowId: string;
  circleId: string;
  status: WorkflowRunStatus;
  triggerType: WorkflowTriggerType;
  matchedCount: number;
  truncated: boolean;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  startedById: string | null;
  approvedById: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

export interface WorkflowRunActionSummary {
  scanned: number;
  partial: boolean;
  byActionType: Record<string, { applied: number; failed: number; skipped: number }>;
}

export interface WorkflowRunDetail extends WorkflowRun {
  definitionSnapshot: WorkflowDefinition;
  itemStatusCounts: Record<string, number>;
  actionSummary: WorkflowRunActionSummary;
}

export interface WorkflowRunListResponse {
  items: WorkflowRun[];
  meta: WorkflowListMeta;
}

export interface WorkflowRunItem {
  id: string;
  mediaItemId: string;
  status: WorkflowRunItemStatus;
  actionResults: unknown;
  error: string | null;
  updatedAt: string;
  media: {
    type: string;
    capturedAt: string | null;
    filename: string | null;
    width: number | null;
    height: number | null;
  } | null;
  thumbnailUrl: string | null;
}

export interface WorkflowRunItemsResponse {
  items: WorkflowRunItem[];
  meta: WorkflowListMeta;
}

// ---------------------------------------------------------------------------
// DTOs / query params
// ---------------------------------------------------------------------------

export interface CreateWorkflowDto {
  circleId: string;
  name: string;
  description?: string | null;
  enabled?: boolean;
  trigger?: WorkflowTriggerType;
  cronExpression?: string | null;
  definition: WorkflowDefinition;
}

export interface UpdateWorkflowDto {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  trigger?: WorkflowTriggerType;
  cronExpression?: string | null;
  definition?: WorkflowDefinition;
}

export interface CreateRunDto {
  maxItems?: number;
}

export interface ApproveRunDto {
  excludedItemIds?: string[];
  confirmation?: string;
}

export interface WorkflowsQueryParams {
  circleId: string;
  page?: number;
  pageSize?: number;
}

export interface RunsQueryParams {
  page?: number;
  pageSize?: number;
}

export interface RunItemsQueryParams {
  status?: WorkflowRunItemStatus;
  page?: number;
  pageSize?: number;
}
