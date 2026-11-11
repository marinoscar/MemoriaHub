import { BadRequestException } from '@nestjs/common';
import {
  emptyParamsSchema,
  resolveBurstGroupParamsSchema,
  resolveDuplicateGroupParamsSchema,
  BASE_ACTION_PERMISSION,
  RESOLVE_GROUP_PERMISSION,
  registerWorkflowAction,
  registerWorkflowField,
  type WorkflowActionDescriptor,
  type WorkflowFieldDescriptor,
} from '@marinoscar/memoriahub-api/workflows';

/**
 * The review-queue half of the Media Item catalog (burst, duplicate and location-suggestion fields and the
 * resolve, dismiss, accept and reject actions). The workflows slice (RETRO-J9, #622) holds the built-in
 * item-level catalog and knows no review queue; the web app, which still owns the burst and duplicate review
 * services, registers these on top, in the order the catalog always had (after the built-ins).
 */
export const REVIEW_FIELDS: WorkflowFieldDescriptor[] = [
  // Workflow-only descriptors targeting the burst/duplicate/location review
  // queues so a Media-Item workflow can drive their resolve/dismiss/accept
  // actions in Phase 2.
  {
    key: 'inPendingBurstGroup',
    label: 'In a pending burst group',
    group: 'Review',
    type: 'boolean',
    operators: ['is'],
    valueType: 'boolean',
    dependency: 'bursts',
    buildWhere: (_op, value) =>
      value === true
        ? { burstGroup: { is: { status: 'pending' } } }
        : { burstGroup: { isNot: { status: 'pending' } } },
  },
  {
    key: 'burstGroupConfidence',
    label: 'Burst-group confidence ≥',
    group: 'Review',
    type: 'number',
    operators: ['gte'],
    valueType: 'number',
    dependency: 'bursts',
    // Burst confidence IS persisted on burst_groups, so this is a pure indexed
    // relation predicate (unlike duplicateGroupConfidence below).
    buildWhere: (_op, value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new BadRequestException('burstGroupConfidence value must be a number');
      return { burstGroup: { is: { status: 'pending', confidence: { gte: n } } } };
    },
  },
  {
    key: 'inPendingDuplicateGroup',
    label: 'In a pending duplicate group',
    group: 'Review',
    type: 'boolean',
    operators: ['is'],
    valueType: 'boolean',
    dependency: 'duplicates',
    buildWhere: (_op, value) =>
      value === true
        ? { duplicateGroup: { is: { status: 'pending' } } }
        : { duplicateGroup: { isNot: { status: 'pending' } } },
  },
  {
    key: 'duplicateGroupConfidence',
    label: 'Duplicate-group confidence ≥',
    group: 'Review',
    type: 'number',
    operators: ['gte'],
    valueType: 'number',
    dependency: 'duplicates',
    // IMPORTANT: duplicate-group confidence (tightest-pair CLIP cosine
    // similarity) is computed at READ time, NOT persisted (see CLAUDE.md), so
    // this CANNOT be a pure index predicate the way burstGroupConfidence is.
    // The bounding predicate restricts to items already in a pending duplicate
    // group (a small set); the exact confidence comparison is a bounded
    // per-candidate compute pass. In Phase 1 the compute pass is deferred to the
    // Phase-2 executor (no `refinementPredicate` here), so preview counts items
    // in a pending duplicate group without applying the threshold — documented
    // behavior. Marked readTimeRefinement so the compiler surfaces it.
    readTimeRefinement: true,
    buildWhere: (_op, _value) => ({ duplicateGroup: { is: { status: 'pending' } } }),
  },
  {
    key: 'hasPendingLocationSuggestion',
    label: 'Has a pending location suggestion',
    group: 'Review',
    type: 'boolean',
    operators: ['is'],
    valueType: 'boolean',
    dependency: 'locationSuggestions',
    buildWhere: (_op, value) =>
      value === true
        ? { locationSuggestion: { is: { status: 'pending' } } }
        : { locationSuggestion: { isNot: { status: 'pending' } } },
  },
  {
    key: 'locationSuggestionConfidence',
    label: 'Location-suggestion confidence ≥',
    group: 'Review',
    type: 'number',
    operators: ['gte'],
    valueType: 'number',
    dependency: 'locationSuggestions',
    buildWhere: (_op, value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        throw new BadRequestException('locationSuggestionConfidence value must be a number');
      }
      return { locationSuggestion: { is: { status: 'pending', confidence: { gte: n } } } };
    },
  },
  {
    key: 'locationSuggestionMethod',
    label: 'Location-suggestion method',
    group: 'Review',
    type: 'enum',
    operators: ['equals'],
    valueType: 'enum',
    enumValues: ['interpolated', 'nearest'],
    dependency: 'locationSuggestions',
    buildWhere: (_op, value) => ({
      locationSuggestion: { is: { status: 'pending', method: String(value) } },
    }),
  },
];

/** The review-queue actions. */
export const REVIEW_ACTIONS: WorkflowActionDescriptor[] = [
  {
    type: 'resolve_burst_group',
    label: 'Resolve burst group',
    paramsSchema: resolveBurstGroupParamsSchema,
    permission: RESOLVE_GROUP_PERMISSION,
    triggerCompatibility: 'all',
    reversible: true,
    highImpact: false,
  },
  {
    type: 'dismiss_burst_group',
    label: 'Dismiss burst group',
    paramsSchema: emptyParamsSchema,
    permission: BASE_ACTION_PERMISSION,
    triggerCompatibility: 'all',
    reversible: true,
    highImpact: false,
  },
  {
    type: 'resolve_duplicate_group',
    label: 'Resolve duplicate group',
    paramsSchema: resolveDuplicateGroupParamsSchema,
    permission: RESOLVE_GROUP_PERMISSION,
    triggerCompatibility: 'all',
    reversible: true,
    highImpact: false,
  },
  {
    type: 'dismiss_duplicate_group',
    label: 'Dismiss duplicate group',
    paramsSchema: emptyParamsSchema,
    permission: BASE_ACTION_PERMISSION,
    triggerCompatibility: 'all',
    reversible: true,
    highImpact: false,
  },
  {
    type: 'accept_location_suggestion',
    label: 'Accept location suggestion',
    paramsSchema: emptyParamsSchema,
    permission: BASE_ACTION_PERMISSION,
    triggerCompatibility: 'all',
    reversible: true,
    highImpact: false,
  },
  {
    type: 'reject_location_suggestion',
    label: 'Reject location suggestion',
    paramsSchema: emptyParamsSchema,
    permission: BASE_ACTION_PERMISSION,
    triggerCompatibility: 'all',
    reversible: true,
    highImpact: false,
  },
];

let registered = false;

/** Registers the review-queue fields and actions with the workflows slice. Idempotent. */
export function registerReviewCatalog(): void {
  if (registered) return;
  registered = true;
  for (const field of REVIEW_FIELDS) registerWorkflowField('media_item', field);
  for (const action of REVIEW_ACTIONS) registerWorkflowAction('media_item', action);
}
