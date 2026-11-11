import { WORKFLOW_SUBJECT } from '../workflows.constants.js';
import type {
  SubjectRegistryEntry,
  WorkflowActionDescriptor,
  WorkflowFieldDescriptor,
} from './field-descriptor.interface.js';
import { MEDIA_ITEM_ACTIONS, MEDIA_ITEM_FIELDS } from './media-item-fields.js';

/**
 * Per-Subject registry: the extension point for Subjects (v1 registers exactly `media_item`) and, within a
 * Subject, for fields and actions. The compiler, validator and subjects API all resolve their catalogs through
 * these functions, so a Subject (and the fields and actions of one slice) slots in without an engine change.
 *
 * The built-in `media_item` entry carries the item-level fields and actions. The owner of a review queue adds
 * its own with {@link registerWorkflowField} and {@link registerWorkflowAction} when it starts (the web app for
 * the burst and duplicate queues, the location slice for its own), so this slice imports none of them. The
 * catalog order is registration order: built-ins first.
 */
const REGISTRY: Record<string, SubjectRegistryEntry> = {
  [WORKFLOW_SUBJECT.media_item]: {
    subject: WORKFLOW_SUBJECT.media_item,
    label: 'Media Item',
    // Phase 1 registers the trigger vocabulary; execution/scheduling is Phase 2/4.
    triggers: ['manual', 'on_media_enriched', 'scheduled'],
    fields: [...MEDIA_ITEM_FIELDS],
    actions: [...MEDIA_ITEM_ACTIONS],
  },
};

/**
 * Registers a field for a Subject. Idempotent per `key`: a second registration replaces the first in place,
 * so a restarting test module does not double the catalog and the order is kept.
 *
 * @param subject - the Subject (`media_item`).
 * @param field - the field descriptor.
 * @throws Error when the Subject is not registered.
 * @extensionPoint registry
 * @stability experimental
 */
export function registerWorkflowField(subject: string, field: WorkflowFieldDescriptor): void {
  const entry = REGISTRY[subject];
  if (!entry) throw new Error(`Cannot register workflow field "${field.key}": unknown subject "${subject}"`);
  const at = entry.fields.findIndex((f) => f.key === field.key);
  if (at >= 0) entry.fields[at] = field;
  else entry.fields.push(field);
}

/**
 * Registers an action for a Subject. Idempotent per `type`, like {@link registerWorkflowField}. The executor
 * that applies it is registered separately with `WorkflowActionHandlerRegistry`.
 *
 * @param subject - the Subject (`media_item`).
 * @param action - the action descriptor (params schema, permission, trigger compatibility).
 * @throws Error when the Subject is not registered.
 * @extensionPoint registry
 * @stability experimental
 */
export function registerWorkflowAction(subject: string, action: WorkflowActionDescriptor): void {
  const entry = REGISTRY[subject];
  if (!entry) throw new Error(`Cannot register workflow action "${action.type}": unknown subject "${subject}"`);
  const at = entry.actions.findIndex((a) => a.type === action.type);
  if (at >= 0) entry.actions[at] = action;
  else entry.actions.push(action);
}

/**
 * All registered Subject keys.
 *
 * @stability experimental
 */
export function registeredSubjects(): string[] {
  return Object.keys(REGISTRY);
}

/**
 * True when `subject` is a registered Subject.
 *
 * @param subject - the Subject.
 * @stability experimental
 */
export function isRegisteredSubject(subject: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, subject);
}

/**
 * A Subject's registry entry, or undefined if unknown.
 *
 * @param subject - the Subject.
 * @stability experimental
 */
export function getSubjectRegistry(subject: string): SubjectRegistryEntry | undefined {
  return REGISTRY[subject];
}

/**
 * The full registry (all Subjects). Used by `GET /api/workflows/subjects`.
 *
 * @stability experimental
 */
export function getFullRegistry(): SubjectRegistryEntry[] {
  return Object.values(REGISTRY);
}

/**
 * O(1)-ish field lookup within a Subject. Returns undefined for an unknown field.
 *
 * @param subject - the Subject.
 * @param fieldKey - the field key.
 * @stability experimental
 */
export function getField(subject: string, fieldKey: string): WorkflowFieldDescriptor | undefined {
  const entry = REGISTRY[subject];
  if (!entry) return undefined;
  return entry.fields.find((f) => f.key === fieldKey);
}

/**
 * True when `actionType` is registered for the Subject.
 *
 * @param subject - the Subject.
 * @param actionType - the action type.
 * @stability experimental
 */
export function isRegisteredAction(subject: string, actionType: string): boolean {
  const entry = REGISTRY[subject];
  if (!entry) return false;
  return entry.actions.some((a) => a.type === actionType);
}

/**
 * All action descriptors registered for a Subject (empty for an unknown Subject).
 *
 * @param subject - the Subject.
 * @stability experimental
 */
export function registeredActions(subject: string): WorkflowActionDescriptor[] {
  return REGISTRY[subject]?.actions ?? [];
}

/**
 * The action descriptor (with its `paramsSchema` and `permission`), or undefined for an unknown
 * Subject or action. Used by the run-create path to validate action params and authorize them.
 *
 * @param subject - the Subject.
 * @param type - the action type.
 * @stability experimental
 */
export function getActionDescriptor(subject: string, type: string): WorkflowActionDescriptor | undefined {
  const entry = REGISTRY[subject];
  if (!entry) return undefined;
  return entry.actions.find((a) => a.type === type);
}
