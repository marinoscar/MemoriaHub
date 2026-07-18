// ---------------------------------------------------------------------------
// Workflow builder — central draft state + reducer (pure, serializable).
//
// The draft is a superset of what the create/update DTOs need: name /
// description / enabled / trigger / cronExpression plus the full versioned,
// Subject-tagged `WorkflowDefinition` (match + conditions + actions + options).
// Preview and save consume `state.definition` directly.
//
// Conditions support exactly ONE nesting level (matching the backend): the top
// list holds leaves and groups; a group holds only leaves. All reducer branches
// return new objects/arrays so React sees fresh references.
// ---------------------------------------------------------------------------

import type {
  Workflow,
  WorkflowDefinition,
  WorkflowLeafCondition,
  WorkflowGroupCondition,
  WorkflowTopCondition,
  WorkflowMatch,
  WorkflowActionInstance,
  WorkflowTriggerType,
} from '../../types/workflows';
import { isWorkflowGroupCondition } from '../../types/workflows';
import type { WorkflowTemplate } from '../../constants/workflowTemplates';

export interface BuilderState {
  name: string;
  description: string;
  enabled: boolean;
  trigger: WorkflowTriggerType;
  cronExpression: string;
  definition: WorkflowDefinition;
}

function blankDefinition(): WorkflowDefinition {
  return {
    version: 1,
    subject: 'media_item',
    match: 'all',
    conditions: [],
    actions: [],
    options: { requirePreview: true },
  };
}

/** A brand-new, empty builder draft. */
export function blankState(): BuilderState {
  return {
    name: '',
    description: '',
    enabled: false,
    trigger: 'manual',
    cronExpression: '',
    definition: blankDefinition(),
  };
}

/** Hydrate a draft from a template (templates gallery / ?template=). */
export function stateFromTemplate(t: WorkflowTemplate): BuilderState {
  return {
    name: t.name,
    description: t.description,
    enabled: false,
    trigger: t.suggestedTrigger,
    cronExpression: t.suggestedCron ?? '',
    // Deep clone so edits never mutate the shared template constant.
    definition: cloneDefinition(t.definition),
  };
}

/** Hydrate a draft from an existing workflow (edit mode). */
export function stateFromWorkflow(w: Workflow): BuilderState {
  return {
    name: w.name,
    description: w.description ?? '',
    enabled: w.enabled,
    trigger: w.trigger,
    cronExpression: w.cronExpression ?? '',
    definition: cloneDefinition(w.definition),
  };
}

/** Structured deep clone of a definition (safe for our JSON-only shapes). */
export function cloneDefinition(def: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(def)) as WorkflowDefinition;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export type BuilderAction =
  // Trigger block / metadata
  | { kind: 'setName'; value: string }
  | { kind: 'setDescription'; value: string }
  | { kind: 'setEnabled'; value: boolean }
  | { kind: 'setTrigger'; value: WorkflowTriggerType }
  | { kind: 'setCron'; value: string }
  // Conditions — top level
  | { kind: 'setMatch'; value: WorkflowMatch }
  | { kind: 'addLeaf' }
  | { kind: 'addGroup' }
  | { kind: 'removeTop'; index: number }
  | { kind: 'updateLeaf'; index: number; patch: Partial<WorkflowLeafCondition> }
  // Conditions — group level
  | { kind: 'setGroupMatch'; groupIndex: number; value: WorkflowMatch }
  | { kind: 'addGroupLeaf'; groupIndex: number }
  | { kind: 'removeGroupLeaf'; groupIndex: number; childIndex: number }
  | {
      kind: 'updateGroupLeaf';
      groupIndex: number;
      childIndex: number;
      patch: Partial<WorkflowLeafCondition>;
    }
  // Actions
  | { kind: 'addAction'; action: WorkflowActionInstance }
  | { kind: 'setAction'; index: number; action: WorkflowActionInstance }
  | { kind: 'removeAction'; index: number }
  | { kind: 'moveAction'; index: number; direction: -1 | 1 }
  // Safety options
  | { kind: 'setMaxItems'; value: number | undefined }
  | { kind: 'setRequirePreview'; value: boolean }
  // Wholesale replace (template/workflow hydration)
  | { kind: 'replace'; state: BuilderState };

const emptyLeaf = (): WorkflowLeafCondition => ({ field: '', op: '' });

function withDefinition(
  state: BuilderState,
  def: WorkflowDefinition,
): BuilderState {
  return { ...state, definition: def };
}

function mapTop(
  def: WorkflowDefinition,
  conditions: WorkflowTopCondition[],
): WorkflowDefinition {
  return { ...def, conditions };
}

export function builderReducer(
  state: BuilderState,
  action: BuilderAction,
): BuilderState {
  const def = state.definition;
  switch (action.kind) {
    case 'setName':
      return { ...state, name: action.value };
    case 'setDescription':
      return { ...state, description: action.value };
    case 'setEnabled':
      return { ...state, enabled: action.value };
    case 'setTrigger':
      return { ...state, trigger: action.value };
    case 'setCron':
      return { ...state, cronExpression: action.value };

    case 'setMatch':
      return withDefinition(state, { ...def, match: action.value });

    case 'addLeaf':
      return withDefinition(
        state,
        mapTop(def, [...def.conditions, emptyLeaf()]),
      );

    case 'addGroup': {
      const group: WorkflowGroupCondition = {
        match: 'all',
        conditions: [emptyLeaf()],
      };
      return withDefinition(state, mapTop(def, [...def.conditions, group]));
    }

    case 'removeTop':
      return withDefinition(
        state,
        mapTop(
          def,
          def.conditions.filter((_, i) => i !== action.index),
        ),
      );

    case 'updateLeaf':
      return withDefinition(
        state,
        mapTop(
          def,
          def.conditions.map((c, i) => {
            if (i !== action.index || isWorkflowGroupCondition(c)) return c;
            return { ...c, ...action.patch };
          }),
        ),
      );

    case 'setGroupMatch':
      return withDefinition(
        state,
        mapTop(
          def,
          def.conditions.map((c, i) => {
            if (i !== action.groupIndex || !isWorkflowGroupCondition(c)) return c;
            return { ...c, match: action.value };
          }),
        ),
      );

    case 'addGroupLeaf':
      return withDefinition(
        state,
        mapTop(
          def,
          def.conditions.map((c, i) => {
            if (i !== action.groupIndex || !isWorkflowGroupCondition(c)) return c;
            return { ...c, conditions: [...c.conditions, emptyLeaf()] };
          }),
        ),
      );

    case 'removeGroupLeaf':
      return withDefinition(
        state,
        mapTop(
          def,
          def.conditions.map((c, i) => {
            if (i !== action.groupIndex || !isWorkflowGroupCondition(c)) return c;
            return {
              ...c,
              conditions: c.conditions.filter((_, j) => j !== action.childIndex),
            };
          }),
        ),
      );

    case 'updateGroupLeaf':
      return withDefinition(
        state,
        mapTop(
          def,
          def.conditions.map((c, i) => {
            if (i !== action.groupIndex || !isWorkflowGroupCondition(c)) return c;
            return {
              ...c,
              conditions: c.conditions.map((leaf, j) =>
                j === action.childIndex ? { ...leaf, ...action.patch } : leaf,
              ),
            };
          }),
        ),
      );

    case 'addAction':
      return withDefinition(state, {
        ...def,
        actions: [...def.actions, action.action],
      });

    case 'setAction':
      return withDefinition(state, {
        ...def,
        actions: def.actions.map((a, i) => (i === action.index ? action.action : a)),
      });

    case 'removeAction':
      return withDefinition(state, {
        ...def,
        actions: def.actions.filter((_, i) => i !== action.index),
      });

    case 'moveAction': {
      const target = action.index + action.direction;
      if (target < 0 || target >= def.actions.length) return state;
      const next = [...def.actions];
      const [moved] = next.splice(action.index, 1);
      next.splice(target, 0, moved);
      return withDefinition(state, { ...def, actions: next });
    }

    case 'setMaxItems': {
      const options = { ...(def.options ?? {}) };
      if (action.value === undefined) delete options.maxItems;
      else options.maxItems = action.value;
      return withDefinition(state, { ...def, options });
    }

    case 'setRequirePreview':
      return withDefinition(state, {
        ...def,
        options: { ...(def.options ?? {}), requirePreview: action.value },
      });

    case 'replace':
      return action.state;

    default:
      return state;
  }
}
